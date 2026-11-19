import Phaser from 'phaser';
import bus from '../core/EventBus.js';
import { moveHero, reachableTiles, findPath, checkTileInteraction, pickUpResource, occupiedTiles } from '../logic/mapLogic.js';
import { endTurn as endTurnLogic } from '../logic/turnLogic.js';
import { planMapTurn, executeMapStep, MAX_MOVE_CALLS } from '../logic/mapAI.js';
import { autoSave } from '../logic/saveLogic.js';
import { openSkillPanel } from './ui/skillPanel.js';
import { openSavePanel } from './ui/savePanel.js';
import { toast as showToast, RES_NAMES, createButton, DEPTH, THEME } from './ui/components.js';
import {
  hasArt,
  pixelSprite,
  terrainVariantKey,
  resKey,
  townMapKey,
  heroMapKey
} from '../core/pixelArt.js';

/**
 * MapScene —— 大地图场景
 *
 * M0：占位版（直线移动）
 * M2：接入地图逻辑 —— 选中英雄、显示可达范围、A* 移动
 * M3：路径预览、逐格移动动画、资源拾取、进城与遭遇战触发
 * M11：接入地图 AI —— 电脑回合逐格播放、可视化行动流水
 *
 * 图层顺序（从下到上）：地形 → 可达范围 → 路径预览 → 资源 → 城镇 → 英雄 → 状态栏
 * 格子尺寸 40px，地图左上角留 8px 边距，顶部 48px 为状态栏。
 */
const TILE = 40;
const OFFSET_X = 8;
const OFFSET_Y = 48;

/**
 * 电脑回合续跑信息的存放位置（registry 跨场景保留）
 *
 * 电脑进攻 → 切 BattleScene → MapScene 被销毁 → 战斗结算后 scene.start('MapScene')
 * 重新创建。要在回来后接着跑剩余英雄，就得把「已行动过哪些英雄、城务是否已做」
 * 存到 registry 里（registry 是 Phaser 的全局注册表，场景切换不会丢）。
 */
const AI_RESUME_KEY = 'mapAiResume';

// 地形配色（占位美术）
const TERRAIN_COLORS = {
  0: 0x7ab648, // 平原
  1: 0x2f6b2f, // 森林
  2: 0x8a8a8a, // 山地
  3: 0x3a6ea5, // 水域
  4: 0xb59a6a  // 道路
};

// 资源图标配色与首字
const RESOURCE_STYLE = {
  gold: { color: 0xf1c40f, char: '金' },
  wood: { color: 0x8bc34a, char: '木' },
  ore: { color: 0xb0bec5, char: '矿' },
  mercury: { color: 0x9c27b0, char: '汞' },
  sulfur: { color: 0xffeb3b, char: '硫' },
  crystal: { color: 0x29b6f6, char: '晶' },
  gem: { color: 0xe91e63, char: '宝' }
};

export default class MapScene extends Phaser.Scene {
  constructor() {
    super('MapScene');
  }

  create() {
    /** @type {object} 全局状态 */
    this.state = this.registry.get('state');
    this.data = this.registry.get('data');
    this.selectedHero = this.state.heroes.find((h) => h.playerId === 0) || null;

    // 英雄的显示位置（动画期间与逻辑位置解耦）
    this.displayPos = new Map();
    for (const hero of this.state.heroes) this.displayPos.set(hero.id, { ...hero.pos });
    /** @type {Map<string, Phaser.GameObjects.Container>} 英雄精灵缓存 */
    this.heroSprites = new Map();
    /** @type {Map<string, Phaser.GameObjects.Circle>} 英雄主体（用于描边高亮） */
    this.heroCircles = new Map();
    /** 可达格缓存：key = "x,y" */
    this.reachableCache = new Set();
    this.moving = false; // 移动动画中，锁定输入
    /** M8：技能加点面板控制器 */
    this.skillPanel = null;
    /** M12：存档面板控制器 */
    this.savePanel = null;
    /** 英雄+城镇重叠选择弹层 */
    this.choiceLayer = null;
    /** M11：电脑回合是否正在播放（播放期间锁定玩家输入） */
    this.aiPlaying = false;
    /** M11：电脑回合的行动队列（来自 planMapTurn） */
    this.aiSteps = [];
    /** M11：电脑回合队列的游标 */
    this.aiCursor = 0;
    /** M11：电脑回合已行动过的英雄（战斗返回后重规划用） */
    this.aiSkipHeroIds = new Set();
    /** M11：电脑回合是否已做过城务（战斗返回后重规划用） */
    this.aiCityDone = false;
    /** M11：电脑回合累计移动次数（验收 3 的上限保护） */
    this.aiMoveCalls = 0;
    /** M11：电脑回合启动定时器句柄（防重复调度） */
    this.aiTimer = null;

    // ── 图层顺序（自底向上）──────────────────────────────
    // groundLayer : 地形瓦片（540 张，必须在最底）
    // rangeLayer  : 可达范围高亮
    // pathLayer   : 移动路径
    // resLayer    : 资源图标
    // townLayer   : 城镇
    // heroLayer   : 英雄头像
    //
    // ⚠️ 瓦片必须放进 groundLayer，不能直接 add 到 scene 顶层。
    //    Phaser 按**插入顺序**渲染，顶层元素排在容器之后 ——
    //    顶层瓦片会盖住所有 layer 容器里的东西。
    this.groundLayer = this.add.container(0, 0);
    this.drawTerrain();
    this.rangeLayer = this.add.container(0, 0);
    this.pathLayer = this.add.container(0, 0);
    this.resLayer = this.add.container(0, 0);
    this.townLayer = this.add.container(0, 0);
    this.heroLayer = this.add.container(0, 0);

    this.drawResources();
    this.drawTowns();
    this.drawHeroes();
    this.drawReachable();
    this.drawStatusBar();
    this.bindInput();

    // 逻辑层事件 → 界面刷新
    // 注意：场景切换时必须解绑，否则每次进图都会多挂一份监听（事件重复触发 + 场景对象泄漏）
    this.busOff = [
      bus.on('hero:moved', () => this.redraw()),
      // M12：每天开始时自动写一次 auto 档（day:new 在切回玩家 0 时触发）
      bus.on('day:new', () => {
        this.drawStatusBar();
        this.autoSaveNow();
      }),
      bus.on('turn:start', (p) => this.onTurnStart(p)),
      bus.on('resource:changed', () => this.drawStatusBar()),
      bus.on('game:over', (r) => this.onGameOver(r)),
      // M6c：战斗结算写回了英雄/城镇，刷新地图
      bus.on('battle:resolved', () => this.redraw())
    ];
    this.events.once('shutdown', () => {
      for (const off of this.busOff || []) off();
      this.busOff = [];
    });

    // 战斗结算时发出的 game:over 可能在本场景创建之前就触发过，这里补一次提示
    if (this.state.gameOver) this.onGameOver(this.state.gameOver);

    // M11：电脑发起战斗后，本场景会被销毁重建。
    // registry 里存着续跑信息（已行动过的英雄、城务状态、移动计数），
    // 这里接上，把电脑回合剩下的英雄跑完。
    //
    // ⚠️ 续跑信息**总是**要取走（哪怕游戏已结束），
    //    否则会残留在 registry 里，下一局开局时被误读。
    const resume = this.registry.get(AI_RESUME_KEY);
    this.registry.remove(AI_RESUME_KEY);
    if (resume && !this.state.gameOver) {
      const aiPlayer = this.state.players[this.state.meta.currentPlayer];
      if (aiPlayer?.isAI) this.scheduleAiTurn(resume);
    }
  }

  /**
   * 排一个「稍后开始电脑回合」的定时器
   *
   * 用 aiTimer 做互斥：create() 的续跑路径与 onTurnStart 的常规路径
   * 都走这里，避免两条路径都排定时器、导致电脑回合跑两遍。
   *
   * @param {object} [resume] 续跑信息
   */
  scheduleAiTurn(resume = null) {
    if (this.aiTimer) return;
    this.aiTimer = this.time.delayedCall(300, () => {
      this.aiTimer = null;
      this.startAiTurn(resume || {});
    });
  }

  /** 格子坐标 → 画布像素中心 */
  cellToPixel(x, y) {
    return { px: OFFSET_X + x * TILE + TILE / 2, py: OFFSET_Y + y * TILE + TILE / 2 };
  }

  /** 画布像素 → 格子坐标 */
  pixelToCell(px, py) {
    return { x: Math.floor((px - OFFSET_X) / TILE), y: Math.floor((py - OFFSET_Y) / TILE) };
  }

  /**
   * 画地形网格
   *
   * M14：优先用像素地形瓦片（每种地形 4 个变体，按坐标散列取值，
   *      避免整片地面重复）。资源缺失时退回色块占位。
   */
  drawTerrain() {
    const { width, height, tiles } = this.state.map;
    const useArt = hasArt(this, 'px_terrain_plain_0');

    if (useArt) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const key = terrainVariantKey(tiles[y][x], x, y);
          if (!key) continue;
          const t = pixelSprite(this, key, OFFSET_X + x * TILE, OFFSET_Y + y * TILE, TILE, 0, 0);
          if (t) this.groundLayer.add(t);
        }
      }
      return;
    }

    // 回退：色块占位
    const g = this.add.graphics();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const color = TERRAIN_COLORS[tiles[y][x]] ?? 0x000000;
        g.fillStyle(color, 1);
        g.fillRect(OFFSET_X + x * TILE, OFFSET_Y + y * TILE, TILE - 1, TILE - 1);
      }
    }
    this.groundLayer.add(g);
  }

  /**
   * 画地图资源（像素图标，被捡走后消失）
   */
  drawResources() {
    this.resLayer.removeAll(true);
    for (const obj of this.state.map.objects || []) {
      if (obj.type !== 'resource') continue;
      const style = RESOURCE_STYLE[obj.resource] || { color: 0xffffff, char: '?' };
      const { px, py } = this.cellToPixel(obj.pos.x, obj.pos.y);

      const img = pixelSprite(this, resKey(obj.resource), px, py, 30);
      if (img) {
        this.resLayer.add(img);
        continue;
      }

      // 回退：色块 + 首字
      const box = this.add.rectangle(px, py, 26, 26, style.color, 0.92).setStrokeStyle(2, 0xffffff);
      const text = this.add.text(px, py, style.char, { fontSize: '13px', color: '#222' }).setOrigin(0.5);
      this.resLayer.add([box, text]);
    }
  }

  /**
   * 画城镇（像素城池 + 名字）
   */
  drawTowns() {
    this.townLayer.removeAll(true);
    for (const town of this.state.towns) {
      const { px, py } = this.cellToPixel(town.pos.x, town.pos.y);
      const color = town.faction === 'shu' ? 0xc0392b : 0x2980b9; // 蜀红 / 魏蓝

      const img = pixelSprite(this, townMapKey(town.faction), px, py - 2, 34);
      if (img) {
        this.townLayer.add(img);
      } else {
        // 回退：色块方块
        const rect = this.add.rectangle(px, py, TILE - 8, TILE - 8, color).setStrokeStyle(2, 0xffffff);
        this.townLayer.add(rect);
      }

      const label = this.add.text(px, py - TILE, town.name, { fontSize: '12px', color: '#fff' }).setOrigin(0.5);
      this.townLayer.add(label);
    }
  }

  /**
   * 画英雄（像素头像 + 阵营色圆环，选中时金色描边）
   */
  drawHeroes() {
    for (const hero of this.state.heroes) {
      const { px, py } = this.cellToPixel(hero.pos.x, hero.pos.y);
      let sprite = this.heroSprites.get(hero.id);

      if (!sprite) {
        sprite = this.add.container(px, py);
        const factionColor = hero.playerId === 0 ? 0xc0392b : 0x3498db;
        const portrait = pixelSprite(this, heroMapKey(hero.name), 0, -1, 30);

        let ring;
        if (portrait) {
          // 阵营色圆环：既是底座也是选中指示器
          ring = this.add.circle(0, 0, TILE / 2 - 2, 0xffffff, 0)
            .setStrokeStyle(2, factionColor);
          sprite.add([ring, portrait]);
        } else {
          // 回退：色块圆 + 名字首字
          ring = this.add.circle(0, 0, TILE / 3, factionColor).setStrokeStyle(2, 0xffffff);
          const label = this.add.text(0, 0, hero.name.slice(0, 1), { fontSize: '14px', color: '#fff' }).setOrigin(0.5);
          sprite.add([ring, label]);
        }

        this.heroLayer.add(sprite);
        this.heroSprites.set(hero.id, sprite);
        this.heroCircles.set(hero.id, ring);
      }

      // 位置以显示位置为准（动画期间与逻辑位置解耦）
      const p = this.displayPos.get(hero.id) || hero.pos;
      const { px: dx, py: dy } = this.cellToPixel(p.x, p.y);
      if (sprite.x !== dx || sprite.y !== dy) sprite.setPosition(dx, dy);

      // 选中高亮
      const ring = this.heroCircles.get(hero.id);
      const isSel = this.selectedHero && this.selectedHero.id === hero.id;
      const factionColor = hero.playerId === 0 ? 0xc0392b : 0x3498db;
      ring.setStrokeStyle(isSel ? 3 : 2, isSel ? 0xf1c40f : factionColor);
    }
  }

  /** 画选中英雄的可达范围（半透明绿） */
  drawReachable() {
    this.rangeLayer.removeAll(true);
    this.reachableCache.clear();
    if (!this.selectedHero) return;
    const tiles = reachableTiles(this.state, this.selectedHero.id);
    for (const t of tiles) {
      const { px, py } = this.cellToPixel(t.x, t.y);
      const rect = this.add.rectangle(px, py, TILE - 1, TILE - 1, 0x2ecc71, 0.28);
      this.rangeLayer.add(rect);
      this.reachableCache.add(`${t.x},${t.y}`);
    }
  }

  /** 画路径预览（鼠标悬停在可达格时） */
  drawPathPreview(path) {
    this.pathLayer.removeAll(true);
    if (!path || path.length === 0) return;
    for (const p of path) {
      const { px, py } = this.cellToPixel(p.x, p.y);
      const dot = this.add.circle(px, py, 5, 0xffffff, 0.85);
      this.pathLayer.add(dot);
    }
  }

  /** 顶部状态栏：日期、资源、当前行动方、结束回合按钮 */
  drawStatusBar() {
    if (this.bar) this.bar.destroy();
    this.bar = this.add.container(0, 0);

    const p = this.state.players[0];
    const cur = this.state.players[this.state.meta.currentPlayer];
    const bg = this.add.rectangle(640, 24, 1280, 48, 0x11111f);
    const text = this.add.text(16, 12,
      `第${this.state.meta.week}周 第${this.state.meta.day}天  |  ` +
      `金:${p.gold} 木:${p.wood} 矿:${p.ore} 汞:${p.mercury} 硫:${p.sulfur} 晶:${p.crystal} 宝:${p.gem}` +
      `  |  当前:${cur.faction === 'shu' ? '蜀汉' : '曹魏'}${cur.isAI ? '(电脑)' : ''}` +
      (this.selectedHero ? `  |  ${this.selectedHero.name} Lv.${this.selectedHero.level || 1} 行动力:${this.selectedHero.movePoints}` : ''),
      { fontSize: '14px', color: '#eee' });
    const isMyTurn = this.state.meta.currentPlayer === 0;
    const endBtn = this.add.text(1160, 12, isMyTurn ? '[结束回合]' : '[电脑行动中]', {
      fontSize: '14px', color: isMyTurn ? '#f1c40f' : '#888888'
    })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.endTurn());
    this.bar.add([bg, text, endBtn]);

    // M12：存档 / 读档入口
    const saveBtn = this.add.text(1060, 12, '[存档]', {
      fontSize: '14px', color: '#3498db'
    })
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.openSavePanel());
    this.bar.add(saveBtn);

    // M8：玩家英雄有待分配的技能点 → 显示可点击的提示
    const pendingHero = this.state.heroes.find(
      (h) => h.playerId === 0 && (h.pendingLevels || 0) > 0
    );
    if (pendingHero) {
      const tip = this.add.text(900, 12, `[${pendingHero.name} 技能加点 ${pendingHero.pendingLevels}]`, {
        fontSize: '14px', color: '#2ecc71'
      })
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.openSkillPanel(pendingHero.id));
      this.bar.add(tip);
    }
  }

  /**
   * 打开技能加点面板（M8）
   * @param {string} heroId
   */
  openSkillPanel(heroId) {
    if (this.skillPanel) return;
    this.skillPanel = openSkillPanel(this, {
      state: this.state,
      data: this.data,
      heroId,
      onDone: () => {
        this.skillPanel = null;
        this.redraw();
      }
    });
  }

  /**
   * 自动存档（M12）：写 'auto' 位
   *
   * 在 day:new（每天开始）时调用。失败不打断游戏流程，只在控制台留痕。
   */
  autoSaveNow() {
    const r = autoSave(this.state);
    if (!r.ok) {
      console.warn('[M12] 自动存档失败：', r.reason);
    }
    return r;
  }

  /**
   * 打开存档 / 读档面板（M12）
   */
  openSavePanel() {
    if (this.savePanel) return;
    this.savePanel = openSavePanel(this, {
      state: this.state,
      onLoad: (loaded) => {
        this.savePanel = null;
        this.applyLoadedState(loaded);
      },
      onCancel: () => {
        this.savePanel = null;
      }
    });
  }

  /**
   * 应用读档回来的 state（M12）
   *
   * 读档 = 把 registry 里的 state 换掉，然后重建整个 MapScene。
   * 之所以要重建：场景里的精灵、可达格缓存、显示位置都是按开局状态建的，
   * 换 state 后必须重新画一遍。
   *
   * @param {object} loaded 读档得到的完整 state
   */
  applyLoadedState(loaded) {
    if (!loaded) return;
    this.registry.set('state', loaded);
    // 调试钩子同步更新（无头脚本读 window.__gameState）
    if (typeof window !== 'undefined') window.__gameState = loaded;
    // 读档后不应残留上一局的电脑回合续跑信息
    this.registry.remove(AI_RESUME_KEY);
    // 重建场景，让所有渲染对象按新 state 重画
    this.scene.start('MapScene');
  }

  /**
   * 屏幕上方飘一条提示（M13：统一走组件库）
   */
  toast(msg) {
    showToast(this, msg, { y: 60, toY: 20, duration: 1400 });
  }

  /**
   * 英雄和城镇重叠时的选择弹层
   *
   * 两个按钮：控制英雄（选中）/ 进入城镇（或进攻城镇）。
   * 点遮罩只关闭弹层、不执行任何操作 —— 与 confirmDialog 不同，
   * confirmDialog 点遮罩会触发 onCancel，这里需要"点了不做事"。
   *
   * @param {object} hero 己方英雄
   * @param {object} town 所在格的城镇
   */
  showHeroTownChoice(hero, town) {
    const isOwnTown = town.playerId === 0;
    const actionText = isOwnTown ? '进入城镇' : '进攻城镇';
    const CX = 640;
    const CY = 400;
    const W = 520;
    const H = 230;

    const layer = this.add.container(0, 0).setDepth(DEPTH.modal);

    // 遮罩：吞掉点击，点遮罩只关闭弹层
    const shade = this.add.rectangle(CX, CY, 1280, 800, THEME.shade, THEME.shadeAlpha);
    shade.setInteractive();

    // 底板
    const panel = this.add.rectangle(CX, CY, W, H, 0x1a2332, 0.99)
      .setStrokeStyle(2, THEME.panelBorder)
      .setRounded(14);

    // 标题
    const title = this.add.text(CX, CY - 56, `「${hero.name}」在「${town.name}」处`, {
      fontSize: '19px', color: THEME.gold
    }).setOrigin(0.5);
    const hint = this.add.text(CX, CY - 22, '请选择要执行的操作：', {
      fontSize: '15px', color: THEME.light
    }).setOrigin(0.5);

    /** 关闭弹层 */
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.choiceLayer = null;
      layer.destroy(true);
    };

    // 两个并排按钮
    const btnY = CY + 52;
    const btnHero = createButton(this, CX - 110, btnY, '[控制英雄]', () => {
      close();
      this.selectedHero = hero;
      this.drawHeroes();
      this.drawReachable();
      this.drawStatusBar();
    }, { width: 170, height: 42, color: THEME.white, borderColor: THEME.blue, bgColor: THEME.cardBg });
    const btnTown = createButton(this, CX + 110, btnY, `[${actionText}]`, () => {
      close();
      if (isOwnTown) {
        this.scene.start('TownScene', { townId: town.id, heroId: hero.id });
      } else {
        this.scene.start('BattleScene', { attackerId: hero.id, townId: town.id });
      }
    }, { width: 170, height: 42, color: THEME.gold, borderColor: 0xf1c40f, bgColor: THEME.cardBg });

    layer.add([shade, panel, title, hint, btnHero, btnTown]);
    this.choiceLayer = layer;

    // 点遮罩 = 只关闭，不执行任何操作
    shade.on('pointerdown', close);
  }

  /** 鼠标移动 → 路径预览 */
  bindHover() {
    this.input.on('pointermove', (pointer) => {
      this.pathLayer.removeAll(true);
      if (this.moving || !this.selectedHero) return;
      const cell = this.pixelToCell(pointer.x, pointer.y);
      if (!this.reachableCache.has(`${cell.x},${cell.y}`)) return;

      const blocked = occupiedTiles(this.state, this.selectedHero.id);
      const path = findPath(this.state.map, this.selectedHero.pos, cell, blocked);
      this.drawPathPreview(path);
    });
  }

  /** 点击地图：选中英雄 / 寻路移动 */
  bindInput() {
    this.bindHover();

    this.input.on('pointerdown', (pointer, currentlyOver) => {
      if (this.moving) return; // 移动动画中锁定输入

      // ── 防止 UI 点击穿透到地图 ──────────────────────────────
      // 与 BattleScene 同一类问题：Phaser 先对 GameObject 发 pointerdown
      // （面板按钮在这里响应），再对场景发 pointerdown（本处理器）。
      // 不挡住的话，点技能/存档面板里的按钮会被当成"点了地图某格"，
      // 触发英雄寻路移动。
      //   1) 弹层打开时地图点击不响应；
      //   2) 落点上有可交互对象时不穿透（兜住"点按钮刚关掉面板"的那次点击）。
      if (this.skillPanel || this.savePanel || this.choiceLayer) return;
      if (currentlyOver && currentlyOver.length > 0) return;

      const cell = this.pixelToCell(pointer.x, pointer.y);
      const { width, height } = this.state.map;
      if (cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height) return;

      // ── 英雄和城镇重叠 → 弹出选择框 ──────────────────────────
      // 点到的格子上既有己方英雄又有城镇时，弹出选项让玩家决定：
      // 控制英雄（选中）还是进城 / 攻城。点遮罩只关闭弹层、不执行操作。
      const townHere = this.state.towns.find((t) => t.pos.x === cell.x && t.pos.y === cell.y);
      const ownHeroHere = this.state.heroes.find(
        (h) => h.playerId === 0 && h.pos.x === cell.x && h.pos.y === cell.y
      );
      if (townHere && ownHeroHere) {
        this.showHeroTownChoice(ownHeroHere, townHere);
        return;
      }

      // 点击己方英雄 → 切换选中
      const clickedHero = this.state.heroes.find((h) => h.pos.x === cell.x && h.pos.y === cell.y);
      if (clickedHero && clickedHero.playerId === 0) {
        this.selectedHero = clickedHero;
        this.drawHeroes();
        this.drawReachable();
        this.drawStatusBar();
        return;
      }

      if (!this.selectedHero) return;

      // 寻路移动（逻辑在 M2）
      const res = moveHero(this.state, this.selectedHero.id, cell);
      if (!res.ok) {
        const msg = {
          noPath: '此路不通',
          notEnoughMove: '行动力不足',
          noHero: '未找到英雄'
        }[res.reason] || '无法移动';
        this.toast(msg);
        return;
      }

      this.drawStatusBar();
      this.animateMove(this.selectedHero, res.path);
    });
  }

  /**
   * 沿路径逐格移动英雄（每格 100ms），结束后触发格子交互
   * @param {object} hero
   * @param {Array<{x:number,y:number}>} path
   */
  async animateMove(hero, path) {
    this.moving = true;
    this.pathLayer.removeAll(true);
    for (const step of path) {
      const { px, py } = this.cellToPixel(step.x, step.y);
      await new Promise((resolve) => {
        this.tweens.add({
          targets: this.heroSprites.get(hero.id),
          x: px, y: py,
          duration: 100,
          ease: 'Linear',
          onComplete: resolve
        });
      });
      this.displayPos.set(hero.id, { ...step });
    }
    this.moving = false;
    this.displayPos.set(hero.id, { ...hero.pos });
    this.redraw();
    this.handleInteraction(hero);
  }

  /**
   * 移动完成后触发格子交互
   * @param {object} hero
   */
  handleInteraction(hero) {
    const inter = checkTileInteraction(this.state, hero.pos);
    if (!inter) return;

    switch (inter.type) {
      case 'resource': {
        const res = pickUpResource(this.state, hero.id, hero.pos);
        if (res.ok) {
          const names = RES_NAMES;
          this.toast(`获得 ${res.amount} ${names[res.resource] || res.resource}`);
          this.drawResources();
          this.drawStatusBar();
        }
        break;
      }
      case 'ownTown':
        this.scene.start('TownScene', { townId: inter.town.id, heroId: hero.id });
        break;
      case 'enemyHero':
        this.toast(`遭遇 ${inter.hero.name}！`);
        this.scene.start('BattleScene', { attackerId: hero.id, defenderId: inter.hero.id });
        break;
      case 'enemyTown':
        this.toast(`进攻 ${inter.town.name}！`);
        this.scene.start('BattleScene', { attackerId: hero.id, townId: inter.town.id });
        break;
      default:
        break;
    }
  }

  /** 结束回合：交给 M4 逻辑处理 */
  endTurn() {
    if (this.state.meta.currentPlayer !== 0) {
      this.toast('电脑正在行动');
      return;
    }
    endTurnLogic(this.state, this.data);
    this.redraw();
  }

  /**
   * 回合开始回调：轮到电脑时驱动 AI（M11）
   * AI 行动结束后自动继续推进回合，直到轮到玩家或游戏结束
   * @param {{playerId:number}} payload
   */
  onTurnStart(payload) {
    const player = this.state.players.find((p) => p.id === payload.playerId);
    this.drawStatusBar();
    if (!player?.isAI) {
      this.aiTurnGuard = 0; // 回到玩家回合，重置保护计数
      return;
    }
    // 电脑回合开始：等一小会儿再动，让玩家看清"电脑行动中"的提示
    this.scheduleAiTurn();
  }

  // ══════════════════════════════════════════════
  // M11 · 电脑回合驱动
  // ══════════════════════════════════════════════

  /**
   * 开始（或继续）电脑回合
   *
   * 用 M11 的「规划层 / 执行层」两段式：
   *   1. planMapTurn 算出整回合的行动序列（纯函数，不改状态）
   *   2. executeMapStep 逐步执行，每步之间留动画时间
   *
   * 遇到战斗步骤时**停下**：战斗要切到 BattleScene，
   * 战斗结算完再由 MapScene 重建时用 registry 里的续跑信息接着跑剩下的英雄。
   *
   * @param {object} [resume]
   *   skipHeroIds  已行动过的英雄（重规划时跳过）
   *   skipCity     城务是否已做过
   *   moveCalls    本回合已用掉的移动次数（上限保护要跨战斗累计）
   */
  startAiTurn(resume = {}) {
    if (this.aiPlaying) return; // 防重入
    if (this.state.gameOver) return;

    const playerId = this.state.meta.currentPlayer;
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player?.isAI) return; // 不是电脑回合（不该发生，防御性返回）

    this.aiPlaying = true;
    this.aiSkipHeroIds = new Set(resume.skipHeroIds || []);
    this.aiCityDone = !!resume.skipCity;
    this.aiMoveCalls = resume.moveCalls || 0;

    const steps = planMapTurn(this.state, this.data, playerId, {
      skipHeroIds: [...this.aiSkipHeroIds],
      skipCity: this.aiCityDone
    });

    this.aiSteps = steps;
    this.aiCursor = 0;

    this.drawStatusBar();
    this.playNextAiStep();
  }

  /**
   * 执行行动序列的下一步（逐步播放，步与步之间留动画时间）
   */
  playNextAiStep() {
    if (!this.aiPlaying) return;
    if (this.state.gameOver) {
      this.finishAiTurn();
      return;
    }

    // 序列走完 → 收尾
    if (this.aiCursor >= this.aiSteps.length) {
      this.finishAiTurn();
      return;
    }

    const step = this.aiSteps[this.aiCursor];
    this.aiCursor += 1;

    // 城务做完就标记（战斗返回后重规划不再做城务）
    if (step.group === 'city') this.aiCityDone = true;

    // ── 移动 ──
    if (step.type === 'move') {
      // 验收 3：单回合最多 100 次移动调用，超出强制停止
      if (this.aiMoveCalls >= MAX_MOVE_CALLS) {
        this.toast('电脑行动已达上限，停止移动');
        this.aiSteps = [];
        this.aiCursor = 0;
        this.finishAiTurn();
        return;
      }
      this.aiMoveCalls += 1;

      const r = executeMapStep(this.state, this.data, step);
      if (!r.ok) {
        // 这一步失败 → 跳过该英雄剩余步骤
        this.skipGroupRemain(step);
        this.time.delayedCall(60, () => this.playNextAiStep());
        return;
      }

      const hero = this.state.heroes.find((h) => h.id === step.heroId);
      if (hero) {
        this.animateHeroStep(hero, r.from, r.to).then(() => {
          this.time.delayedCall(20, () => this.playNextAiStep());
        });
        return;
      }
      this.time.delayedCall(20, () => this.playNextAiStep());
      return;
    }

    // ── 捡资源 ──
    if (step.type === 'pickup') {
      const r = executeMapStep(this.state, this.data, step);
      if (r.ok) {
        const names = RES_NAMES;
        this.toast(`电脑拾取 ${r.amount} ${names[r.resource] || r.resource}`);
        this.drawResources();
        this.drawStatusBar();
      }
      this.time.delayedCall(180, () => this.playNextAiStep());
      return;
    }

    // ── 建造 ──
    if (step.type === 'build') {
      const r = executeMapStep(this.state, this.data, step);
      if (r.ok) {
        const b = this.data.buildings.find((x) => x.id === step.buildingId);
        this.toast(`电脑建成了 ${b?.name || step.buildingId}`);
        this.drawStatusBar();
      }
      this.time.delayedCall(180, () => this.playNextAiStep());
      return;
    }

    // ── 招募 ──
    if (step.type === 'recruit') {
      const r = executeMapStep(this.state, this.data, step);
      if (r.ok) {
        const u = this.data.units.find((x) => x.id === step.unitId);
        this.toast(`电脑招募 ${step.count} 名${u?.name || step.unitId}`);
        this.drawStatusBar();
      }
      this.time.delayedCall(180, () => this.playNextAiStep());
      return;
    }

    // ── 战斗：切场景 ──
    if (step.type === 'battle') {
      const r = executeMapStep(this.state, this.data, step);
      if (!r.ok) {
        this.skipGroupRemain(step);
        this.time.delayedCall(60, () => this.playNextAiStep());
        return;
      }
      this.startAiBattle(step);
      return;
    }

    // 未知步骤 → 直接跳过
    this.time.delayedCall(20, () => this.playNextAiStep());
  }

  /**
   * 当前步骤失败 → 跳过同一组（同一英雄）剩下的所有步骤
   *
   * 用 group 而不是 heroId 判断边界：城务步骤的 group 是 'city'，
   * 英雄步骤的 group 是 heroId，两者不会混在一起。
   *
   * @param {object} step 刚执行完的步骤
   */
  skipGroupRemain(step) {
    const group = step.group;
    if (group === undefined) return;
    while (this.aiCursor < this.aiSteps.length && this.aiSteps[this.aiCursor].group === group) {
      this.aiCursor += 1;
    }
  }

  /**
   * 单格移动动画（电脑回合用）
   *
   * 与玩家版的 animateMove 不同：这里每次只走一格，且**不触发格子交互**
   * （战斗由计划里的 battle 步骤显式触发，不靠走到格子上的副作用）。
   *
   * @param {object} hero
   * @param {{x:number,y:number}} from
   * @param {{x:number,y:number}} to
   * @returns {Promise<void>}
   */
  animateHeroStep(hero, from, to) {
    return new Promise((resolve) => {
      const sprite = this.heroSprites.get(hero.id);
      const { px, py } = this.cellToPixel(to.x, to.y);
      if (!sprite) {
        this.displayPos.set(hero.id, { ...to });
        resolve();
        return;
      }
      this.tweens.add({
        targets: sprite,
        x: px, y: py,
        duration: 110,
        ease: 'Linear',
        onComplete: () => {
          this.displayPos.set(hero.id, { ...to });
          this.redraw();
          resolve();
        }
      });
    });
  }

  /**
   * 电脑发起战斗 → 切到 BattleScene
   *
   * 战斗结束后 MapScene 会被重新创建（scene.start('MapScene')），
   * 这时要接着跑剩下的英雄，所以先把续跑信息存进 registry。
   *
   * @param {object} step battle 步骤
   */
  startAiBattle(step) {
    this.aiPlaying = false;

    // ── 算出哪些英雄已经完整行动过 ──
    // 战斗步骤一定是它所属那一组的最后一步（打得过就打 / 攻城都是
    // 「先走完路，最后一步开打」），所以「该组最后一步的下标 < 当前游标」
    // 就等价于「这个英雄已经行动完了」。
    //
    // ⚠️ 城务组（group === 'city'）不参与判断：城务里可能也有某个英雄的
    //    移动（回城补兵），但那不代表它的战术回合也做完了。
    const groupLastIndex = new Map();
    this.aiSteps.forEach((s, i) => {
      if (s.group && s.group !== 'city') groupLastIndex.set(s.group, i);
    });

    const skipHeroIds = [...this.aiSkipHeroIds];
    for (const [heroId, lastIdx] of groupLastIndex) {
      if (lastIdx < this.aiCursor && !skipHeroIds.includes(heroId)) {
        skipHeroIds.push(heroId);
      }
    }

    this.registry.set(AI_RESUME_KEY, {
      skipHeroIds,
      skipCity: this.aiCityDone,
      moveCalls: this.aiMoveCalls
    });

    const target = step.targetType === 'town'
      ? this.state.towns.find((t) => t.id === step.targetId)
      : this.state.heroes.find((h) => h.id === step.targetId);

    if (step.targetType === 'town') {
      this.toast(`电脑进攻 ${target?.name || '城镇'}！`);
      this.scene.start('BattleScene', { attackerId: step.heroId, townId: step.targetId });
    } else {
      this.toast(`电脑向 ${target?.name || '武将'} 发起进攻！`);
      this.scene.start('BattleScene', { attackerId: step.heroId, defenderId: step.targetId });
    }
  }

  /**
   * 电脑回合结束 → 把回合交还给玩家
   *
   * ⚠️ endTurnLogic 会切到下一个玩家（电脑 → 玩家）并推进日期。
   *    战斗中断后回到 MapScene 续跑时，也走这里收尾，
   *    保证「一个电脑回合只 endTurn 一次」。
   */
  finishAiTurn() {
    this.aiPlaying = false;
    this.aiSteps = [];
    this.aiCursor = 0;
    this.redraw();

    if (this.state.gameOver) return;

    endTurnLogic(this.state, this.data);
  }

  /** 游戏结束提示 */
  onGameOver(result) {
    const winner = this.state.players.find((p) => p.id === result.winnerId);
    this.toast(`战局已定：${winner?.faction === 'shu' ? '蜀汉' : '曹魏'}获胜（${result.reason}）`);
  }

  /** 重画所有动态层 */
  redraw() {
    this.drawHeroes();
    this.drawReachable();
    this.drawStatusBar();
  }
}

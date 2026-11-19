import Phaser from 'phaser';
import bus from '../core/EventBus.js';
import { availableBuildings, construct, recruit, recruitOptions, formatCost } from '../logic/townLogic.js';
import { openSkillPanel } from './ui/skillPanel.js';
import { toast as showToast, createCounter, RES_NAMES } from './ui/components.js';

/**
 * TownScene —— 城镇场景（M5：城建与招募）
 *
 * 布局（1280×800）：
 *   ┌──────────────────────────────────────┐
 *   │ 成都 第1周第1天  资源…      [返回地图] │
 *   ├───────────────┬──────────────────────┤
 *   │ 建筑列表       │ 招募面板               │
 *   │ ✅大本营       │ 乡勇 攻2防2血6  余20   │
 *   │ ⬜内政厅 5000金 │ 单价40金 [-] 10 [+] [招募]│
 *   ├───────────────┴──────────────────────┤
 *   │ 英雄军队：乡勇×50 | 弓手×20           │
 *   └──────────────────────────────────────┘
 *
 * 规则全部来自 src/logic/townLogic.js，本场景只负责显示与调用。
 */

/** 顶栏高度 */
const HEADER_H = 56;
/** 左面板 x 起点与宽度 */
const LEFT_X = 16;
const LEFT_W = 500;
/** 右面板 x 起点与宽度 */
const RIGHT_X = 528;
const RIGHT_W = 736;
/** 底栏（军队）y 起点 */
const BOTTOM_Y = 632;
/** 建筑行高 */
const ROW_H = 36;

export default class TownScene extends Phaser.Scene {
  constructor() {
    super('TownScene');
  }

  /** 接收 MapScene 传入的参数 */
  init(params) {
    this.townId = params?.townId || null;
    this.heroId = params?.heroId || null;
  }

  create() {
    this.state = this.registry.get('state');
    this.data = this.registry.get('data');

    this.town = this.state.towns.find((t) => t.id === this.townId);
    this.hero = this.state.heroes.find((h) => h.id === this.heroId)
      || this.state.heroes.find((h) => h.playerId === this.town?.playerId);
    this.player = this.state.players.find((p) => p.id === this.town?.playerId);

    /** 每种兵种的当前招募数量 */
    this.recruitCounts = {};

    // 分层容器
    this.headerLayer = this.add.container(0, 0);
    this.leftLayer = this.add.container(0, 0);
    this.rightLayer = this.add.container(0, 0);
    this.bottomLayer = this.add.container(0, 0);
    this.toastLayer = this.add.container(0, 0);
    /** M8：技能加点面板控制器 */
    this.skillPanel = null;

    this.drawHeader();
    this.drawBuildings();
    this.drawRecruit();
    this.drawArmy();

    // 逻辑层事件 → 界面刷新（场景关闭时解绑，避免监听泄漏）
    this.busOff = [
      bus.on('resource:changed', () => this.refresh()),
      bus.on('day:new', () => this.refresh()),
      bus.on('town:built', () => this.refresh()),
      bus.on('army:changed', () => this.refresh()),
      bus.on('recruit:pool', () => this.refresh())
    ];
    this.events.once('shutdown', () => {
      for (const off of this.busOff || []) off();
      this.busOff = [];
    });
  }

  /** 刷新所有面板 */
  refresh() {
    this.drawHeader();
    this.drawBuildings();
    this.drawRecruit();
    this.drawArmy();
  }

  // ───────────────────────── 顶栏 ─────────────────────────

  drawHeader() {
    this.headerLayer.removeAll(true);
    this.headerLayer.add(this.add.rectangle(640, HEADER_H / 2, 1280, HEADER_H, 0x11111f));

    const title = `${this.town?.name || '城镇'}   第${this.state.meta.week}周 第${this.state.meta.day}天`;
    this.headerLayer.add(this.add.text(20, HEADER_H / 2, title, { fontSize: '20px', color: '#fff' }).setOrigin(0, 0.5));

    const p = this.player;
    const resText = p
      ? `金:${p.gold} 木:${p.wood} 矿:${p.ore} 汞:${p.mercury} 硫:${p.sulfur} 晶:${p.crystal} 宝:${p.gem}`
      : '';
    this.headerLayer.add(this.add.text(240, HEADER_H / 2, resText, { fontSize: '14px', color: '#f1c40f' }).setOrigin(0, 0.5));

    const back = this.add.text(1210, HEADER_H / 2, '[返回地图]', { fontSize: '16px', color: '#f1c40f' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.scene.start('MapScene'));
    this.headerLayer.add(back);
  }

  // ───────────────────────── 建筑列表 ─────────────────────────

  drawBuildings() {
    this.leftLayer.removeAll(true);

    this.leftLayer.add(this.add.rectangle(LEFT_X + LEFT_W / 2, HEADER_H + 300, LEFT_W, 600, 0x1c2b4a, 0.85));
    this.leftLayer.add(this.add.text(LEFT_X + 12, HEADER_H + 22, '建筑', { fontSize: '17px', color: '#fff' }).setOrigin(0, 0.5));

    // 今日建造次数
    const built = this.town?.builtToday || 0;
    this.leftLayer.add(this.add.text(LEFT_X + LEFT_W - 12, HEADER_H + 22, `今日建造 ${built}/1`, {
      fontSize: '13px', color: built >= 1 ? '#e67e22' : '#9ad18b'
    }).setOrigin(1, 0.5));

    const list = availableBuildings(this.state, this.data, this.townId);
    let y = HEADER_H + 46;

    for (const entry of list) {
      const b = entry.building;
      const rowY = y + ROW_H / 2;

      // 行底色：可建造的高亮
      if (entry.buildable) {
        this.leftLayer.add(this.add.rectangle(LEFT_X + LEFT_W / 2, rowY, LEFT_W - 16, ROW_H - 4, 0x2ecc71, 0.14));
      }

      // 建筑名
      const nameColor = entry.built ? '#7f8c8d' : entry.buildable ? '#fff' : '#bdc3c7';
      this.leftLayer.add(this.add.text(LEFT_X + 22, rowY, b.name, { fontSize: '14px', color: nameColor }).setOrigin(0, 0.5));

      // 花费
      const costText = formatCost(b.cost);
      if (costText) {
        this.leftLayer.add(this.add.text(LEFT_X + 150, rowY, costText, { fontSize: '12px', color: '#f39c12' }).setOrigin(0, 0.5));
      }

      // 右侧状态 / 建造按钮
      const status = this.buildingStatus(entry);
      const btn = this.add.text(LEFT_X + LEFT_W - 24, rowY, status.text, { fontSize: '13px', color: status.color })
        .setOrigin(1, 0.5);
      if (entry.buildable) {
        btn.setInteractive({ useHandCursor: true })
          .on('pointerdown', () => this.onBuild(entry.building.id));
      }
      this.leftLayer.add(btn);

      y += ROW_H;
    }
  }

  /**
   * 建筑行的状态文案与颜色
   * @param {object} entry availableBuildings 的单项
   * @returns {{text:string, color:string}}
   */
  buildingStatus(entry) {
    switch (entry.reason) {
      case 'built':
        return { text: '✓ 已建', color: '#2ecc71' };
      case 'requireNotMet': {
        const names = (entry.missing || []).map((id) => {
          const b = this.data.buildings.find((x) => x.id === id);
          return b ? b.name : id;
        });
        return { text: `需 ${names.join('/')}`, color: '#95a5a6' };
      }
      case 'excluded':
        return { text: '互斥', color: '#e67e22' };
      case 'noResource':
        return { text: '资源不足', color: '#e74c3c' };
      case 'alreadyBuiltToday':
        return { text: '今日已建满', color: '#95a5a6' };
      default:
        return { text: '[建造]', color: '#f1c40f' };
    }
  }

  /** 点击建造 */
  onBuild(buildingId) {
    const res = construct(this.state, this.data, this.townId, buildingId);
    if (res.ok) {
      const b = this.data.buildings.find((x) => x.id === buildingId);
      this.toast(`建成 ${b?.name || buildingId}`);
    } else {
      this.toast(this.reasonText(res.reason));
    }
    this.refresh();
  }

  // ───────────────────────── 招募面板 ─────────────────────────

  drawRecruit() {
    this.rightLayer.removeAll(true);
    this.rightLayer.add(this.add.rectangle(RIGHT_X + RIGHT_W / 2, HEADER_H + 300, RIGHT_W, 600, 0x1c2b4a, 0.85));
    this.rightLayer.add(this.add.text(RIGHT_X + 12, HEADER_H + 22, '招募', { fontSize: '17px', color: '#fff' }).setOrigin(0, 0.5));

    const options = recruitOptions(this.state, this.data, this.townId);
    if (options.length === 0) {
      this.rightLayer.add(this.add.text(RIGHT_X + 12, HEADER_H + 60, '本城暂无可招募兵种（需先建造招募建筑）', {
        fontSize: '14px', color: '#95a5a6'
      }).setOrigin(0, 0.5));
      return;
    }

    let y = HEADER_H + 46;
    for (const opt of options) {
      this.drawRecruitRow(opt, y);
      y += 92;
    }
  }

  /**
   * 画一条兵种招募行
   * @param {object} opt recruitOptions 的单项
   * @param {number} y 顶部 y
   */
  drawRecruitRow(opt, y) {
    const u = opt.unit;
    const cardH = 84;

    this.rightLayer.add(this.add.rectangle(RIGHT_X + RIGHT_W / 2, y + cardH / 2, RIGHT_W - 16, cardH, 0x24365c, 0.9));

    // 兵种名
    this.rightLayer.add(this.add.text(RIGHT_X + 24, y + 18, u.name, { fontSize: '15px', color: '#fff' }).setOrigin(0, 0.5));

    // 属性
    const attrs = `攻${u.attack} 防${u.defense} 血${u.hp} 速${u.speed} 伤${u.damageMin}-${u.damageMax} 移${u.moveRange}`;
    this.rightLayer.add(this.add.text(RIGHT_X + 130, y + 18, attrs, { fontSize: '12px', color: '#9fb3d8' }).setOrigin(0, 0.5));

    // 等级与特性
    const tierText = `T${u.tier}${u.abilities.length ? '  ' + u.abilities.join('/') : ''}`;
    this.rightLayer.add(this.add.text(RIGHT_X + 400, y + 18, tierText, { fontSize: '12px', color: '#9fb3d8' }).setOrigin(0, 0.5));

    // 单价与产量
    const canAfford = this.canAffordUnit(opt.unitCost, 1);
    this.rightLayer.add(this.add.text(RIGHT_X + 24, y + 40, `单价 ${opt.costText}`, {
      fontSize: '12px', color: canAfford ? '#f39c12' : '#e74c3c'
    }).setOrigin(0, 0.5));
    this.rightLayer.add(this.add.text(RIGHT_X + 130, y + 40, `本周产量 余${opt.poolCount}`, {
      fontSize: '12px', color: '#2ecc71'
    }).setOrigin(0, 0.5));

    // 数量步进器（M13：用组件库的 createCounter，局部更新不再整行重绘）
    const maxAffordable = this.maxAffordableCount(opt);
    const cur = Math.min(this.recruitCounts[u.id] ?? 1, Math.max(1, maxAffordable));
    this.recruitCounts[u.id] = cur;

    // 单价行右侧显示总价（随数量变化）
    const totalText = this.add.text(RIGHT_X + 240, y + 40, '', {
      fontSize: '12px', color: '#f39c12'
    }).setOrigin(0, 0.5);

    // 招募按钮（资源不足置灰不可点）
    const btnLabel = this.add.text(RIGHT_X + RIGHT_W - 40, y + 62, '[招募]', {
      fontSize: '14px', color: '#2ecc71'
    }).setOrigin(0.5);

    /**
     * 根据当前数量刷新总价与招募按钮的可用态
     * @param {number} n
     */
    const refreshRow = (n) => {
      const totalCost = this.scaleCost(opt.unitCost, n);
      const affordable = this.canAffordUnit(totalCost, n) && n <= opt.poolCount;
      const costText = Object.entries(totalCost)
        .map(([res, amount]) => `${amount}${RES_NAMES[res] || res}`)
        .join(' ');
      totalText.setText(costText ? `合计 ${costText}` : '');
      totalText.setColor(affordable ? '#f39c12' : '#e74c3c');
      btnLabel.setText(affordable ? '[招募]' : '资源不足');
      btnLabel.setColor(affordable ? '#2ecc71' : '#7f8c8d');
      if (affordable) {
        if (!btnLabel.input) btnLabel.setInteractive({ useHandCursor: true });
        btnLabel.removeAllListeners('pointerdown');
        btnLabel.on('pointerdown', () => this.onRecruit(u.id, n));
      } else if (btnLabel.input) {
        btnLabel.disableInteractive();
      }
    };

    const counter = createCounter(this, RIGHT_X + 425, y + 62, 1, Math.max(1, maxAffordable), cur, (n) => {
      this.recruitCounts[u.id] = n;
      refreshRow(n);
    }, { width: 150, step: 1 });
    this.rightLayer.add(counter);

    refreshRow(cur);

    this.rightLayer.add([totalText, btnLabel]);
  }

  /**
   * 当前资源最多能招多少个（受产量与资源双重限制）
   * @param {object} opt
   * @returns {number}
   */
  maxAffordableCount(opt) {
    let n = opt.poolCount;
    for (const [res, price] of Object.entries(opt.unitCost || {})) {
      const have = this.player?.[res] || 0;
      n = Math.min(n, Math.floor(have / price));
    }
    return Math.max(0, n);
  }

  /**
   * 按数量计算总价
   * @param {object} unitCost
   * @param {number} n
   * @returns {object}
   */
  scaleCost(unitCost, n) {
    const cost = {};
    for (const [res, price] of Object.entries(unitCost || {})) cost[res] = price * n;
    return cost;
  }

  /**
   * 资源是否够
   * @param {object} cost
   * @param {number} n
   * @returns {boolean}
   */
  canAffordUnit(cost, n) {
    const scaled = this.scaleCost(cost, n);
    for (const [res, amount] of Object.entries(scaled)) {
      if ((this.player?.[res] || 0) < amount) return false;
    }
    return true;
  }

  /** 点击招募 */
  onRecruit(unitId, count) {
    const res = recruit(this.state, this.data, this.townId, this.heroId, unitId, count);
    if (res.ok) {
      const u = this.data.units.find((x) => x.id === unitId);
      this.toast(`招募 ${u?.name || unitId} ×${count}`);
    } else {
      this.toast(this.reasonText(res.reason));
    }
    this.refresh();
  }

  // ───────────────────────── 军队 ─────────────────────────

  drawArmy() {
    this.bottomLayer.removeAll(true);
    this.bottomLayer.add(this.add.rectangle(640, BOTTOM_Y + 84, 1280, 168, 0x16213e, 0.95));
    this.bottomLayer.add(this.add.text(20, BOTTOM_Y + 22, '英雄军队', { fontSize: '16px', color: '#fff' }).setOrigin(0, 0.5));

    const hero = this.hero;
    if (!hero) {
      this.bottomLayer.add(this.add.text(110, BOTTOM_Y + 22, '（无英雄）', { fontSize: '14px', color: '#95a5a6' }).setOrigin(0, 0.5));
      return;
    }

    this.bottomLayer.add(this.add.text(110, BOTTOM_Y + 22, `${hero.name}`, { fontSize: '14px', color: '#f1c40f' }).setOrigin(0, 0.5));

    // M8：等级 / 经验 / 技能一览
    const pending = hero.pendingLevels || 0;
    const lvText = `Lv.${hero.level || 1}  经验 ${hero.exp || 0}/${this.expToNext(hero)}`;
    this.bottomLayer.add(this.add.text(220, BOTTOM_Y + 22, lvText, {
      fontSize: '13px', color: '#9fb3d8'
    }).setOrigin(0, 0.5));

    const skillText = this.skillSummary(hero);
    this.bottomLayer.add(this.add.text(430, BOTTOM_Y + 22, skillText, {
      fontSize: '13px', color: '#8fd694'
    }).setOrigin(0, 0.5));

    // M8：待分配技能点 → 显示加点按钮
    if (pending > 0) {
      this.bottomLayer.add(this.add.text(1200, BOTTOM_Y + 22, `[技能加点 · ${pending} 次]`, {
        fontSize: '14px', color: '#2ecc71'
      })
        .setOrigin(1, 0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.openSkillPanel(hero.id)));
    }

    const army = hero.army || [];
    if (army.length === 0) {
      this.bottomLayer.add(this.add.text(20, BOTTOM_Y + 60, '（无兵）', { fontSize: '14px', color: '#95a5a6' }).setOrigin(0, 0.5));
      return;
    }

    // 军队条目横排（7 格上限，最多 7 行 2 列，这里单列排布）
    let x = 20;
    let y = BOTTOM_Y + 56;
    for (const a of army) {
      const u = this.data.units.find((t) => t.id === a.unitId);
      const label = `${u?.name || a.unitId}×${a.count}`;
      const text = this.add.text(x, y, label, { fontSize: '14px', color: '#d5e1f2' }).setOrigin(0, 0.5);
      this.bottomLayer.add(text);
      x += text.width + 26;
      if (x > 1150) {
        x = 20;
        y += 28;
      }
    }
  }

  /**
   * 距下一级所需经验
   * @param {object} hero
   * @returns {number}
   */
  expToNext(hero) {
    const lv = Math.max(1, hero.level || 1);
    return lv * lv * 100;
  }

  /**
   * 已学技能一览（如「统帅2 弓术1」）
   * @param {object} hero
   * @returns {string}
   */
  skillSummary(hero) {
    const skills = hero.skills || {};
    const parts = [];
    for (const [id, lv] of Object.entries(skills)) {
      if (!lv) continue;
      const def = this.data.skills.find((s) => s.id === id);
      parts.push(`${def?.name || id}${lv}`);
    }
    return parts.length > 0 ? `技能：${parts.join(' ')}` : '技能：无';
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
        this.refresh();
      }
    });
  }

  // ───────────────────────── 提示 ─────────────────────────

  /** 失败原因转中文 */
  reasonText(reason) {
    const map = {
      notFound: '找不到目标',
      wrongFaction: '不属于本阵营',
      alreadyBuilt: '已经建过了',
      requireNotMet: '前置建筑未满足',
      excluded: '与已有建筑互斥',
      alreadyBuiltToday: '本城今日建造次数已用完',
      noResource: '资源不足',
      heroNotFound: '找不到英雄',
      heroNotInTown: '英雄不在城镇中',
      wrongOwner: '不是本城的英雄',
      notAvailable: '本城未建造对应招募建筑',
      invalidCount: '数量无效',
      poolEmpty: '本周产量不足',
      armyFull: '军队兵种已满 7 格'
    };
    return map[reason] || '操作失败';
  }

  /** 屏幕上方飘一条提示 */
  /**
   * 城镇提示（M13：统一走组件库）
   * 提示挂到 toastLayer，跟着城镇界面一起销毁
   */
  toast(msg) {
    const t = showToast(this, msg, { y: 72, toY: 32, duration: 1400 });
    this.toastLayer.add(t);
  }
}

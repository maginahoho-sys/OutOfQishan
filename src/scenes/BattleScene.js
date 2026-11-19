import Phaser from 'phaser';
import bus from '../core/EventBus.js';
import {
  startBattle,
  currentStack,
  currentActionableStack,
  nextTurn,
  movableCells,
  moveStack,
  attackStack,
  attackableTargets,
  cellsInRange,
  hasAbility,
  isEngaged,
  isOutOfRange,
  stackRange,
  resolveBattle,
  BATTLE_WIDTH,
  BATTLE_HEIGHT
} from '../logic/battleLogic.js';
import { planTurn, executeStep, summarizeAction, aiCastSpell } from '../logic/battleAI.js';
import { openSkillPanel } from './ui/skillPanel.js';
import { openSpellPanel } from './ui/spellPanel.js';
import { toast as showToast } from './ui/components.js';
import { hasArt, pixelSprite } from '../core/pixelArt.js';
import { spellTargets, castSpell, hasCastThisTurn, getSpellDef } from '../logic/magicLogic.js';
import {
  CELL,
  GRID_X,
  GRID_Y,
  cellCenter,
  createUnitView,
  refreshUnitView,
  destroyUnitView
} from './battleView.js';
import {
  floatDamage,
  playAttackLunge,
  playHitShake,
  playMoveTo,
  playSpellAura,
  playHealAura,
  playDeathFade,
  startTurnGlow,
  stopTurnGlow
} from './battleFx.js';

/**
 * 战报可视窗口能显示的行数
 *
 * 行高约 19px（13px 字号 + 3px 行距）。战报内容从 y=664 开始，
 * 要在 800 高度内放下就得 ≤ 7 行（664 + 7×19 = 797）。
 */
const LOG_VISIBLE_LINES = 7;

/**
 * BattleScene —— 战斗场景（M7 正式界面）
 *
 * ── 分层结构 ────────────────────────────────────────────────
 *   gridLayer   战场网格（静态，只画一次）
 *   markLayer   高亮层：可移动格 / 射程覆盖 / 可攻击目标 / 施法目标
 *   unitLayer   兵牌层（**持久化**，见下方说明）
 *   fxLayer     飘字与特效（临时对象，播完自毁）
 *   hudLayer    顶栏 + 操作栏 + 结算面板
 *   logLayer    战报滚动区（独立于 hudLayer，见下方说明）
 *
 * ── 为什么兵牌必须持久化 ────────────────────────────────────
 *   M7 的动画是对 Phaser 显示对象跑 tween。若每次 refresh 都重建兵牌，
 *   tween 的目标会在播放途中被销毁 —— 表现为"单位瞬移""动画不播"。
 *   所以这里为每个 stack 保留一个 UnitView（Map<stackId, view>），
 *   refresh 时只增量更新内容（数量/血条/徽章），不重建对象。
 *
 * ── 为什么战报区要独立一层 ────────────────────────────────
 *   战报需要"滚动到底"且保留滚动位置。若把它放在 hudLayer 里，
 *   每次 refresh（removeAll(true)）都会重建文本，滚动位置与滚动条都会丢。
 *
 * 布局（1280×800）：
 *   顶部 40px   双方名称 + 轮次 + 当前行动单位
 *   中部        11×9 战场网格，每格 64px（GRID_X=288, GRID_Y=60）
 *   底部 160px  左：操作栏（按钮 + 选中信息）　右：战报滚动区
 */
export default class BattleScene extends Phaser.Scene {
  constructor() {
    super('BattleScene');
  }

  init(params) {
    this.params = params || {};
    /** 当前选中的 stack id */
    this.selectedId = null;
    /** 当前高亮的可移动格 */
    this.moveCells = [];
    /** 当前高亮的可攻击目标 */
    this.targetIds = [];
    /** M6c：战果结算结果（战斗结束后写入） */
    this.result = null;
    /** M8：技能加点面板控制器 */
    this.skillPanel = null;
    /** M9：施法面板控制器 */
    this.spellPanel = null;
    /** M9：选目标模式（选完魔法后等玩家点目标） */
    this.castingSpellId = null;
    /** M9：选目标模式下高亮的合法目标 stack id */
    this.castTargetIds = [];

    /** M7：stack id → 兵牌视图（持久化，不随 refresh 重建） */
    this.unitViews = new Map();
    /** M7：当前正在闪金光的兵牌视图（切换时要停掉旧的） */
    this.glowingView = null;
    /** M7：战报是否已经滚到底（用户手动上翻后置 false） */
    this.logStickToBottom = true;
    /** M7：战报文本节点（持久化，不随 refresh 重建） */
    this.logText = null;
    /** M7：战报滚动容器（配合 logText 移动实现滚动） */
    this.logScroll = 0;
    /** M7：AI 行动提示（"电脑方思考中…"） */
    this.aiHintText = null;
    /** M10：AI 行动定时器句柄（防止重复排队） */
    this.aiTimer = null;
    /** M10：AI 是否正在执行行动序列（执行期间不接受新的调度） */
    this.aiBusy = false;
  }

  create() {
    this.state = this.registry.get('state');
    this.data = this.registry.get('data');

    this.add.rectangle(640, 400, 1280, 800, 0x1e2b1e);

    // 发起战斗（布阵 + 建出手队列）
    this.battle = startBattle(this.state, this.data, this.params);
    if (!this.battle) {
      this.add.text(640, 400, '战斗无法发起（参数无效）', { fontSize: '20px', color: '#e74c3c' }).setOrigin(0.5);
      return;
    }

    this.gridLayer = this.add.container(0, 0);
    this.markLayer = this.add.container(0, 0);   // 可移动格 / 射程 / 可攻击目标高亮
    this.unitLayer = this.add.container(0, 0);   // 兵牌（持久化）
    this.fxLayer = this.add.container(0, 0).setDepth(800);  // 飘字与特效
    this.hudLayer = this.add.container(0, 0);    // 顶栏 + 操作栏
    this.logLayer = this.add.container(0, 0);    // 战报滚动区（独立）

    this.drawGrid();
    this.syncUnits();
    this.drawHud();
    this.buildLogPanel();
    this.bindInput();

    this.busOff = [
      bus.on('battle:turn', () => { this.clearSelection(); this.refresh(); this.scheduleAI(); }),
      bus.on('battle:round', () => { this.clearSelection(); this.refresh(); this.scheduleAI(); }),
      bus.on('battle:end', () => { this.clearSelection(); this.settleBattle(); this.refresh(); }),
      bus.on('battle:action', (p) => this.onBattleAction(p)),
      bus.on('battle:move', (p) => this.onBattleMove(p)),
      bus.on('magic:cast', (p) => this.onMagicCast(p))
    ];
    this.events.once('shutdown', () => {
      for (const off of this.busOff || []) off();
      this.busOff = [];
      // 退出战场时清理战斗状态，避免残留脏数据
      this.state.battle = null;
      // 兵牌视图随场景销毁，但保险起见清空映射
      this.unitViews.clear();
    });

    // 开局若轮到电脑方，立即驱动
    this.scheduleAI();

    // 开局即分胜负（如进攻空城）：battle:end 在监听注册前就发过了，补一次结算
    if (this.battle.winner) {
      this.settleBattle();
      this.refresh();
    }
  }

  // ══════════════════════════════════════════════
  // M7 · 兵牌（持久化视图）
  // ══════════════════════════════════════════════

  /**
   * 同步兵牌：按 battle.stacks 的当前状态增删改视图
   *
   * - 新出现的 stack → 建视图
   * - 已存在的 → 增量刷新（数量/血条/徽章），**不重建对象**
   * - count 归零的 → 播淡出动画，动画结束后才销毁
   */
  syncUnits() {
    const cur = currentStack(this.battle);
    const curId = cur ? cur.id : null;
    const alive = new Set();

    for (const s of this.battle.stacks) {
      if (s.count <= 0) continue;
      alive.add(s.id);

      let view = this.unitViews.get(s.id);
      if (!view) {
        view = createUnitView(this, s);
        this.unitLayer.add(view.root);
        this.unitViews.set(s.id, view);
      }
      refreshUnitView(this, view, s, {
        isCurrent: s.id === curId,
        isSelected: s.id === this.selectedId
      });
    }

    // 处理阵亡单位：播淡出，播完再删
    for (const [id, view] of [...this.unitViews.entries()]) {
      if (alive.has(id)) continue;
      if (view.dying) continue; // 已经在淡出中
      const stack = this.battle.stacks.find((x) => x.id === id);
      if (stack && stack.count <= 0) {
        playDeathFade(this, view, () => {
          destroyUnitView(this, view);
          this.unitViews.delete(id);
        });
      } else {
        destroyUnitView(this, view);
        this.unitViews.delete(id);
      }
    }

    // 当前行动单位的金色闪烁描边：跟随 currentStack 切换
    const curView = curId ? this.unitViews.get(curId) : null;
    if (this.glowingView && this.glowingView !== curView) {
      stopTurnGlow(this, this.glowingView);
      this.glowingView = null;
    }
    if (curView && this.glowingView !== curView) {
      startTurnGlow(this, curView);
      this.glowingView = curView;
    }
  }

  /**
   * 攻击事件 → 播攻击动画（攻击方前冲 + 受击方抖动 + 伤害飘字）
   *
   * 事件由 battleLogic.attackStack 在**伤害结算后**发出，
   * 所以这里拿到的是"已经打完了"的战场状态，动画只是回放视觉效果。
   *
   * @param {object} p { attackerId, defenderId, damage, killed, retaliate }
   */
  onBattleAction(p) {
    if (!p) return;
    const atkStack = this.battle.stacks.find((x) => x.id === p.attackerId);
    const defStack = this.battle.stacks.find((x) => x.id === p.defenderId);
    const atkView = this.unitViews.get(p.attackerId);
    const defView = this.unitViews.get(p.defenderId);

    // 攻击方前冲 → 到位瞬间触发伤害飘字与受击抖动
    playAttackLunge(this, atkView, defStack, () => {
      if (defStack) floatDamage(this, defStack, p.damage, p.killed);
      if (defView) playHitShake(this, defView);
    });

    // 反击伤害飘在攻击方头上
    if (p.retaliate && p.retaliate.damage > 0) {
      this.time.delayedCall(260, () => {
        if (atkStack) floatDamage(this, atkStack, p.retaliate.damage, p.retaliate.killed);
        if (atkView) playHitShake(this, atkView);
      });
    }
  }

  /**
   * 移动事件 → 播平移动画
   * @param {object} p { stackId, from, to }
   */
  onBattleMove(p) {
    if (!p) return;
    const view = this.unitViews.get(p.stackId);
    if (!view) return;
    playMoveTo(this, view, p.from, p.to);
  }

  /**
   * 施法事件 → 播光环特效
   * @param {object} p { heroId, spellId, targetStackId, effectDesc }
   */
  onMagicCast(p) {
    if (!p) return;
    const def = getSpellDef(p.spellId);
    const isHeal = def && (def.effect?.type === 'heal' || def.effect?.type === 'resurrect');

    // 群体魔法没有单一目标 → 给全队都画一圈
    const isAoe = def && (def.target === 'allAllies' || def.target === 'allEnemies');
    if (isAoe) {
      // 施法方是哪一边？按英雄反查（攻守都可能施法，不能写死）
      const side = this.battle.attackerHeroId === p.heroId ? 'attacker'
        : this.battle.defenderHeroId === p.heroId ? 'defender'
          : this.humanSide;
      for (const s of this.battle.stacks) {
        if (s.count <= 0) continue;
        const inSet = def.target === 'allAllies' ? s.side === side : s.side !== side;
        if (!inSet) continue;
        if (isHeal) playHealAura(this, s);
        else playSpellAura(this, s);
      }
      return;
    }

    const target = this.battle.stacks.find((x) => x.id === p.targetStackId);
    if (!target) return;
    if (isHeal) playHealAura(this, target);
    else playSpellAura(this, target);
  }

  // ══════════════════════════════════════════════
  // 阵营判定（M11：支持「电脑作为进攻方」）
  // ══════════════════════════════════════════════

  /**
   * 电脑玩家的 id
   *
   * 不写死 1：从 state.players 里找 isAI 的那个。
   * @returns {number}
   */
  get aiPlayerId() {
    const ai = this.state?.players?.find((p) => p.isAI);
    return ai ? ai.id : 1;
  }

  /**
   * 玩家（人类）的 id
   * @returns {number}
   */
  get humanPlayerId() {
    const human = this.state?.players?.find((p) => !p.isAI);
    return human ? human.id : 0;
  }

  /**
   * 玩家（人类）控制的阵营
   *
   * ⚠️ 不能写死 'attacker'：
   *    玩家主动进攻时，玩家是攻方；电脑主动进攻玩家时，玩家是守方。
   *    战斗开始时 battle.attackerPlayerId / defenderPlayerId 已经写好了
   *    双方各属哪个玩家，据此反推玩家在哪一边。
   *
   * @returns {'attacker'|'defender'}
   */
  get humanSide() {
    const b = this.battle;
    const human = this.state?.players?.find((p) => !p.isAI);
    if (!b || !human) return 'attacker';
    return b.attackerPlayerId === human.id ? 'attacker' : 'defender';
  }

  /**
   * 电脑控制的阵营（与 humanSide 相反）
   * @returns {'attacker'|'defender'}
   */
  get aiSide() {
    return this.humanSide === 'attacker' ? 'defender' : 'attacker';
  }

  /**
   * 电脑方的英雄 id（本场战斗里属于 AI 的那个英雄）
   * @returns {string|null}
   */
  get aiHeroId() {
    const b = this.battle;
    if (!b) return null;
    return this.aiSide === 'attacker' ? b.attackerHeroId : b.defenderHeroId;
  }

  /**
   * 现在是否轮到玩家操作
   *
   * 判据：当前行动单位属于玩家。
   * 电脑作为进攻方时，出手队列里可能先轮到电脑，
   * 这段时间玩家不该能点[待命]/[防御]/[施法]把电脑这一手抢掉。
   *
   * @returns {boolean}
   */
  isHumanTurn() {
    const cur = currentStack(this.battle);
    if (!cur) return false;
    return cur.playerId === this.humanPlayerId;
  }

  // ══════════════════════════════════════════════
  // 回合驱动
  // ══════════════════════════════════════════════

  /**
   * 若当前行动单位属于电脑方，延时驱动 AI 行动。
   *
   * M10：AI 的行动拆成「规划 → 逐步执行」两段：
   *   planTurn() 只算不做事（纯函数），拿到行动序列；
   *   再逐步 executeStep()，每步之间留出动画时间。
   *   这样移动补间播完才播前冲动画，不会两个 tween 叠在同一块兵牌上。
   *
   * ⚠️ 加锁原因：nextTurn() 内部会 emit 'battle:turn'，那个监听器也会调
   *    scheduleAI()。若本方法再显式调一次，就会排两个定时器，
   *    导致同一个 AI 单位被行动两次（或跳过单位）。
   *    所以用 aiTimer / aiBusy 做互斥。
   */
  scheduleAI() {
    if (this.aiTimer || this.aiBusy) return;

    const cur = currentStack(this.battle);
    if (!cur) return;
    // ⚠️ 用 stack.playerId 判断归属，不看 side：
    //    电脑可能是攻方也可能是守方（玩家主动打它时它是守方）。
    const aiPlayerId = this.aiPlayerId;
    if (cur.playerId !== aiPlayerId) return;

    this.showAiHint(true);
    this.aiTimer = this.time.delayedCall(450, () => {
      this.aiTimer = null;
      if (!this.battle || this.battle.winner) {
        this.showAiHint(false);
        return;
      }
      const c = currentStack(this.battle);
      if (!c) {
        this.showAiHint(false);
        return;
      }

      // M9：电脑方每轮至多施法一次（在单位行动之前）
      this.aiCast();

      // M10：先规划，再逐步执行
      const steps = planTurn(this.battle, this.data, c.id);
      this.aiBusy = true;
      this.playAiSteps(steps, c.id, summarizeAction(steps));
    });
  }

  /**
   * 逐步执行 AI 的行动序列（每步之间留动画时间）
   *
   * @param {Array<object>} steps planTurn 返回的行动序列
   * @param {string} stackId 行动者 stack id
   * @param {string} action 概括动作（传给 nextTurn 写战报）
   */
  playAiSteps(steps, stackId, action = 'wait') {
    const list = steps || [];
    let i = 0;

    const stepNext = () => {
      if (!this.battle || this.battle.winner) {
        this.finishAiTurn(stackId, action);
        return;
      }
      if (i >= list.length) {
        this.finishAiTurn(stackId, action);
        return;
      }

      const step = list[i];
      i += 1;
      const r = executeStep(this.battle, this.data, step);
      this.refresh();

      if (!r.ok) {
        // 这一步失败（比如目标已被打死）→ 直接收尾
        this.finishAiTurn(stackId, action);
        return;
      }

      // 攻击后多停一下，让受击抖动和飘字播完
      const delay = step.type === 'attack' ? 620 : step.type === 'move' ? 300 : 120;
      this.time.delayedCall(delay, stepNext);
    };

    stepNext();
  }

  /**
   * AI 的行动序列播完 → 推进回合并继续驱动下一个 AI 单位
   * @param {string} stackId
   * @param {string} action 概括动作（'attack'/'move'/'defend'/'wait'）
   */
  finishAiTurn(stackId, action = 'wait') {
    this.aiBusy = false;
    if (!this.battle) return;

    // 先收起本轮的提示（下一轮 scheduleAI 会重新点亮）
    this.showAiHint(false);

    // 推进到下一个单位。nextTurn 内部会 emit 'battle:turn'，
    // 那个监听器会调 scheduleAI() → 排下一个 AI 单位的定时器。
    nextTurn(this.battle, { action });

    this.refresh();

    // 兜底：若 nextTurn 因为战斗结束没 emit 事件，这里再调一次（幂等，有锁）
    this.scheduleAI();
  }

  /**
   * 显示/隐藏"电脑方思考中…"提示
   * @param {boolean} show
   */
  showAiHint(show) {
    if (show) {
      if (!this.aiHintText) {
        this.aiHintText = this.add.text(640, 626, '', {
          fontSize: '14px',
          color: '#f39c12',
          background: '#000000',
          padding: { x: 8, y: 3 }
        }).setOrigin(0.5).setDepth(700);
      }
      this.aiHintText.setText('电脑方思考中…');
      this.aiHintText.setVisible(true);
      // 轻微呼吸动画，让玩家知道电脑在动
      this.tweens.killTweensOf(this.aiHintText);
      this.tweens.add({
        targets: this.aiHintText,
        alpha: { from: 1, to: 0.45 },
        duration: 600,
        yoyo: true,
        repeat: -1
      });
    } else if (this.aiHintText) {
      this.tweens.killTweensOf(this.aiHintText);
      this.aiHintText.setVisible(false);
    }
  }

  /**
   * 电脑方施法（M9）
   *
   * 施法失败（没魔法/法力不足/本轮已施法/无好目标）时静默跳过。
   */
  aiCast() {
    // ⚠️ 不能写死 defenderHeroId：电脑主动进攻时它是攻方
    const heroId = this.aiHeroId;
    if (!heroId) return;
    const r = aiCastSpell(this.state, this.data, heroId);
    if (!r.ok) return;
    const hero = this.state?.heroes?.find((h) => h.id === heroId);
    this.toast(`${hero?.name || '电脑'}施放魔法：${r.effectDesc}`);
  }

  /**
   * 战斗结束 → 立即结算战果（M6c）
   */
  settleBattle() {
    if (this.result || !this.battle || !this.battle.winner) return;
    const r = resolveBattle(this.state, this.data);
    if (r.ok) this.result = r;
  }

  /** 清除选中与高亮 */
  clearSelection() {
    this.selectedId = null;
    this.moveCells = [];
    this.targetIds = [];
  }

  /** 重画动态部分 */
  refresh() {
    this.syncUnits();
    this.drawMarks();
    this.drawHud();
    this.updateLog();
  }

  /**
   * 画战场网格
   *
   * M14：优先用像素地表瓦片（64×64，正好一格）；资源缺失时退回棋盘格。
   *
   * ⚠️ 纯铺瓦片会让 11×9 变成一整块草地，**看不出格子在哪**——
   *    战棋里格子边界是刚需（要指认移动范围、射程、站位）。
   *    所以瓦片之上再叠一层：奇偶格轻微明暗交替 + 每格描边。
   */
  drawGrid() {
    if (hasArt(this, 'px_ground_battle')) {
      for (let y = 0; y < BATTLE_HEIGHT; y++) {
        for (let x = 0; x < BATTLE_WIDTH; x++) {
          const t = pixelSprite(this, 'px_ground_battle', GRID_X + x * CELL, GRID_Y + y * CELL, CELL, 0, 0);
          // ⚠️ 必须塞进 gridLayer！
          //    pixelSprite 默认把图加到 scene 顶层，而顶层元素排在所有 layer 容器**之后**
          //    （Phaser 按插入顺序渲染），瓦片会盖住 markLayer 的高亮和 unitLayer 的兵牌。
          if (t) this.gridLayer.add(t);
        }
      }

      // 棋盘感：交替明暗 + 细格线（透明度压得很低，只提示边界，不抢画面）
      const g = this.add.graphics();
      for (let y = 0; y < BATTLE_HEIGHT; y++) {
        for (let x = 0; x < BATTLE_WIDTH; x++) {
          const px = GRID_X + x * CELL;
          const py = GRID_Y + y * CELL;
          g.fillStyle((x + y) % 2 === 0 ? 0xffffff : 0x000000, 0.055);
          g.fillRect(px, py, CELL, CELL);
          g.lineStyle(1, 0x1b2416, 0.5);
          g.strokeRect(px + 0.5, py + 0.5, CELL - 1, CELL - 1);
        }
      }
      this.gridLayer.add(g);
      return;
    }

    // 回退：棋盘格
    const g = this.add.graphics();
    g.lineStyle(1, 0x3a4a3a, 1);
    for (let y = 0; y < BATTLE_HEIGHT; y++) {
      for (let x = 0; x < BATTLE_WIDTH; x++) {
        const px = GRID_X + x * CELL;
        const py = GRID_Y + y * CELL;
        g.fillStyle((x + y) % 2 === 0 ? 0x24301f : 0x1f2a1b, 1);
        g.fillRect(px, py, CELL - 1, CELL - 1);
        g.strokeRect(px, py, CELL - 1, CELL - 1);
      }
    }
    this.gridLayer.add(g);
  }

  /**
   * 画高亮层
   *
   * - 射程覆盖格（选中远程单位时）：黄色半透明
   * - 可移动格：青绿半透明
   * - 可攻击目标：红环（射程内）/ 橙环（超射程，伤害减半）
   * - 施法目标：紫环
   */
  drawMarks() {
    this.markLayer.removeAll(true);

    const sel = this.selectedId ? this.battle.stacks.find((s) => s.id === this.selectedId) : null;

    // 1) 射程覆盖预览（远程单位才有意义）
    if (sel && hasAbility(sel, 'ranged') && stackRange(sel) > 1) {
      for (const c of cellsInRange(sel)) {
        const px = GRID_X + c.x * CELL;
        const py = GRID_Y + c.y * CELL;
        this.markLayer.add(this.add.rectangle(px + CELL / 2, py + CELL / 2, CELL - 2, CELL - 2, 0xf1c40f, 0.14));
      }
    }

    // 2) 可移动格
    for (const c of this.moveCells) {
      const px = GRID_X + c.x * CELL;
      const py = GRID_Y + c.y * CELL;
      this.markLayer.add(this.add.rectangle(px + CELL / 2, py + CELL / 2, CELL - 2, CELL - 2, 0x2ecc71, 0.28));
    }

    // 3) 可攻击目标：射程内红环，超射程橙环（提示伤害减半）
    // ⚠️ add.circle 默认白色实心填充，必须显式传 fillAlpha=0，
    //    否则白色圆盘会盖在兵牌上（半径比兵牌大 4px，会露出一圈白边）
    for (const id of this.targetIds) {
      const s = this.battle.stacks.find((x) => x.id === id);
      if (!s) continue;
      const px = GRID_X + s.pos.x * CELL + CELL / 2;
      const py = GRID_Y + s.pos.y * CELL + CELL / 2;
      const far = sel ? isOutOfRange(sel, s) : false;
      this.markLayer.add(
        this.add.circle(px, py, CELL / 2 - 4, 0xffffff, 0).setStrokeStyle(3, far ? 0xe67e22 : 0xe74c3c)
      );
    }

    // 4) 施法目标标紫环
    for (const id of this.castTargetIds) {
      const s = this.battle.stacks.find((x) => x.id === id);
      if (!s) continue;
      const px = GRID_X + s.pos.x * CELL + CELL / 2;
      const py = GRID_Y + s.pos.y * CELL + CELL / 2;
      this.markLayer.add(
        this.add.circle(px, py, CELL / 2 - 4, 0xffffff, 0).setStrokeStyle(4, 0x9b59b6)
      );
    }
  }

  // ══════════════════════════════════════════════
  // M7 · 顶栏 + 操作栏
  // ══════════════════════════════════════════════

  /** 顶栏 + 底部操作栏 */
  drawHud() {
    this.hudLayer.removeAll(true);
    const b = this.battle;

    const atkHero = this.state.heroes.find((h) => h.id === b.attackerHeroId);
    const defHero = this.state.heroes.find((h) => h.id === b.defenderHeroId);
    const defTown = this.state.towns.find((t) => t.id === b.defenderTownId);

    // ── 顶栏 ──
    // 左右位置固定表示"攻方在左 / 守方在右"（与兵牌配色一致：
    // 攻方红、守方蓝），括号里标注攻守角色。
    // 「我方」标签标在玩家所属的那一边 —— 电脑主动进攻时玩家是守方。
    this.hudLayer.add(this.add.rectangle(640, 20, 1280, 40, 0x11111f));
    const humanSide = this.humanSide;
    const left = atkHero
      ? `${atkHero.name}（攻${humanSide === 'attacker' ? '·我方' : ''}）`
      : '进攻方';
    const right = defHero
      ? `${defHero.name}（守${humanSide === 'defender' ? '·我方' : ''}）`
      : defTown ? `${defTown.name}（守城${humanSide === 'defender' ? '·我方' : ''}）` : '守方';
    this.hudLayer.add(this.add.text(16, 20, left, { fontSize: '16px', color: '#e74c3c' }).setOrigin(0, 0.5));
    this.hudLayer.add(this.add.text(1264, 20, right, { fontSize: '16px', color: '#3498db' }).setOrigin(1, 0.5));

    const cur = currentStack(b);
    const turnText = cur ? `第 ${b.round} 轮 · 轮到 ${cur.unitName}` : `第 ${b.round} 轮`;
    this.hudLayer.add(this.add.text(640, 20, turnText, { fontSize: '16px', color: '#fff' }).setOrigin(0.5));

    // ── 底部操作栏底板（左半边）──
    // 与右侧战报底板对齐（y 630~790）
    this.hudLayer.add(this.add.rectangle(340, 710, 660, 160, 0x16213e, 0.95));

    if (b.winner && !this.result) {
      const text = b.winner === 'draw' ? '两败俱伤！' : `${b.winner === 'attacker' ? '攻方' : '守方'}获胜`;
      this.hudLayer.add(this.add.text(340, 666, text, { fontSize: '24px', color: '#f1c40f' }).setOrigin(0.5));
    }

    // ── 操作按钮 ──
    const btnY = 690;
    if (!b.winner) {
      // ⚠️ 只有轮到玩家行动时按钮才可点：
      //    电脑作为进攻方时，战斗是「电脑先动、玩家后动」，
      //    玩家在电脑回合里点[待命]会把电脑这一手抢掉。
      const canAct = this.isHumanTurn();
      const mkBtn = (x, label, color, onClick) => {
        const t = this.add.text(x, btnY, label, { fontSize: '15px', color })
          .setOrigin(0.5)
          .setInteractive({ useHandCursor: true })
          .on('pointerdown', onClick);
        if (!canAct) t.setAlpha(0.4);
        this.hudLayer.add(t);
        return t;
      };

      mkBtn(40, '[待命]', '#95a5a6', () => {
        if (!this.isHumanTurn()) { this.toast('还没轮到我方行动'); return; }
        this.clearSelection();
        nextTurn(this.battle, { action: 'wait' });
        this.refresh();
      });

      mkBtn(120, '[防御]', '#3498db', () => {
        if (!this.isHumanTurn()) { this.toast('还没轮到我方行动'); return; }
        this.clearSelection();
        nextTurn(this.battle, { action: 'defend' });
        this.refresh();
      });

      // M9：施法按钮
      const hero = this.playerHero;
      const canCastNow = hero && !hasCastThisTurn(b, hero.id);
      const castColor = canCastNow ? '#9b59b6' : '#5d6d80';
      const castLabel = this.castingSpellId ? '[取消施法]' : '[施法]';
      mkBtn(200, castLabel, castColor, () => {
        if (this.castingSpellId) {
          this.cancelCasting();
          return;
        }
        if (!this.isHumanTurn()) { this.toast('还没轮到我方行动'); return; }
        this.openSpellPanel();
      });

      // 攻击按钮：进入"选攻击目标"模式（不用先点单位）
      const atkColor = this.targetIds.length ? '#e74c3c' : '#5d6d80';
      mkBtn(280, '[攻击]', atkColor, () => {
        this.enterAttackMode();
      });
    } else {
      // 战斗结束 → 画战果结算面板
      this.drawResultPanel();
    }

    // ── 选中单位的信息面板 ──
    const sel = this.selectedId ? this.battle.stacks.find((s) => s.id === this.selectedId) : null;
    let hint = b.winner
      ? '战斗结束，点「确定」返回地图'
      : '点我方单位 → 选移动格或攻击目标；点[攻击]直接选目标';

    if (this.castingSpellId) {
      const spellName = getSpellDef(this.castingSpellId)?.name || this.castingSpellId;
      hint = `施法模式：点击紫色高亮的单位施放【${spellName}】（点其他位置取消）`;
    } else if (sel) {
      const ranged = hasAbility(sel, 'ranged');
      const engaged = isEngaged(this.battle, sel);
      const range = stackRange(sel);
      const kind = ranged ? `远程(射程${range})` : `近战(射程${range})`;
      const engagedTip = engaged ? '（被近身，反击减半）' : '';
      const hpText = sel.count > 0 ? `兵${sel.count}` : '';
      const buffText = (sel.buffs || []).length
        ? ` 状态:${sel.buffs.map((bf) => {
          const sign = bf.value > 0 ? '+' : '';
          return `${bf.stat === 'canAct' ? '盲' : bf.stat}${sign}${bf.value}`;
        }).join(' ')}`
        : '';
      hint = `${sel.unitName} ${kind}${engagedTip}　攻${sel.attack} 防${sel.defense} ${hpText} 速${sel.speed} 移${sel.moveRange}${buffText}`;
    }

    this.hudLayer.add(this.add.text(16, 656, hint, {
      fontSize: '12px', color: '#7f8c8d', wordWrap: { width: 620 }
    }).setOrigin(0, 0.5));

    // 施法模式的可取消提示单独放一行（长文案会挤）
    if (this.castingSpellId) {
      this.hudLayer.add(this.add.text(16, 722, '按 [取消施法] 或点击战场空白处退出施法模式', {
        fontSize: '12px', color: '#9b59b6'
      }).setOrigin(0, 0.5));
    }

    // ── 双方兵力对比条（填满左栏底部，同时提供战术信息）──
    const sumSide = (side) => this.battle.stacks
      .filter((x) => x.side === side)
      .reduce((acc, x) => {
        acc.total += x.count;
        acc.init += (x.initialCount ?? x.count);
        return acc;
      }, { total: 0, init: 0 });

    const atkN = sumSide('attacker');
    const defN = sumSide('defender');
    const atkRatio = atkN.init > 0 ? atkN.total / atkN.init : 0;
    const defRatio = defN.init > 0 ? defN.total / defN.init : 0;

    // ⚠️ 「我方 / 敌方」要按玩家实际所在的一边来取，
    //    不能写死攻方=我方：电脑主动进攻时玩家是守方。
    const mine = humanSide === 'attacker' ? atkN : defN;
    const theirs = humanSide === 'attacker' ? defN : atkN;
    const myRatio = humanSide === 'attacker' ? atkRatio : defRatio;
    const theirRatio = humanSide === 'attacker' ? defRatio : atkRatio;

    const barY = 752;
    const barW = 280;
    this.hudLayer.add(this.add.text(16, barY - 14, `我方兵力 ${mine.total}　敌方兵力 ${theirs.total}`, {
      fontSize: '12px', color: '#bdc3c7'
    }).setOrigin(0, 0.5));

    // 我方（红，从左往右）与敌方（蓝，从右往左），共用一条基线
    this.hudLayer.add(this.add.rectangle(16, barY, barW, 8, 0x111111, 0.7).setOrigin(0, 0.5));
    this.hudLayer.add(this.add.rectangle(16, barY, barW * myRatio, 8, 0xc0392b).setOrigin(0, 0.5));
    this.hudLayer.add(this.add.rectangle(324, barY, barW, 8, 0x111111, 0.7).setOrigin(0, 0.5));
    this.hudLayer.add(this.add.rectangle(324, barY, barW * theirRatio, 8, 0x2980b9).setOrigin(0, 0.5));
  }

  // ══════════════════════════════════════════════
  // M7 · 战报滚动区
  // ══════════════════════════════════════════════

  /**
   * 建立战报滚动区（只建一次，后续靠 updateLog 更新内容）
   *
   * 布局（右下角）：
   *   底板     x 660~1270, y 640~796
   *   标题     「战报」+ 条数
   *   内容区   可滚动文本（按行切片，只渲染可视的那些行）
   *
   * ⚠️ 为什么用"行窗口切片"而不是 mask 裁剪？
   *   mask（GeometryMask）方案在 WebGL 下依赖渲染管线，无头浏览器里
   *   既难断言也不好调试。而战报每行高度固定，用切片实现滚动
   *   既简单又完全可控（还能精确断言"当前显示的是第几行"）。
   */
  buildLogPanel() {
    this.logLayer.removeAll(true);

    // 底板（与左侧操作栏底板对齐：y 630~790）
    this.logLayer.add(this.add.rectangle(965, 710, 610, 160, 0x16213e, 0.95));

    // 标题
    this.logTitle = this.add.text(674, 646, '战报', { fontSize: '14px', color: '#f1c40f' }).setOrigin(0, 0.5);
    this.logLayer.add(this.logTitle);

    // 内容文本（只渲染可视窗口内的行）
    this.logText = this.add.text(674, 662, '', {
      fontSize: '13px',
      color: '#d5e1f2',
      lineSpacing: 3
    }).setOrigin(0, 0);
    this.logLayer.add(this.logText);

    // 滚轮上翻看历史
    this.input.on('wheel', (pointer, over, deltaX, deltaY) => {
      this.logScroll = Math.max(0, Math.min(this.logScroll - deltaY * 0.6, this.maxLogScroll()));
      // 手动上翻后取消"自动跟到底"
      if (this.logScroll > 0) this.logStickToBottom = false;
      this.applyLogScroll();
    });

    this.updateLog();
  }

  /**
   * 战报可视窗口能显示多少行
   */
  get logVisibleLines() {
    return LOG_VISIBLE_LINES;
  }

  /**
   * 战报最大可滚动行数
   * @returns {number}
   */
  maxLogScroll() {
    const total = this.battle?.log?.length || 0;
    return Math.max(0, total - this.logVisibleLines);
  }

  /**
   * 按当前滚动位置刷新战报文本
   */
  applyLogScroll() {
    if (!this.logText) return;
    const lines = this.battle.log.map((l) => l.text);
    const start = Math.max(0, Math.min(this.logScroll, Math.max(0, lines.length - 1)));
    const visible = lines.slice(start, start + this.logVisibleLines);
    this.logText.setText(visible.join('\n'));

    // 标题上的条数
    if (this.logTitle) {
      this.logTitle.setText(`战报（${lines.length}）`);
    }
  }

  /**
   * 更新战报内容（有新条目时自动滚到底）
   */
  updateLog() {
    if (!this.logText) return;
    const total = this.battle.log.length;
    const maxScroll = this.maxLogScroll();

    // 跟到底时始终显示最后几行
    if (this.logStickToBottom) {
      this.logScroll = maxScroll;
    } else {
      this.logScroll = Math.min(this.logScroll, maxScroll);
    }
    this.applyLogScroll();
  }

  // ══════════════════════════════════════════════
  // 战果结算面板（M6c）
  // ══════════════════════════════════════════════

  /**
   * 战果结算面板（M6c）
   * 展示：胜负、双方幸存兵力、经验与升级、败方英雄被俘、城镇易主
   */
  drawResultPanel() {
    const r = this.result;
    if (!r) return;

    const factionName = (playerId) => {
      const p = this.state.players.find((x) => x.id === playerId);
      if (!p) return '未知势力';
      return p.faction === 'shu' ? '蜀汉' : '曹魏';
    };

    const winName = r.winner === 'draw' ? '两败俱伤'
      : factionName(r.winnerPlayerId);
    const lines = [];

    const atkLeft = r.attackerArmy.reduce((a, x) => a + x.count, 0);
    const defLeft = r.defenderArmy.reduce((a, x) => a + x.count, 0);
    lines.push(`攻方幸存 ${atkLeft} 人　守方幸存 ${defLeft} 人`);

    if (r.exp > 0) {
      const hero = this.state.heroes.find((h) => h.id === r.expHeroId);
      const lv = r.levelUps > 0 ? `，连升 ${r.levelUps} 级` : '';
      lines.push(`${hero ? hero.name : '胜方英雄'} 获得经验 +${r.exp}${lv}`);
    }
    if (r.removedHeroNames && r.removedHeroNames.length > 0) {
      lines.push(`战败被俘：${r.removedHeroNames.join('、')}`);
    }
    if (r.capturedTownId) {
      const town = this.state.towns.find((t) => t.id === r.capturedTownId);
      lines.push(`攻占城镇：${town ? town.name : r.capturedTownId}`);
    }
    if (r.hiredHeroNames && r.hiredHeroNames.length > 0) {
      lines.push(`势力补充了新武将：${r.hiredHeroNames.join('、')}`);
    }

    // M8：电脑方英雄自动加点的记录
    if (r.autoSkills && r.autoSkills.length > 0) {
      const names = r.autoSkills.map((s) => {
        const def = this.data.skills.find((x) => x.id === s.skillId);
        return `${def?.name || s.skillId} Lv.${s.level}`;
      });
      lines.push(`电脑武将自动加点：${names.join('、')}`);
    }

    // M8：玩家方英雄待分配的技能点
    const expHero = r.expHeroId
      ? this.state.heroes.find((h) => h.id === r.expHeroId)
      : null;
    const pending = expHero?.pendingLevels || 0;

    // 面板
    this.hudLayer.add(this.add.rectangle(640, 400, 560, 340, 0x0b0f1a, 0.94).setStrokeStyle(2, 0xf1c40f));
    this.hudLayer.add(this.add.text(640, 268, '战果结算', {
      fontSize: '20px', color: '#f1c40f'
    }).setOrigin(0.5));
    this.hudLayer.add(this.add.text(640, 305, `${winName} 获胜！`, {
      fontSize: '26px', color: winName === '两败俱伤' ? '#95a5a6' : '#e74c3c'
    }).setOrigin(0.5));
    this.hudLayer.add(this.add.text(640, 388, lines.join('\n'), {
      fontSize: '15px', color: '#d5e1f2', align: 'center', lineSpacing: 8
    }).setOrigin(0.5));

    // M8：技能加点按钮
    // ⚠️ 这里的 pendingLevels 要**实时读**，不能用闭包快照：
    //    玩家在加点面板里分配完点后，快照还是旧值，
    //    点[确定]会再次弹出加点面板，永远回不到地图。
    if (expHero && (expHero.pendingLevels || 0) > 0) {
      this.hudLayer.add(this.add.text(640, 492, `[技能加点 · 还剩 ${expHero.pendingLevels} 次]`, {
        fontSize: '17px', color: '#2ecc71'
      })
        .setOrigin(0.5)
        .setInteractive({ useHandCursor: true })
        .on('pointerdown', () => this.openSkillPanel(expHero.id)));
    }

    this.hudLayer.add(this.add.text(640, 528, '[确定]', {
      fontSize: '18px', color: '#f1c40f'
    })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => {
        // M8：还有未分配的技能点时，先引导加点，避免玩家漏掉
        //
        // ⚠️ 这里必须**实时读** expHero.pendingLevels，不能用闭包里捕获的 pending 快照：
        //    玩家在加点面板里分配完点后，pending 已变成 0，
        //    但快照仍是旧值 → 点[确定]会再次弹出加点面板，永远回不到地图。
        const livePending = expHero ? (expHero.pendingLevels || 0) : 0;
        if (livePending > 0 && expHero) {
          this.openSkillPanel(expHero.id);
          return;
        }
        this.scene.start('MapScene');
      }));
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
        this.refresh(); // 面板文字（待加点次数）随加点结果刷新
      }
    });
  }

  // ══════════════════════════════════════════════
  // M9 · 施法
  // ══════════════════════════════════════════════

  /**
   * 玩家方的英雄 —— 施法由玩家操作
   *
   * ⚠️ 不能写死 attackerHeroId：
   *    玩家主动进攻时玩家是攻方；电脑主动进攻玩家时玩家是守方。
   *    按 humanSide 反推该取哪个英雄。
   *
   * @returns {object|null}
   */
  get playerHero() {
    const b = this.battle;
    if (!b) return null;
    const heroId = this.humanSide === 'attacker' ? b.attackerHeroId : b.defenderHeroId;
    return this.state?.heroes?.find((h) => h.id === heroId) || null;
  }

  /**
   * 打开施法面板（M9）
   */
  openSpellPanel() {
    if (this.spellPanel) return;
    const hero = this.playerHero;
    if (!hero) {
      this.toast('本场没有可施法的英雄');
      return;
    }
    if (hasCastThisTurn(this.battle, hero.id)) {
      this.toast('本轮已施法过，下一轮才能再次施法');
      return;
    }

    this.spellPanel = openSpellPanel(this, {
      state: this.state,
      battle: this.battle,
      heroId: hero.id,
      onPick: (spellId, def) => {
        this.spellPanel = null;
        this.startCasting(spellId, def);
      },
      onCancel: () => {
        this.spellPanel = null;
        this.refresh();
      }
    });
  }

  /**
   * 进入"选目标"模式（或直接施放群体魔法）
   * @param {string} spellId
   * @param {object} def 魔法定义
   */
  startCasting(spellId, def) {
    const hero = this.playerHero;
    if (!hero) return;

    // 群体魔法无需选目标，直接施放
    if (def.target === 'allAllies' || def.target === 'allEnemies') {
      const r = castSpell(this.state, this.data, hero.id, spellId);
      if (r.ok) {
        this.toast(r.effectDesc);
      } else {
        this.toast(`施法失败：${r.reason}`);
      }
      this.refresh();
      return;
    }

    // 单体魔法 → 高亮合法目标，等玩家点
    const ids = spellTargets(this.battle, hero.id, spellId);
    if (ids.length === 0) {
      this.toast('没有合法目标');
      this.refresh();
      return;
    }
    this.castingSpellId = spellId;
    this.castTargetIds = ids;
    this.clearSelection();
    this.refresh();
  }

  /**
   * 取消选目标模式
   */
  cancelCasting() {
    this.castingSpellId = null;
    this.castTargetIds = [];
    this.refresh();
  }

  /**
   * 对指定目标施放当前选中的魔法
   * @param {string} stackId 目标 stack id
   */
  castOnTarget(stackId) {
    const hero = this.playerHero;
    const spellId = this.castingSpellId;
    if (!hero || !spellId) return;

    const r = castSpell(this.state, this.data, hero.id, spellId, stackId);
    if (r.ok) {
      this.toast(r.effectDesc);
    } else {
      this.toast(`施法失败：${r.reason}`);
    }
    this.castingSpellId = null;
    this.castTargetIds = [];
    this.clearSelection();
    this.refresh();
  }

  // ══════════════════════════════════════════════
  // 交互
  // ══════════════════════════════════════════════

  /**
   * 进入"只选攻击目标"模式
   *
   * 玩家点[攻击]时用：直接进入选目标状态，不用先点单位。
   */
  enterAttackMode() {
    if (this.battle.winner) return;
    const cur = currentActionableStack(this.battle);
    if (!cur) return;
    // ⚠️ 判"是不是玩家的单位"要看 playerId，不能看 side：
    //    电脑主动进攻时玩家是守方，side 是 'defender'。
    if (cur.playerId !== this.humanPlayerId) {
      this.toast('还没轮到我方单位行动');
      return;
    }
    const targets = attackableTargets(this.battle, cur.id);
    if (targets.length === 0) {
      this.toast('当前没有可攻击的目标');
      return;
    }
    this.selectedId = cur.id;
    this.moveCells = [];        // 攻击模式不显示移动格
    this.targetIds = targets;
    this.refresh();
  }

  /** 绑定鼠标点击 */
  bindInput() {
    this.input.on('pointerdown', (pointer, currentlyOver) => {
      // ── 防止 UI 点击穿透到战场 ────────────────────────────────
      // Phaser 的 processDownEvents 顺序是：
      //   ① 先对命中的 GameObject 发 pointerdown（按钮 / 魔法卡在这里响应）
      //   ② 再对场景发 pointerdown（本处理器）
      //
      // 于是「点魔法卡」这一次点击会先跑 onPick：关面板 + startCasting()
      // 把 castingSpellId 设上；紧接着本处理器又跑一遍，看到 castingSpellId
      // 已设置、而落点（面板盖住的那格）不是合法目标 → 走 cancelCasting()，
      // 把**刚建立**的施法模式当场取消。
      // 表现：点魔法卡 → 面板关了 → 没任何反应，玩家以为"放不了魔法"。
      //
      // 两道防护：
      //   1) 弹层打开时，战场点击一律不响应；
      //   2) 落点上有任何可交互对象（按钮 / 卡片 / 遮罩）时不穿透 ——
      //      这一条兜住第①步刚把面板关掉的那次点击（此时 spellPanel 已是 null）。
      //
      // ⚠️ 兵牌与地面瓦片都不是 interactive，正常点战场时 currentlyOver 为空，
      //    所以这两道防护不影响选单位 / 移动 / 攻击 / 选施法目标。
      if (this.spellPanel || this.skillPanel) return;
      if (currentlyOver && currentlyOver.length > 0) return;

      const cell = this.pickCell(pointer);
      if (!cell) return;
      this.handleClickCell(cell);
    });
  }

  /**
   * 屏幕坐标 → 战场格坐标
   * @param {Phaser.Input.Pointer} pointer
   * @returns {{x:number,y:number}|null}
   */
  pickCell(pointer) {
    const px = pointer.x - GRID_X;
    const py = pointer.y - GRID_Y;
    if (px < 0 || py < 0) return null;
    const cx = Math.floor(px / CELL);
    const cy = Math.floor(py / CELL);
    if (cx < 0 || cy < 0 || cx >= BATTLE_WIDTH || cy >= BATTLE_HEIGHT) return null;
    return { x: cx, y: cy };
  }

  /**
   * 处理点击某个格子
   * @param {{x:number,y:number}} cell
   */
  handleClickCell(cell) {
    const b = this.battle;
    if (b.winner) return;

    // 找该格上的 stack
    const stack = b.stacks.find((s) => s.count > 0 && s.pos.x === cell.x && s.pos.y === cell.y);

    // 0) 选目标模式：点合法目标就施法，点别处取消
    if (this.castingSpellId) {
      if (stack && this.castTargetIds.includes(stack.id)) {
        this.castOnTarget(stack.id);
      } else {
        this.cancelCasting();
      }
      return;
    }

    // 1) 已选中单位 → 先判断是不是可移动格
    if (this.selectedId) {
      const sel = b.stacks.find((s) => s.id === this.selectedId);
      if (!sel) { this.clearSelection(); this.refresh(); return; }

      const canMove = this.moveCells.some((c) => c.x === cell.x && c.y === cell.y);
      if (canMove) {
        const r = moveStack(b, sel.id, cell);
        if (r.ok) {
          // 移动不结束回合：保持选中，让玩家接着点目标攻击
          this.moveCells = [];
          this.targetIds = attackableTargets(b, sel.id);
          this.refresh();
        }
        return;
      }

      // 2) 判断是不是可攻击目标
      if (stack && this.targetIds.includes(stack.id)) {
        const r = attackStack(b, this.data, sel.id, stack.id);
        if (r.ok) {
          this.clearSelection();
          nextTurn(b, { action: 'attack' });
          this.refresh();
        }
        return;
      }

      // 3) 点到自己 → 取消选中
      if (stack && stack.id === this.selectedId) {
        this.clearSelection();
        this.refresh();
        return;
      }
    }

    // 4) 点己方单位 → 选中并显示可移动格 / 可攻击目标
    //    回合制队列决定：只有「当前行动单位」可以操作
    //
    // ⚠️ 判"是不是我方单位"要看 playerId，不能写死 side === 'attacker'：
    //    电脑主动进攻玩家时，玩家是守方（side 是 'defender'）。
    if (stack && stack.playerId === this.humanPlayerId) {
      const cur = currentStack(b);
      if (!cur || cur.id !== stack.id) {
        this.toast('还没轮到该单位行动');
        this.clearSelection();
        this.refresh();
        return;
      }
      this.selectedId = stack.id;
      this.moveCells = movableCells(b, stack.id);
      this.targetIds = attackableTargets(b, stack.id);
      this.refresh();
      return;
    }

    // 5) 点敌方单位但没选中 → 忽略
    this.clearSelection();
    this.refresh();
  }

  /** 屏幕底部提示 */
  /**
   * 战场提示（M13：统一走组件库）
   * 放在战场区下沿（596），避开 AI 提示（626）与底部操作栏（640+）
   */
  toast(text) {
    showToast(this, text, {
      x: 640, y: 596, toY: 596,
      duration: 1200,
      fontSize: '14px',
      color: '#f1c40f',
      background: '#000000',
      depth: 999
    });
  }
}

import bus from '../core/EventBus.js';
import { gainExp, autoChooseSkill, skillBonus } from './skillLogic.js';
import { hireHero } from './townLogic.js';
import { checkGameOver } from './turnLogic.js';
import {
  pushLog,
  applyDamage,
  stackStat,
  stackSpeed,
  buffModifier,
  isBlinded,
  buildTurnQueue
} from './stackOps.js';
import { tickBuffs, grantSpellsForLevel } from './magicLogic.js';

/**
 * battleLogic —— 战场逻辑（纯 JS，禁止 import phaser）
 *
 * 本文件分三次交付：
 *   M6a：initBattle（布阵建 stack）、buildTurnQueue（出手排序）、
 *        currentStack、nextTurn（推进/轮次/buff 递减）、checkBattleEnd（胜负判定）、
 *        applyDamage（伤害施加）、townGarrisonArmy（守军生成）
 *   M6b：movableCells、moveStack、attackStack（伤害公式 + 反击）、
 *        attackableTargets（可攻击目标，供 M7 界面 / M10 AI 用）
 *   M6c：resolveBattle（战果写回、经验结算）
 *
 * 战场尺寸：11×9，攻方从左（x=0~1）入场，守方从右（x=9~10）入场。
 * state.battle 只放纯数据，保证可 JSON 序列化（存档用）。
 *
 * ── 远程规则（M6b 修订，权威口径）──────────────────────────
 *   1. 每个兵种有 `range`（射程，格数）；近战兵 range=1。
 *   2. 远程单位**可攻击全场**任意敌人（不再有"被近身就只能打相邻"的封锁）。
 *   3. 目标在自身射程内 → 满攻击力；超出射程 → 该次攻击伤害减半。
 *   4. 远程单位被近身（相邻有敌）时，它**自己发起的反击**伤害减半。
 *   5. 近战单位仍然必须与目标八方向相邻才能攻击。
 * ─────────────────────────────────────────────────────────
 *
 * ── 模块分层（M9 引入）────────────────────────────────────
 *   stackOps.js  ← 底层原子操作（applyDamage / buff 修正 / 出手队列）
 *      ▲   ▲
 *      │   └── magicLogic.js（M9：施法、buff 生命周期、法力）
 *      └────── battleLogic.js（本文件）
 *   抽 stackOps 是为了打断 battleLogic ↔ magicLogic 的循环依赖。
 * ────────────────────────────────────────────────────────
 */

/**
 * 伤害倍率常量（集中管理，便于平衡调整）
 */
export const DAMAGE_MULT = {
  /** 反击通用半伤（任何单位被攻击后还击） */
  RETALIATION: 0.5,
  /** 超出自身射程时的攻击减伤 */
  OUT_OF_RANGE: 0.5,
  /** 远程单位被近身时，其自身反击的减伤 */
  ENGAGED_RANGED_RETAIL: 0.5,
  /** 守方处于防御姿态时的减伤 */
  DEFENDING: 0.5
};

/**
 * 战场宽度
 *
 * 取 11 而非更宽：英雄无敌4 的战场是 11×11 网格，双方单位在第 0/1 列与第 9/10 列。
 * 若战场过宽（如 15），以 moveRange 4 的近战兵推 3 个回合都碰不到对手，
 * 战斗根本打不起来。11 宽能让近战兵两回合接敌、远程兵开火即可全场覆盖。
 */
export const BATTLE_WIDTH = 11;
/** 战场高度 */
export const BATTLE_HEIGHT = 9;

// ── 底层原子操作已抽到 stackOps.js，这里转出以保持既有导入路径 ──
// （battleLogic.test.js 等调用方仍从本文件导入 applyDamage / stackSpeed / buildTurnQueue）
export { pushLog, applyDamage, stackStat, stackSpeed, buffModifier, isBlinded, buildTurnQueue };

/**
 * 按行均布的布阵坐标
 * 主列：攻方 x=0，守方 x=14；溢出到次列（攻方 x=1，守方 x=13）。
 * 单列最多放 9 个 stack，多于 9 个时才会用到次列。
 * @param {'attacker'|'defender'} side
 * @param {number} index  该方第几个 stack（0 起）
 * @param {number} total  该方 stack 总数
 * @returns {{x:number, y:number}}
 */
export function formationPos(side, index, total) {
  const perCol = BATTLE_HEIGHT;
  const colIdx = Math.floor(index / perCol);
  const rowInCol = index % perCol;
  // 本列实际有几个
  const colCount = Math.min(perCol, Math.max(0, total - colIdx * perCol));
  // 在 9 行里均布
  const y = colCount <= 1 ? Math.floor((BATTLE_HEIGHT - 1) / 2)
    : Math.round((rowInCol * (BATTLE_HEIGHT - 1)) / (colCount - 1));

  if (side === 'attacker') {
    return { x: colIdx === 0 ? 0 : 1, y };
  }
  return { x: colIdx === 0 ? BATTLE_WIDTH - 1 : BATTLE_WIDTH - 2, y };
}

/**
 * 组建一方的 stack 列表
 * @param {object} battle
 * @param {Array<{unitId:string,count:number}>} army
 * @param {'attacker'|'defender'} side
 * @param {object} data 数据表集合（需要 units）
 * @param {number} playerId 该方所属玩家 id
 * @param {object} state GameState（用于查询技能加成）
 * @param {string|null} heroId 该方英雄 id（无英雄的守城部队为 null）
 * @returns {Array<{unitId:string,count:number}>} 归一化后的军队（M6c 经验结算要用开战时快照）
 */
function buildSide(battle, army, side, data, playerId, state, heroId) {
  const units = data?.units || [];
  // 过滤掉无效兵种和数量为 0 的
  const valid = (army || []).filter(
    (a) => a && units.some((u) => u.id === a.unitId) && Math.floor(a.count || 0) > 0
  );

  // M8：英雄技能加成
  //   统帅（armyAttack）  → 全军攻击 +N，直接烘进 stack.attack
  //   防御（armyDefense） → 全军防御 +N，直接烘进 stack.defense
  //   弓术/武勇（rangedDamage/meleeDamage）→ 伤害百分比，按 stack 是否远程取对应值
  const atkBonus = heroId ? skillBonus(state, heroId, 'armyAttack') : 0;
  const defBonus = heroId ? skillBonus(state, heroId, 'armyDefense') : 0;
  const rangedPct = heroId ? skillBonus(state, heroId, 'rangedDamage') : 0;
  const meleePct = heroId ? skillBonus(state, heroId, 'meleeDamage') : 0;

  valid.forEach((a, i) => {
    const unit = units.find((u) => u.id === a.unitId);
    const count = Math.floor(a.count || 0);
    const isRanged = (unit.abilities || []).includes('ranged');
    const stack = {
      id: `s${battle.stacks.length}`,
      side,
      playerId,                   // 该方所属玩家（0=玩家，1=电脑），AI 判断用
      unitId: unit.id,
      unitName: unit.name,
      count,                       // 存活数量
      initialCount: count,         // 开战时的数量（复活上限，M9 用）
      hp: unit.hp,                 // 队首兵的当前生命
      maxHp: unit.hp,              // 单兵满血
      attack: unit.attack + atkBonus,   // M8：统帅加成已计入
      defense: unit.defense + defBonus, // M8：防御加成已计入
      speed: unit.speed,
      damageMin: unit.damageMin,
      damageMax: unit.damageMax,
      moveRange: unit.moveRange,
      range: unit.range ?? 1,          // 射程（近战=1，远程按兵种配置）
      abilities: [...(unit.abilities || [])],
      damagePct: isRanged ? rangedPct : meleePct, // M8：弓术/武勇伤害百分比
      pos: formationPos(side, i, valid.length),
      acted: false,                // 本轮是否已行动（攻击或待命后为 true）
      moved: false,                // 本轮是否已移动（移动后仍可攻击）
      defending: false,            // 本轮是否防御（受击伤害减半）
      retaliated: false,           // 本轮是否已反击过
      buffs: []                    // [{ spellId, stat, value, turnsLeft }]
    };
    battle.stacks.push(stack);
  });

  // 归一化快照：{unitId, count}，供 M6c 计算"被击败军队总价值"用
  return valid.map((a) => ({ unitId: a.unitId, count: Math.floor(a.count || 0) }));
}

/**
 * 初始化一场战斗：把双方军队转成 stacks 并布阵
 * @param {object} state GameState（写入 state.battle）
 * @param {Array<{unitId:string,count:number}>} attackerArmy 攻方军队
 * @param {Array<{unitId:string,count:number}>} defenderArmy 守方军队
 * @param {object} opts
 *   attackerHeroId / defenderHeroId / defenderTownId / data（数据表集合）
 * @returns {object} battle
 */
export function initBattle(state, attackerArmy, defenderArmy, opts = {}) {
  const battle = {
    round: 1,
    attackerHeroId: opts.attackerHeroId ?? null,
    defenderHeroId: opts.defenderHeroId ?? null,
    defenderTownId: opts.defenderTownId ?? null,
    attackerPlayerId: opts.attackerPlayerId ?? 0,
    defenderPlayerId: opts.defenderPlayerId ?? 1,
    stacks: [],
    turnQueue: [],
    currentTurn: 0,
    log: [],
    winner: null,
    // M9：每方每轮限施法 1 次（新一轮由 nextTurn 重置）
    spellCastThisTurn: { attacker: false, defender: false },
    // 开战时的双方军队快照（M6c：算"被击败军队总价值"→ 经验）
    armies: { attacker: [], defender: [] }
  };

  battle.armies.attacker = buildSide(
    battle, attackerArmy, 'attacker', opts.data, battle.attackerPlayerId, state, battle.attackerHeroId
  );
  battle.armies.defender = buildSide(
    battle, defenderArmy, 'defender', opts.data, battle.defenderPlayerId, state, battle.defenderHeroId
  );
  buildTurnQueue(battle);

  state.battle = battle;
  pushLog(battle, '战斗开始！');
  bus.emit('battle:start', { battle });

  // 开局即有一方无兵时直接判胜负
  checkBattleEnd(battle);
  return battle;
}

/**
 * 某 stack 的射程覆盖到的所有格子（M7 射程可视化用）
 *
 * 口径与 isOutOfRange 保持一致：切比雪夫距离 ≤ 射程即在射程内。
 * 近战兵射程为 1，覆盖自身 + 八方向相邻格；远程兵按配置的 range 覆盖一片区域。
 *
 * ⚠️ 注意这是**满伤害范围**。按 M6 远程规则，远程单位其实可以攻击全场任意敌人，
 *    超出射程只是伤害减半。所以这个格子集是"能打出满伤害的范围"，
 *    用于界面上画出射程预览，不代表"只有这些格子能被打"。
 *
 * @param {object} stack
 * @returns {Array<{x:number,y:number}>} 格子列表（含 stack 自身所在格）
 */
export function cellsInRange(stack) {
  if (!stack) return [];
  const r = stackRange(stack);
  const cx = stack.pos?.x ?? 0;
  const cy = stack.pos?.y ?? 0;
  const cells = [];
  for (let y = 0; y < BATTLE_HEIGHT; y++) {
    for (let x = 0; x < BATTLE_WIDTH; x++) {
      if (cellDistance({ x, y }, { x: cx, y: cy }) <= r) cells.push({ x, y });
    }
  }
  return cells;
}

/**
 * 当前应行动的 stack
 *
 * 注意：这是**纯指针查询**，不做任何过滤。
 * 被致盲（buff stat='canAct'）的 stack 在两种情况下会被处理掉：
 *   1. 指针正好停在它身上 → nextTurn 第 1 步标记 acted + 写战报
 *   2. 指针推进时路过它   → advanceToActionable 消费掉（标记 acted + 写战报）
 * 这样 nextTurn 内部"标记 acted"与"指针查询"不会互相干扰，
 * 而且无论致盲发生在行动前还是行动后，都能正确记录"本轮无法行动"。
 *
 * @param {object} battle
 * @returns {object|null}
 */
export function currentStack(battle) {
  if (!battle || battle.winner) return null;
  const id = battle.turnQueue[battle.currentTurn];
  if (!id) return null;
  const stack = battle.stacks.find((s) => s.id === id);
  if (!stack || stack.count <= 0) return null;
  return stack;
}

/**
 * 推进到下一个 stack；一轮结束时开新的一轮
 *
 * 一轮结束会做五件事：
 *   round+1、重置所有 stack 的 acted/defending/retaliated、
 *   buff 的 turnsLeft-1（归零的移除，由 M9 的 tickBuffs 处理）、
 *   重置双方本轮施法次数、按速度重新排序 turnQueue
 *
 * @param {object} battle
 * @param {object} [opts] { action: 'wait'|'defend'|'move'|'attack' } 用于写战报
 * @returns {object|null} 新的当前 stack
 */
export function nextTurn(battle, opts = {}) {
  if (!battle || battle.winner) return null;

  // 1) 结束当前 stack 的行动
  const cur = currentStack(battle);
  if (cur) {
    // 记录"行动前是否已经行动过"：被致盲只对"还没行动"的 stack 有意义
    const wasActed = cur.acted;
    cur.acted = true;
    if (isBlinded(cur)) {
      // M9：被致盲的 stack 本轮不能行动，直接跳过
      if (!wasActed) pushLog(battle, `${cur.unitName} 被致盲，无法行动`);
    } else if (opts.action === 'defend') {
      cur.defending = true;
      pushLog(battle, `${cur.unitName} 原地防守`);
    } else if (opts.action === 'wait') {
      pushLog(battle, `${cur.unitName} 原地待命`);
    }
  }

  // 2) 推进指针，跳过已阵亡 / 已行动 / 被致盲的 stack
  //    （被致盲的会被 advanceToActionable 消费掉：标记 acted + 记战报）
  battle.currentTurn += 1;
  battle.currentTurn = advanceToActionable(battle, battle.currentTurn);

  // 3) 队列走完 → 新的一轮
  if (battle.currentTurn >= battle.turnQueue.length) {
    battle.round += 1;
    for (const s of battle.stacks) {
      s.acted = false;
      s.moved = false;
      s.defending = false;
      s.retaliated = false;
    }
    // buff 持续时间递减（M9：tickBuffs 负责移除归零的 buff）
    tickBuffs(battle);
    // M9：每方每轮限施法 1 次 → 新一轮重置
    battle.spellCastThisTurn = { attacker: false, defender: false };
    buildTurnQueue(battle);
    pushLog(battle, `—— 第 ${battle.round} 轮 ——`);
    battle.currentTurn = advanceToActionable(battle, 0);
    bus.emit('battle:round', { round: battle.round });
  }

  // 4) 胜负判定
  checkBattleEnd(battle);
  bus.emit('battle:turn', {
    stackId: battle.turnQueue[battle.currentTurn] || null,
    round: battle.round
  });
  return currentStack(battle);
}

/**
 * 从 from 下标开始推进指针，返回下一个可行动 stack 的下标
 *
 * M9 规则：被致盲（buff stat='canAct'）的 stack 本轮不能行动。
 * 推进时遇到它，会把它**消费**掉：
 *   - 标记 acted = true（它的这一轮就这么没了）
 *   - 写一条战报「X 被致盲，无法行动」
 * 这样被致盲的单位既不会卡住指针，也能在战报里留下痕迹。
 *
 * 顺序保证：指针从头往后扫，遇到的第一个可行动 stack 立即返回，
 * 所以被消费的致盲 stack 一定是"轮到了它"的那个，日志顺序正确。
 *
 * @param {object} battle
 * @param {number} from
 * @returns {number} 下一个可行动的下标；若队列走完则返回 turnQueue.length
 */
function advanceToActionable(battle, from) {
  let i = from;
  let guard = 0;
  while (i < battle.turnQueue.length && guard++ < 1000) {
    const s = battle.stacks.find((x) => x.id === battle.turnQueue[i]);
    if (!s || s.count <= 0 || s.acted) {
      i += 1;
      continue;
    }
    if (isBlinded(s)) {
      // 被致盲 → 本轮不能行动，消费掉它的这一次机会
      s.acted = true;
      pushLog(battle, `${s.unitName} 被致盲，无法行动`);
      i += 1;
      continue;
    }
    return i;
  }
  return i;
}

/**
 * 胜负判定：一方 stack 全灭即分出胜负
 * @param {object} battle
 * @returns {'attacker'|'defender'|'draw'|null} null 表示战斗未结束
 */
export function checkBattleEnd(battle) {
  if (!battle || battle.winner) return battle?.winner ?? null;

  const attackerAlive = battle.stacks.some((s) => s.side === 'attacker' && s.count > 0);
  const defenderAlive = battle.stacks.some((s) => s.side === 'defender' && s.count > 0);
  if (attackerAlive && defenderAlive) return null;

  let winner = 'draw';
  if (attackerAlive) winner = 'attacker';
  else if (defenderAlive) winner = 'defender';

  battle.winner = winner;
  pushLog(battle, winner === 'draw' ? '两败俱伤！' : `${winner === 'attacker' ? '攻方' : '守方'}获得胜利！`);
  bus.emit('battle:end', { winner });
  return winner;
}

/**
 * 从大地图发起一场战斗（MapScene → BattleScene 之间的胶水层）
 *
 * 交战对象有两种：
 *   { attackerId, defenderId }  英雄 vs 英雄
 *   { attackerId, townId }      英雄 vs 城镇（守军由 townGarrisonArmy 生成）
 *
 * @param {object} state
 * @param {object} data 数据表集合
 * @param {object} params { attackerId, defenderId?, townId? }
 * @returns {object|null} battle；参数无效时返回 null
 */
export function startBattle(state, data, params = {}) {
  const attacker = state.heroes.find((h) => h.id === params.attackerId);
  if (!attacker) return null;

  let defenderArmy = [];
  let defenderHeroId = null;
  let defenderTownId = null;
  let defenderPlayerId = 1;

  if (params.defenderId) {
    const defender = state.heroes.find((h) => h.id === params.defenderId);
    if (!defender) return null;
    defenderHeroId = defender.id;
    defenderPlayerId = defender.playerId ?? 1;
    defenderArmy = defender.army || [];
  } else if (params.townId) {
    const town = state.towns.find((t) => t.id === params.townId);
    if (!town) return null;
    defenderTownId = town.id;
    defenderPlayerId = town.playerId ?? 1;
    defenderArmy = townGarrisonArmy(state, data, town.id);
  } else {
    return null;
  }

  return initBattle(state, attacker.army || [], defenderArmy, {
    attackerHeroId: attacker.id,
    defenderHeroId,
    defenderTownId,
    attackerPlayerId: attacker.playerId ?? 0,
    defenderPlayerId,
    data
  });
}

/**
 * 生成城镇守军
 * 优先用 town.garrison；没有驻军时，按已建招募建筑里 tier 最高的一个兵种生成少量守军。
 * @param {object} state
 * @param {object} data 数据表集合
 * @param {string} townId
 * @returns {Array<{unitId:string,count:number}>}
 */
export function townGarrisonArmy(state, data, townId) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return [];

  if (town.garrison && town.garrison.length > 0) {
    return town.garrison.map((g) => ({ unitId: g.unitId, count: g.count }));
  }

  const builtIds = town.buildings || [];
  const recruits = (data.buildings || []).filter((b) => builtIds.includes(b.id) && b.recruitUnit);
  if (recruits.length === 0) return [];

  const top = recruits.reduce((a, b) => ((b.recruitTier || 0) > (a.recruitTier || 0) ? b : a));
  const unit = (data.units || []).find((u) => u.id === top.recruitUnit);
  if (!unit) return [];

  return [{ unitId: unit.id, count: Math.min(10, unit.growth || 5) }];
}


// ══════════════════════════════════════════════════
// M6b · 移动与攻击
// ══════════════════════════════════════════════════

/** 战场八方向偏移（斜向也算相邻，与英雄无敌一致） */
const DIRS8 = [
  [0, -1], [0, 1], [-1, 0], [1, 0],
  [-1, -1], [1, -1], [-1, 1], [1, 1]
];

/**
 * 判断两个格子是否相邻（八方向）
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {boolean}
 */
export function isAdjacent(a, b) {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx <= 1 && dy <= 1 && dx + dy > 0;
}

/**
 * 判断某 stack 是否拥有指定特性
 * @param {object} stack
 * @param {string} ability
 * @returns {boolean}
 */
export function hasAbility(stack, ability) {
  return !!stack && Array.isArray(stack.abilities) && stack.abilities.includes(ability);
}

/**
 * 格子坐标 → 唯一键
 * @param {{x:number,y:number}} pos
 * @returns {string}
 */
function posKey(pos) {
  return `${pos.x},${pos.y}`;
}

/**
 * 两格之间的切比雪夫距离（八方向移动步数，与 moveRange 同一度量）
 * @param {{x:number,y:number}} a
 * @param {{x:number,y:number}} b
 * @returns {number}
 */
export function cellDistance(a, b) {
  if (!a || !b) return 0;
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * 取 stack 的射程（格数）；缺省为 1（近战）
 * @param {object} stack
 * @returns {number}
 */
export function stackRange(stack) {
  if (!stack) return 1;
  const r = Number(stack.range);
  return Number.isFinite(r) && r >= 1 ? r : 1;
}

/**
 * 攻击者对目标的射程判定
 * 切比雪夫距离 ≤ 射程 → 在射程内（满攻击力），否则超出射程（攻击减半）
 * @param {object} attacker
 * @param {object} defender
 * @returns {boolean} true = 超出射程
 */
export function isOutOfRange(attacker, defender) {
  if (!attacker || !defender) return false;
  return cellDistance(attacker.pos, defender.pos) > stackRange(attacker);
}

/**
 * 判断某 stack 是否被近身（相邻格有敌人）
 *
 * 新规则下远程单位**不会被封锁**：仍然可以全场射击。
 * 被近身只影响它自己的**反击伤害**（减半）。
 *
 * @param {object} battle
 * @param {object} stack
 * @returns {boolean}
 */
export function isEngaged(battle, stack) {
  if (!battle || !stack) return false;
  return battle.stacks.some(
    (s) => s.side !== stack.side && s.count > 0 && isAdjacent(stack.pos, s.pos)
  );
}

/**
 * 计算一次攻击的伤害值（不含击杀结算）
 *
 * 公式（契约 M6 修订版）：
 *   基础 = 随机(damageMin ~ damageMax) × count
 *   攻防差修正：攻击 > 防御 → 每点 +5%（加成上限 +300%）
 *                防御 > 攻击 → 每点 -2%（减益下限 30%）
 *   M8 技能加成：弓术/武勇 → 伤害 × (1 + damagePct/100)
 *   超出射程 → 伤害减半（opts.outOfRange）
 *   守方防御姿态 → 伤害减半（opts.defending）
 *
 * @param {object} attacker 攻击方 stack
 * @param {object} defender 防守方 stack
 * @param {object} [opts] { rng, outOfRange, defending }
 * @returns {number} 伤害值（至少 1）
 */
export function computeDamage(attacker, defender, opts = {}) {
  if (!attacker || !defender) return 0;

  const rng = opts.rng || Math.random;
  const min = attacker.damageMin ?? 1;
  const max = Math.max(attacker.damageMax ?? min, min);
  const roll = min + Math.floor(rng() * (max - min + 1));

  // 基础伤害：单兵伤害 × 数量
  let total = roll * Math.max(1, attacker.count || 1);

  // 攻防差修正
  const atk = stackStat(attacker, 'attack');
  const def = stackStat(defender, 'defense');
  const diff = atk - def;
  let mult = 1;
  if (diff > 0) mult = 1 + Math.min(diff * 0.05, 3);        // 加成上限 +300%
  else if (diff < 0) mult = Math.max(1 + diff * 0.02, 0.3); // 减益下限 30%
  total *= mult;

  // M8：弓术/武勇技能伤害加成（百分比）
  const pct = attacker.damagePct || 0;
  if (pct) total *= 1 + pct / 100;

  // 超出自身射程 → 伤害减半
  if (opts.outOfRange) total *= DAMAGE_MULT.OUT_OF_RANGE;
  // 守方本轮选择防御 → 伤害减半
  if (opts.defending) total *= DAMAGE_MULT.DEFENDING;

  return Math.max(1, Math.round(total));
}

/**
 * 某 stack 本轮可移动到的格子
 *
 * 规则：
 *   - 最多移动 moveRange 格（八方向，每步 1 点行动力）
 *   - 目标格不能被任何单位占据
 *   - 普通单位不能穿过被占据的格；飞行单位（fly）可以穿越（但不能停在上面）
 *   - 本轮已行动（acted）或已移动（moved）的单位不能再次移动
 *
 * @param {object} battle
 * @param {string} stackId
 * @returns {Array<{x:number,y:number}>}
 */
export function movableCells(battle, stackId) {
  const stack = battle?.stacks?.find((s) => s.id === stackId);
  if (!stack || stack.count <= 0) return [];
  if (stack.acted || stack.moved) return [];

  const max = Math.max(0, stack.moveRange || 0);
  if (max <= 0) return [];

  const fly = hasAbility(stack, 'fly');
  const occupied = new Set();
  for (const s of battle.stacks) {
    if (s.id === stackId || s.count <= 0) continue;
    occupied.add(posKey(s.pos));
  }

  const result = [];
  const visited = new Set([posKey(stack.pos)]);
  let frontier = [{ x: stack.pos.x, y: stack.pos.y }];

  for (let step = 0; step < max; step++) {
    const next = [];
    for (const cur of frontier) {
      for (const [dx, dy] of DIRS8) {
        const nx = cur.x + dx;
        const ny = cur.y + dy;
        if (nx < 0 || ny < 0 || nx >= BATTLE_WIDTH || ny >= BATTLE_HEIGHT) continue;
        const k = `${nx},${ny}`;
        if (visited.has(k)) continue;
        visited.add(k);

        if (occupied.has(k)) {
          // 飞行单位可以穿过被占格继续前进，但不能停在那里
          if (fly) next.push({ x: nx, y: ny });
          continue;
        }
        result.push({ x: nx, y: ny });
        next.push({ x: nx, y: ny });
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return result;
}

/**
 * 移动 stack 到目标格（不攻击）
 *
 * 移动只标记 stack.moved = true（表示本轮已移动），**不结束回合**，
 * 因此移动后仍可继续攻击（与英雄无敌一致：移动 + 攻击算同一回合）。
 * 回合推进由调用方显式调用 nextTurn 完成。
 *
 * @param {object} battle
 * @param {string} stackId
 * @param {{x:number,y:number}} to
 * @returns {{ok:boolean, reason?:string, from?:{x:number,y:number}, to?:{x:number,y:number}}}
 */
export function moveStack(battle, stackId, to) {
  if (!battle) return { ok: false, reason: 'noBattle' };
  const stack = battle.stacks.find((s) => s.id === stackId);
  if (!stack) return { ok: false, reason: 'noStack' };
  if (stack.count <= 0) return { ok: false, reason: 'dead' };
  if (stack.acted) return { ok: false, reason: 'acted' };
  // M9：被致盲的 stack 本轮不能行动
  if (isBlinded(stack)) return { ok: false, reason: 'blinded' };
  if (stack.moved) return { ok: false, reason: 'moved' };
  if (!to || typeof to.x !== 'number' || typeof to.y !== 'number') {
    return { ok: false, reason: 'invalidTarget' };
  }

  const cells = movableCells(battle, stackId);
  const hit = cells.find((c) => c.x === to.x && c.y === to.y);
  if (!hit) {
    // 目标格被别的单位占 → occupied；否则距离不够 → tooFar
    const blocker = battle.stacks.find(
      (s) => s.id !== stackId && s.count > 0 && s.pos.x === to.x && s.pos.y === to.y
    );
    return { ok: false, reason: blocker ? 'occupied' : 'tooFar' };
  }

  const from = { x: stack.pos.x, y: stack.pos.y };
  stack.pos = { x: to.x, y: to.y };
  stack.moved = true;
  pushLog(battle, `${stack.unitName} 移动到 (${to.x}, ${to.y})`);

  const result = { ok: true, from, to: { x: to.x, y: to.y } };
  bus.emit('battle:move', { stackId, from, to: result.to });
  return result;
}

/**
 * 某 stack 当前可攻击的目标
 *
 * - 近战（无 ranged）：只能打八方向相邻的敌人
 * - 远程（ranged）：**可攻击范围是全场**，任意敌人都可选；
 *   射程内满攻击力，超出射程则伤害减半（见 computeDamage）
 *
 * 被近身（相邻有敌）**不再封锁**远程的射击，只影响它自己的反击伤害。
 *
 * @param {object} battle
 * @param {string} stackId
 * @returns {string[]} 目标 stack id 数组
 */
export function attackableTargets(battle, stackId) {
  const stack = battle?.stacks?.find((s) => s.id === stackId);
  if (!stack || stack.count <= 0) return [];

  const enemies = battle.stacks.filter((s) => s.side !== stack.side && s.count > 0);
  if (enemies.length === 0) return [];

  const isRanged = hasAbility(stack, 'ranged');
  if (!isRanged) {
    // 近战：只能打相邻
    return enemies.filter((e) => isAdjacent(stack.pos, e.pos)).map((e) => e.id);
  }
  // 远程：全场任选
  return enemies.map((e) => e.id);
}

/**
 * 攻击目标 stack，返回战斗结果明细；含反击逻辑
 *
 * 伤害公式见 computeDamage。
 *
 * 规则要点：
 *   - 近战必须与目标八方向相邻才能攻击
 *   - 远程可攻击全场任意敌人；目标超出自身射程 → 伤害减半
 *   - 反击：守方未反击过、未被全灭、且攻方没有 noRetaliation 时，
 *           守方以自身伤害的一半反击（守方处于防御姿态时不反击）
 *   - 近战守方必须与攻方相邻才能还击；远程守方可远距离还击
 *   - 远程守方被近身时，其反击伤害再减半
 *
 * 本函数**不推进回合**：攻击方标记 acted = true，
 * 由调用方决定何时调用 nextTurn(battle, { action: 'attack' })。
 *
 * @param {object} battle
 * @param {object} [data] 数据表集合（本函数不依赖，保留以兼容契约签名）
 * @param {string} attackerStackId
 * @param {string} defenderStackId
 * @param {object} [opts] { rng }
 * @returns {{
 *   ok:boolean, reason?:string,
 *   damage:number, killed:number,
 *   hits:Array<{damage:number,killed:number}>,
 *   retaliate:{damage:number,killed:number}|null,
 *   outOfRange:boolean, ranged:boolean
 * }}
 */
export function attackStack(battle, data, attackerStackId, defenderStackId, opts = {}) {
  const rng = opts.rng || Math.random;
  const fail = (reason) => ({
    ok: false, reason, damage: 0, killed: 0, hits: [], retaliate: null,
    outOfRange: false, ranged: false
  });

  if (!battle) return fail('noBattle');
  const attacker = battle.stacks.find((s) => s.id === attackerStackId);
  const defender = battle.stacks.find((s) => s.id === defenderStackId);
  if (!attacker) return fail('noStack');
  if (!defender) return fail('noTarget');
  if (attacker.count <= 0) return fail('dead');
  if (defender.count <= 0) return fail('targetDead');
  if (attacker.side === defender.side) return fail('sameSide');
  if (attacker.acted) return fail('acted');
  // M9：被致盲的 stack 本轮不能行动
  if (isBlinded(attacker)) return fail('blinded');

  const isRanged = hasAbility(attacker, 'ranged');
  const adjacent = isAdjacent(attacker.pos, defender.pos);

  // 近战必须相邻才能打；远程全场可打（射程内满伤，超射程减半）
  if (!isRanged && !adjacent) return fail('outOfRange');

  // 目标是否超出攻击者射程
  const outOfRange = isOutOfRange(attacker, defender);

  // 攻击次数：twoAttack 每回合攻击两次
  const hits = [];
  let totalDamage = 0;
  let totalKilled = 0;

  for (let i = 0; i < (hasAbility(attacker, 'twoAttack') ? 2 : 1); i++) {
    if (defender.count <= 0) break;
    const dmg = computeDamage(attacker, defender, {
      rng,
      outOfRange,
      defending: defender.defending
    });
    const { kills } = applyDamage(defender, dmg);
    hits.push({ damage: dmg, killed: kills });
    totalDamage += dmg;
    totalKilled += kills;
  }

  if (hits.length === 0) return fail('noAction');

  pushLog(
    battle,
    `${attacker.unitName} 攻击 ${defender.unitName}，造成 ${totalDamage} 点伤害，击杀 ${totalKilled} 个` +
    (outOfRange ? '（超出射程，伤害减半）' : '')
  );

  // ── 反击 ──
  // 反击规则（对应英雄无敌的"还击"）：
  //   - 守方还活着、本轮未还击过、没在防御姿态、攻方没有 noRetaliation
  //   - 近战守方必须与攻方相邻才能还击（隔空近战不合逻辑）
  //   - 远程守方可以远距离还击（射程即全场）
  //   - 远程守方被近身时，其反击伤害再减半
  let retaliate = null;
  const defenderIsRanged = hasAbility(defender, 'ranged');
  const defenderEngaged = defenderIsRanged && isEngaged(battle, defender);
  const canReach = defenderIsRanged || isAdjacent(defender.pos, attacker.pos);
  const canRetaliate =
    defender.count > 0 &&
    !defender.retaliated &&
    !defender.defending &&               // 防御姿态不反击
    !hasAbility(attacker, 'noRetaliation') &&
    canReach;                            // 近战守方够不着就不能还击
  if (canRetaliate) {
    const counterRaw = computeDamage(defender, attacker, {
      rng,
      outOfRange: isOutOfRange(defender, attacker),
      defending: attacker.defending
    });
    let counterDmg = counterRaw * DAMAGE_MULT.RETALIATION;
    // 被近身的远程单位：反击伤害再减半
    if (defenderEngaged) counterDmg *= DAMAGE_MULT.ENGAGED_RANGED_RETAIL;
    counterDmg = Math.max(1, Math.round(counterDmg));
    const { kills } = applyDamage(attacker, counterDmg);
    retaliate = { damage: counterDmg, killed: kills };
    defender.retaliated = true;
    pushLog(
      battle,
      `${defender.unitName} 反击 ${attacker.unitName}，造成 ${counterDmg} 点伤害，击杀 ${kills} 个` +
      (defenderEngaged ? '（被近身，反击减半）' : '')
    );
  }

  // 攻击方本轮行动完毕
  attacker.acted = true;
  attacker.moved = true;

  const result = {
    ok: true,
    damage: totalDamage,
    killed: totalKilled,
    hits,
    retaliate,
    outOfRange,
    ranged: isRanged
  };
  bus.emit('battle:action', {
    attackerId: attackerStackId,
    defenderId: defenderStackId,
    damage: totalDamage,
    killed: totalKilled,
    retaliate
  });

  return result;
}

/**
 * 当前行动单位能否行动（供界面与 AI 判断）
 * @param {object} battle
 * @param {string} stackId
 * @returns {{ok:boolean, reason?:string}}
 */
export function canAct(battle, stackId) {
  if (!battle) return { ok: false, reason: 'noBattle' };
  if (battle.winner) return { ok: false, reason: 'battleOver' };
  const stack = battle.stacks.find((s) => s.id === stackId);
  if (!stack) return { ok: false, reason: 'noStack' };
  if (stack.count <= 0) return { ok: false, reason: 'dead' };
  if (stack.acted) return { ok: false, reason: 'acted' };
  if (isBlinded(stack)) return { ok: false, reason: 'blinded' };
  return { ok: true };
}

/**
 * 当前"可以操作"的 stack（跳过被致盲的）
 *
 * 界面层用它代替 currentStack：被致盲的 stack 指针虽然还指着它，
 * 但它这一轮不能动，界面不该把操作权交给用户。
 * 若指针处的 stack 被致盲，这里会顺次往后找第一个可行动的。
 *
 * ⚠️ 这是**只读预览**，不产生副作用（不标记 acted、不写战报）。
 *    真正"消费"致盲 stack 的动作发生在 nextTurn / advanceToActionable 里。
 *
 * @param {object} battle
 * @returns {object|null}
 */
export function currentActionableStack(battle) {
  if (!battle || battle.winner) return null;
  const idx = findActionableIndex(battle, battle.currentTurn);
  if (idx < 0) return null;
  const id = battle.turnQueue[idx];
  return battle.stacks.find((s) => s.id === id) || null;
}

/**
 * 从 from 起找第一个可行动（存活、未行动、未致盲）的 stack 下标
 *
 * 与 advanceToActionable 的判定条件保持一致，区别只在于：
 * 这里**不消费**被致盲的 stack（纯查询）。
 *
 * @param {object} battle
 * @param {number} from
 * @returns {number} 找不到返回 -1
 */
function findActionableIndex(battle, from) {
  let i = from;
  let guard = 0;
  while (i < battle.turnQueue.length && guard++ < 1000) {
    const s = battle.stacks.find((x) => x.id === battle.turnQueue[i]);
    if (s && s.count > 0 && !s.acted && !isBlinded(s)) return i;
    i += 1;
  }
  return -1;
}


// ══════════════════════════════════════════════════
// M6c · 战果结算
// ══════════════════════════════════════════════════

/** 经验换算除数：被击败军队总价值 ÷ 该值 = 获得经验 */
export const EXP_DIVISOR = 10;

/**
 * 计算一支军队的总价值（各兵种 aiValue × 数量之和）
 * @param {Array<{unitId:string,count:number}>} army
 * @param {object} data 数据表集合（需要 units）
 * @returns {number}
 */
export function armyValue(army, data) {
  let value = 0;
  for (const a of army || []) {
    const unit = (data?.units || []).find((u) => u.id === a.unitId);
    value += (unit?.aiValue ?? 0) * Math.max(0, Math.floor(a.count || 0));
  }
  return value;
}

/**
 * 统计某一方幸存的军队（按 unitId 合并数量）
 * @param {object} battle
 * @param {'attacker'|'defender'} side
 * @returns {Array<{unitId:string,count:number}>}
 */
export function survivingArmy(battle, side) {
  const merged = new Map();
  for (const s of battle?.stacks || []) {
    if (s.side !== side || s.count <= 0) continue;
    merged.set(s.unitId, (merged.get(s.unitId) || 0) + s.count);
  }
  return [...merged.entries()].map(([unitId, count]) => ({ unitId, count }));
}

/**
 * 战斗结算：把战果写回 state
 *
 * 规则（契约 M6c 定案）：
 *   1. **幸存部队回满血**（英雄无敌规则：战后幸存者治疗满血）
 *   2. **胜方英雄**的军队写回为幸存部队（同 unitId 合并）
 *   3. **败方英雄**从 state.heroes 中移除（战败被俘），其军队全部损失
 *   4. **攻城战**：攻方获胜 → 城镇易主（playerId/faction 改判），守军清空；
 *      攻方战败 → 城镇归属不变，幸存守军写回 town.garrison
 *   5. **经验**：胜方英雄获得 floor(败方军队总价值 / 10) 点经验，可连升多级
 *   6. 败方玩家若因此没有英雄但还有城镇 → 自动补一名新武将（防死锁）
 *   7. 写 state.battle = null，发 bus.emit('battle:resolved', result)
 *
 * @param {object} state GameState
 * @param {object} data 数据表集合
 * @param {object} [opts] { removeLoserHero = true } 败方英雄是否移除
 * @returns {{
 *   ok:boolean, reason?:string,
 *   winner:'attacker'|'defender'|'draw'|null,
 *   winnerPlayerId:number|null, loserPlayerId:number|null,
 *   exp:number, levelUps:number, expHeroId:string|null,
 *   removedHeroes:string[], hiredHeroes:string[],
 *   capturedTownId:string|null,
 *   attackerArmy:Array, defenderArmy:Array
 * }}
 */
export function resolveBattle(state, data, opts = {}) {
  const battle = state?.battle;
  if (!battle) return { ok: false, reason: 'noBattle' };

  // 战斗未结束不许结算
  const winner = battle.winner || checkBattleEnd(battle);
  if (!winner) return { ok: false, reason: 'battleNotOver' };

  const removeLoserHero = opts.removeLoserHero !== false;

  const result = {
    ok: true,
    winner,
    winnerPlayerId: null,
    loserPlayerId: null,
    exp: 0,
    levelUps: 0,
    expHeroId: null,
    removedHeroes: [],
    removedHeroNames: [],
    hiredHeroes: [],
    hiredHeroNames: [],
    capturedTownId: null,
    attackerArmy: [],
    defenderArmy: [],
    // M8：电脑方英雄自动加点的记录
    autoSkillHeroId: null,
    autoSkills: []
  };

  const atkHero = battle.attackerHeroId
    ? state.heroes.find((h) => h.id === battle.attackerHeroId) || null
    : null;
  const defHero = battle.defenderHeroId
    ? state.heroes.find((h) => h.id === battle.defenderHeroId) || null
    : null;

  // 1) 幸存部队回满血
  for (const s of battle.stacks) {
    if (s.count > 0) s.hp = s.maxHp;
  }

  // 2) 统计幸存军队
  const atkArmy = survivingArmy(battle, 'attacker');
  const defArmy = survivingArmy(battle, 'defender');
  result.attackerArmy = atkArmy;
  result.defenderArmy = defArmy;

  // 3) 城镇处理（攻城战）
  const town = battle.defenderTownId
    ? state.towns.find((t) => t.id === battle.defenderTownId) || null
    : null;
  if (town) {
    if (winner === 'attacker') {
      // 攻方攻下城镇：守军全灭，城镇易主（建筑保留）
      const newOwner = state.players.find((p) => p.id === battle.attackerPlayerId);
      town.playerId = battle.attackerPlayerId;
      if (newOwner) town.faction = newOwner.faction;
      town.garrison = [];
      result.capturedTownId = town.id;
      pushLog(battle, `${town.name} 被攻陷！`);
    } else {
      // 守方守住：幸存守军写回驻军
      town.garrison = defArmy.map((a) => ({ ...a }));
    }
  }

  // 4) 写回英雄军队 / 移除败方英雄
  const winnerSide = winner === 'draw' ? null : winner;
  const loserSide = winner === 'attacker' ? 'defender' : (winner === 'defender' ? 'attacker' : null);

  if (winnerSide === 'attacker' && atkHero) {
    atkHero.army = atkArmy.map((a) => ({ ...a }));
  } else if (winnerSide === 'defender' && defHero) {
    defHero.army = defArmy.map((a) => ({ ...a }));
  }

  if (removeLoserHero) {
    // 败方英雄移除（平局则双方都移除）
    const losers = [];
    if (winnerSide === 'attacker') losers.push(defHero);
    else if (winnerSide === 'defender') losers.push(atkHero);
    else losers.push(atkHero, defHero);

    for (const hero of losers) {
      if (!hero) continue;
      const idx = state.heroes.indexOf(hero);
      if (idx < 0) continue;
      state.heroes.splice(idx, 1);
      result.removedHeroes.push(hero.id);
      result.removedHeroNames.push(hero.name);
      pushLog(battle, `${hero.name} 战败被俘！`);
    }
  }

  // 5) 经验结算：胜方英雄获得"败方军队总价值 ÷ 10"点经验
  if (winnerSide && loserSide) {
    const loserArmy = battle.armies?.[loserSide] || [];
    const exp = Math.floor(armyValue(loserArmy, data) / EXP_DIVISOR);
    const winnerHero = winnerSide === 'attacker' ? atkHero : defHero;
    if (winnerHero && exp > 0) {
      const levelUps = gainExp(state, winnerHero.id, exp);
      result.exp = exp;
      result.levelUps = levelUps;
      result.expHeroId = winnerHero.id;
      pushLog(
        battle,
        `${winnerHero.name} 获得 ${exp} 点经验` + (levelUps > 0 ? `，升级 ${levelUps} 次！` : '')
      );

      // M8：电脑方英雄自动加点（玩家方留给界面处理）
      const owner = state.players.find((p) => p.id === winnerHero.playerId);
      if (owner?.isAI && levelUps > 0) {
        result.autoSkillHeroId = winnerHero.id;
        let guard = 0;
        while ((winnerHero.pendingLevels || 0) > 0 && guard++ < 20) {
          const picked = autoChooseSkill(state, data, winnerHero.id);
          if (!picked.ok) break;
          result.autoSkills = result.autoSkills || [];
          result.autoSkills.push({ skillId: picked.skillId, level: picked.level });
        }
      }

      // M9：升级后自动学会本阵营同等级魔法
      if (levelUps > 0) {
        const learned = grantSpellsForLevel(state, winnerHero.id);
        if (learned.length > 0) {
          result.learnedSpells = result.learnedSpells || [];
          result.learnedSpells.push(...learned);
          pushLog(battle, `${winnerHero.name} 学会了新的魔法！`);
        }
      }
    }
  }

  // 6) 败方玩家没有英雄但还有城镇 → 自动补一名新武将（否则玩家会卡死）
  for (const playerId of [battle.attackerPlayerId, battle.defenderPlayerId]) {
    if (playerId == null) continue;
    const hasHero = state.heroes.some((h) => h.playerId === playerId);
    if (hasHero) continue;
    const ownTown = state.towns.find((t) => t.playerId === playerId);
    if (!ownTown) continue;
    // 被俘的英雄名字不再复用（避免"被俘的刘备"又来一个刘备）
    const hired = hireHero(state, data, ownTown.id, { excludeNames: result.removedHeroNames });
    if (hired.ok) {
      result.hiredHeroes.push(hired.hero.id);
      result.hiredHeroNames.push(hired.hero.name);
      pushLog(battle, `${ownTown.name} 补充了新武将 ${hired.hero.name}！`);
    }
  }

  // 7) 胜负玩家 id
  if (winnerSide === 'attacker') {
    result.winnerPlayerId = battle.attackerPlayerId;
    result.loserPlayerId = battle.defenderPlayerId;
  } else if (winnerSide === 'defender') {
    result.winnerPlayerId = battle.defenderPlayerId;
    result.loserPlayerId = battle.attackerPlayerId;
  }

  // 8) 收尾：清空战场、判定全局胜负
  state.battle = null;
  bus.emit('battle:resolved', result);

  const over = checkGameOver(state);
  if (over) bus.emit('game:over', over);

  return result;
}

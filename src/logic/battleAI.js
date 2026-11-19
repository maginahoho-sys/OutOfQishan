import {
  currentStack,
  movableCells,
  moveStack,
  attackStack,
  cellDistance,
  stackRange,
  hasAbility,
  computeDamage,
  isAdjacent,
  isBlinded
} from './battleLogic.js';
import {
  heroSpells,
  canCast,
  hasCastThisTurn,
  spellTargets,
  castSpell
} from './magicLogic.js';

/**
 * battleAI —— 战斗 AI（M10）
 *
 * ── 分层 ────────────────────────────────────────────────────
 *   1. **规划层**（纯函数，不改战场状态）
 *      planTurn(battle, data, stackId) → 行动序列
 *      负责：选谁打（评分）、走到哪（走位评估）
 *   2. **执行层**（改状态，走 M6 的函数）
 *      executeStep(battle, data, step) → 执行单步
 *      aiTakeTurn(battle, data, stackId) → 规划 + 全部执行
 *   3. **兼容层**（M6b 遗留签名，BattleScene 早期在用）
 *      takeTurn(battle, data, stackId) → { action, targetId?, result? }
 *      actIfAI(battle, data, aiPlayerId) → boolean
 *
 * 规划与执行分离，M7 才能把「移动」「攻击」拆开逐步播放动画
 * （一次性全做完的话，移动补间和前冲动画会叠在一起）。
 *
 * ── 策略（契约 M10 定案）────────────────────────────────────
 *   1. **能打到就打**
 *      · 近战：只打八方向相邻的敌人
 *      · 远程：射程内满攻击力，射程外伤害减半
 *      · 选靶优先级：能一击打死 > 射程内 > 集火中 > 远程兵 >
 *                    高价值兵种(aiValue) > 残血
 *   2. **打不到就接近**
 *      · 近战： movableCells 里挑「离最近敌人最近」的格子；
 *        能一步贴上去就移动后立刻开火（移动不结束回合）
 *      · 远程：射程内一个敌人都打不到时，先移动到「能覆盖敌人」的格子
 *        再开火拿满伤害；**绝不主动走进敌人的相邻格**
 *   3. **无牌可打 → 防御**（stack.defending = true）
 *
 * ── 约束 ────────────────────────────────────────────────────
 *   只能通过 M6 导出的函数改战场（moveStack / attackStack / nextTurn），
 *   唯一允许直接写的字段是 `stack.defending`（契约明文允许）。
 *   集火目标存在模块内的 WeakMap 里，不污染 battle 数据（可存档）。
 */

/**
 * 集火目标记录（battle 对象 → 目标 stack id）
 *
 * 用 WeakMap 而不是挂在 battle 上：
 * 契约限定 AI 不得修改 battle 内部字段（defending 除外），
 * 挂 WeakMap 既能让多个 AI 单位共享同一目标，又不会污染战场数据。
 * @type {WeakMap<object, string>}
 */
const focusTargets = new WeakMap();

/**
 * 取当前集火目标 id（该目标已阵亡则自动失效）
 * @param {object} battle
 * @returns {string|null}
 */
export function getFocusTarget(battle) {
  if (!battle) return null;
  const id = focusTargets.get(battle);
  if (!id) return null;
  const s = battle.stacks.find((x) => x.id === id);
  if (!s || s.count <= 0) {
    focusTargets.delete(battle);
    return null;
  }
  return id;
}

/**
 * 记录集火目标
 * @param {object} battle
 * @param {string|null} stackId
 */
export function setFocusTarget(battle, stackId) {
  if (!battle) return;
  if (!stackId) {
    focusTargets.delete(battle);
    return;
  }
  focusTargets.set(battle, stackId);
}

// ══════════════════════════════════════════════════
// 伤害与目标评估
// ══════════════════════════════════════════════════

/**
 * 预估一次攻击能打出的伤害（期望值，不含随机）
 *
 * 直接复用 M6 的 computeDamage，只把随机数换成「取上下限」：
 *   rng=0     → 掷出 damageMin
 *   rng≈1     → 掷出 damageMax
 * 两者取平均 = (damageMin + damageMax) / 2，符合契约预估公式。
 * 这样伤害公式只有一份实现，不会与实际攻击脱节。
 *
 * 另计：
 *   · twoAttack 特性 → 攻击两次，伤害 ×2
 *   · 超出射程（opts.outOfRange）→ 伤害减半（由 computeDamage 处理）
 *   · 目标处于防御姿态（opts.defending）→ 伤害减半（由 computeDamage 处理）
 *
 * @param {object} attacker 攻击方 stack
 * @param {object} defender 防守方 stack
 * @param {object} [opts] { outOfRange, defending }
 * @returns {number} 预估伤害
 */
export function estimateDamage(attacker, defender, opts = {}) {
  if (!attacker || !defender) return 0;
  const lo = computeDamage(attacker, defender, { ...opts, rng: () => 0 });
  const hi = computeDamage(attacker, defender, { ...opts, rng: () => 0.999999 });
  const hits = hasAbility(attacker, 'twoAttack') ? 2 : 1;
  return Math.max(1, ((lo + hi) / 2) * hits);
}

/**
 * 一个 stack 剩余的总生命（队首兵的当前血 + 后面满血的兵）
 *
 * applyDamage 是「队首兵逐个吸收、阵亡后下一个满血补位」，
 * 所以剩余总血 = hp + (count - 1) × maxHp。
 *
 * @param {object} stack
 * @returns {number}
 */
export function stackTotalHp(stack) {
  if (!stack) return 0;
  const maxHp = stack.maxHp || 0;
  return (stack.hp || 0) + Math.max(0, (stack.count || 0) - 1) * maxHp;
}

/**
 * 取兵种的 AI 价值（units.json 的 aiValue 字段）
 * @param {object} data 数据表集合
 * @param {string} unitId
 * @returns {number}
 */
function aiValueOf(data, unitId) {
  const u = (data?.units || []).find((x) => x.id === unitId);
  return u?.aiValue ?? 0;
}

/**
 * 给一个候选目标打分（越高越该打）
 *
 * 权重按契约 M10 的优先级排：
 *   · 一击必杀（预估伤害 ≥ 目标剩余总血）  → 1000
 *   · 在攻击者射程内（满攻击力）            →  400
 *   · 集火中（其他 AI 已经打它）           →  150
 *   · 对方是远程兵（先拆输出点）           →  100
 *   · 兵种价值高（aiValue/10，上限 200）   →    0~200
 *   · 残血（越残越优先补刀）               →    0~80
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {object} attacker 攻击方 stack
 * @param {{x:number,y:number}} attackerPos 攻击方**假设**所在位置（移动后评估用）
 * @param {object} target 候选目标 stack
 * @returns {number}
 */
export function scoreTarget(battle, data, attacker, attackerPos, target) {
  if (!attacker || !target) return 0;

  const outOfRange = cellDistance(attackerPos, target.pos) > stackRange(attacker);
  const dmg = estimateDamage(attacker, target, {
    outOfRange,
    defending: target.defending
  });
  const totalHp = stackTotalHp(target);

  let score = 0;

  // 一击必杀
  if (dmg >= totalHp) score += 1000;
  // 射程内 = 满伤害
  if (!outOfRange) score += 400;
  // 集火：跟着队友一起打同一个目标
  if (getFocusTarget(battle) === target.id) score += 150;
  // 远程兵威胁大，优先拆
  if (hasAbility(target, 'ranged')) score += 100;
  // 兵种价值
  score += Math.min(aiValueOf(data, target.unitId) / 10, 200);
  // 残血优先（按剩余比例）
  const maxTotal = (target.initialCount || target.count || 1) * (target.maxHp || 1);
  if (maxTotal > 0) score += Math.max(0, 1 - totalHp / maxTotal) * 80;

  return score;
}

/**
 * 在候选目标里挑一个最优的
 *
 * 排序完全确定（同分时按 id 排），保证 AI 行为可复现、可测试。
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {object} attacker 攻击方 stack
 * @param {{x:number,y:number}} attackerPos 攻击方假设位置
 * @param {Array<object>} pool 候选目标 stack 数组
 * @returns {object|null}
 */
export function pickTarget(battle, data, attacker, attackerPos, pool) {
  if (!pool || pool.length === 0) return null;
  let best = null;
  let bestScore = -Infinity;
  for (const t of pool) {
    const s = scoreTarget(battle, data, attacker, attackerPos, t);
    if (s > bestScore) {
      bestScore = s;
      best = t;
    }
  }
  return best;
}

// ══════════════════════════════════════════════════
// 规划层（纯函数，不改战场状态）
// ══════════════════════════════════════════════════

/**
 * 规划近战单位的行动
 *
 * 1. 已经贴着敌人 → 直接开火（选最优目标）
 * 2. 没贴着 → 走 movableCells 里最好的格子；
 *    如果这一步能贴上敌人，就追加一次攻击（移动不结束回合）
 * 3. 哪都去不了 → 防御
 *
 * 走位用**切比雪夫距离**（cellDistance，与 moveRange 同一度量，
 * 八方向移动下它才是"几步能到"）而不是契约原文写的曼哈顿距离——
 * 八方向移动时曼哈顿距离会低估可达性。
 *
 * @param {object} battle
 * @param {object} data
 * @param {object} stack
 * @param {Array<object>} enemies
 * @returns {Array<object>} 行动序列
 */
function planMeleeTurn(battle, data, stack, enemies) {
  // 1) 已经能打
  const adjacent = enemies.filter((e) => isAdjacent(stack.pos, e.pos));
  if (adjacent.length > 0) {
    const t = pickTarget(battle, data, stack, stack.pos, adjacent);
    if (t) return [{ type: 'attack', stackId: stack.id, targetId: t.id }];
  }

  // 2) 走过去
  const cells = movableCells(battle, stack.id);
  if (cells.length === 0) {
    return [{ type: 'defend', stackId: stack.id }];
  }

  const curDist = Math.min(...enemies.map((e) => cellDistance(stack.pos, e.pos)));
  let best = null;
  for (const c of cells) {
    const d = Math.min(...enemies.map((e) => cellDistance(c, e.pos)));
    const adj = enemies.filter((e) => isAdjacent(c, e.pos));

    let s = 0;
    if (adj.length > 0) {
      // 移动后能开火：按移动后的位置评估最优目标
      const t = pickTarget(battle, data, stack, c, adj);
      s += 200 + (t ? scoreTarget(battle, data, stack, c, t) : 0);
    }
    s -= d * 20;            // 越近越好
    s -= adj.length * 8;    // 别被围住
    if (d >= curDist) s -= 50; // 没更近就别乱走

    if (!best || s > best.s) best = { cell: c, s };
  }

  if (!best) return [{ type: 'defend', stackId: stack.id }];

  const steps = [{ type: 'move', stackId: stack.id, to: { ...best.cell } }];
  const after = enemies.filter((e) => isAdjacent(best.cell, e.pos));
  if (after.length > 0) {
    const t = pickTarget(battle, data, stack, best.cell, after);
    if (t) steps.push({ type: 'attack', stackId: stack.id, targetId: t.id });
  }
  return steps;
}

/**
 * 规划远程单位的行动
 *
 * 1. 射程内有敌人 → 直接开火（射程内满伤害，优先打这里），**不移动**
 *    （契约：远程兵优先待在能覆盖敌人的位置）
 * 2. 射程内没人 → 移动到「移动后能覆盖到敌人」的格子再开火拿满伤害；
 *    **绝不主动走进敌人的相邻格**（贴脸会被近战打、自己的反击还减半）
 * 3. 一步够不到射程 → 朝敌人推进（仍不进相邻格），到位后照样开火（半伤）
 * 4. 哪都去不了 → 防御
 *
 * @param {object} battle
 * @param {object} data
 * @param {object} stack
 * @param {Array<object>} enemies
 * @returns {Array<object>} 行动序列
 */
function planRangedTurn(battle, data, stack, enemies) {
  const range = stackRange(stack);

  // 1) 射程内有目标 → 就地开火，不动
  const inRange = enemies.filter((e) => cellDistance(stack.pos, e.pos) <= range);
  if (inRange.length > 0) {
    const t = pickTarget(battle, data, stack, stack.pos, inRange);
    if (t) return [{ type: 'attack', stackId: stack.id, targetId: t.id }];
  }

  // 2/3) 走位：先找「能覆盖敌人」的格子，找不到就朝敌人推进
  const cells = movableCells(battle, stack.id);
  if (cells.length === 0) {
    const t = pickTarget(battle, data, stack, stack.pos, enemies);
    if (t) return [{ type: 'attack', stackId: stack.id, targetId: t.id }];
    return [{ type: 'defend', stackId: stack.id }];
  }

  // 候选格：任何情况下都不进敌人相邻格
  const candidates = cells.filter((c) => !enemies.some((e) => isAdjacent(c, e.pos)));
  if (candidates.length === 0) {
    // 全是贴脸格 → 宁可在原地打半伤也不送脸
    const t = pickTarget(battle, data, stack, stack.pos, enemies);
    if (t) return [{ type: 'attack', stackId: stack.id, targetId: t.id }];
    return [{ type: 'defend', stackId: stack.id }];
  }

  const curDist = Math.min(...enemies.map((e) => cellDistance(stack.pos, e.pos)));
  let best = null;
  for (const c of candidates) {
    const covered = enemies.filter((e) => cellDistance(c, e.pos) <= range);
    const nearest = Math.min(...enemies.map((e) => cellDistance(c, e.pos)));
    const travel = cellDistance(stack.pos, c);

    let s;
    if (covered.length > 0) {
      // 能拿到满伤害：优先覆盖更多敌人，其次离敌人远一点（安全），再次少走路
      s = covered.length * 1000 + nearest * 10 - travel * 2;
    } else {
      // 还够不到射程：朝敌人推进（距离越小越好），同样不贴脸
      s = -nearest * 100 - travel * 2;
      if (nearest >= curDist) s -= 50; // 没更近就别乱走
    }
    if (!best || s > best.s) best = { cell: c, s };
  }

  if (!best) {
    const t = pickTarget(battle, data, stack, stack.pos, enemies);
    if (t) return [{ type: 'attack', stackId: stack.id, targetId: t.id }];
    return [{ type: 'defend', stackId: stack.id }];
  }

  const steps = [{ type: 'move', stackId: stack.id, to: { ...best.cell } }];

  // 移动后重新评估射程：能进射程就打满伤害，否则打半伤（远程可打全场）
  const after = enemies.filter((e) => cellDistance(best.cell, e.pos) <= range);
  const pool = after.length > 0 ? after : enemies;
  const t = pickTarget(battle, data, stack, best.cell, pool);
  if (t) steps.push({ type: 'attack', stackId: stack.id, targetId: t.id });
  return steps;
}

/**
 * 规划一个 stack 的完整行动（纯函数，不改任何状态）
 *
 * 返回的行动序列元素形如：
 *   { type:'move',   stackId, to:{x,y} }
 *   { type:'attack', stackId, targetId }
 *   { type:'defend', stackId }
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {string} [stackId] 不给则取 currentStack
 * @returns {Array<object>} 行动序列（空数组表示无事可做）
 */
export function planTurn(battle, data, stackId) {
  if (!battle || battle.winner) return [];
  const stack = stackId
    ? battle.stacks.find((s) => s.id === stackId)
    : currentStack(battle);
  if (!stack || stack.count <= 0 || stack.acted) return [];
  // M9：被致盲的单位本轮不能行动
  if (isBlinded(stack)) return [];

  const enemies = battle.stacks.filter((s) => s.side !== stack.side && s.count > 0);
  if (enemies.length === 0) return [];

  return hasAbility(stack, 'ranged')
    ? planRangedTurn(battle, data, stack, enemies)
    : planMeleeTurn(battle, data, stack, enemies);
}

/**
 * 从行动序列推断出一个概括性的动作名（给 nextTurn 写战报用）
 * @param {Array<object>} steps
 * @returns {'attack'|'move'|'defend'|'wait'}
 */
export function summarizeAction(steps) {
  if (!steps || steps.length === 0) return 'wait';
  const last = steps[steps.length - 1];
  if (last.type === 'attack') return 'attack';
  if (last.type === 'defend') return 'defend';
  return 'move';
}

// ══════════════════════════════════════════════════
// 执行层
// ══════════════════════════════════════════════════

/**
 * 执行行动序列中的一步
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {object} step 行动序列元素
 * @returns {object} 执行结果（含 ok / reason / result）
 */
export function executeStep(battle, data, step) {
  if (!battle || !step) return { ok: false, reason: 'noStep' };

  if (step.type === 'move') {
    const r = moveStack(battle, step.stackId, step.to);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'move',
      stackId: step.stackId,
      from: r.from,
      to: r.to
    };
  }

  if (step.type === 'attack') {
    const r = attackStack(battle, data, step.stackId, step.targetId);
    if (r.ok) setFocusTarget(battle, step.targetId);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'attack',
      stackId: step.stackId,
      targetId: step.targetId,
      result: r
    };
  }

  if (step.type === 'defend') {
    // 契约允许 AI 直接写 defending
    const s = battle.stacks.find((x) => x.id === step.stackId);
    if (s) s.defending = true;
    return { ok: true, type: 'defend', stackId: step.stackId };
  }

  return { ok: false, reason: 'unknownStep' };
}

/**
 * 电脑方一个 stack 的完整回合
 *
 * 规划 + 依次执行，返回**执行后**的行动序列。
 * 序列元素结构与 planTurn 一致，额外带上执行结果：
 *   { type:'move',   stackId, from, to }
 *   { type:'attack', stackId, targetId, result }
 *   { type:'defend', stackId }
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {string} [stackId] 不给则取 currentStack
 * @returns {Array<object>} 行动序列
 */
export function aiTakeTurn(battle, data, stackId) {
  const steps = planTurn(battle, data, stackId);
  const done = [];
  for (const step of steps) {
    const r = executeStep(battle, data, step);
    done.push(r);
    // 一步失败（目标已死/被占）就不再往下走
    if (!r.ok) break;
  }
  return done;
}

// ══════════════════════════════════════════════════
// 兼容层（M6b 起的旧签名）
// ══════════════════════════════════════════════════

/**
 * 让一个 stack 执行一次行动（移动 + 攻击，或只移动，或只攻击，或防御）
 *
 * ⚠️ 旧接口保留：一次性执行完所有步骤，不适合做分步动画。
 *    要逐步播放请用 planTurn + executeStep。
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {string} stackId 要行动的 stack
 * @returns {{action:'attack'|'move'|'defend'|'wait', targetId?:string, result?:object}}
 */
export function takeTurn(battle, data, stackId) {
  const steps = aiTakeTurn(battle, data, stackId);
  if (steps.length === 0) return { action: 'wait' };

  const attack = steps.find((s) => s.type === 'attack' && s.ok);
  if (attack) {
    return { action: 'attack', targetId: attack.targetId, result: attack.result };
  }
  const move = steps.find((s) => s.type === 'move' && s.ok);
  if (move) {
    return { action: 'move', result: move };
  }
  return { action: summarizeAction(steps) };
}

/**
 * 驱动当前行动单位行动（若属于 AI 方）
 * 玩家方的单位返回 false，交由界面处理。
 *
 * @param {object} battle
 * @param {object} data 数据表集合
 * @param {number} aiPlayerId AI 所属玩家 id
 * @returns {boolean} 是否由 AI 处理掉了这一回合
 */
export function actIfAI(battle, data, aiPlayerId) {
  const cur = currentStack(battle);
  if (!cur) return false;
  const playerId = cur.playerId;
  if (playerId === undefined || playerId === null) return false;
  if (playerId !== aiPlayerId) return false;

  takeTurn(battle, data, cur.id);
  return true;
}

// ══════════════════════════════════════════════════
// M9 · 电脑施法
// ══════════════════════════════════════════════════

/**
 * 减益魔法的优先级（越大越优先施放）
 *
 * 致盲（stat='canAct'）收益最高——被致盲的单位整轮不能行动，
 * 等于直接废掉对方一个单位的回合，所以排第一。
 * 其余减益按"减益强度绝对值"排序。
 *
 * @param {object} def 魔法定义
 * @returns {number}
 */
function debuffPriority(def) {
  if (def.effect.stat === 'canAct') return 1000;
  return Math.abs(def.effect.value ?? 0);
}

/**
 * 电脑方施法：每轮至多施法 1 次（由 battle.spellCastThisTurn 控制）
 *
 * 策略（按优先级）：
 *   1. **伤害魔法打残血敌人** —— 优先收割血量百分比最低的敌人
 *   2. **减益魔法** —— 致盲优先（敌人整轮不能动），其次按减益强度
 *   3. **治疗自己人** —— 己方有伤员且治疗量够时才用
 *   4. **增益自己人** —— 己方全员满血时才用（比如群体攻击加成）
 *
 * 不施法的情况：
 *   - 本轮已施过法
 *   - 没有已习得的魔法 / 法力都不够
 *   - 没有任何合法目标
 *
 * @param {object} state GameState
 * @param {object} data 数据表集合
 * @param {string} heroId 施法英雄 id
 * @returns {{ok:boolean, reason?:string, spellId?:string, effectDesc?:string}}
 */
export function aiCastSpell(state, data, heroId) {
  const battle = state?.battle;
  if (!battle) return { ok: false, reason: 'noBattle' };
  if (battle.winner) return { ok: false, reason: 'battleOver' };

  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };

  // 本轮已施法过 → 不再施法
  if (hasCastThisTurn(battle, heroId)) return { ok: false, reason: 'spellLimitReached' };

  const spells = heroSpells(hero).filter((d) => canCast(state, heroId, d.id).ok);
  if (spells.length === 0) return { ok: false, reason: 'noSpell' };

  const side = battle.attackerHeroId === heroId ? 'attacker'
    : battle.defenderHeroId === heroId ? 'defender'
      : null;
  if (!side) return { ok: false, reason: 'notInBattle' };

  const allies = battle.stacks.filter((s) => s.side === side && s.count > 0);
  const enemies = battle.stacks.filter((s) => s.side !== side && s.count > 0);

  // 残血程度：血量百分比越低越"残"（优先打最脆的）
  const hpRatio = (s) => (s.maxHp > 0 ? s.hp / s.maxHp : 0);
  const weakest = (list) => list.slice().sort((a, b) => hpRatio(a) - hpRatio(b))[0];

  // ── 1) 伤害魔法：打残血敌人 ──
  const damageSpells = spells.filter((d) => d.effect.type === 'damage');
  for (const def of damageSpells) {
    const targets = spellTargets(battle, heroId, def.id)
      .map((id) => battle.stacks.find((s) => s.id === id))
      .filter(Boolean);
    if (targets.length === 0) continue;
    const pick = weakest(targets);
    const r = castSpell(state, data, heroId, def.id, pick.id);
    if (r.ok) return { ok: true, spellId: def.id, effectDesc: r.effectDesc };
  }

  // ── 2) 减益魔法：给残血敌人上 ──
  //    致盲（stat='canAct'）收益最高——敌人整轮不能行动，所以排最前
  const debuffSpells = spells
    .filter((d) => d.effect.type === 'debuff')
    .sort((a, b) => debuffPriority(b) - debuffPriority(a));

  for (const def of debuffSpells) {
    const targets = spellTargets(battle, heroId, def.id)
      .map((id) => battle.stacks.find((s) => s.id === id))
      .filter(Boolean);
    if (targets.length === 0) continue;
    // 目标按残血程度排序：越残越优先控住
    const sorted = targets.slice().sort((a, b) => hpRatio(a) - hpRatio(b));
    const r = castSpell(state, data, heroId, def.id, sorted[0].id);
    if (r.ok) return { ok: true, spellId: def.id, effectDesc: r.effectDesc };
  }

  // ── 3) 治疗：己方有伤员才用 ──
  const healSpells = spells.filter((d) => d.effect.type === 'heal' || d.effect.type === 'resurrect');
  const wounded = allies.filter((s) => s.hp < s.maxHp || s.count < (s.initialCount ?? s.count));
  if (wounded.length > 0) {
    for (const def of healSpells) {
      const targets = spellTargets(battle, heroId, def.id)
        .map((id) => battle.stacks.find((s) => s.id === id))
        .filter(Boolean);
      if (targets.length === 0) continue;
      // 优先救最残的
      const pick = weakest(targets);
      const r = castSpell(state, data, heroId, def.id, pick.id);
      if (r.ok) return { ok: true, spellId: def.id, effectDesc: r.effectDesc };
    }
  }

  // ── 4) 增益：己方全员满血时才用 ──
  const buffSpells = spells.filter((d) => d.effect.type === 'buff');
  if (allies.length > 0 && allies.every((s) => s.hp >= s.maxHp && s.count >= (s.initialCount ?? s.count))) {
    for (const def of buffSpells) {
      const targets = spellTargets(battle, heroId, def.id)
        .map((id) => battle.stacks.find((s) => s.id === id))
        .filter(Boolean);
      if (targets.length === 0) continue;
      const r = castSpell(state, data, heroId, def.id, targets[0].id);
      if (r.ok) return { ok: true, spellId: def.id, effectDesc: r.effectDesc };
    }
  }

  return { ok: false, reason: 'noGoodTarget' };
}

/**
 * stackOps —— 战场栈的底层原子操作（纯 JS，禁止 import phaser）
 *
 * 存在的原因：**打破循环依赖**。
 *   - M9 的 magicLogic 需要 M6 的 applyDamage / buildTurnQueue
 *   - M6 的 battleLogic 又需要 M9 的 buffModifier / tickBuffs
 *   两边互相 import 会形成 ESM 循环依赖（加载顺序不确定，运行时会炸）。
 *
 * 所以把"谁都需要、且不依赖任何其他逻辑模块"的基础操作抽到这里：
 *   battleLogic ──▶ stackOps ◀── magicLogic
 *
 * 这里的函数都是纯数据操作，不读 state、不发事件（除 pushLog 那样只写 battle.log）。
 */

/**
 * 往战报里追加一条记录
 * @param {object} battle
 * @param {string} text
 */
export function pushLog(battle, text) {
  if (!battle) return;
  battle.log.push({ text });
}

/**
 * 对一个 stack 施加伤害
 *
 * 伤害由队首兵逐个吸收：先扣队首兵 hp，hp 归零则该兵阵亡、数量-1，
 * 下一个兵以满血补位继续吸收。全灭后剩余伤害无处施加（作废）。
 * （满血时与契约的 floor(伤害/单兵hp) + 余数扣队首 完全等价）
 *
 * @param {object} stack 被攻击的 stack
 * @param {number} damage 伤害值
 * @param {object} [unit] 兵种定义（取单兵满血），不给则用 stack.maxHp
 * @returns {{kills:number, remaining:number}} kills=阵亡兵数，remaining=溢出伤害
 */
export function applyDamage(stack, damage, unit) {
  if (!stack || !(damage > 0)) return { kills: 0, remaining: 0 };
  const maxHp = unit?.hp ?? stack.maxHp ?? 1;
  let remaining = damage;
  let kills = 0;

  while (remaining > 0 && stack.count > 0) {
    if (stack.hp > remaining) {
      stack.hp -= remaining;
      remaining = 0;
    } else {
      remaining -= stack.hp;
      kills += 1;
      stack.count -= 1;
      stack.hp = stack.count > 0 ? maxHp : 0; // 下一个兵满血补位
    }
  }
  return { kills, remaining };
}

/**
 * 查询 stack 某属性的 buff 修正总和（M9 契约导出点）
 *
 * 只统计 stat 匹配的 buff 的 value 之和。
 * 注意：致盲用的是 stat='canAct'、value=0，它不是"数值修正"，
 *       判断被致盲要用 isBlinded()，不要用 buffModifier(stack,'canAct')。
 *
 * @param {object} stack
 * @param {string} stat 属性名（attack/defense/speed/damageMax/...）
 * @returns {number}
 */
export function buffModifier(stack, stat) {
  if (!stack || !stat) return 0;
  let total = 0;
  for (const b of stack.buffs || []) {
    if (b.stat === stat) total += b.value || 0;
  }
  return total;
}

/**
 * 取 stack 的当前属性（含 buff 加成）
 * @param {object} stack
 * @param {'attack'|'defense'|'damageMax'|'speed'|'damageMin'} stat
 * @returns {number}
 */
export function stackStat(stack, stat) {
  if (!stack) return 0;
  return (stack[stat] ?? 0) + buffModifier(stack, stat);
}

/**
 * 取 stack 的当前速度（含 buff 加成）
 * @param {object} stack
 * @returns {number}
 */
export function stackSpeed(stack) {
  return stackStat(stack, 'speed');
}

/**
 * 该 stack 是否处于"致盲"状态（buff stat='canAct' 且 value=0）
 *
 * 致盲的单位本轮不能行动（契约 M9 规则细节）。
 * 用独立判断而不是 buffModifier，因为 canAct 不是可加总的数值属性。
 *
 * @param {object} stack
 * @returns {boolean}
 */
export function isBlinded(stack) {
  if (!stack) return false;
  return (stack.buffs || []).some(
    (b) => b.stat === 'canAct' && (b.value ?? 0) <= 0
  );
}

/**
 * 按速度降序重建出手队列；速度相同则攻方先
 *
 * buff/debuff 改变速度后必须调用它，否则出手顺序不会变
 * （契约 M9 验收标准 2）。
 *
 * ⚠️ 重建会改变数组顺序，而 battle.currentTurn 是**下标**。
 *    所以这里要记住"当前正在行动的是哪个 stack"，重建后把它的下标找回来，
 *    否则施法改变速度会让当前行动单位被偷换成一个别的兵。
 *
 * @param {object} battle
 * @returns {string[]} stack id 数组
 */
export function buildTurnQueue(battle) {
  // 记住当前行动单位（重建前）
  const curId = battle.turnQueue?.[battle.currentTurn] ?? null;

  const list = battle.stacks.map((s, i) => ({ s, i }));
  list.sort((a, b) => {
    const sa = stackSpeed(a.s);
    const sb = stackSpeed(b.s);
    if (sb !== sa) return sb - sa;                                  // 速度降序
    if (a.s.side !== b.s.side) return a.s.side === 'attacker' ? -1 : 1; // 同速攻方先
    return a.i - b.i;                                               // 同方保持原有顺序
  });
  battle.turnQueue = list.map((x) => x.s.id);

  // 重建后把当前行动单位的下标找回来
  if (curId) {
    const idx = battle.turnQueue.indexOf(curId);
    if (idx >= 0) battle.currentTurn = idx;
  }

  return battle.turnQueue;
}

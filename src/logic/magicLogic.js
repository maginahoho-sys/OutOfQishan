import bus from '../core/EventBus.js';
import SPELL_TABLE from '../data/spells.json' with { type: 'json' };
import { applyDamage, buffModifier, isBlinded, buildTurnQueue } from './stackOps.js';
import { skillBonus } from './skillLogic.js';

/**
 * magicLogic —— 魔法系统（纯 JS，禁止 import phaser）
 *
 * 职责：战场施法、buff 生命周期管理、魔法学习与法力恢复。
 *
 * ── 魔法表来源（与 M8 的 skills.json 同理）──────────────────
 *   本模块用 **静态 import** 引入 src/data/spells.json。
 *   原因：契约冻结了 `canCast(state, heroId, spellId)` 的签名（不带 data 参数），
 *   而施法需要知道 manaCost / target / effect。若 canCast 读运行时 data、
 *   castSpell 读静态表，两边不一致会出现"能列出但施不了"的错位。
 *   因此：**魔法定义以静态表为唯一权威源**，data 参数只为契约签名保留。
 * ────────────────────────────────────────────────────────
 *
 * ── 施法规则（M9 定案）──────────────────────────────────
 *   1. 法力消耗 = spells.json 的 manaCost，从 hero.mana 扣。
 *   2. **每方每场战斗每轮限施法 1 次**（记在 battle.spellCastThisTurn，
 *      由 M6 的 nextTurn 在新一轮开始时重置）。
 *   3. 施法**不推进回合**、**不消耗 stack 的行动**，也不触发反击。
 *      施法是"英雄动作"，与 stack 的出手是两条独立的线。
 *   4. 目标类型 target：ally（单个友军）/ enemy（单个敌军）/
 *      allAllies（全体友军）/ allEnemies（全体敌军）。
 *   5. buff/debuff 压入 stack.buffs，格式 { spellId, stat, value, turnsLeft }。
 *   6. 致盲（debuff stat='canAct', value=0）：被致盲的 stack 本轮不能行动，
 *      M6 的 currentStack 会跳过它。
 *   7. 治疗量 = base + perLevel × 英雄等级，再乘「医疗技能」加成。
 *   8. 伤害魔法 = base + perLevel × 英雄等级，**不触发反击**。
 * ────────────────────────────────────────────────────────
 */

/** 魔法定义表（静态，权威源） */
const SPELLS = SPELL_TABLE;

/** spellId → 魔法定义 的索引 */
const SPELL_MAP = new Map(SPELLS.map((s) => [s.id, s]));

/** 契约允许的 effect.type 白名单 */
const EFFECT_TYPES = new Set(['heal', 'damage', 'buff', 'debuff', 'resurrect']);

/** 契约允许的 target 类型白名单 */
const TARGET_TYPES = new Set(['ally', 'enemy', 'allAllies', 'allEnemies']);

/**
 * 查魔法定义
 * @param {string} spellId
 * @returns {object|undefined}
 */
export function getSpellDef(spellId) {
  return SPELL_MAP.get(spellId);
}

/**
 * 列出某个英雄已习得的所有魔法定义
 * @param {object} hero
 * @returns {object[]}
 */
export function heroSpells(hero) {
  if (!hero) return [];
  const ids = hero.spells || [];
  return ids.map((id) => SPELL_MAP.get(id)).filter(Boolean);
}

/**
 * 英雄当前法力是否足够施放某魔法
 *
 * 注意：这里只查「已习得 + 法力够」，不查「本轮是否已施法过」——
 * 那属于战场状态，由 castSpell 检查（因为 canCast 签名不带 battle）。
 *
 * @param {object} state GameState
 * @param {string} heroId 施法英雄
 * @param {string} spellId 魔法 id
 * @returns {{ok:boolean, reason?:'noMana'|'notLearned'|'noHero'|'unknownSpell'}}
 */
export function canCast(state, heroId, spellId) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };

  const def = SPELL_MAP.get(spellId);
  if (!def) return { ok: false, reason: 'unknownSpell' };

  if (!(hero.spells || []).includes(spellId)) {
    return { ok: false, reason: 'notLearned' };
  }
  if ((hero.mana ?? 0) < def.manaCost) {
    return { ok: false, reason: 'noMana' };
  }
  return { ok: true };
}

/**
 * 该英雄本轮是否已经施法过（每方每轮限 1 次）
 * @param {object} battle
 * @param {string} heroId
 * @returns {boolean}
 */
export function hasCastThisTurn(battle, heroId) {
  if (!battle) return false;
  const side = heroSide(battle, heroId);
  if (!side) return false;
  return !!(battle.spellCastThisTurn && battle.spellCastThisTurn[side]);
}

/**
 * 判断英雄在战斗中属于哪一方
 * @param {object} battle
 * @param {string} heroId
 * @returns {'attacker'|'defender'|null}
 */
function heroSide(battle, heroId) {
  if (!battle || !heroId) return null;
  if (battle.attackerHeroId === heroId) return 'attacker';
  if (battle.defenderHeroId === heroId) return 'defender';
  return null;
}

/**
 * 找出某个魔法当前可以作用的目标 stack id 列表
 *
 * - ally      → 施法方一方的存活 stack（单个选择）
 * - enemy    → 对方一方的存活 stack（单个选择）
 * - allAllies → 施法方全部存活 stack
 * - allEnemies → 对方全部存活 stack
 *
 * @param {object} battle
 * @param {string} heroId 施法英雄
 * @param {string} spellId
 * @returns {string[]} stack id 数组（空数组表示没有合法目标）
 */
export function spellTargets(battle, heroId, spellId) {
  const def = SPELL_MAP.get(spellId);
  if (!def || !battle) return [];

  const side = heroSide(battle, heroId);
  if (!side) return [];

  const allies = battle.stacks.filter((s) => s.side === side && s.count > 0);
  const enemies = battle.stacks.filter((s) => s.side !== side && s.count > 0);

  switch (def.target) {
    case 'ally': return allies.map((s) => s.id);
    case 'enemy': return enemies.map((s) => s.id);
    case 'allAllies': return allies.map((s) => s.id);
    case 'allEnemies': return enemies.map((s) => s.id);
    default: return [];
  }
}

/**
 * 施放魔法（战场上）
 *
 * 按 effect.type 执行：
 *   heal      → 目标 stack 回复 base+perLevel×英雄等级 生命（超出上限的部分补回 count，即复活）
 *   damage    → 目标 stack 受伤（走 M6 的击杀计算，不触发反击）
 *   buff/debuff → 往 stack.buffs 压入 { spellId, stat, value, turnsLeft: turns }
 *   resurrect → 同 heal，但可把已阵亡的 count 补回初始数量
 *
 * 施法后：扣法力、标记本轮已施法、重建出手队列（速度被 buff 改过时顺序要变）。
 *
 * @param {object} state GameState
 * @param {object} data 数据表集合（保留以符合契约签名；魔法定义以静态表为准）
 * @param {string} heroId 施法英雄
 * @param {string} spellId 魔法 id
 * @param {string} [targetStackId] target 为 ally/enemy 时必填
 * @returns {{ok:boolean, reason?:string, effectDesc?:string}}
 */
export function castSpell(state, data, heroId, spellId, targetStackId) {
  const fail = (reason) => ({ ok: false, reason });

  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return fail('noHero');

  const def = SPELL_MAP.get(spellId);
  if (!def) return fail('unknownSpell');

  if (!EFFECT_TYPES.has(def.effect?.type)) return fail('unknownEffect');
  if (!TARGET_TYPES.has(def.target)) return fail('unknownTarget');

  const battle = state?.battle;
  if (!battle) return fail('noBattle');
  if (battle.winner) return fail('battleOver');

  // 已习得 + 法力足够
  const castable = canCast(state, heroId, spellId);
  if (!castable.ok) return fail(castable.reason);

  const side = heroSide(battle, heroId);
  if (!side) return fail('notInBattle');

  // 每方每轮限施法 1 次
  if (!battle.spellCastThisTurn) battle.spellCastThisTurn = {};
  if (battle.spellCastThisTurn[side]) return fail('spellLimitReached');

  // 目标解析
  const effect = def.effect;
  const isAOE = def.target === 'allAllies' || def.target === 'allEnemies';
  let targets;

  if (isAOE) {
    const pool = def.target === 'allAllies'
      ? battle.stacks.filter((s) => s.side === side && s.count > 0)
      : battle.stacks.filter((s) => s.side !== side && s.count > 0);
    // 群体魔法没有目标也不该失败（只是没收益），但完全没有目标时拒绝施放
    if (pool.length === 0) return fail('noTarget');
    targets = pool;
  } else {
    const stack = battle.stacks.find((s) => s.id === targetStackId);
    if (!stack) return fail('noTarget');
    if (stack.count <= 0) return fail('targetDead');
    // 校验阵营：ally 必须是本方，enemy 必须是对方
    const wantAlly = def.target === 'ally';
    if (wantAlly && stack.side !== side) return fail('wrongSide');
    if (!wantAlly && stack.side === side) return fail('wrongSide');
    targets = [stack];
  }

  // ── 执行效果 ──
  let effectDesc = '';
  switch (effect.type) {
    case 'heal':
      effectDesc = applyHeal(state, targets, effect, hero);
      break;
    case 'resurrect':
      effectDesc = applyHeal(state, targets, effect, hero);
      break;
    case 'damage':
      effectDesc = applySpellDamage(battle, targets, effect, hero);
      break;
    case 'buff':
    case 'debuff':
      effectDesc = applyBuff(battle, targets, effect, def);
      break;
    default:
      return fail('unknownEffect');
  }

  // ── 结算副作用 ──
  hero.mana = Math.max(0, (hero.mana ?? 0) - def.manaCost);
  battle.spellCastThisTurn[side] = true;

  // 速度被 buff/debuff 改过 → 出手队列要重排
  if (effect.stat === 'speed') buildTurnQueue(battle);

  pushSpellLog(battle, hero, def, effectDesc);

  bus.emit('magic:cast', {
    heroId,
    spellId,
    targetStackId: isAOE ? null : targetStackId,
    effectDesc
  });

  return { ok: true, effectDesc };
}

/**
 * 施法战报
 * @param {object} battle
 * @param {object} hero
 * @param {object} def 魔法定义
 * @param {string} effectDesc
 */
function pushSpellLog(battle, hero, def, effectDesc) {
  battle.log.push({ text: `${hero.name} 施放【${def.name}】：${effectDesc}` });
}

/**
 * 治疗 / 复活效果
 *
 * 治疗量 = (base + perLevel × 英雄等级) × (1 + 医疗技能加成)
 *
 * 治疗优先给"受伤的兵"补血（stack.hp 补到 maxHp），
 * 溢出部分用来补回阵亡的兵（count 增加，最多补到 initialCount）。
 * heal 与 resurrect 用同一套机制，差别只在数据表里的数值
 * （复活是固定 base、不随等级成长）。
 *
 * @param {object} state
 * @param {Array<object>} targets
 * @param {object} effect
 * @param {object} hero 施法英雄（取等级与技能）
 * @returns {string} 效果描述
 */
function applyHeal(state, targets, effect, hero) {
  const level = hero?.level || 1;
  const base = effect.base ?? 0;
  const perLevel = effect.perLevel ?? 0;
  // 医疗技能：每级治疗效果 +20%
  const healBonus = skillBonus(state, hero?.id, 'healBonus');
  let amount = Math.max(1, Math.round((base + perLevel * level) * (1 + healBonus / 100)));

  let totalHealed = 0;
  let totalRevived = 0;
  const names = [];

  for (const stack of targets) {
    names.push(stack.unitName);
    const maxHp = stack.maxHp || 1;

    // 1) 先给还活着的兵补血：stack.hp 补到 maxHp
    if (stack.count > 0) {
      const needHp = maxHp - stack.hp;
      const usedHp = Math.min(amount, Math.max(0, needHp));
      if (usedHp > 0) {
        stack.hp += usedHp;
        amount -= usedHp;
        totalHealed += usedHp;
      }
    }

    // 2) 剩余治疗量用来复活阵亡的兵（每个兵消耗 maxHp 点治疗量）
    const initial = stack.initialCount ?? stack.count;
    if (amount > 0 && initial > stack.count) {
      const canBring = Math.min(initial - stack.count, Math.floor(amount / maxHp));
      if (canBring > 0) {
        stack.count += canBring;
        // 补位的兵是满血的
        if (stack.hp <= 0) stack.hp = maxHp;
        amount -= canBring * maxHp;
        totalRevived += canBring;
      }
    }
  }

  const parts = [];
  if (totalHealed > 0) parts.push(`恢复 ${totalHealed} 点生命`);
  if (totalRevived > 0) parts.push(`复活 ${totalRevived} 个士兵`);
  if (parts.length === 0) parts.push('没有需要恢复的士兵');

  return `${parts.join('，')}（${names.join('、')}）`;
}

/**
 * 伤害魔法效果（不触发反击）
 * @param {object} battle
 * @param {Array<object>} targets
 * @param {object} effect
 * @param {object} hero
 * @returns {string} 效果描述
 */
function applySpellDamage(battle, targets, effect, hero) {
  const level = hero?.level || 1;
  const amount = Math.max(1, Math.round((effect.base ?? 0) + (effect.perLevel ?? 0) * level));

  let totalDamage = 0;
  let totalKilled = 0;
  const names = [];

  for (const stack of targets) {
    names.push(stack.unitName);
    const { kills } = applyDamage(stack, amount);
    totalDamage += amount;
    totalKilled += kills;
  }

  return `对 ${names.join('、')} 造成 ${totalDamage} 点伤害，击杀 ${totalKilled} 个`;
}

/**
 * 增益 / 减益效果
 *
 * 压入 stack.buffs：{ spellId, stat, value, turnsLeft }
 * 同名 stat 的重复 buff 会被替换（取更强的那个），避免叠加失控。
 *
 * @param {object} battle
 * @param {Array<object>} targets
 * @param {object} effect
 * @param {object} def 魔法定义
 * @returns {string} 效果描述
 */
function applyBuff(battle, targets, effect, def) {
  const stat = effect.stat;
  const value = effect.value ?? 0;
  const turns = Math.max(1, effect.turns ?? 1);
  const names = [];

  for (const stack of targets) {
    names.push(stack.unitName);
    if (!Array.isArray(stack.buffs)) stack.buffs = [];

    const existing = stack.buffs.find((b) => b.stat === stat);
    if (existing) {
      // 同属性 buff：取绝对值更大的（增益与减益不互相抵消，按更强的算）
      if (Math.abs(value) > Math.abs(existing.value)) existing.value = value;
      existing.turnsLeft = Math.max(existing.turnsLeft ?? 0, turns);
      existing.spellId = def.id;
    } else {
      stack.buffs.push({
        spellId: def.id,
        stat,
        value,
        turnsLeft: turns
      });
    }
  }

  const sign = value >= 0 ? '+' : '';
  const statName = {
    attack: '攻击',
    defense: '防御',
    speed: '速度',
    damageMax: '每击伤害上限',
    canAct: '行动'
  }[stat] || stat;

  const verb = value >= 0 ? '提升' : '降低';
  return `${names.join('、')} ${statName}${verb} ${Math.abs(value)} 点，持续 ${turns} 回合`;
}

/**
 * 每轮开始时结算 buff：turnsLeft-1，归零移除（由 M6 的 nextTurn 调用）
 *
 * @param {object} battle
 * @returns {number} 本次移除的 buff 数量
 */
export function tickBuffs(battle) {
  if (!battle) return 0;
  let removed = 0;
  for (const s of battle.stacks) {
    if (!Array.isArray(s.buffs) || s.buffs.length === 0) continue;
    const before = s.buffs.length;
    s.buffs = s.buffs
      .map((b) => ({ ...b, turnsLeft: (b.turnsLeft || 0) - 1 }))
      .filter((b) => b.turnsLeft > 0);
    removed += before - s.buffs.length;
  }
  return removed;
}

/**
 * 战斗外每日法力恢复：+5，不超过 maxMana（由 M4 调用）
 *
 * 注意：M4 的 refreshMovePoints 已经做到"每回合回满"，
 * 所以本函数在当前实现下是幂等的；保留它是为了契约完整性与将来
 * 改成"按日恢复"时不必再动逻辑层。
 *
 * @param {object} state
 * @param {string} heroId
 * @returns {{ok:boolean, reason?:string, gained?:number}}
 */
export function dailyManaRegen(state, heroId) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };

  const maxMana = hero.maxMana ?? 10;
  const before = hero.mana ?? 0;
  hero.mana = Math.min(maxMana, before + 5);
  const gained = hero.mana - before;

  if (gained > 0) {
    bus.emit('hero:mana', { heroId, mana: hero.mana, maxMana, gained });
  }
  return { ok: true, gained };
}

/**
 * 英雄升级后自动习得本阵营同等级魔法
 *
 * 规则：英雄等级 ≥ N 时，自动学会本阵营所有 level ≤ N 的魔法（不重复）。
 * 这让"升级"有即时收益，也保证后期魔法（3 级）有获得途径。
 *
 * @param {object} state
 * @param {string} heroId
 * @returns {string[]} 本次新学会的魔法 id
 */
export function grantSpellsForLevel(state, heroId) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return [];

  const faction = hero.faction || inferFaction(state, hero);
  if (!faction) return [];

  const level = hero.level || 1;
  const learned = new Set(hero.spells || []);
  const gained = [];

  for (const spell of SPELLS) {
    if (spell.faction !== faction) continue;
    if (spell.level > level) continue;
    if (learned.has(spell.id)) continue;
    learned.add(spell.id);
    gained.push(spell.id);
  }

  if (gained.length > 0) {
    hero.spells = [...learned];
    bus.emit('hero:spellLearned', { heroId, spellIds: gained });
  }
  return gained;
}

/**
 * 从 playerId 反查阵营
 * @param {object} state
 * @param {object} hero
 * @returns {string|null}
 */
function inferFaction(state, hero) {
  const player = state?.players?.find((p) => p.id === hero.playerId);
  return player?.faction || null;
}

/**
 * 重新导出底层 buff 查询（契约 M9 要求 magicLogic 导出 buffModifier）
 *
 * isBlinded 也一并转出：判断"被致盲"是魔法系统的对外能力，
 * 界面与 AI 都需要它。
 *
 * @param {object} stack
 * @param {string} stat
 * @returns {number}
 */
export { buffModifier, isBlinded };

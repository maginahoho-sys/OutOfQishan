/**
 * 数据表校验脚本（回归用）
 * 用法：node scripts/check-data.mjs
 * 校验 src/data 下五个 JSON 的合法性、交叉引用完整性与数值平衡
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

const failures = [];
const check = (cond, msg) => {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg);
  if (!cond) failures.push(msg);
};

const units = read('units.json');
const spells = read('spells.json');
const skills = read('skills.json');
const buildings = read('buildings.json');
const factions = read('factions.json');

// 兵种
check(units.length === 16, `units 共 ${units.length} 个（应16）`);
check(new Set(units.map((u) => u.id)).size === 16, '兵种 id 无重复');
for (const f of ['shu', 'wei']) {
  for (const t of [1, 2, 3, 4]) {
    const n = units.filter((u) => u.faction === f && u.tier === t).length;
    check(n === 2, `${f} T${t} 兵种数 ${n}（应2）`);
  }
}
const ABILITIES = new Set(['ranged', 'noRetaliation', 'fly', 'twoAttack', 'large']);
for (const u of units) {
  for (const a of u.abilities) check(ABILITIES.has(a), `兵种 ${u.id} 特性 ${a} 合法`);
  check(!u.abilities.includes('large'), `兵种 ${u.id} 未使用 large`);
}

// 射程规则：远程必须有 range 且 ≥2，近战 range 必须是 1
const BATTLE_MAX_RANGE = 10; // 11×9 战场上的最大切比雪夫距离
for (const u of units) {
  const ranged = u.abilities.includes('ranged');
  if (ranged) {
    check(
      Number.isInteger(u.range) && u.range >= 2 && u.range <= BATTLE_MAX_RANGE,
      `远程兵种 ${u.id} range=${u.range} 在 2~${BATTLE_MAX_RANGE} 之间`
    );
  } else {
    check(u.range === 1, `近战兵种 ${u.id} range=1`);
  }
}

// 魔法
const SPELL_TYPES = new Set(['heal', 'damage', 'buff', 'debuff', 'resurrect']);
const SPELL_TARGETS = new Set(['ally', 'enemy', 'allAllies', 'allEnemies']);
const SPELL_STATS = new Set(['attack', 'defense', 'speed', 'damageMax', 'damageMin', 'canAct']);
check(spells.length === 12, `spells 共 ${spells.length} 个（应12）`);
for (const s of spells) check(SPELL_TYPES.has(s.effect.type), `魔法 ${s.id} effect.type 合法`);
for (const f of ['shu', 'wei']) {
  const lv = [1, 2, 3].map((L) => spells.filter((s) => s.faction === f && s.level === L).length);
  check(lv[0] === 3 && lv[1] === 2 && lv[2] === 1, `${f} 各等级魔法数 ${lv.join('/')}（应3/2/1）`);
}
// M9：魔法表结构校验（magicLogic 依赖这些字段）
check(new Set(spells.map((s) => s.id)).size === spells.length, '魔法 id 无重复');
for (const s of spells) {
  check(typeof s.name === 'string' && s.name.length > 0, `魔法 ${s.id} 有中文名`);
  check(['shu', 'wei'].includes(s.faction), `魔法 ${s.id} faction 合法`);
  check(Number.isInteger(s.level) && s.level >= 1 && s.level <= 3, `魔法 ${s.id} level 在 1~3 之间`);
  check(Number.isInteger(s.manaCost) && s.manaCost > 0, `魔法 ${s.id} manaCost 为正整数`);
  check(SPELL_TARGETS.has(s.target), `魔法 ${s.id} target 合法`);
  check(typeof s.desc === 'string' && s.desc.length > 0, `魔法 ${s.id} 有效果说明`);

  const e = s.effect;
  // heal / resurrect / damage 用 base + perLevel；buff / debuff 用 stat + value + turns
  if (e.type === 'heal' || e.type === 'resurrect' || e.type === 'damage') {
    check(Number.isInteger(e.base) && e.base > 0, `魔法 ${s.id} effect.base 为正整数`);
    check(
      e.perLevel === undefined || (Number.isInteger(e.perLevel) && e.perLevel >= 0),
      `魔法 ${s.id} effect.perLevel 为非负整数`
    );
    check(e.stat === undefined && e.turns === undefined, `魔法 ${s.id} 不应带 stat/turns`);
  } else {
    // buff / debuff
    check(SPELL_STATS.has(e.stat), `魔法 ${s.id} effect.stat 合法`);
    check(Number.isInteger(e.value), `魔法 ${s.id} effect.value 为整数`);
    check(Number.isInteger(e.turns) && e.turns >= 1, `魔法 ${s.id} effect.turns ≥ 1`);
    check(e.base === undefined && e.perLevel === undefined, `魔法 ${s.id} 不应带 base/perLevel`);
    // 增益为正、减益为负
    if (e.type === 'buff') check(e.value > 0, `增益魔法 ${s.id} value 为正`);
    // 减益通常为负；但致盲（canAct）是例外：value=0 表示"不能行动"，不是数值修正
    if (e.type === 'debuff' && e.stat !== 'canAct') {
      check(e.value < 0, `减益魔法 ${s.id} value 为负`);
    }
    // 致盲是唯一的 canAct 类减益，value 必须是 0（表示"不能行动"）
    if (e.stat === 'canAct') check(e.value === 0, `魔法 ${s.id} 致盲 value 必须为 0`);
  }
  // 群体魔法必须配群体目标，反之亦然
  const aoe = s.target === 'allAllies' || s.target === 'allEnemies';
  check(
    aoe || s.target === 'ally' || s.target === 'enemy',
    `魔法 ${s.id} target 与效果类型匹配`
  );
}

// 技能
const SKILL_TYPES = new Set([
  'armyAttack', 'armyDefense', 'movePoints', 'mana',
  'goldPerDay', 'rangedDamage', 'meleeDamage', 'healBonus'
]);
check(skills.length === 8, `skills 共 ${skills.length} 个（应8）`);
for (const s of skills) check(SKILL_TYPES.has(s.effect.type), `技能 ${s.id} effect.type 合法`);
// M8：技能表结构校验
for (const s of skills) {
  check(typeof s.maxLevel === 'number' && s.maxLevel >= 1, `技能 ${s.id} maxLevel 为正整数`);
  check(typeof s.effect.perLevel === 'number' && s.effect.perLevel > 0, `技能 ${s.id} effect.perLevel 为正数`);
  check(typeof s.desc === 'string' && s.desc.length > 0, `技能 ${s.id} 有效果说明`);
}
// 每种效果类型至少配一个技能（否则 skillBonus 查询永远返回 0，技能点了没效果）
for (const t of SKILL_TYPES) {
  check(
    skills.some((s) => s.effect.type === t),
    `效果类型 ${t} 至少有一个技能`
  );
}

// 建筑
const unitIds = new Set(units.map((u) => u.id));
const buildingIds = new Set(buildings.map((b) => b.id));
for (const b of buildings) {
  if (b.recruitTier >= 1) check(unitIds.has(b.recruitUnit), `建筑 ${b.id} 的 recruitUnit 存在`);
  for (const r of b.requires || []) check(buildingIds.has(r), `建筑 ${b.id} 前置 ${r} 存在`);
  for (const e of b.excludes || []) check(buildingIds.has(e), `建筑 ${b.id} 互斥 ${e} 存在`);
}
for (const f of ['shu', 'wei']) {
  check(buildings.filter((b) => b.faction === f).length === 8, `${f} 专属建筑 8 个`);
  for (const t of [1, 2, 3, 4]) {
    const tier = buildings.filter((b) => b.faction === f && b.recruitTier === t);
    check(tier.length === 2, `${f} T${t} 招募建筑 2 个`);
    check(
      tier.length === 2 && tier.every((b) => tier.some((x) => x.id === b.excludes?.[0])),
      `${f} T${t} 两建筑双向互斥`
    );
  }
}

// 阵营引用
for (const fa of factions) {
  for (const sp of fa.startSpells) check(spells.some((s) => s.id === sp), `${fa.id} 初始魔法 ${sp} 存在`);
  for (const a of fa.startArmy) check(unitIds.has(a.unitId), `${fa.id} 初始兵种 ${a.unitId} 存在`);
  check(fa.heroPool?.length === 4, `${fa.id} heroPool 4 人`);
}

// 数值平衡
for (const f of ['shu', 'wei']) {
  for (const t of [1, 2, 3]) {
    const lo = Math.min(...units.filter((u) => u.faction === f && u.tier === t).map((u) => u.aiValue));
    const hi = Math.max(...units.filter((u) => u.faction === f && u.tier === t + 1).map((u) => u.aiValue));
    const ratio = hi / lo;
    check(ratio >= 2 && ratio <= 3, `${f} T${t}→T${t + 1} aiValue 增幅 ${ratio.toFixed(2)}×`);
  }
  for (const t of [1, 2, 3, 4]) {
    const v = units.filter((u) => u.faction === f && u.tier === t).map((u) => u.aiValue);
    check(Math.max(...v) / Math.min(...v) <= 1.15, `${f} T${t} 同级 aiValue 接近（${v.join('/')}）`);
  }
}

console.log(failures.length ? `\n❌ ${failures.length} 项未通过` : '\n✅ 数据表全部校验通过');
process.exit(failures.length ? 1 : 0);

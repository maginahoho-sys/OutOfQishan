/**
 * DataLoader —— 游戏数据表加载器
 *
 * 所有策划数据（兵种/魔法/技能/建筑）都是 src/data/*.json，
 * 由 BootScene 在游戏启动时统一加载，之后通过 getXxx() 只读访问。
 *
 * 数据表由 M1 模块按 docs/契约/M1-数据表.md 的格式产出。
 */

/** @type {object|null} 已加载的全部数据表 */
let _data = null;

/**
 * 加载所有数据表（BootScene 调用一次）
 * @returns {Promise<object>} 数据表集合
 */
export async function loadAllData() {
  const [units, spells, skills, buildings, factions, mapDefault] = await Promise.all([
    fetch('/src/data/units.json').then((r) => r.json()),
    fetch('/src/data/spells.json').then((r) => r.json()),
    fetch('/src/data/skills.json').then((r) => r.json()),
    fetch('/src/data/buildings.json').then((r) => r.json()),
    fetch('/src/data/factions.json').then((r) => r.json()),
    fetch('/src/data/map_default.json').then((r) => r.json())
  ]);
  _data = { units, spells, skills, buildings, factions, mapDefault };
  return _data;
}

/** 全部数据表（未加载时返回 null） */
export function allData() {
  return _data;
}

/**
 * 按 id 查兵种定义
 * @param {string} unitId
 * @returns {object|undefined}
 */
export function getUnit(unitId) {
  return _data?.units.find((u) => u.id === unitId);
}

/** 按 id 查魔法定义 */
export function getSpell(spellId) {
  return _data?.spells.find((s) => s.id === spellId);
}

/** 按 id 查技能定义 */
export function getSkill(skillId) {
  return _data?.skills.find((s) => s.id === skillId);
}

/** 按 id 查建筑定义 */
export function getBuilding(buildingId) {
  return _data?.buildings.find((b) => b.id === buildingId);
}

/** 按 id 查阵营定义（'shu' | 'wei'） */
export function getFaction(factionId) {
  return _data?.factions.find((f) => f.id === factionId);
}

import bus from '../core/EventBus.js';
import { canAfford, spendResources } from './turnLogic.js';

/**
 * townLogic —— 城建与招募逻辑（纯 JS，禁止 import phaser）
 *
 * 职责：城镇建筑列表查询、建造建筑、招募兵种到英雄队伍。
 *
 * 规则要点：
 *   - 每座城镇每日最多建造 1 个建筑（town.builtToday，M4 每日重置）
 *   - 建筑需前置建筑（requires）全部建好才能建
 *   - 同级建筑互斥（excludes）：数据表里是双向的，任一方向命中即互斥
 *   - 通用建筑 faction='any'，阵营建筑 faction='shu'|'wei'
 *   - 招募来源为 town.recruitPool（每周按兵种 growth 刷新，M4）
 *   - 英雄军队最多 7 个兵种格，同 unitId 合并数量
 */

/** 英雄军队最多几个兵种格 */
export const MAX_ARMY_SLOTS = 7;

/** 每日建造次数上限 */
export const MAX_BUILD_PER_DAY = 1;

/**
 * 从数据表按 id 查找
 * @param {object} data 数据表集合
 * @param {string} key  表名
 * @param {string} id
 * @returns {object|undefined}
 */
function findIn(data, key, id) {
  return (data?.[key] || []).find((x) => x.id === id);
}

/**
 * 格式化资源花费为可读文本，如 "500金 10木"
 * @param {object} cost
 * @returns {string}
 */
export function formatCost(cost) {
  const names = { gold: '金', wood: '木', ore: '矿', mercury: '汞', sulfur: '硫', crystal: '晶', gem: '宝' };
  return Object.entries(cost || {})
    .map(([res, amount]) => `${amount}${names[res] || res}`)
    .join(' ');
}

/**
 * 查询城镇的建筑列表（含已建 / 不可建及原因）
 *
 * 返回的每一项：
 *   building    建筑数据
 *   built       是否已建成
 *   affordable  资源是否足够（仅在无前置/互斥障碍时才有意义）
 *   buildable   当前是否可以直接建造
 *   reason      不可建原因：built / requireNotMet / excluded / noResource / alreadyBuiltToday
 *
 * @param {object} state
 * @param {object} data  数据表集合
 * @param {string} townId
 * @returns {Array<{building:object, built:boolean, affordable:boolean, buildable:boolean, reason:string|null}>}
 */
export function availableBuildings(state, data, townId) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return [];

  const built = new Set(town.buildings || []);
  const list = [];

  for (const b of data.buildings || []) {
    // 阵营过滤：通用建筑（any）或本城镇阵营专属
    if (b.faction !== 'any' && b.faction !== town.faction) continue;

    const entry = {
      building: b,
      built: built.has(b.id),
      affordable: false,
      buildable: false,
      reason: null
    };

    if (entry.built) {
      entry.reason = 'built';
      list.push(entry);
      continue;
    }

    // 前置未满足
    const missing = (b.requires || []).filter((r) => !built.has(r));
    if (missing.length > 0) {
      entry.reason = 'requireNotMet';
      entry.missing = missing;
      list.push(entry);
      continue;
    }

    // 同级互斥
    if ((b.excludes || []).some((e) => built.has(e))) {
      entry.reason = 'excluded';
      list.push(entry);
      continue;
    }

    // 每日建造次数已用完
    if ((town.builtToday || 0) >= MAX_BUILD_PER_DAY) {
      entry.reason = 'alreadyBuiltToday';
      entry.affordable = canAfford(state, town.playerId, b.cost);
      list.push(entry);
      continue;
    }

    // 资源是否足够
    entry.affordable = canAfford(state, town.playerId, b.cost);
    if (!entry.affordable) {
      entry.reason = 'noResource';
      list.push(entry);
      continue;
    }

    entry.buildable = true;
    list.push(entry);
  }

  return list;
}

/**
 * 建造建筑
 * @param {object} state
 * @param {object} data 数据表集合
 * @param {string} townId
 * @param {string} buildingId
 * @returns {{ok:boolean, reason?:string}}
 *   reason: notFound / wrongFaction / alreadyBuilt / requireNotMet / excluded /
 *           alreadyBuiltToday / noResource
 */
export function construct(state, data, townId, buildingId) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return { ok: false, reason: 'notFound' };

  const building = findIn(data, 'buildings', buildingId);
  if (!building) return { ok: false, reason: 'notFound' };
  if (building.faction !== 'any' && building.faction !== town.faction) {
    return { ok: false, reason: 'wrongFaction' };
  }

  const built = new Set(town.buildings || []);
  if (built.has(buildingId)) return { ok: false, reason: 'alreadyBuilt' };
  if ((building.requires || []).some((r) => !built.has(r))) {
    return { ok: false, reason: 'requireNotMet' };
  }
  if ((building.excludes || []).some((e) => built.has(e))) {
    return { ok: false, reason: 'excluded' };
  }
  if ((town.builtToday || 0) >= MAX_BUILD_PER_DAY) {
    return { ok: false, reason: 'alreadyBuiltToday' };
  }

  const paid = spendResources(state, town.playerId, building.cost);
  if (!paid.ok) return { ok: false, reason: 'noResource' };

  town.buildings = [...(town.buildings || []), buildingId];
  town.builtToday = (town.builtToday || 0) + 1;

  // 招募类建筑建成后，立刻把该兵种补进本周产量（否则要等到下周才能招）
  if (building.recruitTier && building.recruitUnit) {
    const unit = findIn(data, 'units', building.recruitUnit);
    addPoolUnit(town, building.recruitUnit, unit?.growth ?? 0);
    bus.emit('recruit:pool', { pools: [{ townId: town.id, pool: town.recruitPool }] });
  }

  bus.emit('town:built', { townId, buildingId });
  return { ok: true };
}

/**
 * 向城镇产量池追加一个兵种（已存在则不重复添加）
 * @param {object} town
 * @param {string} unitId
 * @param {number} count
 */
function addPoolUnit(town, unitId, count) {
  town.recruitPool = town.recruitPool || [];
  if (town.recruitPool.some((p) => p.unitId === unitId)) return;
  town.recruitPool.push({ unitId, count });
}

/**
 * 招募兵种到英雄队伍
 * @param {object} state
 * @param {object} data 数据表集合
 * @param {string} townId
 * @param {string} heroId
 * @param {string} unitId
 * @param {number} count 招募数量（正整数）
 * @returns {{ok:boolean, reason?:string}}
 *   reason: notFound / heroNotFound / heroNotInTown / wrongOwner / notAvailable /
 *           invalidCount / poolEmpty / armyFull / noResource
 */
export function recruit(state, data, townId, heroId, unitId, count) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return { ok: false, reason: 'notFound' };

  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'heroNotFound' };

  // 英雄必须站在城镇格上才算进城
  if (hero.pos.x !== town.pos.x || hero.pos.y !== town.pos.y) {
    return { ok: false, reason: 'heroNotInTown' };
  }
  if (hero.playerId !== town.playerId) return { ok: false, reason: 'wrongOwner' };

  // 本城必须已建对应的招募建筑
  const builtIds = town.buildings || [];
  const building = (data.buildings || []).find(
    (b) => b.recruitUnit === unitId && builtIds.includes(b.id)
  );
  if (!building) return { ok: false, reason: 'notAvailable' };

  const unit = findIn(data, 'units', unitId);
  if (!unit) return { ok: false, reason: 'notFound' };

  const n = Math.floor(count);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'invalidCount' };

  // 产量池
  const pool = town.recruitPool || [];
  const slot = pool.find((p) => p.unitId === unitId);
  if (!slot || slot.count < n) return { ok: false, reason: 'poolEmpty' };

  // 军队格数上限（同兵种合并，不占新格）
  hero.army = hero.army || [];
  const existing = hero.army.find((a) => a.unitId === unitId);
  if (!existing && hero.army.length >= MAX_ARMY_SLOTS) {
    return { ok: false, reason: 'armyFull' };
  }

  // 资源
  const cost = {};
  for (const [res, price] of Object.entries(unit.cost || {})) {
    cost[res] = price * n;
  }
  const paid = spendResources(state, hero.playerId, cost);
  if (!paid.ok) return { ok: false, reason: 'noResource' };

  // 扣产量、加军队
  slot.count -= n;
  if (existing) existing.count += n;
  else hero.army.push({ unitId, count: n });

  bus.emit('army:changed', { heroId });
  bus.emit('recruit:pool', { pools: [{ townId: town.id, pool: town.recruitPool }] });
  return { ok: true, unitId, count: n };
}

/**
 * 城镇可招募的兵种列表（只列已建招募建筑对应、且产量池里还有货的兵种）
 * @param {object} state
 * @param {object} data
 * @param {string} townId
 * @returns {Array<{unit:object, poolCount:number, maxCount:number, costText:string, unitCost:object}>}
 */
export function recruitOptions(state, data, townId) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return [];
  const builtIds = town.buildings || [];
  const out = [];

  for (const slot of town.recruitPool || []) {
    if (slot.count <= 0) continue;
    const building = (data.buildings || []).find(
      (b) => b.recruitUnit === slot.unitId && builtIds.includes(b.id)
    );
    if (!building) continue;
    const unit = findIn(data, 'units', slot.unitId);
    if (!unit) continue;
    out.push({
      unit,
      poolCount: slot.count,
      maxCount: slot.count,
      unitCost: unit.cost || {},
      costText: formatCost(unit.cost)
    });
  }
  return out;
}

/**
 * 在城镇招募一名新武将
 *
 * 用途（M6c）：战败英雄被移除后，若某玩家已无英雄但还有城镇，
 * 自动补一名新武将到自己的城镇，避免玩家卡死（无法进城、无法招募）。
 *
 * 规则：
 *   - 武将名字取自 factions.json 的 heroPool，按顺序取第一个还没在场的
 *   - opts.excludeNames 里的名字会被跳过（用于避免"被俘的刘备"又来一个刘备）
 *   - 新武将站在城镇格上（这样玩家点城镇就能进城）
 *   - 新武将没有军队，需要自己招募兵种
 *   - 初始魔法沿用阵营的 startSpells
 *
 * @param {object} state
 * @param {object} data 数据表集合
 * @param {string} townId
 * @param {object} [opts] { excludeNames: string[] }
 * @returns {{ok:boolean, reason?:string, hero?:object}}
 *   reason: notFound / noHeroAvailable
 */
export function hireHero(state, data, townId, opts = {}) {
  const town = state.towns.find((t) => t.id === townId);
  if (!town) return { ok: false, reason: 'notFound' };

  const faction = (data.factions || []).find((f) => f.id === town.faction);
  const pool = faction?.heroPool || [];

  // 已经在场的名字、以及本次要避开的名字都不能再用
  const used = new Set(state.heroes.map((h) => h.name));
  for (const n of opts.excludeNames || []) used.add(n);

  let name = pool.find((n) => !used.has(n));
  if (!name) {
    // 武将池用完（或数据表没配 heroPool）→ 生成后备武将，避免玩家彻底卡死
    let n = 1;
    while (used.has(`义士${n}`)) n += 1;
    name = `义士${n}`;
  }

  // id 用同阵营的最大序号 +1，避免与现存英雄冲突
  let maxIdx = 0;
  const re = new RegExp(`^hero_${town.faction}_(\\d+)$`);
  for (const h of state.heroes) {
    const m = h.id.match(re);
    if (m) maxIdx = Math.max(maxIdx, Number(m[1]));
  }

  const hero = {
    id: `hero_${town.faction}_${maxIdx + 1}`,
    playerId: town.playerId,
    name,
    level: 1,
    exp: 0,
    pendingLevels: 0,
    movePoints: 20,
    maxMovePoints: 20,
    mana: 10,
    maxMana: 10,
    pos: { x: town.pos.x, y: town.pos.y },
    skills: {},
    spells: [...(faction?.startSpells || [])],
    army: []
  };

  state.heroes.push(hero);
  bus.emit('hero:hired', { heroId: hero.id, townId: town.id, name: hero.name });
  return { ok: true, hero };
}

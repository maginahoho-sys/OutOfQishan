import bus from '../core/EventBus.js';
import { skillBonus, BASE_MOVE_POINTS, BASE_MANA } from './skillLogic.js';
import { dailyManaRegen } from './magicLogic.js';

/**
 * turnLogic —— 回合与资源逻辑（纯 JS，禁止 import phaser）
 *
 * 职责：回合推进、每日资源结算、每周兵种产量刷新、胜负判定。
 *
 * 回合流程（endTurn）：
 *   当前玩家回合结束 → 发 'turn:end'
 *   → 切换到下一玩家
 *   → 若切回 0 号玩家（人类）：日期推进一天，发 'day:new'（跨周则刷新产量）
 *   → 新玩家回合开始：结算日收入、恢复行动力与法力，发 'turn:start'
 *   → 胜负判定，结束则发 'game:over'
 *
 * M8 起：行动力 / 法力 / 每日金币的加成一律走 skillLogic.skillBonus 查询，
 *        数值口径只保留在 src/data/skills.json 一处（perLevel）。
 */

/** 一周天数 */
const DAYS_PER_WEEK = 7;

/**
 * 从数据表按 id 查找
 * @param {object} data 数据表集合
 * @param {string} key  表名（units/spells/skills/buildings/factions）
 * @param {string} id
 * @returns {object|undefined}
 */
function findIn(data, key, id) {
  return (data?.[key] || []).find((x) => x.id === id);
}

/**
 * 每日资源结算：城镇建筑收入 + 理财技能加成
 * @param {object} state
 * @param {object} data  数据表集合
 * @param {number} playerId
 * @returns {object} 本次获得的资源 { gold: 500, ... }
 */
export function dailyIncome(state, data, playerId) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return {};

  const gain = {};

  // 城镇建筑收入
  for (const town of state.towns) {
    if (town.playerId !== playerId) continue;
    for (const buildingId of town.buildings || []) {
      const building = findIn(data, 'buildings', buildingId);
      if (!building || !building.income) continue;
      for (const [res, amount] of Object.entries(building.income)) {
        gain[res] = (gain[res] || 0) + amount;
      }
    }
  }

  // 技能加成：理财（goldPerDay 效果类型的技能等级 × perLevel）
  for (const hero of state.heroes) {
    if (hero.playerId !== playerId) continue;
    const bonus = skillBonus(state, hero.id, 'goldPerDay');
    if (bonus > 0) gain.gold = (gain.gold || 0) + bonus;
  }

  // 入账
  for (const [res, amount] of Object.entries(gain)) {
    player[res] = (player[res] || 0) + amount;
  }

  bus.emit('resource:changed', { playerId, resources: gain });
  return gain;
}

/**
 * 恢复玩家的行动力与法力
 * 行动力 = 20 + movePoints 类技能加成；法力每回合回满，上限 = 10 + mana 类技能加成
 * @param {object} state
 * @param {object} data
 * @param {number} playerId
 */
export function refreshMovePoints(state, data, playerId) {
  for (const hero of state.heroes) {
    if (hero.playerId !== playerId) continue;
    hero.maxMovePoints = BASE_MOVE_POINTS + skillBonus(state, hero.id, 'movePoints');
    hero.movePoints = hero.maxMovePoints;
    hero.maxMana = BASE_MANA + skillBonus(state, hero.id, 'mana');
    hero.mana = hero.maxMana;
  }
}

/**
 * 每周刷新各城镇的可招募数量
 * 数量 = 对应兵种的 growth；来源为城镇已建成的招募建筑
 * @param {object} state
 * @param {object} data
 */
export function weeklyRecruitPool(state, data) {
  for (const town of state.towns) {
    const pool = [];
    for (const buildingId of town.buildings || []) {
      const building = findIn(data, 'buildings', buildingId);
      if (!building || !building.recruitTier || !building.recruitUnit) continue;
      if (pool.some((p) => p.unitId === building.recruitUnit)) continue;
      const unit = findIn(data, 'units', building.recruitUnit);
      pool.push({ unitId: building.recruitUnit, count: unit?.growth ?? 0 });
    }
    town.recruitPool = pool;
  }
  bus.emit('recruit:pool', {
    pools: state.towns.map((t) => ({ townId: t.id, pool: t.recruitPool }))
  });
}

/**
 * 新的一天开始：重置各城镇当日建造次数（M5 规则：每城每日限建 1 个）
 * @param {object} state
 */
export function resetDailyBuilds(state) {
  for (const town of state.towns) town.builtToday = 0;
}

/**
 * 判断游戏是否结束：某玩家失去所有城镇且所有英雄
 * @param {object} state
 * @returns {{winnerId:number|null, reason:string}|null}
 */
export function checkGameOver(state) {
  for (const player of state.players) {
    const hasTown = state.towns.some((t) => t.playerId === player.id);
    const hasHero = state.heroes.some((h) => h.playerId === player.id);
    if (!hasTown && !hasHero) {
      const winner = state.players.find((p) => p.id !== player.id);
      const result = {
        winnerId: winner ? winner.id : null,
        reason: `${player.faction === 'shu' ? '蜀汉' : '曹魏'}势力覆灭`
      };
      state.gameOver = result;
      return result;
    }
  }
  return null;
}

/**
 * 结束当前玩家的回合并推进到下一玩家
 * @param {object} state
 * @param {object} data  数据表集合
 * @returns {{winnerId:number|null, reason:string}|null} 游戏结束时返回胜负结果
 */
export function endTurn(state, data) {
  const oldPlayerId = state.meta.currentPlayer;
  bus.emit('turn:end', { playerId: oldPlayerId });

  // 切换玩家
  const nextPlayerId = (oldPlayerId + 1) % state.players.length;
  state.meta.currentPlayer = nextPlayerId;

  // 切回人类玩家 → 新的一天
  if (nextPlayerId === 0) {
    state.meta.day += 1;
    if (state.meta.day > DAYS_PER_WEEK) {
      state.meta.day = 1;
      state.meta.week += 1;
      weeklyRecruitPool(state, data); // 新的一周刷新兵种产量
    }
    resetDailyBuilds(state); // 新的一天，每城可再建造 1 个建筑
    // M9：每日法力恢复（当前 refreshMovePoints 已做到"每回合回满"，
    //     所以这一步实际上是幂等的；保留调用是为了契约完整性）
    for (const hero of state.heroes) dailyManaRegen(state, hero.id);
    bus.emit('day:new', { day: state.meta.day, week: state.meta.week });
  }

  // 新玩家回合开始：结算收入、恢复行动力
  dailyIncome(state, data, nextPlayerId);
  refreshMovePoints(state, data, nextPlayerId);
  bus.emit('turn:start', { playerId: nextPlayerId });

  // 胜负判定
  const over = checkGameOver(state);
  if (over) bus.emit('game:over', over);
  return over;
}

/**
 * 玩家资源是否足够支付花费
 * @param {object} state
 * @param {number} playerId
 * @param {object} cost  如 { gold: 500, wood: 5 }
 * @returns {boolean}
 */
export function canAfford(state, playerId, cost) {
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !cost) return false;
  for (const [res, amount] of Object.entries(cost)) {
    if ((player[res] || 0) < amount) return false;
  }
  return true;
}

/**
 * 扣除玩家资源（调用前请先用 canAfford 判断）
 * @param {object} state
 * @param {number} playerId
 * @param {object} cost
 * @returns {{ok:boolean, reason?:string}}
 */
export function spendResources(state, playerId, cost) {
  if (!canAfford(state, playerId, cost)) return { ok: false, reason: 'noResource' };
  const player = state.players.find((p) => p.id === playerId);
  for (const [res, amount] of Object.entries(cost || {})) {
    player[res] = (player[res] || 0) - amount;
  }
  bus.emit('resource:changed', { playerId, resources: cost });
  return { ok: true };
}

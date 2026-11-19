/**
 * GameState —— 全局唯一游戏状态（纯数据，可 JSON 序列化）
 *
 * 设计约束（所有模块必须遵守）：
 * 1. 状态里只放纯数据（对象/数组/字符串/数字），禁止放 Phaser 对象、函数、类实例。
 * 2. 任何模块修改状态后，通过 EventBus 发事件通知渲染层刷新。
 * 3. 存档（M12）= JSON.stringify(state)；读档 = JSON.parse + 校验版本号。
 *
 * 数据结构总览见 docs/契约/M0-状态结构.md
 */

/** 状态版本号，结构变动时 +1（存档兼容性判断用） */
export const STATE_VERSION = 1;

/**
 * 创建一局新游戏的初始状态
 * @param {object} mapData 地图数据（M2 定义的格式）
 * @returns {object} 初始 GameState
 */
export function createNewGame(mapData) {
  return {
    version: STATE_VERSION,
    meta: {
      day: 1,          // 总天数
      week: 1,         // 第几周（每周一兵种产量刷新）
      currentPlayer: 0 // 当前行动玩家下标
    },
    // 玩家：0 = 人类（蜀汉/生命），1 = 电脑（曹魏/守序）
    players: [
      { id: 0, faction: 'shu',  isAI: false, gold: 10000, wood: 20, ore: 20, mercury: 5, sulfur: 5, crystal: 5, gem: 5 },
      { id: 1, faction: 'wei',  isAI: true,  gold: 10000, wood: 20, ore: 20, mercury: 5, sulfur: 5, crystal: 5, gem: 5 }
    ],
    // 英雄列表
    // hero: { id, playerId, name, level, exp, movePoints, maxMovePoints,
    //         pos: {x,y}, skills: {skillId: level}, spells: [spellId],
    //         army: [{ unitId, count }] }   // army 最多 7 格
    heroes: [],
    // 城镇列表
    // town: { id, playerId, faction, name, pos: {x,y}, buildings: [buildingId], garrison: [{unitId,count}] }
    towns: [],
    // 地图（由 M2 地图逻辑生成/校验）
    map: mapData,
    // 战斗状态：非战斗时为 null；战斗中由 M6 战场逻辑维护
    battle: null,
    // 游戏结束标记：null | { winnerId, reason }
    gameOver: null
  };
}

/**
 * 便捷取值：当前行动玩家
 * @param {object} state
 * @returns {object}
 */
export function currentPlayer(state) {
  return state.players[state.meta.currentPlayer];
}

/**
 * 便捷取值：某玩家的所有英雄
 * @param {object} state
 * @param {number} playerId
 * @returns {Array}
 */
export function heroesOf(state, playerId) {
  return state.heroes.filter((h) => h.playerId === playerId);
}

/**
 * 便捷取值：某玩家的所有城镇
 * @param {object} state
 * @param {number} playerId
 * @returns {Array}
 */
export function townsOf(state, playerId) {
  return state.towns.filter((t) => t.playerId === playerId);
}

/**
 * setup —— 初始兵力布置（M0 骨架内置，属于"开局面"逻辑）
 *
 * 职责：根据数据表给双方玩家生成开局英雄和城镇，写入 state。
 * 本文件属于逻辑层：纯 JS，不 import Phaser。
 */

import { weeklyRecruitPool } from './turnLogic.js';
import { grantSpellsForLevel } from './magicLogic.js';

/**
 * 布置双方初始英雄与城镇
 * @param {object} state GameState（会被原地修改）
 * @param {object} data  数据表集合
 */
export function buildInitialForces(state, data) {
  const map = state.map;

  // 从地图数据里读开局点（map_default.json 中定义）
  for (const start of map.starts) {
    const faction = data.factions.find((f) => f.id === start.faction);
    const player = state.players.find((p) => p.faction === start.faction);

    // 开局英雄：带两队 T1 兵
    const hero = {
      id: `hero_${start.faction}_0`,
      playerId: player.id,
      faction: start.faction,   // M9：判定可学魔法用
      name: faction.heroName,
      level: 1,
      exp: 0,
      pendingLevels: 0,   // 待加技能点次数（M8 消耗）
      movePoints: 20,
      maxMovePoints: 20,
      mana: 10,
      maxMana: 10,
      pos: { ...start.heroPos },
      skills: {},
      spells: [...(faction.startSpells || [])],
      army: faction.startArmy.map((a) => ({ ...a }))
    };
    state.heroes.push(hero);

    // M9：补齐本阵营 1 级魔法（startSpells 只是起步的那几个）
    grantSpellsForLevel(state, hero.id);

    // 开局城镇：只带大本营
    state.towns.push({
      id: `town_${start.faction}_0`,
      playerId: player.id,
      faction: start.faction,
      name: faction.townName,
      pos: { ...start.townPos },
      buildings: ['hall'],
      recruitPool: [],
      builtToday: 0,   // 当日已建造次数（M5 用）
      garrison: []
    });
  }

  // 初始化第一周的兵种产量（M4）
  weeklyRecruitPool(state, data);
}

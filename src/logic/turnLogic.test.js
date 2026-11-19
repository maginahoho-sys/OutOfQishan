import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  endTurn,
  dailyIncome,
  refreshMovePoints,
  weeklyRecruitPool,
  checkGameOver,
  canAfford,
  spendResources
} from './turnLogic.js';
import bus from '../core/EventBus.js';

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const data = {
  units: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'units.json'), 'utf8')),
  spells: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'spells.json'), 'utf8')),
  skills: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'skills.json'), 'utf8')),
  buildings: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'buildings.json'), 'utf8')),
  factions: JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'factions.json'), 'utf8'))
};

/** 构造测试用 state */
function makeState() {
  return {
    meta: { day: 1, week: 1, currentPlayer: 0 },
    players: [
      { id: 0, faction: 'shu', isAI: false, gold: 1000, wood: 20, ore: 20, mercury: 5, sulfur: 5, crystal: 5, gem: 5 },
      { id: 1, faction: 'wei', isAI: true, gold: 1000, wood: 20, ore: 20, mercury: 5, sulfur: 5, crystal: 5, gem: 5 }
    ],
    heroes: [
      { id: 'hero_shu_0', playerId: 0, name: '刘备', movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10, pos: { x: 3, y: 13 }, skills: {}, army: [] },
      { id: 'hero_wei_0', playerId: 1, name: '曹操', movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10, pos: { x: 26, y: 4 }, skills: {}, army: [] }
    ],
    towns: [
      { id: 'town_shu_0', playerId: 0, faction: 'shu', name: '成都', pos: { x: 2, y: 14 }, buildings: ['hall'], recruitPool: [], garrison: [] },
      { id: 'town_wei_0', playerId: 1, faction: 'wei', name: '许昌', pos: { x: 27, y: 3 }, buildings: ['hall'], recruitPool: [], garrison: [] }
    ],
    gameOver: null
  };
}

test('验收1：日收入累加正确（城镇建筑 + 理财技能）', () => {
  const state = makeState();
  // 成都只有大本营：每日 500 金
  const gain1 = dailyIncome(state, data, 0);
  assert.equal(gain1.gold, 500);
  assert.equal(state.players[0].gold, 1500, '金币应累加到 1000+500');

  // 加上内政厅：500+1000=1500
  state.towns[0].buildings.push('manor');
  const gain2 = dailyIncome(state, data, 0);
  assert.equal(gain2.gold, 1500);
  assert.equal(state.players[0].gold, 3000);

  // 理财技能 2 级：额外 400 金
  state.heroes[0].skills.finance = 2;
  const gain3 = dailyIncome(state, data, 0);
  assert.equal(gain3.gold, 1900, '1500 + 2×200');
});

test('验收1b：resource:changed 事件带资源明细', () => {
  const state = makeState();
  let payload = null;
  const off = bus.on('resource:changed', (p) => { payload = p; });
  dailyIncome(state, data, 0);
  off();
  assert.ok(payload, '应发出 resource:changed');
  assert.equal(payload.playerId, 0);
  assert.equal(payload.resources.gold, 500);
});

test('验收2：周末到下周一刷新兵种产量', () => {
  const state = makeState();
  state.towns[0].buildings.push('shu_barracks1');
  state.meta.day = 7;
  state.meta.week = 1;

  // 第一次 endTurn：切到 AI 玩家，日期不变
  endTurn(state, data);
  assert.equal(state.meta.currentPlayer, 1);
  assert.equal(state.meta.day, 7);

  // 第二次 endTurn：切回玩家 0 → 跨周，week+1，day 回到 1
  endTurn(state, data);
  assert.equal(state.meta.currentPlayer, 0);
  assert.equal(state.meta.day, 1);
  assert.equal(state.meta.week, 2, '跨周后周数应 +1');

  // 产量已刷新：民兵营 → 乡勇 growth=20
  const pool = state.towns[0].recruitPool;
  assert.ok(Array.isArray(pool), 'recruitPool 应存在');
  assert.equal(pool.length, 1);
  assert.equal(pool[0].unitId, 'shu_militia');
  assert.equal(pool[0].count, 20, '产量应为兵种 growth');
});

test('验收2b：weeklyRecruitPool 按已建招募建筑生成产量', () => {
  const state = makeState();
  state.towns[0].buildings.push('shu_barracks1', 'shu_bowyard');
  weeklyRecruitPool(state, data);
  const pool = state.towns[0].recruitPool;
  assert.equal(pool.length, 2, '两个招募建筑应各出一种兵');
  const byUnit = Object.fromEntries(pool.map((p) => [p.unitId, p.count]));
  assert.equal(byUnit.shu_militia, 20);
  assert.equal(byUnit.shu_archer, 14);
  // 没有招募建筑的大本营城镇 pool 为空
  assert.deepEqual(state.towns[1].recruitPool, []);
});

test('验收3：行军技能提升行动力（谋略提升法力）', () => {
  const state = makeState();
  state.heroes[0].skills.logistics = 2;
  state.heroes[0].skills.wisdom = 1;

  refreshMovePoints(state, data, 0);

  assert.equal(state.heroes[0].maxMovePoints, 20 + 2 * 4, '行动力应为 28');
  assert.equal(state.heroes[0].movePoints, 28, '当前行动力应同步恢复');
  assert.equal(state.heroes[0].maxMana, 20, '法力上限应为 10+10');
  assert.equal(state.heroes[0].mana, 20);
});

test('验收3b：无行军技能时行动力为 20', () => {
  const state = makeState();
  state.heroes[0].movePoints = 3;
  refreshMovePoints(state, data, 0);
  assert.equal(state.heroes[0].movePoints, 20);
});

test('验收4：一方失去所有城镇与英雄即判负', () => {
  const state = makeState();
  assert.equal(checkGameOver(state), null, '双方都有城和英雄时不应结束');

  state.towns = state.towns.filter((t) => t.playerId !== 1);
  state.heroes = state.heroes.filter((h) => h.playerId !== 1);
  const over = checkGameOver(state);
  assert.ok(over, '应判定游戏结束');
  assert.equal(over.winnerId, 0, '人类玩家应获胜');
  assert.equal(state.gameOver.winnerId, 0, 'gameOver 应写入状态');
});

test('验收4b：endTurn 在胜负已定时发出 game:over', () => {
  const state = makeState();
  state.towns = state.towns.filter((t) => t.playerId !== 1);
  state.heroes = state.heroes.filter((h) => h.playerId !== 1);

  let over = null;
  const off = bus.on('game:over', (p) => { over = p; });
  endTurn(state, data);
  off();
  assert.ok(over, '应发出 game:over 事件');
  assert.equal(over.winnerId, 0);
});

test('回合流程：事件顺序与玩家切换', () => {
  const state = makeState();
  const events = [];
  const offs = [
    bus.on('turn:end', (p) => events.push(['turn:end', p.playerId])),
    bus.on('turn:start', (p) => events.push(['turn:start', p.playerId])),
    bus.on('day:new', (p) => events.push(['day:new', p.day, p.week]))
  ];

  endTurn(state, data);
  assert.deepEqual(events, [['turn:end', 0], ['turn:start', 1]], '第一次结束回合不跨天');

  events.length = 0;
  endTurn(state, data);
  assert.deepEqual(events, [['turn:end', 1], ['day:new', 2, 1], ['turn:start', 0]], '第二次结束回合进入第二天');

  offs.forEach((o) => o());
});

test('每日收入在各自回合开始时结算一次', () => {
  const state = makeState();
  endTurn(state, data); // 切到 AI：AI 获得收入
  assert.equal(state.players[1].gold, 1500, 'AI 回合开始应获得 500 金');
  assert.equal(state.players[0].gold, 1000, '玩家 0 此时不该获得收入');
  endTurn(state, data); // 回到玩家 0：玩家获得收入
  assert.equal(state.players[0].gold, 1500, '玩家回合开始应获得 500 金');
});

test('资源支付：canAfford / spendResources', () => {
  const state = makeState();
  assert.equal(canAfford(state, 0, { gold: 500 }), true);
  assert.equal(canAfford(state, 0, { gold: 5000 }), false);

  const res = spendResources(state, 0, { gold: 300, wood: 5 });
  assert.equal(res.ok, true);
  assert.equal(state.players[0].gold, 700);
  assert.equal(state.players[0].wood, 15);

  const bad = spendResources(state, 0, { gold: 99999 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'noResource');
  assert.equal(state.players[0].gold, 700, '失败时不应扣资源');
});

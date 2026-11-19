import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  aiMapTurn,
  planMapTurn,
  planHeroTurn,
  executeMapStep,
  MAX_MOVE_CALLS
} from './mapAI.js';
import { endTurn, refreshMovePoints } from './turnLogic.js';
import { buildInitialForces } from './setup.js';
import { createNewGame } from '../core/GameState.js';
import bus from '../core/EventBus.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const readData = (name) => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));

const DATA = {
  units: readData('units.json'),
  buildings: readData('buildings.json'),
  spells: readData('spells.json'),
  skills: readData('skills.json'),
  factions: readData('factions.json')
};
const MAP = readData('map_default.json');

/**
 * 造一局标准开局（与实际游戏一致：双方各 1 英雄 1 城镇）
 */
function makeGame() {
  const state = createNewGame(JSON.parse(JSON.stringify(MAP)));
  buildInitialForces(state, DATA);
  return state;
}

/** 把某个资源点挪到指定位置（便于构造捡资源场景） */
function placeResource(state, index, pos, resource = 'gold', amount = 600) {
  const obj = state.map.objects[index];
  obj.pos = { ...pos };
  obj.resource = resource;
  obj.amount = amount;
  return obj;
}

/** 清空地图上的所有资源（用于隔离战斗/攻城等策略分支） */
function clearResources(state) {
  state.map.objects = [];
}

/** 只保留一个资源点（其余清空） */
function onlyResource(state, index, pos, resource = 'gold', amount = 600) {
  clearResources(state);
  state.map.objects.push({
    type: 'resource',
    resource,
    amount,
    pos: { ...pos }
  });
}

// ══════════════════════════════════════════════════
// 验收 1：点结束回合后，电脑在地图上自动移动
// ══════════════════════════════════════════════════

test('验收1：电脑回合后英雄位置发生变化（可见移动）', () => {
  const state = makeGame();
  const wei = state.heroes.find((h) => h.playerId === 1);
  const before = { ...wei.pos };

  // 切到电脑回合
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const log = aiMapTurn(state, DATA);

  assert.ok(log.length > 0, '应产出行动流水');
  assert.notDeepEqual(wei.pos, before, '电脑英雄的位置应发生变化');
  assert.ok(
    log.some((e) => e.action === 'move'),
    '流水里应有移动动作'
  );
});

test('验收1b：移动是逐格调用 moveHero，hero:moved 事件逐格发出', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  let events = 0;
  const off = bus.on('hero:moved', () => { events += 1; });
  aiMapTurn(state, DATA);
  off();

  assert.ok(events >= 1, '应至少发出一次 hero:moved 事件');
  // 逐格移动：事件次数应不少于实际走过的格数
  const wei = state.heroes.find((h) => h.playerId === 1);
  assert.ok(events >= 1, '事件数应与移动格数对应');
  assert.ok(wei.movePoints < wei.maxMovePoints, '行动力应被消耗');
});

// ══════════════════════════════════════════════════
// 验收 2：电脑会捡附近的资源（map.objects 减少）
// ══════════════════════════════════════════════════

test('验收2：电脑会捡起附近资源，map.objects 减少', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 只留一个资源点，放到曹操旁边（27,5），确保一格可达
  onlyResource(state, 3, { x: 27, y: 5 }, 'gold', 600);

  // 已建兵营，隔离出「建兵营 -550 金」对账目的干扰（产量池为空，不会招募）
  const weichang = state.towns.find((t) => t.playerId === 1);
  weichang.buildings = ['hall', 'wei_barracks1'];

  const wei = state.heroes.find((h) => h.playerId === 1);
  const goldBefore = state.players[1].gold;
  const objectsBefore = state.map.objects.length;

  const log = aiMapTurn(state, DATA);

  assert.ok(
    log.some((e) => e.action === 'pickup'),
    '流水里应有拾取动作'
  );
  assert.equal(state.map.objects.length, objectsBefore - 1, '资源应从地图移除');
  assert.equal(state.players[1].gold, goldBefore + 600, '金币应入账到电脑玩家');
  assert.ok(
    wei.pos.x === 27 && wei.pos.y === 5,
    '英雄应走到资源格上'
  );
});

test('验收2b：资源不在可达范围时不捡', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 只留一个资源点，放到成都脚下（电脑走不到）
  onlyResource(state, 3, { x: 3, y: 13 }, 'gold', 600);
  const objectsBefore = state.map.objects.length;

  const log = aiMapTurn(state, DATA);

  assert.ok(
    !log.some((e) => e.action === 'pickup'),
    '不该捡到走不到的资源'
  );
  assert.equal(state.map.objects.length, objectsBefore, '资源应仍在地图上');
});

// ══════════════════════════════════════════════════
// 验收 3：连续过 5 天不报错、不死循环
// ══════════════════════════════════════════════════

test('验收3：连续过 5 天不报错、不死循环', () => {
  const state = makeGame();

  for (let day = 0; day < 5; day++) {
    // 玩家 0 结束回合 → 切到电脑
    endTurn(state, DATA);
    assert.equal(state.meta.currentPlayer, 1, '应切到电脑回合');

    const log = aiMapTurn(state, DATA);
    assert.ok(Array.isArray(log), '应返回行动流水');

    // 单回合移动调用次数不得超过上限
    const moves = log.filter((e) => e.action === 'move').length;
    assert.ok(moves <= MAX_MOVE_CALLS, `单回合移动次数 ${moves} 不得超过 ${MAX_MOVE_CALLS}`);

    // 电脑结束回合 → 切回玩家，日期 +1
    endTurn(state, DATA);
  }

  assert.equal(state.meta.day, 6, '5 天后日期应推进到第 6 天');
  assert.equal(state.meta.currentPlayer, 0, '应交还给玩家');
});

test('验收3b：单回合移动调用不超过 100 次上限', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 造 30 个电脑英雄，每个 20 行动力 → 理论可走 600 格
  for (let i = 1; i < 30; i++) {
    state.heroes.push({
      id: `hero_wei_${i}`,
      playerId: 1,
      faction: 'wei',
      name: `义士${i}`,
      level: 1,
      exp: 0,
      movePoints: 20,
      maxMovePoints: 20,
      mana: 10,
      maxMana: 10,
      pos: { x: 26, y: 4 },
      skills: {},
      spells: [],
      army: []
    });
  }

  const log = aiMapTurn(state, DATA);
  const moves = log.filter((e) => e.action === 'move').length;
  assert.ok(moves <= MAX_MOVE_CALLS, `移动次数 ${moves} 应 ≤ ${MAX_MOVE_CALLS}`);
  assert.ok(
    log.some((e) => e.action === 'limit'),
    '应触发上限保护'
  );
});

// ══════════════════════════════════════════════════
// 策略分支
// ══════════════════════════════════════════════════

test('策略2：战力占优时向玩家英雄发起战斗', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 清掉资源，隔离出「打得过就打」分支
  // （契约把「捡便宜」排在「打得过就打」前面，有资源时 AI 会先捡资源）
  clearResources(state);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const shu = state.heroes.find((h) => h.playerId === 0);

  // 把刘备挪到曹操旁边（正交相邻），且兵力远少于曹操
  shu.pos = { x: 25, y: 4 };
  shu.army = [{ unitId: 'shu_militia', count: 1 }];
  wei.army = [{ unitId: 'wei_qingzhou', count: 50 }];

  const log = aiMapTurn(state, DATA);
  const battle = log.find((e) => e.action === 'battle');

  assert.ok(battle, '应产生战斗意图');
  assert.equal(battle.detail.targetType, 'hero');
  assert.equal(battle.detail.targetId, shu.id);
});

test('策略2b：战力不占优时不主动开战', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const shu = state.heroes.find((h) => h.playerId === 0);

  shu.pos = { x: 25, y: 4 };
  // 曹操只有 1 个兵，刘备 50 个 → 打不过
  wei.army = [{ unitId: 'wei_qingzhou', count: 1 }];
  shu.army = [{ unitId: 'shu_militia', count: 50 }];

  const log = aiMapTurn(state, DATA);
  assert.ok(
    !log.some((e) => e.action === 'battle' && e.detail.targetType === 'hero'),
    '打不过就不该打'
  );
});

test('策略3：aiValue 超过 3000 且够得到玩家城镇时攻城', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 清掉资源，隔离出「攻城」分支
  clearResources(state);

  const wei = state.heroes.find((h) => h.playerId === 1);
  // 曹操有 40 青州兵(aiValue 95) + 20 魏弓手(100) = 5800 > 3000
  assert.ok(wei.army.length > 0);

  // 把成都挪到曹操旁边，让攻城条件满足
  const chengdu = state.towns.find((t) => t.playerId === 0);
  chengdu.pos = { x: 25, y: 3 };

  const log = aiMapTurn(state, DATA);
  const battle = log.find((e) => e.action === 'battle' && e.detail.targetType === 'town');

  assert.ok(battle, '应产生攻城意图');
  assert.equal(battle.detail.targetId, chengdu.id);
});

test('策略3b：aiValue 不足 3000 时不攻城', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const chengdu = state.towns.find((t) => t.playerId === 0);
  chengdu.pos = { x: 25, y: 3 };
  // 清空军队 → aiValue = 0，远不到 3000
  wei.army = [];

  const log = aiMapTurn(state, DATA);
  assert.ok(
    !log.some((e) => e.action === 'battle' && e.detail.targetType === 'town'),
    '兵力不足不该攻城'
  );
});

test('策略4：无目标时往玩家主城方向推进', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 清掉所有资源与玩家英雄 → 只剩推进
  state.map.objects = [];
  state.heroes = state.heroes.filter((h) => h.playerId === 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const before = { ...wei.pos };

  const log = aiMapTurn(state, DATA);

  assert.ok(log.some((e) => e.action === 'move'), '应向主城推进');
  assert.notDeepEqual(wei.pos, before, '位置应变化');
  // 推进方向应朝玩家城镇（成都 2,14）靠近
  const distBefore = Math.abs(before.x - 2) + Math.abs(before.y - 14);
  const distAfter = Math.abs(wei.pos.x - 2) + Math.abs(wei.pos.y - 14);
  assert.ok(distAfter < distBefore, '应更靠近成都');
});

test('策略5：城里有货且资源够时自动招募 T1 兵', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 清掉资源，隔离出「补兵」分支（避免顺手捡资源干扰金币账目）
  clearResources(state);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const weichang = state.towns.find((t) => t.playerId === 1);

  // 造好兵营 + 池里有货（模拟已建兵营后的状态）
  weichang.buildings = ['hall', 'wei_barracks1'];
  weichang.recruitPool = [{ unitId: 'wei_qingzhou', count: 20 }];

  // 把曹操放到城里
  wei.pos = { ...weichang.pos };
  wei.army = [{ unitId: 'wei_qingzhou', count: 40 }];

  const goldBefore = state.players[1].gold;
  const log = aiMapTurn(state, DATA);
  const recruitEntry = log.find((e) => e.action === 'recruit');

  assert.ok(recruitEntry, '应产生招募动作');
  assert.equal(recruitEntry.detail.unitId, 'wei_qingzhou');
  assert.equal(recruitEntry.detail.count, 10, '应招满一队（10 个）');
  assert.equal(wei.army.find((a) => a.unitId === 'wei_qingzhou').count, 50, '军队应 +10');
  assert.equal(state.players[1].gold, goldBefore - 450, '应扣 45 金 × 10');
  assert.equal(weichang.recruitPool[0].count, 10, '产量池应减 10');
});

test('策略5b：没有兵营时先建兵营', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  // 清掉资源，隔离出「建兵营」分支
  clearResources(state);

  const weichang = state.towns.find((t) => t.playerId === 1);
  const goldBefore = state.players[1].gold;

  const log = aiMapTurn(state, DATA);
  const buildEntry = log.find((e) => e.action === 'build');

  assert.ok(buildEntry, '应产生建造动作');
  assert.equal(buildEntry.detail.buildingId, 'wei_barracks1');
  assert.ok(weichang.buildings.includes('wei_barracks1'), '兵营应建成');

  // 建兵营后 M5 会立刻把该兵种按 growth 补进产量池，
  // 所以同一回合就能接着招兵（550 建营 + 450 招 10 个青州兵 = 1000）
  const recruitEntry = log.find((e) => e.action === 'recruit');
  assert.ok(recruitEntry, '建完兵营后同一回合应能招兵');
  assert.equal(recruitEntry.detail.unitId, 'wei_qingzhou');
  assert.equal(recruitEntry.detail.count, 10, '应招满一队（10 个）');
  assert.equal(state.players[1].gold, goldBefore - 550 - 450, '合计应扣 1000 金');
  assert.equal(weichang.recruitPool[0].count, 10, '产量池应剩 10 个');
});

test('策略5c：产量池为空时不招募', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const weichang = state.towns.find((t) => t.playerId === 1);
  weichang.buildings = ['hall', 'wei_barracks1'];
  weichang.recruitPool = [];
  wei.pos = { ...weichang.pos };

  const log = aiMapTurn(state, DATA);
  assert.ok(
    !log.some((e) => e.action === 'recruit'),
    '没货不该招募'
  );
});

// ══════════════════════════════════════════════════
// 规划层 / 执行层
// ══════════════════════════════════════════════════

test('规划层是纯函数：不修改 state', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const snapshot = JSON.stringify(state);
  const steps = planMapTurn(state, DATA, 1);

  assert.ok(Array.isArray(steps));
  assert.equal(JSON.stringify(state), snapshot, '规划不应改动 state');
});

test('规划层输出逐格移动步骤', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);
  state.map.objects = [];
  state.heroes = state.heroes.filter((h) => h.playerId === 1);

  const steps = planMapTurn(state, DATA, 1);
  const moves = steps.filter((s) => s.type === 'move');

  assert.ok(moves.length > 1, '应拆成多格');
  for (const m of moves) {
    assert.equal(m.type, 'move');
    assert.ok(m.to && Number.isInteger(m.to.x) && Number.isInteger(m.to.y));
  }
  // 相邻性：连续两步应四方向相邻
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1].to;
    const b = moves[i].to;
    assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, '移动步应逐格相邻');
  }
});

test('执行层：executeMapStep 逐格移动并扣行动力', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const before = wei.movePoints;

  const r = executeMapStep(state, DATA, { type: 'move', heroId: wei.id, to: { x: 26, y: 5 } });
  assert.equal(r.ok, true);
  assert.equal(r.type, 'move');
  assert.deepEqual(r.from, { x: 26, y: 4 });
  assert.deepEqual(r.to, { x: 26, y: 5 });
  assert.ok(wei.movePoints < before, '行动力应减少');
});

test('执行层：未知步骤类型返回 unknownStep', () => {
  const state = makeGame();
  const r = executeMapStep(state, DATA, { type: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknownStep');
});

test('执行层：战斗步骤只产出意图，不直接改战场状态', () => {
  const state = makeGame();
  const before = state.battle;
  const r = executeMapStep(state, DATA, {
    type: 'battle', heroId: 'hero_wei_0', targetType: 'hero', targetId: 'hero_shu_0'
  });
  assert.equal(r.ok, true);
  assert.equal(r.needBattle, true);
  assert.equal(state.battle, before, '逻辑层不应创建战场');
});

test('行动流水格式为 {heroId, action, detail}', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const log = aiMapTurn(state, DATA);
  assert.ok(log.length > 0);
  for (const entry of log) {
    assert.ok('heroId' in entry, '流水项应有 heroId');
    assert.ok(typeof entry.action === 'string', '流水项应有 action');
    assert.ok(entry.detail && typeof entry.detail === 'object', '流水项应有 detail');
  }
});

test('英雄站上城镇格后仍能移动出城（不卡死）', () => {
  const state = makeGame();
  state.meta.currentPlayer = 1;
  refreshMovePoints(state, DATA, 1);

  const wei = state.heroes.find((h) => h.playerId === 1);
  const weichang = state.towns.find((t) => t.playerId === 1);
  wei.pos = { ...weichang.pos };

  // 站在城镇格上时应能向城外走
  const steps = planHeroTurn(state, DATA, wei);
  const moves = steps.filter((s) => s.type === 'move');
  assert.ok(moves.length > 0, '站在城上的英雄应能规划出城路线');

  const r = executeMapStep(state, DATA, moves[0]);
  assert.equal(r.ok, true, `出城移动应成功，实际 ${r.reason}`);
});

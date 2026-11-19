import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findPath,
  pathCost,
  moveHero,
  reachableTiles,
  checkTileInteraction,
  isWalkable,
  occupiedTiles,
  pickUpResource
} from './mapLogic.js';
import bus from '../core/EventBus.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const map = JSON.parse(fs.readFileSync(path.join(DIR, 'map_default.json'), 'utf8'));

/** 构造一个测试用 state */
function makeState(overrides = {}) {
  return {
    meta: { day: 1, week: 1, currentPlayer: 0 },
    players: [
      { id: 0, faction: 'shu', isAI: false, gold: 1000 },
      { id: 1, faction: 'wei', isAI: true, gold: 1000 }
    ],
    heroes: [
      { id: 'hero_shu_0', playerId: 0, name: '刘备', movePoints: 20, pos: { x: 3, y: 13 } },
      { id: 'hero_wei_0', playerId: 1, name: '曹操', movePoints: 20, pos: { x: 26, y: 4 } }
    ],
    towns: [
      { id: 'town_shu_0', playerId: 0, name: '成都', pos: { x: 2, y: 14 } },
      { id: 'town_wei_0', playerId: 1, name: '许昌', pos: { x: 27, y: 3 } }
    ],
    map,
    ...overrides
  };
}

test('验收1：成都到许昌有路径', () => {
  const from = { x: 3, y: 13 };
  const p = findPath(map, from, { x: 26, y: 4 });
  assert.ok(p && p.length > 0, '应存在路径');
  assert.deepEqual(p[p.length - 1], { x: 26, y: 4 }, '路径终点正确');
  // 路径应为连续的四方向步进，且不含起点
  let prev = from;
  for (const step of p) {
    const d = Math.abs(step.x - prev.x) + Math.abs(step.y - prev.y);
    assert.equal(d, 1, `路径应在 (${prev.x},${prev.y}) 与 (${step.x},${step.y}) 之间相邻`);
    prev = step;
  }
  // 路径不得经过不可通行地形
  for (const step of p) {
    assert.ok(isWalkable(map, step.x, step.y), `路径格 (${step.x},${step.y}) 应可通行`);
  }
});

test('验收2：以湖心为终点返回 null（水域不可达）', () => {
  assert.equal(findPath(map, { x: 3, y: 13 }, { x: 14, y: 8 }), null);
  assert.equal(isWalkable(map, 14, 8), false);
});

test('验收3：全道路 10 格消耗 5 点', () => {
  const roadMap = { width: 11, height: 1, tiles: [Array(11).fill(4)] };
  const p = findPath(roadMap, { x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(pathCost(roadMap, p), 5);
});

test('验收3b：平原 10 格消耗 10 点，森林 10 格消耗 20 点', () => {
  const plain = { width: 11, height: 1, tiles: [Array(11).fill(0)] };
  assert.equal(pathCost(plain, findPath(plain, { x: 0, y: 0 }, { x: 10, y: 0 })), 10);
  const forest = { width: 11, height: 1, tiles: [Array(11).fill(1)] };
  assert.equal(pathCost(forest, findPath(forest, { x: 0, y: 0 }, { x: 10, y: 0 })), 20);
});

test('验收4：reachableTiles 每格 cost 不超过剩余行动力', () => {
  const state = makeState();
  const tiles = reachableTiles(state, 'hero_shu_0');
  assert.ok(tiles.length > 0, '应有可达格');
  for (const t of tiles) {
    assert.ok(t.cost <= 20, `可达格 ${t.x},${t.y} 消耗 ${t.cost} 超出行动力 20`);
    assert.ok(t.cost >= 1, '消耗至少为 1');
  }
});

test('行动力不足时可达范围收缩', () => {
  const state = makeState();
  state.heroes[0].movePoints = 2;
  const tiles = reachableTiles(state, 'hero_shu_0');
  assert.ok(tiles.every((t) => t.cost <= 2), '所有可达格消耗应 ≤2');
});

test('moveHero：扣行动力、更新位置、发 hero:moved 事件', () => {
  const state = makeState();
  let payload = null;
  const off = bus.on('hero:moved', (p) => { payload = p; });

  const res = moveHero(state, 'hero_shu_0', { x: 5, y: 13 });
  off();

  assert.equal(res.ok, true);
  assert.deepEqual(state.heroes[0].pos, { x: 5, y: 13 }, '位置应更新');
  assert.equal(state.heroes[0].movePoints, 20 - res.cost, '行动力应按消耗扣减');
  assert.ok(payload, '应发出 hero:moved 事件');
  assert.equal(payload.heroId, 'hero_shu_0');
  assert.deepEqual(payload.from, { x: 3, y: 13 });
});

test('moveHero：行动力不足返回 notEnoughMove，位置不变', () => {
  const state = makeState();
  state.heroes[0].movePoints = 1;
  const res = moveHero(state, 'hero_shu_0', { x: 20, y: 13 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'notEnoughMove');
  assert.deepEqual(state.heroes[0].pos, { x: 3, y: 13 }, '位置不应变化');
});

test('moveHero：无路返回 noPath', () => {
  const state = makeState();
  const res = moveHero(state, 'hero_shu_0', { x: 14, y: 8 }); // 湖心
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noPath');
});

test('其他英雄/城镇所在格不可穿越，但可作为终点', () => {
  const blocked = occupiedTiles(makeState(), 'hero_shu_0');
  // 曹操所在格不可作为中转：找一条穿过 (26,4) 的路径应失败
  const p = findPath(map, { x: 24, y: 4 }, { x: 26, y: 4 }, blocked);
  assert.ok(p, '终点本身可到达');
  assert.equal(p[p.length - 1].x, 26, '终点为曹操所在格');
  // 到达后不再从该格扩展
  const p2 = findPath(map, { x: 26, y: 4 }, { x: 27, y: 4 }, blocked);
  assert.equal(p2, null, '从被占用的格不能再向外走');
});

test('checkTileInteraction：资源 / 自家城镇 / 敌方城镇 / 敌方英雄', () => {
  const state = makeState();

  const res = state.map.objects.find((o) => o.type === 'resource');
  const r = checkTileInteraction(state, res.pos);
  assert.equal(r.type, 'resource');
  assert.equal(r.object, res);

  const own = checkTileInteraction(state, { x: 2, y: 14 });
  assert.equal(own.type, 'ownTown');
  assert.equal(own.town.id, 'town_shu_0');

  const enemyTown = checkTileInteraction(state, { x: 27, y: 3 });
  assert.equal(enemyTown.type, 'enemyTown');

  const enemyHero = checkTileInteraction(state, { x: 26, y: 4 });
  assert.equal(enemyHero.type, 'enemyHero');
  assert.equal(enemyHero.hero.id, 'hero_wei_0');

  // 空格无交互
  assert.equal(checkTileInteraction(state, { x: 15, y: 15 }), null);
  // 自己脚下不算交互（脚下没有资源）
  assert.equal(checkTileInteraction(state, { x: 3, y: 13 }), null);
});

test('回归：进攻方踩上敌方英雄的格子后仍能触发遭遇战', () => {
  const state = makeState();
  // 刘备走到曹操所在的格子（两英雄同格）
  state.heroes[0].pos = { x: 26, y: 4 };
  const r = checkTileInteraction(state, { x: 26, y: 4 });
  assert.ok(r, '同格时应能识别出交互');
  assert.equal(r.type, 'enemyHero');
  assert.equal(r.hero.id, 'hero_wei_0', '必须指向敌方英雄，而不是同格的自己');
});

test('英雄踩在资源格上时仍能识别为资源交互', () => {
  const state = makeState();
  const res = state.map.objects.find((o) => o.type === 'resource');
  // 把刘备挪到资源格上
  state.heroes[0].pos = { ...res.pos };
  const r = checkTileInteraction(state, res.pos);
  assert.equal(r.type, 'resource', '己方英雄脚下有资源时应识别为资源');
});

test('pickUpResource：资源入账并从地图移除', () => {
  const state = makeState();
  const res = state.map.objects.find((o) => o.type === 'resource');
  const before = state.players[0].gold;
  const countBefore = state.map.objects.length;

  const out = pickUpResource(state, 'hero_shu_0', res.pos);
  assert.equal(out.ok, true);
  assert.equal(out.resource, res.resource);
  assert.equal(out.amount, res.amount);
  assert.equal(state.players[0].gold, before + res.amount, '金币应入账');
  assert.equal(state.map.objects.length, countBefore - 1, '资源应从地图移除');

  // 同一资源不能再拾
  const again = pickUpResource(state, 'hero_shu_0', res.pos);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'noResource');
});

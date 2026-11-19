import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  availableBuildings,
  construct,
  recruit,
  recruitOptions,
  formatCost,
  MAX_ARMY_SLOTS
} from './townLogic.js';
import { buildInitialForces } from './setup.js';
import { canAfford } from './turnLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');

/** 读取数据表 */
function loadData() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return {
    units: read('units.json'),
    spells: read('spells.json'),
    skills: read('skills.json'),
    buildings: read('buildings.json'),
    factions: read('factions.json'),
    map: read('map_default.json')
  };
}

/** 造一个干净的测试用 state */
function makeState() {
  const data = loadData();
  const state = {
    meta: { day: 1, week: 1, currentPlayer: 0 },
    players: [
      { id: 0, faction: 'shu', isAI: false, gold: 10000, wood: 20, ore: 20, mercury: 10, sulfur: 10, crystal: 10, gem: 10 },
      { id: 1, faction: 'wei', isAI: true, gold: 10000, wood: 20, ore: 20, mercury: 10, sulfur: 10, crystal: 10, gem: 10 }
    ],
    heroes: [],
    towns: [],
    map: data.map
  };
  buildInitialForces(state, data);
  return { state, data };
}

/** 蜀汉城镇 id */
const SHU_TOWN = 'town_shu_0';
const WEI_TOWN = 'town_wei_0';
const SHU_HERO = 'hero_shu_0';

// ──────────────────────────────────────────────
// 验收1：availableBuildings 列出建筑并给出状态
// ──────────────────────────────────────────────
test('availableBuildings：列出本阵营建筑，含已建/可建状态', () => {
  const { state, data } = makeState();
  const list = availableBuildings(state, data, SHU_TOWN);
  const ids = list.map((e) => e.building.id);

  // 通用建筑 5 个 + 蜀汉专属 8 个 = 13
  assert.equal(list.length, 13);
  assert.ok(ids.includes('hall'));
  assert.ok(ids.includes('shu_barracks1'));
  // 曹魏专属建筑不应出现在蜀汉城镇
  assert.ok(!ids.includes('wei_barracks1'));

  const hall = list.find((e) => e.building.id === 'hall');
  assert.equal(hall.built, true);
  assert.equal(hall.reason, 'built');

  const barracks = list.find((e) => e.building.id === 'shu_barracks1');
  assert.equal(barracks.built, false);
  assert.equal(barracks.buildable, true);
  assert.equal(barracks.affordable, true);
  assert.equal(barracks.reason, null);
});

// ──────────────────────────────────────────────
// 验收2：construct 建造、扣资源、每日限建 1 个
// ──────────────────────────────────────────────
test('construct：建造酒馆扣 300 金，且当日不能再建', () => {
  const { state, data } = makeState();
  const goldBefore = state.players[0].gold;

  const res = construct(state, data, SHU_TOWN, 'tavern');
  assert.equal(res.ok, true);
  assert.equal(state.players[0].gold, goldBefore - 300);
  assert.ok(state.towns[0].buildings.includes('tavern'));
  assert.equal(state.towns[0].builtToday, 1);

  // 当日第二个建筑 → alreadyBuiltToday
  const res2 = construct(state, data, SHU_TOWN, 'market');
  assert.equal(res2.ok, false);
  assert.equal(res2.reason, 'alreadyBuiltToday');
  assert.equal(state.players[0].gold, goldBefore - 300);
});

// ──────────────────────────────────────────────
// 验收3：construct 前置与互斥
// ──────────────────────────────────────────────
test('construct：前置未满足 → requireNotMet', () => {
  const { state, data } = makeState();
  const res = construct(state, data, SHU_TOWN, 'shu_barracks2'); // 需要 shu_barracks1
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'requireNotMet');
});

test('construct：同级互斥 → excluded（双向生效）', () => {
  const { state, data } = makeState();
  // 先建弓房
  state.towns[0].builtToday = 0;
  assert.equal(construct(state, data, SHU_TOWN, 'shu_bowyard').ok, true);
  // 弓房与民兵营互斥（shu_bowyard.excludes 含 shu_barracks1）
  state.towns[0].builtToday = 0;
  const res = construct(state, data, SHU_TOWN, 'shu_barracks1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'excluded');
});

test('construct：资源不足 → noResource', () => {
  const { state, data } = makeState();
  state.players[0].gold = 10;
  const res = construct(state, data, SHU_TOWN, 'tavern'); // 300 金
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noResource');
  assert.equal(state.players[0].gold, 10);
});

test('construct：重复建造同一建筑 → alreadyBuilt', () => {
  const { state, data } = makeState();
  state.towns[0].builtToday = 0;
  assert.equal(construct(state, data, SHU_TOWN, 'shu_barracks1').ok, true);
  state.towns[0].builtToday = 0;
  const res = construct(state, data, SHU_TOWN, 'shu_barracks1');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'alreadyBuilt');
});

// ──────────────────────────────────────────────
// 验收4：recruit 扣资源、扣产量、加军队
// ──────────────────────────────────────────────
test('recruit：招 10 个乡勇，扣 400 金、军队 40→50、产量减少', () => {
  const { state, data } = makeState();
  const town = state.towns.find((t) => t.id === SHU_TOWN);
  const hero = state.heroes.find((h) => h.id === SHU_HERO);

  // 英雄站到城镇格上（进城状态）
  hero.pos = { ...town.pos };

  // 先建民兵营（建成后立刻有产量）
  state.towns[0].builtToday = 0;
  assert.equal(construct(state, data, SHU_TOWN, 'shu_barracks1').ok, true);

  const poolBefore = town.recruitPool.find((p) => p.unitId === 'shu_militia').count;
  const goldBefore = state.players[0].gold;

  const res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 10);
  assert.equal(res.ok, true);
  assert.equal(state.players[0].gold, goldBefore - 400);
  assert.equal(hero.army.find((a) => a.unitId === 'shu_militia').count, 50);
  assert.equal(town.recruitPool.find((p) => p.unitId === 'shu_militia').count, poolBefore - 10);
});

test('recruit：英雄不在城镇 → heroNotInTown', () => {
  const { state, data } = makeState();
  state.towns[0].builtToday = 0;
  construct(state, data, SHU_TOWN, 'shu_barracks1');
  const res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 5);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'heroNotInTown');
});

test('recruit：未建招募建筑 → notAvailable', () => {
  const { state, data } = makeState();
  const hero = state.heroes.find((h) => h.id === SHU_HERO);
  hero.pos = { ...state.towns[0].pos };
  const res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 5);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'notAvailable');
});

test('recruit：产量不足 → poolEmpty', () => {
  const { state, data } = makeState();
  const town = state.towns.find((t) => t.id === SHU_TOWN);
  const hero = state.heroes.find((h) => h.id === SHU_HERO);
  hero.pos = { ...town.pos };
  state.towns[0].builtToday = 0;
  construct(state, data, SHU_TOWN, 'shu_barracks1');
  town.recruitPool.find((p) => p.unitId === 'shu_militia').count = 3;
  const res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 10);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'poolEmpty');
});

test('recruit：资源不足 → noResource', () => {
  const { state, data } = makeState();
  const town = state.towns.find((t) => t.id === SHU_TOWN);
  const hero = state.heroes.find((h) => h.id === SHU_HERO);
  hero.pos = { ...town.pos };
  state.towns[0].builtToday = 0;
  construct(state, data, SHU_TOWN, 'shu_barracks1');
  state.players[0].gold = 0;
  const res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 10);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noResource');
});

test('recruit：军队 7 格上限 → armyFull（同兵种合并不占格）', () => {
  const { state, data } = makeState();
  const town = state.towns.find((t) => t.id === SHU_TOWN);
  const hero = state.heroes.find((h) => h.id === SHU_HERO);
  hero.pos = { ...town.pos };
  state.towns[0].builtToday = 0;
  construct(state, data, SHU_TOWN, 'shu_barracks1');

  // 塞满 7 个兵种格
  hero.army = [
    { unitId: 'shu_militia', count: 1 },
    { unitId: 'shu_archer', count: 1 },
    { unitId: 'shu_baidie', count: 1 },
    { unitId: 'shu_crossbow', count: 1 },
    { unitId: 'shu_wudang', count: 1 },
    { unitId: 'shu_fangshi', count: 1 },
    { unitId: 'shu_wuhu', count: 1 }
  ];
  assert.equal(hero.army.length, MAX_ARMY_SLOTS);

  // 新兵种 → armyFull
  let res = recruit(state, data, SHU_TOWN, SHU_HERO, 'shu_militia', 1);
  assert.equal(res.ok, true); // 同兵种合并，不占新格
  assert.equal(hero.army.length, MAX_ARMY_SLOTS);

  // 再招一个不同兵种 → 需要先有该兵种的产量与建筑，此处用另一个城测
  const weiTown = state.towns.find((t) => t.id === WEI_TOWN);
  const weiHero = state.heroes.find((h) => h.id === 'hero_wei_0');
  weiHero.pos = { ...weiTown.pos };
  state.towns[1].builtToday = 0;
  construct(state, data, WEI_TOWN, 'wei_barracks1');
  const wres = recruit(state, data, WEI_TOWN, 'hero_wei_0', 'wei_qingzhou', 1);
  assert.equal(wres.ok, true);
});

// ──────────────────────────────────────────────
// 验收5：辅助函数
// ──────────────────────────────────────────────
test('recruitOptions：只列已建招募建筑对应、产量>0 的兵种', () => {
  const { state, data } = makeState();
  // 未建任何招募建筑 → 空
  assert.equal(recruitOptions(state, data, SHU_TOWN).length, 0);

  state.towns[0].builtToday = 0;
  construct(state, data, SHU_TOWN, 'shu_barracks1');
  const opts = recruitOptions(state, data, SHU_TOWN);
  assert.equal(opts.length, 1);
  assert.equal(opts[0].unit.id, 'shu_militia');
  assert.equal(opts[0].poolCount, 20); // growth
  assert.equal(opts[0].costText, '40金');
});

test('formatCost：资源花费转中文文本', () => {
  assert.equal(formatCost({ gold: 500, wood: 10 }), '500金 10木');
  assert.equal(formatCost({}), '');
});

test('canAfford 与 construct 使用同一套资源判断', () => {
  const { state, data } = makeState();
  assert.equal(canAfford(state, 0, { gold: 300 }), true);
  state.players[0].gold = 100;
  assert.equal(canAfford(state, 0, { gold: 300 }), false);
  const res = construct(state, data, SHU_TOWN, 'tavern');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noResource');
});

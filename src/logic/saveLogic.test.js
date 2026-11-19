import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  saveGame,
  loadGame,
  listSaves,
  deleteSave,
  autoSave,
  makeLabel,
  formatSavedAt,
  __setStorage,
  __resetStorage,
  SAVE_SLOTS,
  MANUAL_SLOTS,
  AUTO_SLOT
} from './saveLogic.js';
import { createNewGame, STATE_VERSION } from '../core/GameState.js';
import { buildInitialForces } from './setup.js';
import { pickUpResource } from './mapLogic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');

/** 读数据表 */
function loadData() {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  return {
    units: read('units.json'),
    spells: read('spells.json'),
    skills: read('skills.json'),
    buildings: read('buildings.json'),
    factions: read('factions.json'),
    mapDefault: read('map_default.json')
  };
}

/**
 * 造一个内存版 localStorage，并注入 saveLogic
 * @returns {object} 存储后端（带 spy 计数）
 */
function useMemoryStorage() {
  const map = new Map();
  const store = {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    key(i) { const a = Array.from(map.keys()); return i < a.length ? a[i] : null; },
    get length() { return map.size; },
    // 测试用：直接看裸存储内容
    _raw: map
  };
  __setStorage(store);
  return store;
}

/** 造一局完整的测试用 state */
function makeState() {
  const data = loadData();
  const state = createNewGame(data.mapDefault);
  buildInitialForces(state, data);
  return { state, data };
}

// ──────────────────────────────────────────────
// 基础：存 / 取 往返
// ──────────────────────────────────────────────

test('saveGame：写入 localStorage 并返回摘要信息', () => {
  const store = useMemoryStorage();
  const { state } = makeState();

  const r = saveGame(state, 0);
  assert.equal(r.ok, true);
  assert.equal(r.slot, 0);
  assert.equal(r.label, '第1周第1天');
  assert.ok(r.savedAt > 0);

  // key 规则：ooqs_save_<slot>
  assert.ok(store._raw.has('ooqs_save_0'), '应写入 ooqs_save_0');
});

test('loadGame：完整恢复 state（英雄/城镇/资源一致）', () => {
  useMemoryStorage();
  const { state } = makeState();

  // 改点状态，验证能原样恢复
  state.players[0].gold = 4321;
  state.heroes[0].pos = { x: 7, y: 9 };
  state.towns[0].buildings.push('wei_barracks1');
  state.meta.day = 5;
  state.meta.week = 2;

  assert.equal(saveGame(state, 1).ok, true);

  const r = loadGame(1);
  assert.equal(r.ok, true);
  assert.equal(r.state.players[0].gold, 4321);
  assert.deepEqual(r.state.heroes[0].pos, { x: 7, y: 9 });
  assert.ok(r.state.towns[0].buildings.includes('wei_barracks1'));
  assert.equal(r.state.meta.day, 5);
  assert.equal(r.state.meta.week, 2);
  assert.equal(r.state.heroes.length, state.heroes.length);
  assert.equal(r.state.towns.length, state.towns.length);
});

test('loadGame：返回的是独立副本，改它不会污染存档', () => {
  useMemoryStorage();
  const { state } = makeState();
  saveGame(state, 0);

  const a = loadGame(0);
  a.state.players[0].gold = 999999;
  a.state.heroes.length = 0;

  const b = loadGame(0);
  assert.notEqual(b.state.players[0].gold, 999999, '第二次读档不应受第一次改动影响');
  assert.ok(b.state.heroes.length > 0);
});

test('存档保留地图资源的拾取状态（map.objects 减少能恢复）', () => {
  useMemoryStorage();
  const { state, data } = makeState();

  // 找一个资源格，把英雄挪过去再捡
  const obj = state.map.objects[0];
  const hero = state.heroes[0];
  hero.pos = { ...obj.pos };
  const before = state.map.objects.length;
  assert.equal(pickUpResource(state, hero.id, hero.pos).ok, true);
  assert.equal(state.map.objects.length, before - 1);

  saveGame(state, 0);
  const r = loadGame(0);
  assert.equal(r.state.map.objects.length, before - 1, '读档后地图上被捡走的资源不该回来');
});

// ──────────────────────────────────────────────
// 异常分支：空档 / 损坏 / 版本不符
// ──────────────────────────────────────────────

test('loadGame：空档位返回 empty', () => {
  useMemoryStorage();
  const r = loadGame(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty');
});

test('loadGame：内容被篡改成非法 JSON 时返回 corrupted（不抛错）', () => {
  const store = useMemoryStorage();
  store._raw.set('ooqs_save_0', '{这不是合法 JSON');
  const r = loadGame(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'corrupted');
});

test('loadGame：内容被篡改成别的结构时返回 corrupted', () => {
  const store = useMemoryStorage();
  store._raw.set('ooqs_save_0', JSON.stringify({ hello: 'world' }));
  assert.equal(loadGame(0).reason, 'corrupted');

  store._raw.set('ooqs_save_1', JSON.stringify({ version: 1, state: { meta: {} } }));
  assert.equal(loadGame(1).reason, 'corrupted', '缺 players/heroes/towns 应判为损坏');
});

test('loadGame：版本号不匹配返回 versionMismatch（不做迁移）', () => {
  const store = useMemoryStorage();
  const { state } = makeState();
  saveGame(state, 0);

  // 把存档里的版本号改成别的值
  const raw = JSON.parse(store._raw.get('ooqs_save_0'));
  raw.version = STATE_VERSION + 99;
  store._raw.set('ooqs_save_0', JSON.stringify(raw));

  const r = loadGame(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'versionMismatch');
  assert.equal(r.version, STATE_VERSION + 99);
});

// ──────────────────────────────────────────────
// 存档位管理
// ──────────────────────────────────────────────

test('listSaves：4 个档位（0/1/2/auto）占用情况正确', () => {
  useMemoryStorage();
  const { state } = makeState();

  let list = listSaves();
  assert.equal(list.length, 4);
  // 空槽位返回 null（契约：[{ slot, label, savedAt } | null, ...]）
  assert.deepEqual(list.map((x) => (x ? x.slot : null)), [null, null, null, null]);
  assert.ok(list.every((x) => x === null), '初始应全为空');

  saveGame(state, 1);
  autoSave(state);

  list = listSaves();
  assert.equal(list[0], null, '槽位 0 未存');
  assert.ok(list[1], '槽位 1 已存');
  assert.equal(list[1].label, '第1周第1天');
  assert.ok(list[1].savedAt > 0);
  assert.equal(list[2], null, '槽位 2 未存');
  assert.ok(list[3], '自动位已存');
  assert.equal(list[3].slot, 'auto');
});

test('listSaves：损坏的档位标成 corrupted 而不是静默当成空', () => {
  const store = useMemoryStorage();
  store._raw.set('ooqs_save_2', '坏内容');
  const list = listSaves();
  assert.ok(list[2]);
  assert.equal(list[2].corrupted, true);
  assert.equal(list[2].label, '存档损坏');
});

test('deleteSave：删除后槽位变空', () => {
  useMemoryStorage();
  const { state } = makeState();
  saveGame(state, 0);
  assert.ok(listSaves()[0]);

  assert.equal(deleteSave(0).ok, true);
  assert.equal(listSaves()[0], null);
  assert.equal(loadGame(0).reason, 'empty');
});

test('autoSave：写到 auto 位，不影响手动位', () => {
  const store = useMemoryStorage();
  const { state } = makeState();
  saveGame(state, 2);

  const r = autoSave(state);
  assert.equal(r.ok, true);
  assert.ok(store._raw.has('ooqs_save_auto'));
  assert.ok(store._raw.has('ooqs_save_2'), '手动位不应被自动存档覆盖');
  assert.equal(listSaves()[3].slot, AUTO_SLOT);
});

// ──────────────────────────────────────────────
// 边界与健壮性
// ──────────────────────────────────────────────

test('非法 slot 一律返回 invalidSlot（不抛错）', () => {
  useMemoryStorage();
  const { state } = makeState();
  for (const bad of [3, -1, 'xxx', null, undefined, {}]) {
    assert.equal(saveGame(state, bad).ok, false);
    assert.equal(saveGame(state, bad).reason, 'invalidSlot');
    assert.equal(loadGame(bad).reason, 'invalidSlot');
    assert.equal(deleteSave(bad).reason, 'invalidSlot');
  }
});

test('state 不是对象时返回 invalidState', () => {
  useMemoryStorage();
  assert.equal(saveGame(null, 0).reason, 'invalidState');
  assert.equal(saveGame(undefined, 0).reason, 'invalidState');
});

test('state 含循环引用时返回 serializeFailed（不抛错）', () => {
  useMemoryStorage();
  const { state } = makeState();
  state.self = state; // 制造环
  const r = saveGame(state, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'serializeFailed');
});

test('存储写入抛异常时返回 storageError（不抛错）', () => {
  const broken = {
    getItem() { return null; },
    setItem() { throw new Error('boom'); },
    removeItem() { throw new Error('boom'); }
  };
  __setStorage(broken);
  const { state } = makeState();
  const r = saveGame(state, 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'storageError');
});

test('存储读取抛异常时返回 corrupted（不抛错）', () => {
  const broken = {
    getItem() { throw new Error('boom'); },
    setItem() {},
    removeItem() {}
  };
  __setStorage(broken);
  const r = loadGame(0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'corrupted');
});

test('存档把 battle 置空（战斗是临时状态）', () => {
  const store = useMemoryStorage();
  const { state } = makeState();
  state.battle = { stacks: [{ id: 'x' }], round: 3 };
  saveGame(state, 0);

  const raw = JSON.parse(store._raw.get('ooqs_save_0'));
  assert.equal(raw.state.battle, null);
  assert.equal(loadGame(0).state.battle, null);
});

test('makeLabel：按周/天生成摘要', () => {
  assert.equal(makeLabel({ meta: { week: 1, day: 1 } }), '第1周第1天');
  assert.equal(makeLabel({ meta: { week: 3, day: 5 } }), '第3周第5天');
  assert.equal(makeLabel({}), '第1周第1天', '缺字段时给默认值');
});

test('formatSavedAt：时间戳格式化，非法值给兜底', () => {
  assert.match(formatSavedAt(Date.now()), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(formatSavedAt(0), '未知时间');
  assert.equal(formatSavedAt(NaN), '未知时间');
});

test('常量：手动位 3 个 + 自动位 1 个', () => {
  assert.deepEqual(MANUAL_SLOTS, [0, 1, 2]);
  assert.equal(AUTO_SLOT, 'auto');
  assert.deepEqual(SAVE_SLOTS, [0, 1, 2, 'auto']);
});

// 测试结束后把存储后端复位，避免影响其它测试文件
test('__resetStorage：恢复默认存储探测', () => {
  useMemoryStorage();
  __resetStorage();
  // 默认后端在 Node 下是内存存储，依然可用
  const { state } = makeState();
  assert.equal(saveGame(state, 0).ok, true);
  assert.equal(loadGame(0).ok, true);
});

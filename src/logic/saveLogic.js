import { STATE_VERSION } from '../core/GameState.js';

/**
 * saveLogic —— 存档系统（M12）
 *
 * 纯 JS，禁止 import phaser。职责：
 *   - 把 GameState 序列化成 JSON 存进 localStorage（3 个手动位 + 1 个自动位）
 *   - 读档时校验版本号；版本不一致**不做迁移**，直接返回 versionMismatch
 *   - 任何异常都不抛，统一返回 { ok:false, reason }
 *
 * 存档 key 规则：'ooqs_save_' + slot，slot ∈ {0, 1, 2, 'auto'}
 * 存档内容格式：
 *   {
 *     version: 1,          // STATE_VERSION，结构变动时 +1
 *     savedAt: 1730000000, // 时间戳（毫秒）
 *     label: '第1周第1天', // 给人看的摘要
 *     state: { ... }       // GameState 快照
 *   }
 *
 * 关于 state.battle：
 *   战斗是临时场景，存档只在地图层做（玩家点「结束回合」/ 自动存档都在地图层），
 *   因此存档时把 battle 置空，避免读档后出现"半个战场"的坏状态。
 *
 * 关于存储后端：
 *   浏览器里有 localStorage；Node 单测里没有，这里用内存 Map 兜底，
 *   并提供 __setStorage / __resetStorage 供测试注入。
 */

/** 手动存档位 */
export const MANUAL_SLOTS = [0, 1, 2];
/** 自动存档位 */
export const AUTO_SLOT = 'auto';
/** 全部存档位（顺序即 UI 展示顺序） */
export const SAVE_SLOTS = [0, 1, 2, AUTO_SLOT];

/** localStorage key 前缀 */
const KEY_PREFIX = 'ooqs_save_';

/**
 * 内存兜底存储（Node 单测环境 / 隐私模式降级）
 * @returns {object} 兼容 localStorage 的最小接口
 */
function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(k) { return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { map.set(k, String(v)); },
    removeItem(k) { map.delete(k); },
    key(i) { const a = Array.from(map.keys()); return i < a.length ? a[i] : null; },
    get length() { return map.size; }
  };
}

/** @type {object|null} 缓存的存储后端 */
let _storage = null;

/**
 * 取得存储后端
 *
 * 优先用 globalThis.localStorage；某些浏览器隐私模式下 localStorage 存在但
 * setItem 会抛异常，所以先做一次写探针，失败则降级到内存存储。
 *
 * @returns {object} 存储后端
 */
function getStorage() {
  if (_storage) return _storage;
  try {
    const ls = globalThis.localStorage;
    if (ls) {
      const probe = '__ooqs_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      _storage = ls;
      return _storage;
    }
  } catch (e) {
    // 隐私模式 / 配额受限 → 走内存存储
  }
  _storage = createMemoryStorage();
  return _storage;
}

/**
 * 测试钩子：注入自定义存储后端
 * @param {object|null} storage 兼容 localStorage 的对象，传 null 恢复默认
 */
export function __setStorage(storage) {
  _storage = storage;
}

/**
 * 测试钩子：清空存储后端（回到默认探测逻辑）
 */
export function __resetStorage() {
  _storage = null;
}

/**
 * 存档位的 key
 * @param {number|string} slot
 * @returns {string}
 */
function keyOf(slot) {
  return `${KEY_PREFIX}${slot}`;
}

/**
 * 规范化 slot：URL 参数等场景会传字符串 '0'，统一转成数字
 * @param {any} slot
 * @returns {number|'auto'|null} 合法则返回规范化后的 slot，非法返回 null
 */
export function normalizeSlot(slot) {
  if (slot === AUTO_SLOT) return AUTO_SLOT;
  if (typeof slot === 'number' && SAVE_SLOTS.includes(slot)) return slot;
  if (typeof slot === 'string' && /^\d+$/.test(slot)) {
    const n = Number(slot);
    if (SAVE_SLOTS.includes(n)) return n;
  }
  return null;
}

/**
 * 生成存档摘要文字
 * @param {object} state
 * @returns {string} 形如 '第1周第1天'
 */
export function makeLabel(state) {
  const week = state?.meta?.week ?? 1;
  const day = state?.meta?.day ?? 1;
  return `第${week}周第${day}天`;
}

/**
 * 保存游戏
 *
 * @param {object} state GameState（会被快照，不会被修改）
 * @param {number|'auto'} slot 存档位：0 | 1 | 2 | 'auto'
 * @returns {{ok:boolean, reason?:string, slot?:number|string, savedAt?:number, label?:string}}
 *   reason: 'invalidSlot' | 'invalidState' | 'serializeFailed' | 'quotaExceeded' | 'storageError'
 */
export function saveGame(state, slot) {
  try {
    const s = normalizeSlot(slot);
    if (s === null) return { ok: false, reason: 'invalidSlot' };
    if (!state || typeof state !== 'object') return { ok: false, reason: 'invalidState' };

    // 战斗是临时状态，存档统一置空
    const snapshot = { ...state, battle: null };
    const savedAt = Date.now();
    const payload = {
      version: STATE_VERSION,
      savedAt,
      label: makeLabel(state),
      state: snapshot
    };

    let text;
    try {
      text = JSON.stringify(payload);
    } catch (e) {
      return { ok: false, reason: 'serializeFailed' };
    }

    try {
      getStorage().setItem(keyOf(s), text);
    } catch (e) {
      // 配额满是最常见原因
      const quota = /quota|exceed/i.test(String(e && e.name) + String(e && e.message));
      return { ok: false, reason: quota ? 'quotaExceeded' : 'storageError' };
    }

    return { ok: true, slot: s, savedAt, label: payload.label };
  } catch (e) {
    return { ok: false, reason: 'storageError' };
  }
}

/**
 * 读取存档
 *
 * @param {number|'auto'} slot
 * @returns {{ok:boolean, state?:object, reason?:string, savedAt?:number, label?:string, version?:number}}
 *   reason: 'invalidSlot' | 'empty' | 'corrupted' | 'versionMismatch'
 */
export function loadGame(slot) {
  try {
    const s = normalizeSlot(slot);
    if (s === null) return { ok: false, reason: 'invalidSlot' };

    const raw = getStorage().getItem(keyOf(s));
    if (raw === null || raw === undefined || raw === '') {
      return { ok: false, reason: 'empty' };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 内容被篡改成非法 JSON
      return { ok: false, reason: 'corrupted' };
    }

    // 结构校验：不是对象 / 缺字段 / state 不是对象 → 视为损坏
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'corrupted' };
    }
    if (typeof parsed.version !== 'number' || !parsed.state || typeof parsed.state !== 'object') {
      return { ok: false, reason: 'corrupted' };
    }
    // state 基本字段缺失也算损坏（防止半截 JSON 被当成有效存档）
    const st = parsed.state;
    if (!st.meta || !Array.isArray(st.players) || !Array.isArray(st.heroes) || !Array.isArray(st.towns)) {
      return { ok: false, reason: 'corrupted' };
    }

    // 版本不匹配：不做迁移，直接拒绝
    if (parsed.version !== STATE_VERSION) {
      return { ok: false, reason: 'versionMismatch', version: parsed.version };
    }

    return {
      ok: true,
      state: parsed.state, // JSON.parse 出来的就是独立副本，改它不会影响存档
      savedAt: parsed.savedAt,
      label: parsed.label,
      version: parsed.version
    };
  } catch (e) {
    return { ok: false, reason: 'corrupted' };
  }
}

/**
 * 列出所有存档位的摘要（供读档界面显示）
 *
 * @returns {Array<{slot:number|string, label:string, savedAt:number, corrupted?:boolean}>}
 *   没有有效存档的槽位返回 null
 */
export function listSaves() {
  const out = [];
  for (const slot of SAVE_SLOTS) {
    out.push(readSlotSummary(slot));
  }
  return out;
}

/**
 * 读单个槽位的摘要（不返回完整 state，避免解析开销）
 * @param {number|'auto'} slot
 * @returns {object|null}
 */
function readSlotSummary(slot) {
  try {
    const raw = getStorage().getItem(keyOf(slot));
    if (raw === null || raw === undefined || raw === '') return null;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { slot, label: '存档损坏', savedAt: 0, corrupted: true };
    }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number' || !parsed.state) {
      return { slot, label: '存档损坏', savedAt: 0, corrupted: true };
    }
    if (parsed.version !== STATE_VERSION) {
      return { slot, label: '版本不符', savedAt: parsed.savedAt || 0, corrupted: true };
    }
    return {
      slot,
      label: parsed.label || makeLabel(parsed.state),
      savedAt: parsed.savedAt || 0
    };
  } catch (e) {
    return null;
  }
}

/**
 * 删除存档
 * @param {number|'auto'} slot
 * @returns {{ok:boolean, reason?:string}}
 */
export function deleteSave(slot) {
  try {
    const s = normalizeSlot(slot);
    if (s === null) return { ok: false, reason: 'invalidSlot' };
    getStorage().removeItem(keyOf(s));
    return { ok: true, slot: s };
  } catch (e) {
    return { ok: false, reason: 'storageError' };
  }
}

/**
 * 自动存档：写 'auto' 位
 *
 * 由渲染层在 'day:new' 事件时调用（每天开始时留一个档）。
 *
 * @param {object} state
 * @returns {{ok:boolean, reason?:string}}
 */
export function autoSave(state) {
  return saveGame(state, AUTO_SLOT);
}

/**
 * 把时间戳格式化成人类可读的文本（UI 用）
 * @param {number} ts 毫秒时间戳
 * @returns {string} 形如 '2026-11-19 18:53'
 */
export function formatSavedAt(ts) {
  if (!ts) return '未知时间';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

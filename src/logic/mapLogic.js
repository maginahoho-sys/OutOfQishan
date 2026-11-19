import bus from '../core/EventBus.js';

/**
 * mapLogic —— 大地图逻辑（纯 JS，禁止 import phaser）
 *
 * 职责：寻路、移动结算、可达范围、格子交互判定。
 * 所有函数只操作 state 纯数据，通过 EventBus 通知渲染层。
 *
 * 地形码：0平原(1点/格) 1森林(2点/格) 2山地(不可走) 3水域(不可走) 4道路(0.5点/格)
 * 内部用「半点」整数计费，避免浮点误差（平原2 森林4 道路1）。
 */

export const TERRAIN = {
  PLAIN: 0,
  FOREST: 1,
  MOUNTAIN: 2,
  WATER: 3,
  ROAD: 4
};

/** 每格行动力消耗（半点） */
const COST_HALF = {
  [TERRAIN.PLAIN]: 2,
  [TERRAIN.FOREST]: 4,
  [TERRAIN.ROAD]: 1
};

/** 四方向移动 */
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

/** 坐标转字符串键 */
const key = (x, y) => `${x},${y}`;

/**
 * 判断格子是否在地图内且可通行
 * @param {object} map
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
export function isWalkable(map, x, y) {
  if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
  const t = map.tiles[y][x];
  return t !== TERRAIN.MOUNTAIN && t !== TERRAIN.WATER;
}

/**
 * 取某格地形的行动力消耗（半点）
 * @param {number} terrain 地形码
 * @returns {number} 不可走返回 Infinity
 */
export function terrainCostHalf(terrain) {
  const c = COST_HALF[terrain];
  return c === undefined ? Infinity : c;
}

/**
 * 收集地图上被占据的格子（英雄与城镇）
 * @param {object} state
 * @param {string} [exceptHeroId] 排除该英雄自身
 * @returns {Array<{x:number,y:number,kind:'hero'|'town',id:string}>}
 */
export function occupiedTiles(state, exceptHeroId = null) {
  const list = [];
  for (const h of state.heroes) {
    if (h.id === exceptHeroId) continue;
    list.push({ x: h.pos.x, y: h.pos.y, kind: 'hero', id: h.id });
  }
  for (const t of state.towns) {
    list.push({ x: t.pos.x, y: t.pos.y, kind: 'town', id: t.id });
  }
  return list;
}

/**
 * 某个英雄寻路时的障碍格集合
 *
 * 与 occupiedTiles 的区别：**排除该英雄当前所在的格子**。
 *
 * 为什么要排除：英雄进城后会与城镇格重合，而 findPath 遇到"起点被占"会直接
 * 返回 null（无法出发）。若不排除，英雄一旦站到城镇格上就再也走不出来，
 * 玩家和电脑都会被卡死（电脑在城里补完兵同样出不来）。
 *
 * @param {object} state
 * @param {string} heroId
 * @param {{x:number,y:number}} [fromPos] 起点坐标。
 *   默认为英雄当前所在格。规划层传入「假设位置」时用这个参数
 *   （例如英雄进城补兵后，战术规划要从城里的位置继续算）。
 * @returns {Array<{x:number,y:number,kind:'hero'|'town',id:string}>}
 */
export function blockedFor(state, heroId, fromPos = null) {
  const list = occupiedTiles(state, heroId);
  const hero = state.heroes.find((h) => h.id === heroId);
  const start = fromPos || hero?.pos;
  if (!start) return list;
  return list.filter((p) => !(p.x === start.x && p.y === start.y));
}

/** 曼哈顿距离启发（以半点计，最便宜一格为道路=1半点，故 ×1 可采纳） */
function heuristic(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * A* 寻路
 * @param {object} map  state.map（含 width/height/tiles）
 * @param {{x:number,y:number}} from 起点
 * @param {{x:number,y:number}} to   终点
 * @param {Array<{x:number,y:number}>} [blocked] 不可穿越的格子（终点除外）
 * @returns {Array<{x:number,y:number}>|null} 路径（含终点、不含起点）；不可达返回 null
 */
export function findPath(map, from, to, blocked = []) {
  if (!map || !from || !to) return null;
  // 终点必须是可通行地形
  if (!isWalkable(map, to.x, to.y)) return null;

  const blockedSet = new Set(blocked.map((p) => key(p.x, p.y)));
  const goalKey = key(to.x, to.y);
  const startKey = key(from.x, from.y);
  if (startKey === goalKey) return [];
  // 起点被他人/城镇占据时无法出发
  if (blockedSet.has(startKey)) return null;

  const open = [{ x: from.x, y: from.y, g: 0, f: heuristic(from, to) }];
  const gScore = new Map([[startKey, 0]]);
  const cameFrom = new Map();
  const closed = new Set();

  while (open.length > 0) {
    // 小地图直接线性取最小值即可
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (ck === goalKey) {
      // 回溯路径：含终点、不含起点
      const path = [{ x: cur.x, y: cur.y }];
      let k = ck;
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k);
        if (key(prev.x, prev.y) === startKey) break; // 起点不计入路径
        path.unshift({ x: prev.x, y: prev.y });
        k = key(prev.x, prev.y);
      }
      return path;
    }

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(map, nx, ny)) continue;
      const nk = key(nx, ny);
      // 被占用的格不可穿越，但允许作为终点（用于进城/遭遇战）
      if (blockedSet.has(nk) && nk !== goalKey) continue;

      const step = terrainCostHalf(map.tiles[ny][nx]);
      const ng = cur.g + step;
      if (gScore.has(nk) && gScore.get(nk) <= ng) continue;

      gScore.set(nk, ng);
      cameFrom.set(nk, { x: cur.x, y: cur.y });
      open.push({ x: nx, y: ny, g: ng, f: ng + heuristic({ x: nx, y: ny }, to) });
    }
  }
  return null;
}

/**
 * 计算路径的行动力消耗
 * 连续同地形合并成一段后向上取整（道路两格=1点）
 * @param {object} map
 * @param {Array<{x:number,y:number}>} path findPath 的返回值
 * @returns {number} 总消耗（整数）
 */
export function pathCost(map, path) {
  if (!path || path.length === 0) return 0;
  const unit = (t) => (t === TERRAIN.ROAD ? 0.5 : t === TERRAIN.FOREST ? 2 : 1);
  let total = 0;
  let segTerrain = null;
  let segLen = 0;
  for (const p of path) {
    const t = map.tiles[p.y][p.x];
    if (t !== segTerrain) {
      if (segTerrain !== null) total += Math.ceil(segLen * unit(segTerrain));
      segTerrain = t;
      segLen = 0;
    }
    segLen++;
  }
  total += Math.ceil(segLen * unit(segTerrain));
  return total;
}

/**
 * 执行英雄移动：扣行动力、更新位置、发事件
 * @param {object} state
 * @param {string} heroId
 * @param {{x:number,y:number}} to
 * @returns {{ok:boolean, reason?:string, path?:Array, cost?:number}}
 *   reason: 'noHero' | 'noPath' | 'notEnoughMove'
 */
export function moveHero(state, heroId, to) {
  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };

  // 用 blockedFor（排除自己当前所在格）而不是 occupiedTiles：
  // 英雄站上城镇格后与城镇重合，若起点被判为障碍将无法出发，会卡死双方
  const blocked = blockedFor(state, heroId);
  const path = findPath(state.map, hero.pos, to, blocked);
  if (!path) return { ok: false, reason: 'noPath' };

  const cost = pathCost(state.map, path);
  if (cost > hero.movePoints) return { ok: false, reason: 'notEnoughMove' };

  const from = { ...hero.pos };
  hero.pos = { x: to.x, y: to.y };
  hero.movePoints -= cost;

  bus.emit('hero:moved', { heroId, from, to: { x: to.x, y: to.y }, cost });
  return { ok: true, path, cost };
}

/**
 * 查询英雄当前可达的所有格子
 * 敌方英雄/城镇格可作为终点（触发战斗/攻城），但不可穿越
 * @param {object} state
 * @param {string} heroId
 * @returns {Array<{x:number,y:number,cost:number}>} 按 cost 升序
 */
export function reachableTiles(state, heroId) {
  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return [];

  const blockedSet = new Set(occupiedTiles(state, heroId).map((p) => key(p.x, p.y)));
  const budget = hero.movePoints * 2; // 半点预算
  const startKey = key(hero.pos.x, hero.pos.y);

  const dist = new Map([[startKey, 0]]);
  const open = [{ x: hero.pos.x, y: hero.pos.y, g: 0 }];
  const out = [];

  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].g < open[bi].g) bi = i;
    const cur = open.splice(bi, 1)[0];
    const ck = key(cur.x, cur.y);
    if (cur.g > (dist.get(ck) ?? Infinity)) continue;
    if (ck !== startKey) out.push({ x: cur.x, y: cur.y, cost: Math.ceil(cur.g / 2) });
    // 被占用的格只能作为终点，不再向外扩展（不可穿越）
    if (cur.terminal) continue;

    for (const [dx, dy] of DIRS) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(state.map, nx, ny)) continue;
      const nk = key(nx, ny);
      const step = terrainCostHalf(state.map.tiles[ny][nx]);
      const ng = cur.g + step;
      if (ng > budget) continue;
      if (ng < (dist.get(nk) ?? Infinity)) {
        dist.set(nk, ng);
        // 该格被他人/城镇占据 → 标记为终点型节点
        open.push({ x: nx, y: ny, g: ng, terminal: blockedSet.has(nk) });
      }
    }
  }
  return out.sort((a, b) => a.cost - b.cost || a.y - b.y || a.x - b.x);
}

/**
 * 拾取地图上的资源
 * @param {object} state
 * @param {string} heroId 拾取者（资源归其所属玩家）
 * @param {{x:number,y:number}} pos 资源所在格
 * @returns {{ok:boolean, reason?:string, resource?:string, amount?:number}}
 */
export function pickUpResource(state, heroId, pos) {
  const objects = state.map.objects || [];
  const idx = objects.findIndex(
    (o) => o.type === 'resource' && o.pos.x === pos.x && o.pos.y === pos.y
  );
  if (idx === -1) return { ok: false, reason: 'noResource' };

  const hero = state.heroes.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };

  const obj = objects[idx];
  const player = state.players.find((p) => p.id === hero.playerId);
  const res = obj.resource;   // gold / wood / ore / mercury / sulfur / crystal / gem
  const amount = obj.amount || 0;

  player[res] = (player[res] || 0) + amount;
  objects.splice(idx, 1); // 资源从地图上移除

  bus.emit('resource:changed', { playerId: player.id, resources: { [res]: amount } });
  bus.emit('resource:picked', { heroId, object: obj });
  return { ok: true, resource: res, amount };
}

/**
 * 查询格子上的交互对象
 * @param {object} state
 * @param {{x:number,y:number}} pos
 * @returns {{type:string}|null}
 *   'resource' | 'enemyHero' | 'enemyTown' | 'ownTown'
 */
export function checkTileInteraction(state, pos) {
  if (!pos) return null;
  const me = state.players[state.meta.currentPlayer];

  // 城镇
  const town = state.towns.find((t) => t.pos.x === pos.x && t.pos.y === pos.y);
  if (town) {
    return { type: town.playerId === me.id ? 'ownTown' : 'enemyTown', town };
  }

  // 敌方英雄（同一格上可能同时有进攻方与守方英雄，必须挑敌方的那个）
  const enemyHero = state.heroes.find(
    (h) => h.pos.x === pos.x && h.pos.y === pos.y && h.playerId !== me.id
  );
  if (enemyHero) {
    return { type: 'enemyHero', hero: enemyHero };
  }

  // 地图资源（己方英雄踩在资源上时也应能拾取）
  const obj = (state.map.objects || []).find((o) => o.pos.x === pos.x && o.pos.y === pos.y);
  if (obj && obj.type === 'resource') {
    return { type: 'resource', object: obj };
  }

  return null;
}

import {
  findPath,
  moveHero,
  reachableTiles,
  blockedFor,
  terrainCostHalf,
  pickUpResource
} from './mapLogic.js';
import { recruit, construct } from './townLogic.js';
import { armyValue } from './battleLogic.js';
import { canAfford } from './turnLogic.js';

/**
 * mapAI —— 地图 AI（M11）
 *
 * ── 分层 ────────────────────────────────────────────────────
 *   1. **规划层**（纯函数，不改 state）
 *      planMapTurn(state, data, playerId, opts) → 行动序列（steps）
 *      负责：去哪捡东西 / 打谁 / 攻哪个城 / 往哪推进 / 要不要回城补兵
 *   2. **执行层**（改状态，只走 M2/M4/M5 的导出函数）
 *      executeMapStep(state, data, step) → 执行单步
 *      aiMapTurn(state, data)          → 规划 + 全部执行（契约入口）
 *
 * 规划与执行分离，MapScene 才能把「移动」「战斗」「招募」拆开逐步播放动画。
 *
 * ── 策略（契约 M11 定案）────────────────────────────────────
 *   0. **城务**（每回合先做，见「与契约顺序的差异」）
 *      缺兵营 → 建兵营；新一周 → 派英雄进城补一队 T1 兵。
 *   1. **捡便宜**：可达范围内有未捡资源 → 走最近的去捡。
 *   2. **打得过就打**：可达范围内有玩家英雄且己方军队 aiValue 总和
 *      > 对方 × 1.2 → 移动并触发战斗。
 *   3. **攻城**：己方军队 aiValue 总和 > 3000 且能走到玩家城镇 → 去攻城。
 *   4. **否则推进**：沿 findPath 往玩家主城方向走，行动力用完为止。
 *
 * ── 约束 ────────────────────────────────────────────────────
 *   · 写状态只允许通过 M2（moveHero / pickUpResource）、
 *     M4（canAfford，只读）、M5（recruit / construct）的导出函数；
 *   · M6 的 armyValue 只做**读取**，用于算「aiValue 总和」；
 *   · 移动**一步一调用 moveHero**，hero:moved 事件逐格发出，界面能看到移动；
 *   · 不读取也不修改玩家 0 的私有决策，只读公开状态；
 *   · 单回合最多 MAX_MOVE_CALLS 次移动调用，超出强制停止（验收 3）。
 *
 * ── 成本口径 ────────────────────────────────────────────────
 *   moveHero 内部按 pathCost 计费：连续同地形合并后向上取整（道路 2 格 = 1 点）。
 *   但本模块**逐格**调用 moveHero，每次只走一格，单格成本是：
 *     道路 1 点 / 平原 1 点 / 森林 2 点
 *   所以规划预算时用 pathStepCost（逐格累加），
 *   不能直接用 reachableTiles 的 cost（那是连续口径，会偏乐观）。
 *   连续口径 ⊆ 逐格口径，所以 reachableTiles 可以用来做**候选粗筛**，
 *   再用 pathStepCost 做**精确校验**。
 *
 * ── 规划态仿真（sim）────────────────────────────────────────
 *   一个回合里英雄会移动、进城、补兵，这些都会改变后续决策依据
 *   （比如补完兵 aiValue 涨了，可能就够资格攻城了）。
 *   所以规划层不直接读真 state，而是先造一份**影子副本** sim，
 *   在 sim 上逐步「预演」每一步，等真执行时结果完全一致。
 *   规划层只读真 state，不写；sim 是纯拷贝，改它不影响真 state。
 */

/** 策略 2：主动开战的战力倍数门槛（己方 > 对方 × 该值） */
const FIGHT_VALUE_RATIO = 1.2;

/** 策略 3：攻城所需的最低 armyValue */
const SIEGE_VALUE_MIN = 3000;

/** 验收 3：单回合最多移动调用次数，超出强制停止 */
export const MAX_MOVE_CALLS = 100;

/** 「补满一队」的目标数量（一队满编，口径对齐 M5 验收「招募 10 个乡勇」） */
const STACK_TARGET = 10;

// ══════════════════════════════════════════════════
// 基础工具
// ══════════════════════════════════════════════════

/**
 * 取当前行动玩家 id（AI 回合就是电脑玩家的 id）
 * @param {object} state
 * @returns {number}
 */
function currentPlayerId(state) {
  const cur = state.players[state.meta.currentPlayer];
  if (cur) return cur.id;
  const ai = state.players.find((p) => p.isAI);
  return ai ? ai.id : 1;
}

/**
 * 计算一条路径**逐格走**的行动力消耗
 *
 * 与 moveHero 的实际扣费一致（moveHero 每次只走一格时 pathCost 的结果）：
 *   道路 1 点 / 平原 1 点 / 森林 2 点
 *
 * @param {object} map
 * @param {Array<{x:number,y:number}>} path
 * @returns {number} 消耗（点）；不可通行返回 Infinity
 */
function pathStepCost(map, path) {
  if (!path || path.length === 0) return 0;
  let cost = 0;
  for (const p of path) {
    const half = terrainCostHalf(map.tiles[p.y][p.x]);
    if (!Number.isFinite(half)) return Infinity;
    cost += Math.ceil(half / 2);
  }
  return cost;
}

/**
 * 把路径拆成逐格的移动步骤
 * @param {object} hero
 * @param {Array<{x:number,y:number}>} path
 * @returns {Array<object>}
 */
function moveSteps(hero, path) {
  return path.map((p) => ({ type: 'move', heroId: hero.id, to: { x: p.x, y: p.y } }));
}

/**
 * 造一份「规划态影子副本」
 *
 * 拷贝的是会被步骤改变的部分：英雄位置/行动力/军队、城镇建筑/产量池、
 * 玩家资源、地图资源点。真 state 完全不被触碰。
 *
 * ⚠️ 必须把 data 里的 units 一起带进来：
 *    预演招募时要按兵种单价扣钱，缺了 units 会算成 0 金，
 *    导致「钱不够」的情况判断不出来（可能规划出付不起的招兵）。
 *
 * @param {object} state
 * @param {object} data
 * @returns {object} sim
 */
function makeSim(state, data) {
  return {
    ...state,
    units: data?.units || [],
    buildings: data?.buildings || [],
    players: state.players.map((p) => ({ ...p })),
    heroes: state.heroes.map((h) => ({
      ...h,
      pos: { ...h.pos },
      army: (h.army || []).map((a) => ({ ...a }))
    })),
    towns: state.towns.map((t) => ({
      ...t,
      buildings: [...(t.buildings || [])],
      recruitPool: (t.recruitPool || []).map((s) => ({ ...s }))
    })),
    map: {
      ...state.map,
      objects: (state.map.objects || []).map((o) => ({ ...o, pos: { ...o.pos } }))
    }
  };
}

/**
 * 在影子状态上预演一步（与执行层的实际效果保持一致）
 *
 * @param {object} sim
 * @param {object} step
 */
function applyStepToSim(sim, step) {
  if (step.type === 'move') {
    const hero = sim.heroes.find((h) => h.id === step.heroId);
    if (!hero) return;
    const half = terrainCostHalf(sim.map.tiles[step.to.y][step.to.x]);
    hero.pos = { x: step.to.x, y: step.to.y };
    hero.movePoints = Math.max(0, hero.movePoints - Math.ceil(half / 2));
    return;
  }

  if (step.type === 'pickup') {
    const hero = sim.heroes.find((h) => h.id === step.heroId);
    if (!hero) return;
    const idx = sim.map.objects.findIndex(
      (o) => o.type === 'resource' && o.pos.x === step.pos.x && o.pos.y === step.pos.y
    );
    if (idx === -1) return;
    const obj = sim.map.objects[idx];
    const player = sim.players.find((p) => p.id === hero.playerId);
    player[obj.resource] = (player[obj.resource] || 0) + (obj.amount || 0);
    sim.map.objects.splice(idx, 1);
    return;
  }

  if (step.type === 'recruit') {
    const hero = sim.heroes.find((h) => h.id === step.heroId);
    const town = sim.towns.find((t) => t.id === step.townId);
    if (!hero || !town) return;
    const slot = (town.recruitPool || []).find((s) => s.unitId === step.unitId);
    if (slot) slot.count -= step.count;
    const existing = hero.army.find((a) => a.unitId === step.unitId);
    if (existing) existing.count += step.count;
    else hero.army.push({ unitId: step.unitId, count: step.count });
    const unit = (sim.units || []).find((u) => u.id === step.unitId);
    const price = unit?.cost?.gold || 0;
    const player = sim.players.find((p) => p.id === hero.playerId);
    player.gold = Math.max(0, (player.gold || 0) - price * step.count);
    return;
  }

  if (step.type === 'build') {
    const town = sim.towns.find((t) => t.id === step.townId);
    if (!town) return;
    town.buildings = [...(town.buildings || []), step.buildingId];
    town.builtToday = (town.builtToday || 0) + 1;
    // 建造要扣钱（与 M5 的 construct 一致），否则「钱够不够」的判断会偏松
    const building = (sim.buildings || []).find((b) => b.id === step.buildingId);
    const cost = building?.cost || {};
    const player = sim.players.find((p) => p.id === town.playerId);
    if (player) {
      for (const [res, amount] of Object.entries(cost)) {
        player[res] = Math.max(0, (player[res] || 0) - amount);
      }
    }
    return;
  }
}

/**
 * 某格是否被敌方城镇占据（推进时不能踩上去，否则白白触发攻城）
 * @param {object} state
 * @param {object} hero
 * @param {{x:number,y:number}} pos
 * @returns {boolean}
 */
function isEnemyTown(state, hero, pos) {
  return state.towns.some(
    (t) => t.playerId !== hero.playerId && t.pos.x === pos.x && t.pos.y === pos.y
  );
}

// ══════════════════════════════════════════════════
// 策略 0 · 城务（建兵营 + 回城补兵）
// ══════════════════════════════════════════════════

/**
 * 规划城务
 *
 * 契约原文：「城中无英雄驻守且轮到新一周：若资源够，自动招募 T1 兵补满一队
 * （调 M5 的 recruit）」。
 *
 * 实现要点：
 *   · recruit 要求英雄**站在城镇格上**才算进城（townLogic 的硬约束），
 *     所以要先派一个英雄走到城里，再调用 recruit；
 *   · 「补满一队」= 补足一队满编（10 个，口径对齐 M5 验收标准
 *     「招募 10 个乡勇：扣 400 金、英雄军队乡勇 40→50」）；
 *   · 「轮到新一周」= state.meta.day === 1。产量池每周一由 M4 的
 *     weeklyRecruitPool 刷新（week 递增），所以每周只有周一能补兵，
 *     不会天天把英雄拉回城；
 *   · 开局城镇只有大本营、没有兵营，而兵营是招兵的前提，
 *     所以缺兵营时先调 construct 建一个（construct 会立刻把该兵种
 *     按 growth 补进本周产量池，于是同一回合就能招）。
 *
 * @param {object} sim 影子状态
 * @param {object} data
 * @param {number} playerId
 * @returns {Array<object>} 城务步骤
 */
function planCityDefense(sim, data, playerId) {
  const steps = [];
  const towns = sim.towns.filter((t) => t.playerId === playerId);

  for (const town of towns) {
    const built = new Set(town.buildings || []);

    // ── 缺兵营 → 建一个（每城每日限建 1 个）──
    const hasBarracks = (data.buildings || []).some(
      (b) => built.has(b.id) && b.recruitTier === 1 && b.faction === town.faction
    );
    if (!hasBarracks) {
      const barrack = (data.buildings || []).find(
        (b) =>
          b.faction === town.faction &&
          b.recruitTier === 1 &&
          !built.has(b.id) &&
          (b.requires || []).every((r) => built.has(r)) &&
          !(b.excludes || []).some((e) => built.has(e)) &&
          canAfford(sim, playerId, b.cost)
      );
      if (barrack && (town.builtToday || 0) < 1) {
        steps.push({
          type: 'build',
          heroId: null,
          townId: town.id,
          buildingId: barrack.id
        });
        // 预演建造：construct 会把兵种按 growth 补进产量池
        applyStepToSim(sim, { type: 'build', heroId: null, townId: town.id, buildingId: barrack.id });
        const newUnit = (data.units || []).find((u) => u.id === barrack.recruitUnit);
        if (newUnit && !(town.recruitPool || []).some((s) => s.unitId === newUnit.id)) {
          town.recruitPool = [
            ...(town.recruitPool || []),
            { unitId: newUnit.id, count: newUnit.growth ?? 0 }
          ];
        }
      }
    }

    // ── 只在新一周（产量刚刷新）补兵 ──
    if (sim.meta.day !== 1) continue;

    // ── 池子里找有货的 T1 兵种 ──
    const t1Units = (data.units || []).filter(
      (u) => u.faction === town.faction && u.tier === 1
    );
    const slot = (town.recruitPool || []).find(
      (s) => s.count > 0 && t1Units.some((u) => u.id === s.unitId)
    );
    if (!slot) continue;

    const unit = t1Units.find((u) => u.id === slot.unitId);
    if (!unit) continue;

    // ── 派一个英雄进城 ──
    const pick = pickRecruitHero(sim, town, playerId);
    if (!pick) continue;

    // ── 招募数量：受产量池与金币双重限制 ──
    const gold = sim.players[playerId].gold || 0;
    const price = unit.cost?.gold || 0;
    const affordable = price > 0 ? Math.floor(gold / price) : STACK_TARGET;
    const count = Math.max(0, Math.min(STACK_TARGET, slot.count, affordable));
    if (count <= 0) continue;

    // 先走到城里（已经在城里就不用移动）
    const moveStepsToTown = pick.path.length > 0 ? moveSteps(pick.hero, pick.path) : [];

    const recruitStep = {
      type: 'recruit',
      heroId: pick.hero.id,
      townId: town.id,
      unitId: unit.id,
      count
    };
    steps.push(...moveStepsToTown, recruitStep);

    // 预演：补完兵后英雄位置与兵力都变了，后续战术要按新状态算
    for (const s of moveStepsToTown) applyStepToSim(sim, s);
    applyStepToSim(sim, recruitStep);
  }

  return steps;
}

/**
 * 挑一个去城里补兵的英雄：离城镇最近、且这一轮走得到
 *
 * 优先选「已在城里」的英雄（省得走过去），其次选路更近的。
 *
 * @param {object} sim
 * @param {object} town 目标城镇
 * @param {number} playerId 城镇所属玩家
 * @returns {{hero:object, path:Array, cost:number}|null}
 */
function pickRecruitHero(sim, town, playerId) {
  let best = null;

  for (const hero of sim.heroes.filter((h) => h.playerId === playerId)) {
    const blocked = blockedFor(sim, hero.id, hero.pos);
    const path = findPath(sim.map, hero.pos, town.pos, blocked);
    if (path === null) continue; // 完全走不到
    const cost = pathStepCost(sim.map, path);
    if (!Number.isFinite(cost) || cost > hero.movePoints) continue;

    const inTown = path.length === 0;
    const better =
      !best ||
      (inTown && !best.inTown) ||
      (inTown === best.inTown && cost < best.cost);
    if (better) best = { hero, path, cost, inTown };
  }

  return best;
}

// ══════════════════════════════════════════════════
// 策略 1 · 捡便宜
// ══════════════════════════════════════════════════

/**
 * 规划「去捡最近的一个资源」
 *
 * 候选来源：地图上还没被捡走的资源点（map.objects）。
 * 粗筛用 reachableTiles（契约点名的「可达范围」），
 * 精选用 pathStepCost 校验逐格走的真实消耗。
 *
 * @param {object} sim
 * @param {object} hero
 * @returns {Array<object>} 行动序列
 */
function planPickup(sim, hero) {
  const objects = (sim.map.objects || []).filter((o) => o.type === 'resource');
  if (objects.length === 0) return [];

  const reach = new Set(reachableTiles(sim, hero.id).map((t) => `${t.x},${t.y}`));
  const blocked = blockedFor(sim, hero.id, hero.pos);

  let best = null;
  for (const obj of objects) {
    // 契约：只在可达范围内挑
    if (!reach.has(`${obj.pos.x},${obj.pos.y}`)) continue;

    const path = findPath(sim.map, hero.pos, obj.pos, blocked);
    if (!path || path.length === 0) continue;

    const cost = pathStepCost(sim.map, path);
    if (!Number.isFinite(cost) || cost > hero.movePoints) continue;

    if (!best || cost < best.cost) best = { obj, path, cost };
  }

  if (!best) return [];

  const steps = moveSteps(hero, best.path);
  steps.push({
    type: 'pickup',
    heroId: hero.id,
    pos: { x: best.obj.pos.x, y: best.obj.pos.y }
  });
  return steps;
}

// ══════════════════════════════════════════════════
// 策略 2 · 打得过就打
// ══════════════════════════════════════════════════

/**
 * 规划「打一个打得过的玩家英雄」
 *
 * 条件（契约）：可达范围内有玩家英雄，且己方军队 aiValue 总和 > 对方 × 1.2。
 * 多个候选时挑最近（路径消耗最小）的那个。
 *
 * @param {object} sim
 * @param {object} data
 * @param {object} hero
 * @returns {Array<object>}
 */
function planFight(sim, data, hero) {
  const myValue = armyValue(hero.army || [], data);
  const reach = new Set(reachableTiles(sim, hero.id).map((t) => `${t.x},${t.y}`));
  const blocked = blockedFor(sim, hero.id, hero.pos);

  let best = null;
  for (const enemy of sim.heroes) {
    if (enemy.playerId === hero.playerId) continue;
    // 契约：只在可达范围内
    if (!reach.has(`${enemy.pos.x},${enemy.pos.y}`)) continue;

    const enemyValue = armyValue(enemy.army || [], data);
    // 契约：己方 > 对方 × 1.2 才打
    if (!(myValue > enemyValue * FIGHT_VALUE_RATIO)) continue;

    const path = findPath(sim.map, hero.pos, enemy.pos, blocked);
    if (!path || path.length === 0) continue;

    const cost = pathStepCost(sim.map, path);
    if (!Number.isFinite(cost) || cost > hero.movePoints) continue;

    if (!best || cost < best.cost) best = { enemy, path, cost };
  }

  if (!best) return [];

  const steps = moveSteps(hero, best.path);
  steps.push({
    type: 'battle',
    heroId: hero.id,
    targetType: 'hero',
    targetId: best.enemy.id
  });
  return steps;
}

// ══════════════════════════════════════════════════
// 策略 3 · 攻城
// ══════════════════════════════════════════════════

/**
 * 规划「攻一座玩家城镇」
 *
 * 条件（契约）：己方军队 aiValue 总和 > 3000，且能走到玩家城镇。
 *
 * @param {object} sim
 * @param {object} data
 * @param {object} hero
 * @returns {Array<object>}
 */
function planSiege(sim, data, hero) {
  const myValue = armyValue(hero.army || [], data);
  if (!(myValue > SIEGE_VALUE_MIN)) return [];

  const reach = new Set(reachableTiles(sim, hero.id).map((t) => `${t.x},${t.y}`));
  const blocked = blockedFor(sim, hero.id, hero.pos);

  let best = null;
  for (const town of sim.towns) {
    if (town.playerId === hero.playerId) continue;
    if (!reach.has(`${town.pos.x},${town.pos.y}`)) continue;

    const path = findPath(sim.map, hero.pos, town.pos, blocked);
    if (!path || path.length === 0) continue;

    const cost = pathStepCost(sim.map, path);
    if (!Number.isFinite(cost) || cost > hero.movePoints) continue;

    if (!best || cost < best.cost) best = { town, path, cost };
  }

  if (!best) return [];

  const steps = moveSteps(hero, best.path);
  steps.push({
    type: 'battle',
    heroId: hero.id,
    targetType: 'town',
    targetId: best.town.id
  });
  return steps;
}

// ══════════════════════════════════════════════════
// 策略 4 · 推进
// ══════════════════════════════════════════════════

/**
 * 规划「往玩家主城方向推进」
 *
 * 目标按「敌方城镇中离自己最近的」依次尝试。
 * 推进途中**不踩进敌方城镇格**：策略 3 不满足（打不过）时踩上去只会白挨打。
 * 行动力按逐格累加，用完即止。
 *
 * @param {object} sim
 * @param {object} hero
 * @returns {Array<object>}
 */
function planAdvance(sim, hero) {
  const targets = sim.towns
    .filter((t) => t.playerId !== hero.playerId)
    .sort(
      (a, b) =>
        Math.abs(a.pos.x - hero.pos.x) + Math.abs(a.pos.y - hero.pos.y) -
        (Math.abs(b.pos.x - hero.pos.x) + Math.abs(b.pos.y - hero.pos.y))
    );
  if (targets.length === 0) return [];

  const blocked = blockedFor(sim, hero.id, hero.pos);

  for (const target of targets) {
    const path = findPath(sim.map, hero.pos, target.pos, blocked);
    if (!path || path.length === 0) continue;

    // 终点若是敌方城镇格且路径不止一格 → 停在城外，不踩进去
    let usable = path;
    const last = path[path.length - 1];
    if (isEnemyTown(sim, hero, last) && path.length > 1) {
      usable = path.slice(0, path.length - 1);
    }
    if (usable.length === 0) continue;

    // 逐格累加，行动力用完为止
    const steps = [];
    let spent = 0;
    for (const p of usable) {
      const half = terrainCostHalf(sim.map.tiles[p.y][p.x]);
      if (!Number.isFinite(half)) break;
      const c = Math.ceil(half / 2);
      if (spent + c > hero.movePoints) break;
      spent += c;
      steps.push({ type: 'move', heroId: hero.id, to: { x: p.x, y: p.y } });
    }
    if (steps.length > 0) return steps;
  }

  return [];
}

// ══════════════════════════════════════════════════
// 规划层
// ══════════════════════════════════════════════════

/**
 * 规划单个英雄的完整行动（纯函数，不改 state）
 *
 * 顺序：捡便宜 → 打得过就打 → 攻城 → 推进。
 * 每条策略一旦命中就不再往下走（先做最有价值的事）。
 *
 * @param {object} state
 * @param {object} data
 * @param {object} hero
 * @returns {Array<object>} 行动序列
 */
export function planHeroTurn(state, data, hero) {
  if (!hero) return [];
  if (hero.movePoints <= 0) return [];

  const pickup = planPickup(state, hero);
  if (pickup.length > 0) return pickup;

  const fight = planFight(state, data, hero);
  if (fight.length > 0) return fight;

  const siege = planSiege(state, data, hero);
  if (siege.length > 0) return siege;

  return planAdvance(state, hero);
}

/**
 * 规划电脑玩家的完整回合（纯函数，不改 state）
 *
 * 行动序列 = 城务步骤 + 各英雄的行动步骤。
 *
 * ⚠️ 全部规划都在**影子状态 sim** 上完成：城务会移动英雄、补兵，
 *    后面的战术必须基于「补完兵之后」的位置与兵力来算。
 *    sim 只在规划期间存在，真 state 一个字节都不改。
 *
 * @param {object} state
 * @param {object} data
 * @param {number} [playerId] 默认为当前行动玩家
 * @param {object} [opts]
 *   skipHeroIds  跳过这些英雄（战斗返回后重规划时，已行动过的英雄不再动）
 *   skipCity     跳过城务（城务本回合已做过）
 * @returns {Array<object>} 行动序列
 *
 * 每个步骤额外带一个 group 字段：
 *   group === 'city'  → 城务步骤（建兵营 / 回城补兵）
 *   group === heroId  → 该英雄的行动步骤
 * 场景层靠它把序列切成「组」，战斗返回后能准确知道哪些英雄已行动过。
 */
export function planMapTurn(state, data, playerId = currentPlayerId(state), opts = {}) {
  const sim = makeSim(state, data);
  const steps = [];

  if (!opts.skipCity) {
    const citySteps = planCityDefense(sim, data, playerId);
    for (const s of citySteps) s.group = 'city';
    steps.push(...citySteps);
  }

  const skip = new Set(opts.skipHeroIds || []);
  for (const hero of sim.heroes) {
    if (hero.playerId !== playerId) continue;
    if (skip.has(hero.id)) continue;

    const heroSteps = planHeroTurn(sim, data, hero);
    for (const s of heroSteps) s.group = hero.id;
    steps.push(...heroSteps);

    // 预演这批步骤，后续英雄的规划要看到更新后的局面
    for (const s of heroSteps) applyStepToSim(sim, s);
  }

  return steps;
}

// ══════════════════════════════════════════════════
// 执行层
// ══════════════════════════════════════════════════

/**
 * 执行行动序列中的一步
 *
 * 各类型的副作用：
 *   move    → 调用 M2 的 moveHero（逐格移动，事件逐格发出）
 *   pickup  → 调用 M2 的 pickUpResource（资源入账并从地图移除）
 *   battle  → **不**开打：逻辑层不碰 M6 的战场状态，
 *             只把战斗意图交给场景层（MapScene 切 BattleScene）
 *   recruit → 调用 M5 的 recruit
 *   build   → 调用 M5 的 construct
 *
 * @param {object} state
 * @param {object} data
 * @param {object} step
 * @returns {object} 执行结果 { ok, reason?, type, ... }
 */
export function executeMapStep(state, data, step) {
  if (!state || !step) return { ok: false, reason: 'noStep', type: 'none' };

  if (step.type === 'move') {
    const hero = state.heroes.find((h) => h.id === step.heroId);
    const from = hero ? { ...hero.pos } : null;
    const r = moveHero(state, step.heroId, step.to);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'move',
      heroId: step.heroId,
      from,
      to: r.ok ? { ...step.to } : from,
      cost: r.cost
    };
  }

  if (step.type === 'pickup') {
    const r = pickUpResource(state, step.heroId, step.pos);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'pickup',
      heroId: step.heroId,
      resource: r.resource,
      amount: r.amount,
      pos: step.pos
    };
  }

  if (step.type === 'battle') {
    // 逻辑层不启动战斗：只产出意图，由场景层决定何时切 BattleScene
    return {
      ok: true,
      type: 'battle',
      heroId: step.heroId,
      targetType: step.targetType,
      targetId: step.targetId,
      needBattle: true
    };
  }

  if (step.type === 'recruit') {
    const r = recruit(state, data, step.townId, step.heroId, step.unitId, step.count);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'recruit',
      heroId: step.heroId,
      townId: step.townId,
      unitId: step.unitId,
      count: step.count
    };
  }

  if (step.type === 'build') {
    const r = construct(state, data, step.townId, step.buildingId);
    return {
      ok: r.ok,
      reason: r.reason,
      type: 'build',
      heroId: step.heroId,
      townId: step.townId,
      buildingId: step.buildingId
    };
  }

  return { ok: false, reason: 'unknownStep', type: 'none' };
}

/**
 * 把一步的执行结果翻译成给界面看的一行流水
 * @param {object} step
 * @param {object} result executeMapStep 的返回值
 * @returns {{heroId:string|null, action:string, detail:object}}
 */
function toLogEntry(step, result) {
  const detail = { ok: result.ok !== false };
  if (result.reason) detail.reason = result.reason;

  if (step.type === 'move') {
    detail.text = result.ok ? `移动到 (${result.to.x},${result.to.y})` : `移动失败(${result.reason})`;
    detail.from = result.from;
    detail.to = result.to;
    detail.cost = result.cost;
  } else if (step.type === 'pickup') {
    detail.text = result.ok
      ? `拾取 ${result.amount} ${result.resource}`
      : `拾取失败(${result.reason})`;
    detail.resource = result.resource;
    detail.amount = result.amount;
  } else if (step.type === 'battle') {
    detail.text = step.targetType === 'town' ? '进攻城镇' : '挑战敌方武将';
    detail.targetType = step.targetType;
    detail.targetId = step.targetId;
  } else if (step.type === 'recruit') {
    detail.text = result.ok ? `招募 ${step.count} 名 ${step.unitId}` : `招募失败(${result.reason})`;
    detail.unitId = step.unitId;
    detail.count = step.count;
  } else if (step.type === 'build') {
    detail.text = result.ok ? `建造 ${step.buildingId}` : `建造失败(${result.reason})`;
    detail.buildingId = step.buildingId;
  }

  return { heroId: step.heroId ?? null, action: step.type, detail };
}

/**
 * 电脑玩家的完整回合（所有英雄轮流行动）
 *
 * 契约入口。规划 + 依次执行，返回行动流水供界面展示「电脑行动中…」。
 *
 * ⚠️ 遇到战斗步骤会**停止**并把战斗意图放进流水：
 *    战斗要切场景（MapScene → BattleScene），由场景层在战斗结束后
 *    重新规划并继续（届时战场已结算，状态变了，需要重新规划）。
 *
 * @param {object} state
 * @param {object} data
 * @returns {Array<object>} 行动流水 [{ heroId, action, detail }]
 */
export function aiMapTurn(state, data) {
  const playerId = currentPlayerId(state);
  const steps = planMapTurn(state, data, playerId);

  const log = [];
  let moveCalls = 0;
  let i = 0;

  while (i < steps.length) {
    const step = steps[i];

    if (step.type === 'move') {
      // 验收 3：单回合最多 100 次移动调用，超出强制停止
      if (moveCalls >= MAX_MOVE_CALLS) {
        log.push({
          heroId: step.heroId ?? null,
          action: 'limit',
          detail: { ok: true, text: '已达单回合移动上限，停止行动' }
        });
        return log;
      }
      moveCalls += 1;
    }

    const result = executeMapStep(state, data, step);
    log.push(toLogEntry(step, result));
    i += 1;

    // 战斗交给场景层（MapScene 切 BattleScene），这里停下
    if (step.type === 'battle' && result.ok) return log;

    // 一步失败：跳过该英雄剩余的步骤（换下一个英雄继续）
    if (!result.ok && step.heroId) {
      while (i < steps.length && steps[i].heroId === step.heroId) i += 1;
    }
  }

  return log;
}

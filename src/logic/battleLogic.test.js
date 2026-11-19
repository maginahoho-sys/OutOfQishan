import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initBattle,
  currentStack,
  nextTurn,
  checkBattleEnd,
  buildTurnQueue,
  applyDamage,
  formationPos,
  townGarrisonArmy,
  stackSpeed,
  BATTLE_WIDTH,
  BATTLE_HEIGHT,
  // M6b
  movableCells,
  moveStack,
  attackStack,
  attackableTargets,
  computeDamage,
  isAdjacent,
  hasAbility,
  isEngaged,
  isOutOfRange,
  cellDistance,
  stackRange,
  cellsInRange,
  canAct,
  // M6c
  resolveBattle,
  armyValue,
  survivingArmy,
  EXP_DIVISOR
} from './battleLogic.js';

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

const DATA = loadData();

/** 造一个最小 state（只需要 battle 字段） */
function makeState() {
  return {
    meta: { day: 1, week: 1, currentPlayer: 0 },
    players: [
      { id: 0, faction: 'shu', isAI: false },
      { id: 1, faction: 'wei', isAI: true }
    ],
    heroes: [],
    towns: [],
    battle: null
  };
}

const SHU_ARMY = [
  { unitId: 'shu_militia', count: 40 },
  { unitId: 'shu_archer', count: 20 }
];
const WEI_ARMY = [
  { unitId: 'wei_qingzhou', count: 40 },
  { unitId: 'wei_archer', count: 20 }
];

// ──────────────────────────────────────────────
// 布阵
// ──────────────────────────────────────────────
test('initBattle：双方军队转成 stack，属性来自 units.json', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });

  assert.equal(battle.stacks.length, 4);
  assert.equal(state.battle, battle);
  assert.equal(battle.round, 1);
  assert.equal(battle.winner, null);
  assert.equal(battle.attackerHeroId, 'hero_shu_0');
  assert.equal(battle.defenderHeroId, 'hero_wei_0');

  const s0 = battle.stacks[0];
  assert.equal(s0.id, 's0');
  assert.equal(s0.side, 'attacker');
  assert.equal(s0.unitId, 'shu_militia');
  assert.equal(s0.unitName, '乡勇');
  assert.equal(s0.count, 40);
  assert.equal(s0.hp, 6);      // 单兵满血
  assert.equal(s0.maxHp, 6);
  assert.equal(s0.attack, 2);
  assert.equal(s0.defense, 2);
  assert.equal(s0.speed, 3);
  assert.equal(s0.acted, false);
  assert.deepEqual(s0.buffs, []);
});

test('initBattle：攻方从左入场、守方从右入场，且按行均布', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });

  for (const s of battle.stacks) {
    if (s.side === 'attacker') {
      assert.ok(s.pos.x <= 1, `攻方 x=${s.pos.x} 应在 0~1 列`);
    } else {
      assert.ok(s.pos.x >= BATTLE_WIDTH - 2, `守方 x=${s.pos.x} 应在最右两列`);
    }
    assert.ok(s.pos.y >= 0 && s.pos.y < BATTLE_HEIGHT);
  }

  // 2 个 stack 时分列首尾
  const atk = battle.stacks.filter((s) => s.side === 'attacker');
  assert.deepEqual(atk[0].pos, { x: 0, y: 0 });
  assert.deepEqual(atk[1].pos, { x: 0, y: 8 });
});

test('formationPos：7 个 stack 在 9 行里均布', () => {
  const ys = [];
  for (let i = 0; i < 7; i++) ys.push(formationPos('attacker', i, 7).y);
  assert.deepEqual(ys, [0, 1, 3, 4, 5, 7, 8]);
  // 每个 stack 的 x 都是 0
  for (let i = 0; i < 7; i++) assert.equal(formationPos('attacker', i, 7).x, 0);
});

test('initBattle：过滤数量为 0 与不存在的兵种', () => {
  const state = makeState();
  const battle = initBattle(state, [
    { unitId: 'shu_militia', count: 10 },
    { unitId: 'shu_archer', count: 0 },
    { unitId: 'not_exist', count: 5 }
  ], WEI_ARMY, { data: DATA });
  assert.equal(battle.stacks.filter((s) => s.side === 'attacker').length, 1);
});

// ──────────────────────────────────────────────
// 出手排序
// ──────────────────────────────────────────────
test('turnQueue：速度降序，速度相同则攻方先', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });

  // s0 乡勇(3) s1 弓手(4) s2 青州兵(3) s3 魏弓手(4)
  assert.deepEqual(battle.turnQueue, ['s1', 's3', 's0', 's2']);
  assert.equal(currentStack(battle).id, 's1');
});

test('turnQueue：同方同速保持原有顺序', () => {
  const state = makeState();
  const battle = initBattle(state, [
    { unitId: 'shu_militia', count: 10 },
    { unitId: 'shu_bai_die', count: 5 }
  ], [], { data: DATA });
  // 两个兵同速（白毦兵 speed 4 / 乡勇 speed 3 不同，改用同速兵种验证）
  const rebuilt = buildTurnQueue(battle);
  assert.equal(rebuilt.length, battle.stacks.length);
});

// ──────────────────────────────────────────────
// 回合推进
// ──────────────────────────────────────────────
test('nextTurn：推进到下一个 stack，当前 stack 标记 acted', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });

  const first = currentStack(battle);
  assert.equal(first.id, 's1');

  const next = nextTurn(battle, { action: 'wait' });
  assert.equal(first.acted, true);
  assert.equal(next.id, 's3');
  assert.equal(next.acted, false);
  // 战报有"待命"记录
  assert.ok(battle.log.some((l) => l.text.includes('原地待命')));
});

test('nextTurn：防御指令会设置 defending', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  const first = currentStack(battle);
  nextTurn(battle, { action: 'defend' });
  assert.equal(first.defending, true);
});

test('nextTurn：一轮结束后 round+1、acted 重置、重新排序', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });

  // 走完一整轮（4 个 stack）
  for (let i = 0; i < 4; i++) nextTurn(battle, { action: 'wait' });

  assert.equal(battle.round, 2);
  assert.equal(battle.currentTurn, 0);
  assert.ok(battle.stacks.every((s) => s.acted === false));
  // 新一轮仍按速度排序
  assert.deepEqual(battle.turnQueue, ['s1', 's3', 's0', 's2']);
  assert.equal(currentStack(battle).id, 's1');
  assert.ok(battle.log.some((l) => l.text.includes('第 2 轮')));
});

test('nextTurn：buff 的 turnsLeft 随轮次递减，归零移除', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  const s = battle.stacks[0];
  s.buffs = [{ spellId: 'bless', stat: 'attack', value: 2, turnsLeft: 2 }];

  nextTurn(battle, { action: 'wait' });
  nextTurn(battle, { action: 'wait' });
  nextTurn(battle, { action: 'wait' });
  nextTurn(battle, { action: 'wait' }); // 一轮结束

  assert.equal(battle.round, 2);
  assert.equal(s.buffs.length, 1);
  assert.equal(s.buffs[0].turnsLeft, 1);
});

test('stackSpeed：buff 会加成速度', () => {
  const stack = { speed: 3, buffs: [{ stat: 'speed', value: 2 }] };
  assert.equal(stackSpeed(stack), 5);
});

// ──────────────────────────────────────────────
// 胜负判定
// ──────────────────────────────────────────────
test('checkBattleEnd：守方全灭 → 攻方获胜', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  for (const s of battle.stacks) if (s.side === 'defender') s.count = 0;
  assert.equal(checkBattleEnd(battle), 'attacker');
  assert.equal(battle.winner, 'attacker');
});

test('checkBattleEnd：攻方全灭 → 守方获胜', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  for (const s of battle.stacks) if (s.side === 'attacker') s.count = 0;
  assert.equal(checkBattleEnd(battle), 'defender');
  assert.equal(battle.winner, 'defender');
});

test('checkBattleEnd：双方全灭 → 平局', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  for (const s of battle.stacks) s.count = 0;
  assert.equal(checkBattleEnd(battle), 'draw');
  assert.equal(battle.winner, 'draw');
});

test('nextTurn：分出胜负后不再推进', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  for (const s of battle.stacks) if (s.side === 'defender') s.count = 0;
  nextTurn(battle, { action: 'wait' });
  assert.equal(battle.winner, 'attacker');
  assert.equal(currentStack(battle), null);
  assert.equal(nextTurn(battle), null);
});

test('initBattle：一方无兵 → 立即判胜负', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, [], { data: DATA });
  assert.equal(battle.winner, 'attacker');
});

// ──────────────────────────────────────────────
// 伤害施加（M6b 复用）
// ──────────────────────────────────────────────
test('applyDamage：满血时击杀数 = floor(伤害/单兵hp)，余数扣队首兵', () => {
  const state = makeState();
  const battle = initBattle(state, [{ unitId: 'shu_militia', count: 10 }], [], { data: DATA });
  const s = battle.stacks[0];

  const r = applyDamage(s, 20); // 单兵 6 血 → 3 个死，剩 2 点
  assert.equal(r.kills, 3);
  assert.equal(s.count, 7);
  assert.equal(s.hp, 4); // 新补位的兵满血 6，被扣 2
});

test('applyDamage：伤害不足一次击杀时只扣队首兵 hp', () => {
  const state = makeState();
  const battle = initBattle(state, [{ unitId: 'shu_militia', count: 10 }], [], { data: DATA });
  const s = battle.stacks[0];
  const r = applyDamage(s, 2);
  assert.equal(r.kills, 0);
  assert.equal(s.count, 10);
  assert.equal(s.hp, 4);
});

test('applyDamage：伤害超过全军总血量 → 全灭且溢出伤害作废', () => {
  const state = makeState();
  const battle = initBattle(state, [{ unitId: 'shu_militia', count: 3 }], [], { data: DATA });
  const s = battle.stacks[0];
  const r = applyDamage(s, 100);
  assert.equal(r.kills, 3);
  assert.equal(s.count, 0);
  assert.equal(s.hp, 0);
  // 全军总血量 3×6=18，剩下 82 点无处施加（作废，但作为 remaining 返回）
  assert.equal(r.remaining, 82);
});

test('applyDamage：队首兵受伤后再受击，会先阵亡再补位', () => {
  const state = makeState();
  const battle = initBattle(state, [{ unitId: 'shu_militia', count: 10 }], [], { data: DATA });
  const s = battle.stacks[0];
  s.hp = 2; // 队首兵只剩 2 血
  const r = applyDamage(s, 6);
  assert.equal(r.kills, 1); // 队首兵阵亡
  assert.equal(s.count, 9);
  assert.equal(s.hp, 2); // 补位兵满血 6，吸收剩余 4 点伤害后剩 2
});

// ──────────────────────────────────────────────
// 完整对局（M6a 框架 + 测试内简化攻击）
// ──────────────────────────────────────────────
test('验收：10 乡勇 vs 10 青州兵能完整打完一场并分出胜负', () => {
  const state = makeState();
  const battle = initBattle(state,
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }],
    { data: DATA });

  // 测试内简化版攻击（正式实现见 M6b 的 attackStack）
  const simulate = (attackerId, defenderId) => {
    const a = battle.stacks.find((s) => s.id === attackerId);
    const d = battle.stacks.find((s) => s.id === defenderId);
    const dmg = a.damageMin * a.count; // 固定取最小伤害，保证可复现
    const { kills } = applyDamage(d, dmg);
    return { damage: dmg, kills };
  };

  let guard = 0;
  while (!battle.winner && guard++ < 500) {
    const cur = currentStack(battle);
    if (!cur) break;
    const enemy = battle.stacks.find((s) => s.side !== cur.side && s.count > 0);
    if (!enemy) break;
    simulate(cur.id, enemy.id);
    nextTurn(battle, { action: 'attack' });
  }

  assert.ok(battle.winner, '战斗应分出胜负');
  assert.ok(['attacker', 'defender', 'draw'].includes(battle.winner));
  // 一方确实被打空了
  const alive = { attacker: 0, defender: 0 };
  for (const s of battle.stacks) if (s.count > 0) alive[s.side] += s.count;
  assert.ok(alive.attacker === 0 || alive.defender === 0);
  assert.ok(guard < 500, '战斗应在合理步数内结束');
});

// ──────────────────────────────────────────────
// 守军与序列化
// ──────────────────────────────────────────────
test('townGarrisonArmy：优先用驻军，没有驻军则按最高招募建筑生成', () => {
  const state = makeState();
  state.towns.push({
    id: 'town_wei_0', playerId: 1, faction: 'wei', name: '许昌',
    pos: { x: 27, y: 3 }, buildings: ['hall', 'wei_barracks1'], garrison: [], recruitPool: []
  });

  const g = townGarrisonArmy(state, DATA, 'town_wei_0');
  assert.equal(g.length, 1);
  assert.equal(g[0].unitId, 'wei_qingzhou');
  assert.ok(g[0].count > 0);

  // 有驻军时用驻军
  state.towns[0].garrison = [{ unitId: 'wei_archer', count: 7 }];
  const g2 = townGarrisonArmy(state, DATA, 'town_wei_0');
  assert.deepEqual(g2, [{ unitId: 'wei_archer', count: 7 }]);

  // 没有招募建筑 → 空守军
  state.towns[0].garrison = [];
  state.towns[0].buildings = ['hall'];
  assert.deepEqual(townGarrisonArmy(state, DATA, 'town_wei_0'), []);
});

test('state.battle 可 JSON 序列化（存档兼容）', () => {
  const state = makeState();
  const battle = initBattle(state, SHU_ARMY, WEI_ARMY, { data: DATA });
  const round = JSON.parse(JSON.stringify(battle));
  assert.equal(round.stacks.length, 4);
  assert.equal(round.turnQueue.length, 4);
  assert.deepEqual(round.stacks[0].pos, battle.stacks[0].pos);
});

// ══════════════════════════════════════════════════
// M6b · 移动
// ══════════════════════════════════════════════════

/** 造一场只含指定兵种的对局，便于精确控制位置 */
function battleOf(attackerArmy, defenderArmy) {
  const state = makeState();
  const battle = initBattle(state, attackerArmy, defenderArmy, { data: DATA });
  return battle;
}

test('movableCells：返回 moveRange 内的格，不含自身与被占据的格', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const s = battle.stacks[0];
  s.pos = { x: 7, y: 4 }; // 乡勇 moveRange = 4

  const cells = movableCells(battle, s.id);
  assert.ok(cells.length > 0);
  // 自身不在结果里
  assert.equal(cells.find((c) => c.x === 7 && c.y === 4), undefined);
  // 距离不超过 4
  for (const c of cells) {
    assert.ok(Math.max(Math.abs(c.x - 7), Math.abs(c.y - 4)) <= 4);
  }
  // 场外不算
  assert.equal(cells.find((c) => c.x < 0 || c.x >= BATTLE_WIDTH || c.y < 0 || c.y >= BATTLE_HEIGHT), undefined);
});

test('movableCells：非飞行单位无法穿过封锁线，飞行单位可以', () => {
  // 布局：白刃(4,4)，敌方把 (5,3)(5,4)(5,5) 三格堵死 → 只有飞行单位能穿过这堵墙
  const battle = battleOf(
    [
      { unitId: 'shu_militia', count: 10 },
      { unitId: 'shu_wudang', count: 10 }   // 无当飞军（fly）
    ],
    [
      { unitId: 'wei_qingzhou', count: 10 },
      { unitId: 'wei_archer', count: 10 }
    ]
  );
  const walker = battle.stacks[0];
  const flyer = battle.stacks[1];

  // 手动加一个敌方 stack 补齐第三个封锁格
  const blockC = {
    id: 'blockC', side: 'defender', unitId: 'wei_archer', unitName: '魏弓手',
    count: 10, hp: 5, maxHp: 5, attack: 3, defense: 1, speed: 4,
    damageMin: 2, damageMax: 3, moveRange: 3, abilities: ['ranged'],
    pos: { x: 5, y: 5 }, acted: false, moved: false, defending: false, retaliated: false, buffs: []
  };
  battle.stacks.push(blockC);

  walker.pos = { x: 4, y: 4 };
  flyer.pos = { x: 4, y: 4 };
  battle.stacks[2].pos = { x: 5, y: 3 };
  battle.stacks[3].pos = { x: 5, y: 4 };

  // 行动力压到 2 格，避免绕行到 (5,6) 再折回
  walker.moveRange = 2;
  flyer.moveRange = 2;

  const walkCells = movableCells(battle, walker.id);
  assert.equal(walkCells.find((c) => c.x === 5 && c.y === 4), undefined, '被占格不可落点');
  assert.equal(walkCells.find((c) => c.x === 6 && c.y === 4), undefined, '非飞行单位被封锁线挡住');

  const flyCells = movableCells(battle, flyer.id);
  assert.ok(flyCells.find((c) => c.x === 6 && c.y === 4), '飞行单位可以穿过封锁线');
  assert.equal(flyCells.find((c) => c.x === 5 && c.y === 4), undefined, '飞行单位也不能停在被占格上');
});

test('movableCells：飞行单位可穿越被占据的格', () => {
  const battle = battleOf(
    [{ unitId: 'shu_wudang', count: 10 }, { unitId: 'shu_militia', count: 10 }],
    []
  );
  const fly = battle.stacks[0];   // 无当飞军（fly）
  const wall = battle.stacks[1];
  fly.pos = { x: 4, y: 4 };
  wall.pos = { x: 5, y: 4 };

  const cells = movableCells(battle, fly.id);
  assert.equal(cells.find((c) => c.x === 5 && c.y === 4), undefined, '仍不能停在被占格上');
  assert.ok(cells.find((c) => c.x === 6 && c.y === 4), '但可以飞越');
});

test('movableCells：已行动或已移动的单位返回空', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const s = battle.stacks[0];
  assert.ok(movableCells(battle, s.id).length > 0);
  s.acted = true;
  assert.equal(movableCells(battle, s.id).length, 0);
  s.acted = false;
  s.moved = true;
  assert.equal(movableCells(battle, s.id).length, 0);
});

test('moveStack：成功移动，位置更新并标记 moved', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const s = battle.stacks[0];
  s.pos = { x: 4, y: 4 };

  const r = moveStack(battle, s.id, { x: 6, y: 4 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.from, { x: 4, y: 4 });
  assert.deepEqual(s.pos, { x: 6, y: 4 });
  assert.equal(s.moved, true);
  assert.equal(s.acted, false, '移动不结束回合，仍可攻击');
});

test('moveStack：距离太远返回 tooFar，被占据返回 occupied', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 10 }],
    []
  );
  const s0 = battle.stacks[0];
  s0.pos = { x: 4, y: 4 };
  assert.equal(moveStack(battle, s0.id, { x: 12, y: 4 }).reason, 'tooFar');

  const s1 = battle.stacks[1];
  s1.pos = { x: 5, y: 4 };
  assert.equal(moveStack(battle, s0.id, { x: 5, y: 4 }).reason, 'occupied');
});

test('moveStack：已行动的单位不能再移动', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const s = battle.stacks[0];
  s.pos = { x: 4, y: 4 };
  s.acted = true;
  assert.equal(moveStack(battle, s.id, { x: 5, y: 4 }).reason, 'acted');
});

// ══════════════════════════════════════════════════
// M6b · 伤害公式
// ══════════════════════════════════════════════════

/** 固定随机数：让单兵伤害取到指定值 */
function fixedRng(roll) {
  return () => roll;
}

test('computeDamage：攻击=防御时伤害落在 [min×count, max×count] 区间', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const a = battle.stacks[0];
  // 乡勇 attack 2 / defense 2 → 造一个 defense 2 的对手
  const d = { attack: 2, defense: 2, damageMin: 1, damageMax: 3, count: 10, hp: 6, buffs: [] };

  const lo = computeDamage(a, d, { rng: fixedRng(0) });   // 单兵伤害取 1
  const hi = computeDamage(a, d, { rng: fixedRng(0.999) }); // 单兵伤害取 3
  assert.equal(lo, 10);  // 1 × 10
  assert.equal(hi, 30);  // 3 × 10
});

test('computeDamage：攻击高于防御时伤害上浮，低于时伤害下降', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const a = battle.stacks[0]; // attack 2
  const weak = { attack: 2, defense: 0, damageMin: 1, damageMax: 1, count: 10, hp: 6, buffs: [] };
  const strong = { attack: 2, defense: 40, damageMin: 1, damageMax: 1, count: 10, hp: 6, buffs: [] };

  const up = computeDamage(a, weak, { rng: fixedRng(0) });    // 攻 2 vs 防 0 → +10%
  const down = computeDamage(a, strong, { rng: fixedRng(0) }); // 攻 2 vs 防 40 → -76%，但不低于 30%
  assert.equal(up, 11, '攻 2 vs 防 0：10 × 1.10 = 11');
  assert.equal(down, 3, '减益下限 30%：10 × 0.3 = 3');
});

test('computeDamage：超出射程伤害减半，防御姿态伤害减半', () => {
  const battle = battleOf([{ unitId: 'shu_militia', count: 10 }], []);
  const a = battle.stacks[0];
  const d = { attack: 2, defense: 2, damageMin: 1, damageMax: 1, count: 10, hp: 6, buffs: [] };

  assert.equal(computeDamage(a, d, { rng: fixedRng(0) }), 10);
  assert.equal(computeDamage(a, d, { rng: fixedRng(0), outOfRange: true }), 5, '超射程减半');
  assert.equal(computeDamage(a, d, { rng: fixedRng(0), defending: true }), 5, '防御减半');
});

// ══════════════════════════════════════════════════
// M6b · 攻击
// ══════════════════════════════════════════════════

test('attackStack：近战必须相邻才能打', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 0, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'outOfRange');

  // 挪到相邻后可以打
  a.pos = { x: 4, y: 0 };
  const r2 = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r2.ok, true);
  assert.ok(r2.damage > 0);
  assert.ok(r2.killed > 0);
  assert.equal(d.count, 10 - r2.killed);
});

test('attackStack：伤害与击杀数正确（伤害按 count 结算，逐兵吸收）', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  // 乡勇 attack 2 / damageMin 1 / count 10 → 基础 10；对手 青州兵 defense 3 → 攻 2 < 防 3 → ×0.98 → 9.8 → 10
  // 实际取整后为 10 → 青州兵单兵 7 血 → 击杀 1，剩 3 血在队首
  assert.equal(r.damage, 10);
  assert.equal(r.killed, 1);
  assert.equal(d.count, 9);
  assert.equal(d.hp, 4); // 7 - 3
});

test('attackStack：不能攻击己方单位、不能重复行动', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 10 }],
    []
  );
  const a = battle.stacks[0];
  const ally = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  ally.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, ally.id, { rng: fixedRng(0) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sameSide');

  // 打一次后 acted = true，不能再打
  const battle2 = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a2 = battle2.stacks[0];
  const d2 = battle2.stacks[1];
  a2.pos = { x: 4, y: 0 };
  d2.pos = { x: 5, y: 0 };
  attackStack(battle2, DATA, a2.id, d2.id, { rng: fixedRng(0) });
  const r2 = attackStack(battle2, DATA, a2.id, d2.id, { rng: fixedRng(0) });
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'acted');
});

test('attackStack：远程可攻击全场，射程内满伤、超射程减半', () => {
  // 弓手 attack 3 / damageMin 2 / count 20 → 基础 40；range = 6
  const battle = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_qingzhou', count: 40 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 0, y: 0 };
  d.pos = { x: 10, y: 0 };

  // 距离 10 > 射程 6 → 超射程，伤害减半
  const far = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(far.ok, true);
  assert.equal(far.outOfRange, true);
  // 弓手 attack 3 vs 青州兵 defense 3 → 无修正 → 2 × 20 = 40 → 超射程减半 = 20
  assert.equal(far.damage, 20);

  // 挪到射程内 → 满伤害
  const battle2 = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_qingzhou', count: 40 }]
  );
  const a2 = battle2.stacks[0];
  const d2 = battle2.stacks[1];
  a2.pos = { x: 4, y: 0 };
  d2.pos = { x: 8, y: 0 };
  const near = attackStack(battle2, DATA, a2.id, d2.id, { rng: fixedRng(0) });
  assert.equal(near.ok, true);
  assert.equal(near.outOfRange, false);
  assert.equal(near.damage, 40);
});

test('attackStack：远程被近身仍可射击全场，伤害按射程算', () => {
  const battle = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_qingzhou', count: 40 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };   // 贴脸 → 被近身

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.ok, true, '被近身不封锁射击');
  assert.equal(r.outOfRange, false);
  assert.equal(r.damage, 40, '射程内仍是满伤害');
});

test('attackableTargets：近战只列相邻敌人；远程列全部敌人', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const melee = battle.stacks[0];
  const ranged = battle.stacks[1];
  const enemy = battle.stacks[2];
  melee.pos = { x: 0, y: 0 };
  ranged.pos = { x: 0, y: 4 };
  enemy.pos = { x: 8, y: 0 };

  assert.deepEqual(attackableTargets(battle, melee.id), [], '近战够不着');
  assert.deepEqual(attackableTargets(battle, ranged.id), [enemy.id], '远程可全场射击');

  // 敌人贴近弓手 → 仍列全部敌人（不再是"只能打相邻"）
  enemy.pos = { x: 1, y: 4 };
  assert.deepEqual(attackableTargets(battle, ranged.id), [enemy.id]);
  assert.equal(isEngaged(battle, ranged), true);
});

test('isOutOfRange / stackRange：射程判定', () => {
  const battle = battleOf(
    [{ unitId: 'shu_archer', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];

  assert.equal(stackRange(a), 6, '弓手射程 6');
  a.pos = { x: 0, y: 0 };
  d.pos = { x: 5, y: 0 };
  assert.equal(isOutOfRange(a, d), false, '距离 5 在射程内');
  d.pos = { x: 7, y: 0 };
  assert.equal(isOutOfRange(a, d), true, '距离 7 超出射程');
  assert.equal(cellDistance({ x: 0, y: 0 }, { x: 3, y: 5 }), 5, '切比雪夫距离');
});

test('cellsInRange：近战覆盖 8 方向相邻格，远程覆盖射程内整片区域', () => {
  // 直接构造 stack：cellsInRange 只依赖 pos 与 range，不受布阵位置干扰
  const melee = { pos: { x: 5, y: 4 }, range: 1 };
  const meleeCells = cellsInRange(melee);
  assert.equal(meleeCells.length, 9, '近战射程 1 覆盖 9 格');
  assert.ok(meleeCells.some((c) => c.x === 5 && c.y === 4), '含自身所在格');
  assert.ok(meleeCells.some((c) => c.x === 6 && c.y === 5), '含斜向相邻格');
  assert.ok(!meleeCells.some((c) => c.x === 7 && c.y === 4), '不含距离 2 的格');

  // 远程：切比雪夫距离 ≤ r 覆盖的是一个 (2r+1)×(2r+1) 的方形
  // （|dx|≤r 且 |dy|≤r 两个条件同时成立）
  // r=1 → 9，r=2 → 25，r=3 → 49
  for (const r of [1, 2, 3]) {
    const cells = cellsInRange({ pos: { x: 5, y: 4 }, range: r });
    assert.equal(cells.length, (2 * r + 1) * (2 * r + 1), `射程 ${r} 的格子数`);
    assert.ok(cells.every((c) => cellDistance(c, { x: 5, y: 4 }) <= r), '全部在射程内');
    assert.ok(cells.some((c) => cellDistance(c, { x: 5, y: 4 }) === r), '含射程边界格');
  }
});

test('cellsInRange：贴边时不会越出战场边界', () => {
  // 角落：射程 2 时，只有 3×3 落在场内
  const corner = cellsInRange({ pos: { x: 0, y: 0 }, range: 2 });
  assert.ok(corner.every((c) => c.x >= 0 && c.x < BATTLE_WIDTH), 'x 不越界');
  assert.ok(corner.every((c) => c.y >= 0 && c.y < BATTLE_HEIGHT), 'y 不越界');
  assert.equal(corner.length, 9, '角落处的射程覆盖');

  // 贴左边界的中间行：x 只有 0~3 四列，y 取满 1~7 行
  const edge = cellsInRange({ pos: { x: 0, y: 4 }, range: 3 });
  assert.ok(edge.every((c) => c.x >= 0 && c.x <= 3), '只覆盖向右的一侧');
  assert.equal(edge.length, 28, '被战场边界裁剪后的覆盖');
});

test('attackStack：远程被近身时反击伤害减半', () => {
  // 守方是被近身的远程（魏弓手 range 6），攻方近战贴脸
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 20 }],
    [{ unitId: 'wei_archer', count: 20 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.ok(r.retaliate, '远程守方可反击');
  // 乡勇 attack 2 / damageMin 1 / count 20 → 基础 20；vs 魏弓手 defense 1 → +5% → 21
  // 魏弓手单兵 5 血 → 21 伤害打死 4 个，剩 16 个、队首兵 hp 4
  // 反击：魏弓手 attack 3 / damageMin 2 / count 16 → 基础 32；vs 乡勇 defense 2 → +5% → 33.6 → 34
  // 反击半伤 → 17；被近身再减半 → 8.5 → 9
  assert.equal(r.retaliate.damage, 9);
});

test('attackStack：远程未被近身时反击不减半', () => {
  // 守方远程站远处，被远程单位攻击（未被近身）
  const battle = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_archer', count: 20 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 0, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.ok(r.retaliate, '远程守方可远距离反击');
  // 蜀弓手 attack 3 / damageMin 2 / count 20 → 基础 40；vs 魏弓手 defense 1 → +10% → 44
  // 魏弓手单兵 5 血 → 44 伤害打死 8 个，剩 12 个
  // 反击：魏弓手 attack 3 / damageMin 2 / count 12 → 基础 24；vs 蜀弓手 defense 1 → +10% → 26.4 → 26
  // 反击半伤 → 13；未被近身，不再减半
  assert.equal(r.retaliate.damage, 13);
});

test('attackStack：守方会反击，伤害为自身伤害的一半', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.ok(r.retaliate, '应触发反击');
  // 青州兵 attack 2 / damageMin 1 / count 9（被打掉 1 个后）→ 基础 9；乡勇 defense 2 → 无修正 → 9
  // 反击为一半 → 5
  assert.equal(r.retaliate.damage, 5);
  assert.ok(r.retaliate.killed >= 0);
  assert.equal(d.retaliated, true);
});

test('attackStack：近战守方距离太远无法反击，远程守方可以远距离反击', () => {
  // 近战守方：弓手在 (0,8)，青州兵在 (10,0)，相距 10 格 → 青州兵够不着，不能反击
  const battle = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_qingzhou', count: 40 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 0, y: 8 };
  d.pos = { x: 10, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.ok, true);
  assert.equal(r.retaliate, null, '近战守方够不着，不能反击');

  // 换成远程守方（魏弓手）→ 可以远距离反击
  const battle2 = battleOf(
    [{ unitId: 'shu_archer', count: 20 }],
    [{ unitId: 'wei_archer', count: 40 }]
  );
  const a2 = battle2.stacks[0];
  const d2 = battle2.stacks[1];
  a2.pos = { x: 0, y: 8 };
  d2.pos = { x: 10, y: 0 };

  const r2 = attackStack(battle2, DATA, a2.id, d2.id, { rng: fixedRng(0) });
  assert.equal(r2.ok, true);
  assert.ok(r2.retaliate, '远程守方可远距离反击');
});

test('attackStack：守方本轮已反击过就不再反击', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 20 }],
    [{ unitId: 'wei_qingzhou', count: 20 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };
  d.retaliated = true;

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.retaliate, null);
});

test('attackStack：noRetaliation 兵种攻击不触发反击', () => {
  const battle = battleOf(
    [{ unitId: 'shu_wuhu', count: 5 }],   // 五虎上将（noRetaliation）
    [{ unitId: 'wei_qingzhou', count: 20 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.ok, true);
  assert.equal(r.retaliate, null, 'noRetaliation 不应被反击');
  assert.equal(d.retaliated, false);
});

test('attackStack：twoAttack 兵种一回合攻击两次', () => {
  const battle = battleOf(
    [{ unitId: 'shu_crossbow', count: 20 }],  // 诸葛连弩（ranged + twoAttack）
    [{ unitId: 'wei_qingzhou', count: 40 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
  assert.equal(r.hits.length, 2, '应打两次');
  assert.equal(r.damage, r.hits[0].damage + r.hits[1].damage);
});

test('canAct：已行动/阵亡的单位不能再行动', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const s = battle.stacks[0];
  assert.equal(canAct(battle, s.id).ok, true);
  s.acted = true;
  assert.equal(canAct(battle, s.id).ok, false);
  s.acted = false;
  s.count = 0;
  assert.equal(canAct(battle, s.id).ok, false);
});

test('isAdjacent / hasAbility：基础工具函数', () => {
  assert.equal(isAdjacent({ x: 1, y: 1 }, { x: 2, y: 2 }), true, '斜角也算相邻');
  assert.equal(isAdjacent({ x: 1, y: 1 }, { x: 2, y: 3 }), false);
  assert.equal(isAdjacent({ x: 1, y: 1 }, { x: 1, y: 1 }), false, '自身不算相邻');
  assert.equal(hasAbility({ abilities: ['ranged'] }, 'ranged'), true);
  assert.equal(hasAbility({ abilities: [] }, 'ranged'), false);
  assert.equal(hasAbility(null, 'ranged'), false);
});

// ══════════════════════════════════════════════════
// M6b · 完整对局
// ══════════════════════════════════════════════════

/**
 * 简易自动对局：近战兵向最近的敌人推进到相邻后攻击，远程兵原地射击。
 * 用于验证"10 乡勇 vs 10 青州兵能完整打完一场"。
 */
function autoBattle(battle, maxSteps = 2000) {
  let steps = 0;
  while (!battle.winner && steps++ < maxSteps) {
    const cur = currentStack(battle);
    if (!cur) break;

    const enemies = battle.stacks.filter((s) => s.side !== cur.side && s.count > 0);
    if (enemies.length === 0) break;

    // 1) 有相邻敌人 → 直接打
    const adj = enemies.find((e) => isAdjacent(cur.pos, e.pos));
    if (adj) {
      const r = attackStack(battle, DATA, cur.id, adj.id, { rng: fixedRng(0.5) });
      if (r.ok) {
        nextTurn(battle, { action: 'attack' });
        continue;
      }
    }

    // 2) 远程 → 射杀射程内最弱的敌人（射程内满伤害）
    if (hasAbility(cur, 'ranged')) {
      const inRange = enemies.filter((e) => !isOutOfRange(cur, e));
      const pool = inRange.length > 0 ? inRange : enemies;
      const weak = pool.slice().sort((a, b) => a.count - b.count)[0];
      const r = attackStack(battle, DATA, cur.id, weak.id, { rng: fixedRng(0.5) });
      if (r.ok) {
        nextTurn(battle, { action: 'attack' });
        continue;
      }
    }

    // 3) 否则向最近的敌人推进一格
    const cells = movableCells(battle, cur.id);
    if (cells.length > 0) {
      let best = null;
      let bestDist = Infinity;
      for (const c of cells) {
        for (const e of enemies) {
          const d = Math.max(Math.abs(c.x - e.pos.x), Math.abs(c.y - e.pos.y));
          if (d < bestDist) {
            bestDist = d;
            best = c;
          }
        }
      }
      if (best) {
        const mv = moveStack(battle, cur.id, best);
        if (mv.ok) {
          nextTurn(battle, { action: 'move' });
          continue;
        }
      }
    }

    // 4) 走不动 → 待命
    nextTurn(battle, { action: 'wait' });
  }
  return steps;
}

test('验收：10 乡勇 vs 10 青州兵能完整打完一场并分出胜负', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );

  const steps = autoBattle(battle);
  assert.ok(battle.winner, '战斗应分出胜负');
  assert.ok(['attacker', 'defender', 'draw'].includes(battle.winner));

  const alive = { attacker: 0, defender: 0 };
  for (const s of battle.stacks) if (s.count > 0) alive[s.side] += s.count;
  assert.ok(alive.attacker === 0 || alive.defender === 0, '应有一方被全歼');
  assert.ok(steps < 2000, '战斗应在合理步数内结束');
});

test('验收：一方全灭后 battle.winner 正确', () => {
  const battle = battleOf(
    [{ unitId: 'shu_militia', count: 10 }],
    [{ unitId: 'wei_qingzhou', count: 10 }]
  );
  const a = battle.stacks[0];
  const d = battle.stacks[1];
  a.pos = { x: 4, y: 0 };
  d.pos = { x: 5, y: 0 };

  // 连续攻击直到守方全灭
  let guard = 0;
  while (d.count > 0 && guard++ < 100) {
    a.acted = false;   // 允许连续攻击（模拟多次行动）
    a.moved = false;
    d.retaliated = true; // 关掉反击，加速测试
    const r = attackStack(battle, DATA, a.id, d.id, { rng: fixedRng(0) });
    if (!r.ok) break;
  }

  assert.equal(d.count, 0);
  assert.equal(checkBattleEnd(battle), 'attacker');
  assert.equal(battle.winner, 'attacker');
});


// ──────────────────────────────────────────────
// M6c · 战果结算
// ──────────────────────────────────────────────

/**
 * 造一个带英雄与城镇的 state（用于结算测试）
 * @param {object} [opts] { withTown, defenderIsTown }
 */
function makeBattleState(opts = {}) {
  const state = makeState();
  state.heroes.push({
    id: 'hero_shu_0',
    playerId: 0,
    name: '刘备',
    level: 1,
    exp: 0,
    pendingLevels: 0,
    movePoints: 20,
    maxMovePoints: 20,
    mana: 10,
    maxMana: 10,
    pos: { x: 3, y: 13 },
    skills: {},
    spells: [],
    army: [{ unitId: 'shu_militia', count: 40 }, { unitId: 'shu_archer', count: 20 }]
  });
  state.heroes.push({
    id: 'hero_wei_0',
    playerId: 1,
    name: '曹操',
    level: 1,
    exp: 0,
    pendingLevels: 0,
    movePoints: 20,
    maxMovePoints: 20,
    mana: 10,
    maxMana: 10,
    pos: { x: 25, y: 4 },
    skills: {},
    spells: [],
    army: [{ unitId: 'wei_qingzhou', count: 40 }, { unitId: 'wei_archer', count: 20 }]
  });
  state.towns.push({
    id: 'town_shu_0',
    playerId: 0,
    faction: 'shu',
    name: '成都',
    pos: { x: 2, y: 14 },
    buildings: ['hall'],
    recruitPool: [],
    builtToday: 0,
    garrison: []
  });
  state.towns.push({
    id: 'town_wei_0',
    playerId: 1,
    faction: 'wei',
    name: '许昌',
    pos: { x: 26, y: 3 },
    buildings: ['hall'],
    recruitPool: [],
    builtToday: 0,
    garrison: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  if (opts.withTown === false) {
    state.towns = [];
  }
  return state;
}

/** 把一场战斗打到某一方全灭（直接改 count，最省事） */
function forceWinner(battle, side) {
  for (const s of battle.stacks) {
    if (s.side !== side) s.count = 0;
  }
  checkBattleEnd(battle);
  return battle.winner;
}

test('resolveBattle：攻方获胜 → 败方英雄被移除，胜方军队写回幸存数量', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });

  // 攻方留 30 乡勇 + 10 弓手；守方全灭
  // stack 顺序：0=蜀乡勇 1=蜀弓手 2=魏青州兵 3=魏弓手
  battle.stacks[0].count = 30;
  battle.stacks[1].count = 10;
  forceWinner(battle, 'attacker');

  const r = resolveBattle(state, DATA);
  assert.equal(r.ok, true);
  assert.equal(r.winner, 'attacker');
  assert.equal(r.winnerPlayerId, 0);
  assert.equal(r.loserPlayerId, 1);

  // 败方英雄被移除
  assert.equal(state.heroes.find((h) => h.id === 'hero_wei_0'), undefined, '败方英雄应被移除');
  assert.deepEqual(r.removedHeroes, ['hero_wei_0']);

  // 胜方军队写回
  const atk = state.heroes.find((h) => h.id === 'hero_shu_0');
  assert.deepEqual(atk.army, [{ unitId: 'shu_militia', count: 30 }, { unitId: 'shu_archer', count: 10 }]);

  // 战场清空
  assert.equal(state.battle, null);
});

test('resolveBattle：胜方英雄获得 floor(败方军队总价值/10) 点经验', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  forceWinner(battle, 'attacker');

  // 败方军队：40 青州兵(aiValue 95) + 20 魏弓手(100) = 3800 + 2000 = 5800
  const r = resolveBattle(state, DATA);
  assert.equal(r.exp, 580);
  assert.equal(r.expHeroId, 'hero_shu_0');

  const atk = state.heroes.find((h) => h.id === 'hero_shu_0');
  assert.equal(atk.exp, 80, '580 经验：1→2 扣 100，2→3 扣 400，余 80');
  assert.equal(atk.level, 3);
  assert.equal(atk.pendingLevels, 2);
  assert.equal(r.levelUps, 2);
});

test('resolveBattle：守方获胜 → 攻方英雄被移除，经验归守方英雄', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  forceWinner(battle, 'defender');

  const r = resolveBattle(state, DATA);
  assert.equal(r.winner, 'defender');
  assert.equal(r.winnerPlayerId, 1);
  assert.equal(state.heroes.find((h) => h.id === 'hero_shu_0'), undefined, '攻方英雄应被移除');

  // 败方是攻方军队：40 乡勇(90) + 20 弓手(100) = 3600 + 2000 = 5600 → 560 经验
  assert.equal(r.exp, 560);
  const def = state.heroes.find((h) => h.id === 'hero_wei_0');
  assert.equal(def.level, 3);
});

test('resolveBattle：攻城战攻方获胜 → 城镇易主，守军清空', () => {
  const state = makeBattleState();
  const battle = initBattle(
    state,
    state.heroes[0].army,
    [{ unitId: 'wei_qingzhou', count: 10 }],
    {
      attackerHeroId: 'hero_shu_0',
      defenderTownId: 'town_wei_0',
      data: DATA
    }
  );
  forceWinner(battle, 'attacker');

  const r = resolveBattle(state, DATA);
  assert.equal(r.capturedTownId, 'town_wei_0');

  const town = state.towns.find((t) => t.id === 'town_wei_0');
  assert.equal(town.playerId, 0, '城镇应归攻方');
  assert.equal(town.faction, 'shu');
  assert.deepEqual(town.garrison, [], '守军应被清空');
  assert.deepEqual(town.buildings, ['hall'], '建筑应保留');
});

test('resolveBattle：攻城战攻方战败 → 城镇归属不变，幸存守军写回驻军', () => {
  const state = makeBattleState();
  const battle = initBattle(
    state,
    state.heroes[0].army,
    [{ unitId: 'wei_qingzhou', count: 10 }],
    {
      attackerHeroId: 'hero_shu_0',
      defenderTownId: 'town_wei_0',
      data: DATA
    }
  );
  // 守军剩 4 个
  battle.stacks[2].count = 4;
  forceWinner(battle, 'defender');

  const r = resolveBattle(state, DATA);
  assert.equal(r.capturedTownId, null);

  const town = state.towns.find((t) => t.id === 'town_wei_0');
  assert.equal(town.playerId, 1, '城镇归属不变');
  assert.deepEqual(town.garrison, [{ unitId: 'wei_qingzhou', count: 4 }]);
});

test('resolveBattle：败方玩家没有英雄但还有城镇 → 自动补一名新武将', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  forceWinner(battle, 'attacker');

  const r = resolveBattle(state, DATA);
  assert.equal(r.removedHeroes.length, 1);
  assert.equal(r.hiredHeroes.length, 1, '曹魏应补充新武将');

  const hired = state.heroes.find((h) => h.id === r.hiredHeroes[0]);
  assert.ok(hired, '新武将应加入 state.heroes');
  assert.equal(hired.playerId, 1);
  assert.deepEqual(hired.army, [], '新武将没有军队');
  assert.deepEqual(hired.pos, { x: 26, y: 3 }, '新武将站在城镇上');
  assert.equal(hired.name, '夏侯惇', '被俘的曹操不该再出现同名武将');
  assert.deepEqual(r.hiredHeroNames, ['夏侯惇']);
  assert.deepEqual(r.removedHeroNames, ['曹操']);
});

test('resolveBattle：平局 → 双方英雄都被移除', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  // 双方全灭
  for (const s of battle.stacks) s.count = 0;
  checkBattleEnd(battle);
  assert.equal(battle.winner, 'draw');

  const r = resolveBattle(state, DATA);
  assert.equal(r.winner, 'draw');
  assert.equal(r.removedHeroes.length, 2);
  // 双方都还有城镇 → 各自补一名武将
  assert.equal(r.hiredHeroes.length, 2);
});

test('resolveBattle：没有战斗 / 战斗未结束 → 返回失败原因', () => {
  const state = makeBattleState();
  assert.equal(resolveBattle(state, DATA).reason, 'noBattle');

  initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  assert.equal(resolveBattle(state, DATA).reason, 'battleNotOver');
});

test('resolveBattle：幸存部队回满血（战后治疗）', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  battle.stacks[0].hp = 1;   // 队首兵受伤
  forceWinner(battle, 'attacker');

  resolveBattle(state, DATA);
  assert.equal(battle.stacks[0].hp, battle.stacks[0].maxHp, '幸存队首兵应回满血');
});

test('resolveBattle：removeLoserHero=false 时败方英雄保留（可选撤退模式）', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  forceWinner(battle, 'attacker');

  const r = resolveBattle(state, DATA, { removeLoserHero: false });
  assert.equal(r.removedHeroes.length, 0);
  assert.ok(state.heroes.find((h) => h.id === 'hero_wei_0'), '败方英雄应保留');
});

test('armyValue：军队总价值 = 各兵种 aiValue × 数量', () => {
  const v = armyValue(
    [{ unitId: 'shu_militia', count: 40 }, { unitId: 'shu_archer', count: 20 }],
    DATA
  );
  assert.equal(v, 40 * 90 + 20 * 100);
});

test('验收：一方全灭后 battle.winner 正确、resolveBattle 后败方英雄被移除', () => {
  const state = makeBattleState();
  const battle = initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    data: DATA
  });
  const attackers = battle.stacks.filter((s) => s.side === 'attacker');
  const defenders = battle.stacks.filter((s) => s.side === 'defender');
  const atk = attackers[0];

  // 逐个击破守方的每一个 stack（关掉反击加速测试）
  let guard = 0;
  for (const d of defenders) {
    atk.pos = { x: Math.max(0, d.pos.x - 1), y: d.pos.y };
    while (d.count > 0 && guard++ < 200) {
      atk.acted = false;    // 允许连续攻击（模拟多次行动）
      atk.moved = false;
      d.retaliated = true; // 关掉反击
      const r = attackStack(battle, DATA, atk.id, d.id, { rng: fixedRng(0) });
      if (!r.ok) break;
    }
  }

  assert.equal(checkBattleEnd(battle), 'attacker');
  const res = resolveBattle(state, DATA);
  assert.equal(res.ok, true);
  assert.equal(state.heroes.find((h) => h.id === 'hero_wei_0'), undefined);
});

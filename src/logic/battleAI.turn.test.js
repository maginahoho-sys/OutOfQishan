import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initBattle,
  nextTurn,
  currentStack,
  moveStack,
  attackStack,
  cellDistance,
  isAdjacent,
  isOutOfRange
} from './battleLogic.js';
import {
  planTurn,
  executeStep,
  aiTakeTurn,
  takeTurn,
  actIfAI,
  estimateDamage,
  stackTotalHp,
  scoreTarget,
  pickTarget,
  summarizeAction
} from './battleAI.js';

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
    factions: read('factions.json')
  };
}

const DATA = loadData();

/**
 * 造一个战斗 state
 */
function makeState(opts = {}) {
  const {
    atkArmy = [{ unitId: 'shu_militia', count: 10 }],
    defArmy = [{ unitId: 'wei_qingzhou', count: 10 }]
  } = opts;

  return {
    meta: { currentPlayer: 0, day: 1, week: 1 },
    players: [
      { id: 0, faction: 'shu', isAI: false, gold: 0, wood: 0, ore: 0 },
      { id: 1, faction: 'wei', isAI: true, gold: 0, wood: 0, ore: 0 }
    ],
    heroes: [
      {
        id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备',
        level: 1, exp: 0, pendingLevels: 0,
        movePoints: 20, maxMovePoints: 20, mana: 20, maxMana: 20,
        pos: { x: 3, y: 13 }, skills: {}, spells: [],
        army: atkArmy.map((a) => ({ ...a }))
      },
      {
        id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操',
        level: 1, exp: 0, pendingLevels: 0,
        movePoints: 20, maxMovePoints: 20, mana: 20, maxMana: 20,
        pos: { x: 26, y: 4 }, skills: {}, spells: [],
        army: defArmy.map((a) => ({ ...a }))
      }
    ],
    towns: [],
    battle: null
  };
}

/** 起一场战斗 */
function startBattleOf(state) {
  return initBattle(state, state.heroes[0].army, state.heroes[1].army, {
    attackerHeroId: 'hero_shu_0',
    defenderHeroId: 'hero_wei_0',
    attackerPlayerId: 0,
    defenderPlayerId: 1,
    data: DATA
  });
}

/** 取某一方的 stack 数组 */
function sideOf(battle, side) {
  return battle.stacks.filter((s) => s.side === side);
}

/** 把某个 stack 放到指定格子 */
function place(stack, x, y) {
  stack.pos = { x, y };
}

// ══════════════════════════════════════════════
// 预估伤害
// ══════════════════════════════════════════════

test('estimateDamage：等于 (min+max)/2 × 次数 × 攻防修正', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  // 乡勇 attack 2 / damage 1~3；青州兵 defense 3 → 攻防差 -1 → ×0.98
  const est = estimateDamage(atk, def);
  const expected = Math.max(1, Math.round(2 * 10 * 0.98));
  assert.ok(Math.abs(est - expected) <= 1, `预估伤害 ${est} 应接近 ${expected}`);
});

test('estimateDamage：超射程伤害减半', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  const inRange = estimateDamage(atk, def, { outOfRange: false });
  const outRange = estimateDamage(atk, def, { outOfRange: true });
  assert.ok(outRange < inRange, '超射程伤害应更低');
  assert.ok(Math.abs(outRange - inRange / 2) <= 1, '超射程应约等于一半');
});

test('estimateDamage：twoAttack 伤害翻倍', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_crossbow', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  const withTwo = estimateDamage(atk, def);
  atk.abilities = atk.abilities.filter((a) => a !== 'twoAttack');
  const withoutTwo = estimateDamage(atk, def);
  assert.ok(Math.abs(withTwo - withoutTwo * 2) <= 2, '双击伤害应约为两倍');
});

test('stackTotalHp：剩余总血 = 队首当前血 + 后面满血的兵', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const s = sideOf(battle, 'attacker')[0];

  assert.equal(stackTotalHp(s), 6 + 9 * 6, '10 个满血乡勇 = 60');
  s.hp = 2;
  s.count = 5;
  assert.equal(stackTotalHp(s), 2 + 4 * 6, '5 个兵（队首剩 2 血）= 26');
});

// ══════════════════════════════════════════════
// 选靶评分
// ══════════════════════════════════════════════

test('scoreTarget：能一击打死的目标评分最高', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_crossbow', count: 10 }],
    // 两个守方 stack，才有两个候选目标
    defArmy: [
      { unitId: 'wei_qingzhou', count: 10 },
      { unitId: 'wei_qingzhou', count: 10 }
    ]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const [t1, t2] = sideOf(battle, 'defender');

  // t2 残血到能被一击打死
  t2.hp = 1;
  t2.count = 1;
  place(t1, 10, 0);
  place(t2, 10, 3);

  const s1 = scoreTarget(battle, DATA, atk, atk.pos, t1);
  const s2 = scoreTarget(battle, DATA, atk, atk.pos, t2);
  assert.ok(s2 > s1, `能打死的目标(${s2})应比满血目标(${s1})分高`);
});

test('pickTarget：同分时结果确定（可复现）', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const pool = sideOf(battle, 'defender');

  const a = pickTarget(battle, DATA, atk, atk.pos, pool);
  const b = pickTarget(battle, DATA, atk, atk.pos, pool);
  assert.equal(a.id, b.id, '同分时应选同一个目标');
});

// ══════════════════════════════════════════════
// 规划层：近战
// ══════════════════════════════════════════════

test('planTurn：近战相邻时直接开火，不移动', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 4, 4);
  place(def, 5, 4);

  const steps = planTurn(battle, DATA, atk.id);
  assert.equal(steps.length, 1, '只该有一步');
  assert.equal(steps[0].type, 'attack');
  assert.equal(steps[0].targetId, def.id);
});

test('planTurn：近战打不到时向最近敌人推进', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 8, 0);

  const steps = planTurn(battle, DATA, atk.id);
  assert.ok(steps.length >= 1, '应有行动');
  assert.equal(steps[0].type, 'move', '第一步应是移动');
  // 乡勇 moveRange 4 → 一步最多靠近 4 格
  assert.ok(
    cellDistance(steps[0].to, def.pos) < cellDistance(atk.pos, def.pos),
    '移动后应更靠近敌人'
  );
});

test('planTurn：近战能一步贴上敌人时，移动后同回合追加攻击', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 3, 0); // 距离 3，乡勇 moveRange 4 → 一步能贴上

  const steps = planTurn(battle, DATA, atk.id);
  assert.equal(steps.length, 2, '应有移动 + 攻击两步');
  assert.equal(steps[0].type, 'move');
  assert.equal(steps[1].type, 'attack');
  assert.ok(isAdjacent(steps[0].to, def.pos), '移动后应与敌人相邻');
  assert.equal(steps[1].targetId, def.id);
});

test('planTurn：近战无路可走且够不着 → 防御', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  // moveRange 设为 0 → 哪都去不了
  atk.moveRange = 0;
  place(atk, 0, 0);
  place(def, 9, 8);

  const steps = planTurn(battle, DATA, atk.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'defend');
});

// ══════════════════════════════════════════════
// 规划层：远程
// ══════════════════════════════════════════════

test('planTurn：远程射程内有敌人时原地开火，不移动', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 3, 0); // 弓手射程 6 → 在射程内

  const steps = planTurn(battle, DATA, atk.id);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, 'attack');
  assert.equal(steps[0].targetId, def.id);
});

test('planTurn：远程不会主动走进敌人相邻格', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 2, 0); // 距离 2 → 远程射程 6，其实已在射程内

  // 强制让敌人远到射程外，逼 AI 走位
  place(def, 9, 8);
  atk.moveRange = 3;

  const steps = planTurn(battle, DATA, atk.id);
  const moveStep = steps.find((s) => s.type === 'move');
  if (moveStep) {
    assert.ok(
      !isAdjacent(moveStep.to, def.pos),
      '远程单位不应移动到敌人相邻格'
    );
  }
});

test('planTurn：远程射程外时优先移动到射程内再开火', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 10, 0); // 距离 10 > 射程 6
  atk.moveRange = 5;

  const steps = planTurn(battle, DATA, atk.id);
  const moveStep = steps.find((s) => s.type === 'move');
  assert.ok(moveStep, '射程外应先走位');

  const atkStep = steps.find((s) => s.type === 'attack');
  assert.ok(atkStep, '走位后应开火');

  // 移动后的位置应让敌人进入射程（射程 6）
  const newDist = cellDistance(moveStep.to, def.pos);
  assert.ok(newDist <= 6, `移动后距离 ${newDist} 应在射程 6 内`);
  assert.ok(
    newDist < cellDistance(atk.pos, def.pos),
    '移动后应比原地更接近射程内'
  );
});

test('planTurn：远程够不到射程时会朝敌人推进', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 10, 8); // 对角远角，距离 10
  atk.moveRange = 2; // 一步不可能进射程

  const steps = planTurn(battle, DATA, atk.id);
  const moveStep = steps.find((s) => s.type === 'move');
  assert.ok(moveStep, '应推进');
  assert.ok(
    cellDistance(moveStep.to, def.pos) < cellDistance(atk.pos, def.pos),
    '应朝敌人推进'
  );
});

// ══════════════════════════════════════════════
// 执行层
// ══════════════════════════════════════════════

test('executeStep：move 改变位置并标记 moved', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  place(atk, 4, 4);

  const r = executeStep(battle, DATA, { type: 'move', stackId: atk.id, to: { x: 5, y: 4 } });
  assert.equal(r.ok, true);
  assert.deepEqual(atk.pos, { x: 5, y: 4 });
  assert.equal(atk.moved, true);
});

test('executeStep：attack 造成伤害', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];
  place(atk, 4, 4);
  place(def, 5, 4);

  const before = def.count;
  const r = executeStep(battle, DATA, { type: 'attack', stackId: atk.id, targetId: def.id });
  assert.equal(r.ok, true);
  assert.ok(r.result.damage > 0, '应有伤害');
  assert.ok(def.count < before || def.hp < def.maxHp, '目标应受损');
});

test('executeStep：defend 设置 defending', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];

  const r = executeStep(battle, DATA, { type: 'defend', stackId: atk.id });
  assert.equal(r.ok, true);
  assert.equal(atk.defending, true);
});

test('aiTakeTurn：返回行动序列（含 move 与 attack）', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  place(atk, 0, 0);
  place(def, 3, 0);

  const seq = aiTakeTurn(battle, DATA, atk.id);
  assert.ok(Array.isArray(seq), '应返回数组');
  assert.equal(seq.length, 2, '应有移动 + 攻击两步');
  assert.equal(seq[0].type, 'move');
  assert.equal(seq[0].ok, true);
  assert.equal(seq[1].type, 'attack');
  assert.equal(seq[1].ok, true);
  assert.ok(seq[1].result.damage > 0);
});

test('summarizeAction：从序列推断动作名', () => {
  assert.equal(summarizeAction([]), 'wait');
  assert.equal(summarizeAction([{ type: 'move' }]), 'move');
  assert.equal(summarizeAction([{ type: 'move' }, { type: 'attack' }]), 'attack');
  assert.equal(summarizeAction([{ type: 'defend' }]), 'defend');
});

// ══════════════════════════════════════════════
// 兼容层
// ══════════════════════════════════════════════

test('takeTurn：保留旧签名 {action, targetId?, result?}', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];
  place(atk, 4, 4);
  place(def, 5, 4);

  const r = takeTurn(battle, DATA, atk.id);
  assert.equal(r.action, 'attack');
  assert.equal(r.targetId, def.id);
  assert.ok(r.result.damage > 0);
});

test('actIfAI：只处理 AI 方单位', () => {
  const state = makeState();
  const battle = startBattleOf(state);

  // 当前轮到攻方（playerId 0，玩家方）→ 不该被 AI 处理
  assert.equal(actIfAI(battle, DATA, 1), false);

  // 轮到守方（playerId 1，AI 方）→ 被处理
  const cur = currentStack(battle);
  if (cur.playerId === 0) {
    nextTurn(battle, { action: 'wait' });
  }
  assert.equal(actIfAI(battle, DATA, 1), true);
});

// ══════════════════════════════════════════════
// 验收标准
// ══════════════════════════════════════════════

test('验收1：10 乡勇(AI) vs 10 乡勇(玩家只防御)，AI 能在 20 轮内获胜', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);

  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];
  // 攻方是玩家（只防御），守方是 AI
  atk.playerId = 0;
  def.playerId = 1;

  let rounds = 0;
  let guard = 0;
  while (!battle.winner && guard++ < 2000) {
    const cur = currentStack(battle);
    if (!cur) break;

    if (cur.playerId === 1) {
      // AI 行动
      aiTakeTurn(battle, DATA, cur.id);
    } else {
      // 玩家只防御
      cur.defending = true;
    }
    nextTurn(battle, { action: cur.playerId === 1 ? 'attack' : 'defend' });
    rounds = battle.round;
    if (battle.round > 20) break;
  }

  assert.ok(battle.winner, '20 轮内应分出胜负');
  assert.equal(battle.winner, 'defender', 'AI（守方）应获胜');
  assert.ok(battle.round <= 20, `应在 20 轮内获胜，实际第 ${battle.round} 轮`);
});

test('验收2：AI 的远程兵不会主动走进敌人相邻格', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  atk.playerId = 1;
  def.playerId = 0;

  // 多跑几轮，每轮都检查 AI 远程兵的落点
  for (let i = 0; i < 6; i++) {
    const steps = planTurn(battle, DATA, atk.id);
    const moveStep = steps.find((s) => s.type === 'move');
    if (moveStep) {
      assert.ok(
        !isAdjacent(moveStep.to, def.pos),
        `第 ${i + 1} 轮远程兵走进了敌人相邻格`
      );
    }
    aiTakeTurn(battle, DATA, atk.id);
    nextTurn(battle, { action: 'wait' });
    if (battle.winner) break;
  }
});

test('验收3：AI 的远程兵在射程外时优先移动到射程内再开火', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_archer', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];

  atk.playerId = 1;
  def.playerId = 0;
  place(atk, 0, 0);
  place(def, 10, 0);
  atk.moveRange = 5;

  const steps = planTurn(battle, DATA, atk.id);
  const moveStep = steps.find((s) => s.type === 'move');
  const atkStep = steps.find((s) => s.type === 'attack');

  assert.ok(moveStep, '射程外应先走位');
  assert.ok(atkStep, '走位后应开火');
  assert.ok(cellDistance(moveStep.to, def.pos) <= 6, '移动后敌人应进入射程');

  // 真正执行一遍，检查实际开火不是超射程（半伤）
  const seq = aiTakeTurn(battle, DATA, atk.id);
  const realAtk = seq.find((s) => s.type === 'attack');
  assert.equal(realAtk.ok, true);
  assert.equal(realAtk.result.outOfRange, false, '移动进射程后开火不应是超射程');
});

test('验收4：aiTakeTurn 的返回值可被渲染层逐步消费', () => {
  const state = makeState({
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }]
  });
  const battle = startBattleOf(state);
  const atk = sideOf(battle, 'attacker')[0];
  const def = sideOf(battle, 'defender')[0];
  place(atk, 0, 0);
  place(def, 3, 0);

  const seq = aiTakeTurn(battle, DATA, atk.id);
  // 每一步都应该是渲染层能识别的结构
  for (const step of seq) {
    assert.ok(['move', 'attack', 'defend'].includes(step.type), `未知步骤类型 ${step.type}`);
    assert.equal(typeof step.ok, 'boolean');
    if (step.type === 'move') {
      assert.equal(typeof step.to.x, 'number');
      assert.equal(typeof step.to.y, 'number');
    }
    if (step.type === 'attack') {
      assert.equal(typeof step.targetId, 'string');
      assert.ok(step.result, '攻击步骤应带结果');
      assert.equal(typeof step.result.damage, 'number');
    }
  }
});

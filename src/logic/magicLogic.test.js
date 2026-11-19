import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import bus from '../core/EventBus.js';
import {
  canCast,
  castSpell,
  tickBuffs,
  buffModifier,
  dailyManaRegen,
  isBlinded,
  spellTargets,
  hasCastThisTurn,
  grantSpellsForLevel,
  getSpellDef,
  heroSpells
} from './magicLogic.js';
import { initBattle, nextTurn, checkBattleEnd, stackStat, stackSpeed, moveStack, attackStack } from './battleLogic.js';

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
 * @param {object} opts
 *   attackerHero: 攻方英雄额外字段
 *   defenderHero: 守方英雄额外字段
 *   atkArmy / defArmy: 军队
 */
function makeState(opts = {}) {
  const {
    attackerHero = {},
    defenderHero = {},
    atkArmy = [{ unitId: 'shu_militia', count: 10 }],
    defArmy = [{ unitId: 'wei_qingzhou', count: 10 }]
  } = opts;

  const state = {
    meta: { currentPlayer: 0, day: 1, week: 1 },
    players: [
      { id: 0, faction: 'shu', isAI: false, gold: 0, wood: 0, ore: 0 },
      { id: 1, faction: 'wei', isAI: true, gold: 0, wood: 0, ore: 0 }
    ],
    heroes: [
      {
        id: 'hero_shu_0',
        playerId: 0,
        faction: 'shu',
        name: '刘备',
        level: 1,
        exp: 0,
        pendingLevels: 0,
        movePoints: 20,
        maxMovePoints: 20,
        mana: 20,
        maxMana: 20,
        pos: { x: 3, y: 13 },
        skills: {},
        spells: ['heal', 'bless', 'huti', 'quxie', 'fuhuo'],
        army: atkArmy.map((a) => ({ ...a })),
        ...attackerHero
      },
      {
        id: 'hero_wei_0',
        playerId: 1,
        faction: 'wei',
        name: '曹操',
        level: 1,
        exp: 0,
        pendingLevels: 0,
        movePoints: 20,
        maxMovePoints: 20,
        mana: 20,
        maxMana: 20,
        pos: { x: 26, y: 4 },
        skills: {},
        spells: ['slow', 'haste', 'zhimang'],
        army: defArmy.map((a) => ({ ...a })),
        ...defenderHero
      }
    ],
    towns: [],
    battle: null
  };
  return state;
}

/** 起一场战斗 */
function startBattleOf(state, opts = {}) {
  const battle = initBattle(
    state,
    opts.atkArmy || state.heroes[0].army,
    opts.defArmy || state.heroes[1].army,
    {
      attackerHeroId: 'hero_shu_0',
      defenderHeroId: 'hero_wei_0',
      attackerPlayerId: 0,
      defenderPlayerId: 1,
      data: DATA
    }
  );
  return battle;
}

// ══════════════════════════════════════════════
// canCast
// ══════════════════════════════════════════════

test('canCast：法力足够且已习得 → ok', () => {
  const state = makeState();
  const r = canCast(state, 'hero_shu_0', 'heal');
  assert.equal(r.ok, true);
});

test('canCast：未习得的魔法 → notLearned', () => {
  const state = makeState();
  const r = canCast(state, 'hero_shu_0', 'slow'); // 蜀汉没学迟缓
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'notLearned');
});

test('canCast：法力不足 → noMana', () => {
  const state = makeState({ attackerHero: { mana: 1 } });
  const r = canCast(state, 'hero_shu_0', 'heal'); // heal 消耗 4
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noMana');
});

test('canCast：英雄不存在 → noHero；魔法不存在 → unknownSpell', () => {
  const state = makeState();
  assert.equal(canCast(state, 'hero_nope', 'heal').reason, 'noHero');
  assert.equal(canCast(state, 'hero_shu_0', 'nope').reason, 'unknownSpell');
});

// ══════════════════════════════════════════════
// 验收标准 1：刘备施放治疗：法力-4，目标 stack hp 上升且 log 有记录
// ══════════════════════════════════════════════

test('验收1：施放治疗 → 法力-4、目标 hp 上升、战报有记录', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');
  target.hp = 2; // 让它带伤

  const beforeMana = state.heroes[0].mana;
  const r = castSpell(state, DATA, 'hero_shu_0', 'heal', target.id);

  assert.equal(r.ok, true);
  assert.equal(state.heroes[0].mana, beforeMana - 4, 'heal 消耗 4 法力');
  assert.ok(target.hp > 2, '目标 hp 应上升');
  assert.ok(
    battle.log.some((l) => l.text.includes('施放【治疗】')),
    '战报应记录施法'
  );
});

test('验收1b：治疗量 = base + perLevel × 英雄等级', () => {
  const state = makeState({ attackerHero: { level: 3 } });
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');
  target.hp = 1;
  target.maxHp = 100; // 放大血量，方便观察治疗量

  castSpell(state, DATA, 'hero_shu_0', 'heal', target.id);
  // base 10 + perLevel 5 × level 3 = 25
  assert.equal(target.hp, 1 + 25, '治疗量应为 25');
});

test('验收1c：医疗技能提升治疗效果 20%/级', () => {
  const state = makeState({ attackerHero: { level: 1, skills: { medicine: 2 } } });
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');
  target.hp = 1;
  target.maxHp = 100;

  castSpell(state, DATA, 'hero_shu_0', 'heal', target.id);
  // (10 + 5×1) × (1 + 40/100) = 15 × 1.4 = 21
  assert.equal(target.hp, 1 + 21, '医疗 2 级应提升 40% 治疗量');
});

test('治疗：溢出治疗量可以复活阵亡的士兵（不超过初始数量）', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');
  target.count = 3;         // 阵亡了 7 个
  target.hp = target.maxHp; // 满血（没受伤，治疗量全拿去复活）

  castSpell(state, DATA, 'hero_shu_0', 'fuhuo', target.id); // fuhuo base 20
  // 20 点治疗量，乡勇 hp 6 → 复活 3 个（20/6=3），剩 2 点浪费
  assert.equal(target.count, 6, '应复活 3 个士兵');
  assert.ok(target.count <= target.initialCount, '不能超过初始数量');
});

test('治疗：复活数量不超过初始数量上限', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');
  target.count = 1;
  target.hp = target.maxHp;

  // 用一个超大治疗量（改 initialCount 模拟上限）
  target.initialCount = 2;
  const def = getSpellDef('fuhuo');
  assert.ok(def, 'fuhuo 定义应存在');

  castSpell(state, DATA, 'hero_shu_0', 'fuhuo', target.id);
  assert.ok(target.count <= 2, '复活后数量不超过 initialCount');
});

// ══════════════════════════════════════════════
// 验收标准 2：迟缓作用于敌 stack 后，其速度-2 且 turnQueue 顺序相应变化
// ══════════════════════════════════════════════

test('验收2：迟缓 → 敌 stack 速度-2，且 turnQueue 顺序变化', () => {
  // 注意：魔法有阵营归属（slow 属于曹魏），这里显式给蜀汉英雄塞进 spells
  const state = makeState({
    attackerHero: { spells: ['heal', 'slow'] },
    atkArmy: [{ unitId: 'shu_militia', count: 10 }],
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }, { unitId: 'wei_wuwei', count: 10 }]
  });
  const battle = startBattleOf(state);

  const enemy = battle.stacks.find((s) => s.side === 'defender' && s.unitId === 'wei_qingzhou');
  const other = battle.stacks.find((s) => s.side === 'defender' && s.unitId === 'wei_wuwei');

  // 青州兵 speed 3，武卫营 speed 4 → 队列里武卫营在前
  assert.ok(battle.turnQueue.indexOf(other.id) < battle.turnQueue.indexOf(enemy.id),
    '初始速度快的武卫营应排在前面');

  const before = stackSpeed(enemy);
  assert.equal(before, 3, '青州兵初始速度 3');

  const r = castSpell(state, DATA, 'hero_shu_0', 'slow', enemy.id);
  assert.equal(r.ok, true);
  assert.equal(stackSpeed(enemy), 1, '迟缓后速度应变成 1');

  // 速度被改 → 出手队列要重排：青州兵现在应该排到武卫营后面
  assert.ok(battle.turnQueue.indexOf(enemy.id) > battle.turnQueue.indexOf(other.id),
    '迟缓后青州兵应排到武卫营后面');
});

test('buff/debuff：压入 stack.buffs，格式为 { spellId, stat, value, turnsLeft }', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id); // 护体：defense +2，3 回合

  assert.equal(ally.buffs.length, 1);
  const b = ally.buffs[0];
  assert.equal(b.spellId, 'huti');
  assert.equal(b.stat, 'defense');
  assert.equal(b.value, 2);
  assert.equal(b.turnsLeft, 3);
  assert.equal(stackStat(ally, 'defense'), ally.defense + 2, '防御应加上 buff');
});

test('buff：重复施加同属性取更强的那个，不叠加失控', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id); // defense +2
  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id); // 再来一次

  assert.equal(ally.buffs.length, 1, '同属性 buff 应替换而不是叠加');
  assert.equal(buffModifier(ally, 'defense'), 2, '总修正仍是 +2，不会翻倍');
});

test('祝福：damageMax +2 让每击伤害上限提高', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  const before = stackStat(ally, 'damageMax');
  castSpell(state, DATA, 'hero_shu_0', 'bless', ally.id);
  assert.equal(stackStat(ally, 'damageMax'), before + 2, '伤害上限应 +2');
});

// ══════════════════════════════════════════════
// 验收标准 3：buff 持续 3 轮后自动消失，属性复原
// ══════════════════════════════════════════════

test('验收3：buff 持续 3 轮后自动消失，属性复原', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  const baseDefense = stackStat(ally, 'defense');

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(stackStat(ally, 'defense'), baseDefense + 2);

  // 走 3 轮：每轮结束时 tickBuffs 递减一次
  for (let i = 0; i < 3; i++) {
    tickBuffs(battle);
  }

  assert.equal(ally.buffs.length, 0, '3 轮后 buff 应消失');
  assert.equal(stackStat(ally, 'defense'), baseDefense, '属性应复原');
});

test('tickBuffs：turnsLeft 递减，归零移除', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(ally.buffs[0].turnsLeft, 3);

  tickBuffs(battle);
  assert.equal(ally.buffs[0].turnsLeft, 2);
  tickBuffs(battle);
  assert.equal(ally.buffs[0].turnsLeft, 1);
  tickBuffs(battle);
  assert.equal(ally.buffs.length, 0, 'turnsLeft 归零应移除');
});

test('M6 nextTurn：新一轮时自动 tickBuffs 并重置施法次数', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(battle.spellCastThisTurn.attacker, true, '施法后应标记本轮已施法');

  // 把队列走完一轮（两个 stack 各行动一次）
  nextTurn(battle, { action: 'wait' });
  nextTurn(battle, { action: 'wait' });

  assert.equal(battle.round, 2, '应进入第 2 轮');
  assert.equal(battle.spellCastThisTurn.attacker, false, '新一轮应重置施法次数');
  assert.equal(ally.buffs[0].turnsLeft, 2, '一轮过后 buff 应递减一次');
});

// ══════════════════════════════════════════════
// 验收标准 4：法力不足时 canCast 返回 noMana
// ══════════════════════════════════════════════

test('验收4：法力不足 → canCast 返回 noMana，castSpell 也拒绝', () => {
  const state = makeState({ attackerHero: { mana: 2 } });
  const battle = startBattleOf(state);
  const target = battle.stacks.find((s) => s.side === 'attacker');

  assert.equal(canCast(state, 'hero_shu_0', 'heal').reason, 'noMana');

  const r = castSpell(state, DATA, 'hero_shu_0', 'heal', target.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noMana');
  assert.equal(state.heroes[0].mana, 2, '失败的施法不应扣法力');
});

// ══════════════════════════════════════════════
// 施法限制与目标校验
// ══════════════════════════════════════════════

test('每方每轮限施法 1 次', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  const enemy = battle.stacks.find((s) => s.side === 'defender');

  const r1 = castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(r1.ok, true);

  const r2 = castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'spellLimitReached');

  assert.equal(hasCastThisTurn(battle, 'hero_shu_0'), true);
  assert.equal(hasCastThisTurn(battle, 'hero_wei_0'), false, '对方不受影响');
});

test('施法目标校验：给友军施放 enemy 魔法 → wrongSide', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  const r = castSpell(state, DATA, 'hero_shu_0', 'quxie', ally.id); // 驱邪是 enemy 目标
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrongSide');
});

test('施法目标校验：目标不存在 → noTarget', () => {
  const state = makeState();
  startBattleOf(state);
  const r = castSpell(state, DATA, 'hero_shu_0', 'heal', 's_not_exist');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noTarget');
});

test('群体魔法：allAllies 给全部友军上 buff', () => {
  // 天佑是 3 级魔法，这里显式塞进 spells（正常流程靠升级自动学）
  const state = makeState({
    attackerHero: { spells: ['heal', 'tianyou'] },
    atkArmy: [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 10 }]
  });
  const battle = startBattleOf(state);

  const r = castSpell(state, DATA, 'hero_shu_0', 'tianyou'); // 天佑：全体友军 attack+3
  assert.equal(r.ok, true);

  const allies = battle.stacks.filter((s) => s.side === 'attacker');
  assert.equal(allies.length, 2);
  for (const a of allies) {
    assert.equal(stackStat(a, 'attack'), a.attack + 3, '全员攻击 +3');
  }
});

test('群体魔法：allEnemies 给全部敌军上 debuff', () => {
  // 空城是曹魏 3 级魔法，这里显式塞进曹魏英雄的 spells
  const state = makeState({
    defenderHero: { spells: ['slow', 'kongcheng'] },
    defArmy: [{ unitId: 'wei_qingzhou', count: 10 }, { unitId: 'wei_wuwei', count: 10 }]
  });
  const battle = startBattleOf(state);

  const r = castSpell(state, DATA, 'hero_wei_0', 'kongcheng'); // 空城：全体敌军 attack-3
  assert.equal(r.ok, true);

  const enemies = battle.stacks.filter((s) => s.side === 'attacker');
  assert.equal(enemies.length, 1);
  for (const e of enemies) {
    assert.equal(stackStat(e, 'attack'), e.attack - 3, '全员攻击 -3');
  }
});

test('伤害魔法：造成伤害且不触发反击', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const enemy = battle.stacks.find((s) => s.side === 'defender');
  const atk = battle.stacks.find((s) => s.side === 'attacker');
  const enemyHpBefore = enemy.hp;
  const atkHpBefore = atk.hp;

  const r = castSpell(state, DATA, 'hero_shu_0', 'quxie', enemy.id); // 驱邪：8+4×1=12
  assert.equal(r.ok, true);
  assert.ok(enemy.hp < enemyHpBefore || enemy.count < 10, '敌人应受伤');
  assert.equal(atk.hp, atkHpBefore, '施法不应触发反击');
});

test('施法不推进回合、不消耗 stack 行动', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  const turnBefore = battle.currentTurn;

  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(battle.currentTurn, turnBefore, '施法不应推进指针');
  assert.equal(ally.acted, false, '施法不应消耗 stack 行动');
});

// ══════════════════════════════════════════════
// 致盲
// ══════════════════════════════════════════════

test('致盲：debuff stat=canAct，被致盲 stack 本轮不能行动', () => {
  // 致盲是曹魏魔法，由曹魏英雄对蜀汉单位施放
  const state = makeState({
    defenderHero: { spells: ['slow', 'zhimang'] }
  });
  const battle = startBattleOf(state);
  const atkStack = battle.stacks.find((s) => s.side === 'attacker');

  const r = castSpell(state, DATA, 'hero_wei_0', 'zhimang', atkStack.id);
  assert.equal(r.ok, true);
  assert.equal(isBlinded(atkStack), true, '应处于致盲状态');
  assert.equal(atkStack.buffs[0].stat, 'canAct');
  assert.equal(atkStack.buffs[0].value, 0);

  // 被致盲的 stack 轮到时会被 nextTurn 跳过（标记 acted 并写"无法行动"）
  // 走完一整轮，确保无论它排在队列哪一位都会被处理到
  for (let i = 0; i < battle.turnQueue.length; i++) {
    nextTurn(battle, { action: 'wait' });
  }
  assert.equal(atkStack.acted, true, '致盲 stack 应被标记为已行动（跳过）');
  assert.ok(
    battle.log.some((l) => l.text.includes('被致盲，无法行动')),
    '战报应记录致盲跳过'
  );
});

test('致盲：被致盲的单位不能移动、不能攻击', () => {
  const state = makeState({
    defenderHero: { spells: ['slow', 'zhimang'] }
  });
  const battle = startBattleOf(state);
  const atkStack = battle.stacks.find((s) => s.side === 'attacker');
  const defStack = battle.stacks.find((s) => s.side === 'defender');

  castSpell(state, DATA, 'hero_wei_0', 'zhimang', atkStack.id);

  const mv = moveStack(battle, atkStack.id, { x: atkStack.pos.x + 1, y: atkStack.pos.y });
  assert.equal(mv.ok, false);
  assert.equal(mv.reason, 'blinded', '被致盲不能移动');

  const at = attackStack(battle, DATA, atkStack.id, defStack.id);
  assert.equal(at.ok, false);
  assert.equal(at.reason, 'blinded', '被致盲不能攻击');
});

test('isBlinded：无 canAct buff 时为 false', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  assert.equal(isBlinded(ally), false);
  castSpell(state, DATA, 'hero_shu_0', 'huti', ally.id);
  assert.equal(isBlinded(ally), false, '护体不是致盲');
});

// ══════════════════════════════════════════════
// 事件与查询
// ══════════════════════════════════════════════

test('施法发出 magic:cast 事件', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  let payload = null;
  const off = bus.on('magic:cast', (p) => { payload = p; });
  castSpell(state, DATA, 'hero_shu_0', 'heal', ally.id);
  off();

  assert.ok(payload, '应发出 magic:cast');
  assert.equal(payload.heroId, 'hero_shu_0');
  assert.equal(payload.spellId, 'heal');
  assert.equal(payload.targetStackId, ally.id);
  assert.ok(payload.effectDesc);
});

test('spellTargets：按 target 类型返回合法目标', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  const enemy = battle.stacks.find((s) => s.side === 'defender');

  assert.deepEqual(spellTargets(battle, 'hero_shu_0', 'heal'), [ally.id], 'ally → 本方');
  assert.deepEqual(spellTargets(battle, 'hero_shu_0', 'quxie'), [enemy.id], 'enemy → 对方');
  assert.deepEqual(spellTargets(battle, 'hero_shu_0', 'tianyou'), [ally.id], 'allAllies → 本方全体');
  assert.deepEqual(spellTargets(battle, 'hero_shu_0', 'kongcheng'), [enemy.id], 'allEnemies → 对方全体');
});

test('dailyManaRegen：+5 且不超过 maxMana', () => {
  const state = makeState({ attackerHero: { mana: 3, maxMana: 20 } });
  const r = dailyManaRegen(state, 'hero_shu_0');
  assert.equal(r.ok, true);
  assert.equal(r.gained, 5);
  assert.equal(state.heroes[0].mana, 8);

  // 接近上限时不能溢出
  state.heroes[0].mana = 18;
  dailyManaRegen(state, 'hero_shu_0');
  assert.equal(state.heroes[0].mana, 20, '不应超过 maxMana');
});

test('grantSpellsForLevel：升级后自动学会本阵营同等级魔法', () => {
  const state = makeState({ attackerHero: { level: 1, spells: [] } });
  const gained = grantSpellsForLevel(state, 'hero_shu_0');
  // 蜀汉 1 级魔法：heal / bless / huti
  assert.equal(gained.length, 3);
  assert.ok(gained.includes('heal'));

  // 升到 2 级 → 追加 2 级魔法
  state.heroes[0].level = 2;
  const gained2 = grantSpellsForLevel(state, 'hero_shu_0');
  assert.equal(gained2.length, 2, '2 级魔法有 2 个');
  assert.ok(gained2.includes('quxie'));
  assert.ok(gained2.includes('fuhuo'));

  // 重复调用不会重复授予
  const gained3 = grantSpellsForLevel(state, 'hero_shu_0');
  assert.equal(gained3.length, 0);
});

test('grantSpellsForLevel：不会学到对方阵营的魔法', () => {
  const state = makeState({ attackerHero: { level: 3, spells: [] } });
  const gained = grantSpellsForLevel(state, 'hero_shu_0');
  assert.ok(!gained.includes('slow'), '蜀汉不应学到迟缓');
  assert.ok(!gained.includes('kongcheng'), '蜀汉不应学到空城');
  assert.ok(gained.includes('tianyou'), '蜀汉 3 级魔法应学到天佑');
});

test('heroSpells：列出英雄已习得的魔法定义', () => {
  const state = makeState();
  const list = heroSpells(state.heroes[0]);
  assert.ok(list.length > 0);
  assert.ok(list.every((s) => s.id && s.name));
});

// ══════════════════════════════════════════════
// 边界情况
// ══════════════════════════════════════════════

test('战斗已结束时不能施法', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  battle.winner = 'attacker';

  const r = castSpell(state, DATA, 'hero_shu_0', 'heal', ally.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'battleOver');
});

test('不在战斗中的英雄不能施法', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  // 换一个不在 battle 里的英雄 id
  const r = castSpell(state, DATA, 'hero_unknown', 'heal', ally.id);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noHero');
});

test('未知 effect.type → unknownEffect', () => {
  const state = makeState();
  const battle = startBattleOf(state);
  const ally = battle.stacks.find((s) => s.side === 'attacker');

  // 临时篡改魔法定义来模拟脏数据
  const def = getSpellDef('heal');
  const saved = def.effect.type;
  def.effect.type = 'unknownType';
  try {
    const r = castSpell(state, DATA, 'hero_shu_0', 'heal', ally.id);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unknownEffect');
  } finally {
    def.effect.type = saved;
  }
});

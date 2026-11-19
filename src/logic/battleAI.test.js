import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initBattle, nextTurn, stackStat } from './battleLogic.js';
import { aiCastSpell } from './battleAI.js';
import { isBlinded, hasCastThisTurn } from './magicLogic.js';

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
 * @param {object} opts attackerHero / defenderHero 额外字段
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
        id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备',
        level: 1, exp: 0, pendingLevels: 0,
        movePoints: 20, maxMovePoints: 20, mana: 20, maxMana: 20,
        pos: { x: 3, y: 13 }, skills: {},
        spells: ['heal', 'bless', 'huti', 'quxie', 'fuhuo'],
        army: atkArmy.map((a) => ({ ...a })),
        ...attackerHero
      },
      {
        id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操',
        level: 1, exp: 0, pendingLevels: 0,
        movePoints: 20, maxMovePoints: 20, mana: 20, maxMana: 20,
        pos: { x: 26, y: 4 }, skills: {},
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
function startBattleOf(state) {
  return initBattle(
    state,
    state.heroes[0].army,
    state.heroes[1].army,
    {
      attackerHeroId: 'hero_shu_0',
      defenderHeroId: 'hero_wei_0',
      attackerPlayerId: 0,
      defenderPlayerId: 1,
      data: DATA
    }
  );
}

// ══════════════════════════════════════════════
// AI 施法基本行为
// ══════════════════════════════════════════════

test('AI 施法：优先用伤害魔法打残血敌人', () => {
  const state = makeState({
    defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'] } // 加火计（伤害魔法）
  });
  const battle = startBattleOf(state);

  const enemies = battle.stacks.filter((s) => s.side === 'attacker');
  // 让第一个敌人残血
  enemies[0].hp = 1;
  enemies[0].count = 1;

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, true, 'AI 应该施法成功');
  assert.equal(r.spellId, 'huoji', '优先用伤害魔法');
  assert.ok(
    battle.log.some((l) => l.text.includes('施放【火计】')),
    '战报应记录施法'
  );
});

test('AI 施法：伤害魔法优先打血量百分比最低的敌人', () => {
  const state = makeState({
    defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'] },
    atkArmy: [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 10 }]
  });
  const battle = startBattleOf(state);

  const enemies = battle.stacks.filter((s) => s.side === 'attacker');
  // enemies[0] 满血，enemies[1] 残血 → AI 应打 enemies[1]
  enemies[1].hp = 1;
  enemies[1].count = 1;
  const hpBefore0 = enemies[0].hp;
  const hpBefore1 = enemies[1].hp;

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, true);
  assert.equal(r.spellId, 'huoji');
  assert.ok(enemies[1].hp < hpBefore1 || enemies[1].count < 10, '残血敌人应受伤');
  assert.equal(enemies[0].hp, hpBefore0, '满血敌人不应受伤');
});

test('AI 施法：没有伤害魔法时用减益（致盲）', () => {
  const state = makeState({ defenderHero: { spells: ['slow', 'haste', 'zhimang'] } });
  const battle = startBattleOf(state);
  const enemy = battle.stacks.find((s) => s.side === 'attacker');

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, true);
  assert.equal(r.spellId, 'zhimang', '应该用致盲');
  assert.equal(isBlinded(enemy), true, '敌人应被致盲');
});

test('AI 施法：每轮至多一次，第二次被拒绝', () => {
  const state = makeState({ defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'] } });
  startBattleOf(state);

  const r1 = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r1.ok, true);
  assert.equal(hasCastThisTurn(state.battle, 'hero_wei_0'), true);

  const r2 = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'spellLimitReached');
});

test('AI 施法：新一轮后可以再次施法', () => {
  const state = makeState({ defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'] } });
  const battle = startBattleOf(state);

  assert.equal(aiCastSpell(state, DATA, 'hero_wei_0').ok, true);

  // 走完一整轮（2 个 stack）
  nextTurn(battle, { action: 'wait' });
  nextTurn(battle, { action: 'wait' });
  assert.equal(battle.round, 2);
  assert.equal(hasCastThisTurn(battle, 'hero_wei_0'), false, '新一轮应重置施法次数');
});

test('AI 施法：法力不足时不施法', () => {
  const state = makeState({
    defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'], mana: 0 }
  });
  startBattleOf(state);

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noSpell');
});

test('AI 施法：没有习得魔法时不施法', () => {
  const state = makeState({ defenderHero: { spells: [] } });
  startBattleOf(state);

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noSpell');
});

test('AI 施法：己方有伤员时会治疗', () => {
  const state = makeState({
    attackerHero: { spells: ['heal'] },
    defenderHero: { spells: ['slow', 'haste'] } // 只有减益，没有伤害魔法
  });
  const battle = startBattleOf(state);

  // 蜀汉（攻方）自己的兵受伤 → 治疗应打在攻方身上
  const ally = battle.stacks.find((s) => s.side === 'attacker');
  ally.hp = 1;

  const r = aiCastSpell(state, DATA, 'hero_shu_0');
  assert.equal(r.ok, true);
  assert.equal(r.spellId, 'heal', '有伤员时应优先治疗');
  assert.ok(ally.hp > 1, '伤员应被治疗');
});

test('AI 施法：己方全员满血时用增益', () => {
  const state = makeState({
    defenderHero: { spells: ['haste'] } // 只有增益（速度 +2）
  });
  const battle = startBattleOf(state);

  const ally = battle.stacks.find((s) => s.side === 'defender');
  const speedBefore = stackStat(ally, 'speed');

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, true);
  assert.equal(r.spellId, 'haste');
  assert.ok(stackStat(ally, 'speed') > speedBefore, '速度应提升');
});

test('AI 施法：不在战斗中的英雄不能施法', () => {
  const state = makeState();
  state.battle = null;
  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'noBattle');
});

test('AI 施法：战斗结束后不再施法', () => {
  const state = makeState({ defenderHero: { spells: ['slow', 'haste', 'zhimang', 'huoji'] } });
  const battle = startBattleOf(state);
  battle.winner = 'attacker';

  const r = aiCastSpell(state, DATA, 'hero_wei_0');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'battleOver');
});

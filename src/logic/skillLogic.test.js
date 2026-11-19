import { test } from 'node:test';
import assert from 'node:assert/strict';

import bus from '../core/EventBus.js';
import {
  expForLevel,
  gainExp,
  levelUpOptions,
  chooseSkill,
  skillBonus,
  autoChooseSkill,
  upgradableSkills,
  heroSkillLevel,
  getSkillDef,
  BASE_MOVE_POINTS,
  BASE_MANA,
  LEVEL_UP_OPTION_COUNT
} from './skillLogic.js';
import { refreshMovePoints } from './turnLogic.js';

/** 造一个只含一名英雄的最小 state */
function makeState(hero = {}) {
  return {
    heroes: [
      {
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
        skills: {},
        ...hero
      }
    ]
  };
}

/** 固定随机数（返回 0 → 洗牌结果固定） */
function fixedRng(v = 0) {
  return () => v;
}

// ══════════════════════════════════════════════
// 经验部分（M6c 随 M8 一并交付）
// ══════════════════════════════════════════════

test('expForLevel：level² × 100', () => {
  assert.equal(expForLevel(1), 100);   // 1→2
  assert.equal(expForLevel(2), 400);   // 2→3
  assert.equal(expForLevel(3), 900);   // 3→4
  assert.equal(expForLevel(10), 10000);
});

test('gainExp：经验不足门槛不升级', () => {
  const state = makeState();
  const levels = gainExp(state, 'hero_shu_0', 99);
  assert.equal(levels, 0);
  assert.equal(state.heroes[0].level, 1);
  assert.equal(state.heroes[0].exp, 99);
  assert.equal(state.heroes[0].pendingLevels, 0);
});

test('gainExp：刚好 100 经验升 1 级，pendingLevels=1', () => {
  const state = makeState();
  const levels = gainExp(state, 'hero_shu_0', 100);
  assert.equal(levels, 1);
  assert.equal(state.heroes[0].level, 2);
  assert.equal(state.heroes[0].exp, 0, '升级后余量为 0');
  assert.equal(state.heroes[0].pendingLevels, 1);
});

test('gainExp：可连升多级', () => {
  const state = makeState();
  // 1→2 需 100，2→3 需 400，合计 500
  const levels = gainExp(state, 'hero_shu_0', 500);
  assert.equal(levels, 2);
  assert.equal(state.heroes[0].level, 3);
  assert.equal(state.heroes[0].exp, 0);
  assert.equal(state.heroes[0].pendingLevels, 2);
});

test('gainExp：跨多次结算的经验会累加', () => {
  const state = makeState();
  gainExp(state, 'hero_shu_0', 60);
  gainExp(state, 'hero_shu_0', 60);
  assert.equal(state.heroes[0].level, 2);
  assert.equal(state.heroes[0].exp, 20);
  assert.equal(state.heroes[0].pendingLevels, 1);
});

test('gainExp：英雄不存在 / 经验为 0 或负数时不报错', () => {
  const state = makeState();
  assert.equal(gainExp(state, 'no_such_hero', 100), 0);
  assert.equal(gainExp(state, 'hero_shu_0', 0), 0);
  assert.equal(gainExp(state, 'hero_shu_0', -50), 0);
  assert.equal(state.heroes[0].level, 1);
});

// ══════════════════════════════════════════════
// M8 · 技能加点
// ══════════════════════════════════════════════

test('验收1：1 级英雄获得 100 经验 → pendingLevels=1，levelUpOptions 返回 3 个候选', () => {
  const state = makeState();
  gainExp(state, 'hero_shu_0', 100);
  assert.equal(state.heroes[0].pendingLevels, 1);

  const opts = levelUpOptions(state, {}, 'hero_shu_0');
  assert.equal(opts.length, 3, '应给出 3 个候选');

  for (const o of opts) {
    assert.ok(o.skillId, '候选应有 skillId');
    assert.ok(o.name, '候选应有名称');
    assert.equal(o.currentLevel, 0, '新英雄还没技能');
    assert.equal(o.nextLevel, 1);
    assert.ok(typeof o.desc === 'string');
  }
});

test('验收1b：候选不重复', () => {
  const state = makeState();
  const opts = levelUpOptions(state, {}, 'hero_shu_0');
  const ids = opts.map((o) => o.skillId);
  assert.equal(new Set(ids).size, ids.length, '候选不应重复');
});

test('验收1c：英雄不存在时返回空数组', () => {
  const state = makeState();
  assert.deepEqual(levelUpOptions(state, {}, 'no_such_hero'), []);
});

test('验收2：chooseSkill 后 skills 里对应技能等级 +1', () => {
  const state = makeState();
  gainExp(state, 'hero_shu_0', 100);

  const opts = levelUpOptions(state, {}, 'hero_shu_0');
  const pick = opts[0];
  const res = chooseSkill(state, {}, 'hero_shu_0', pick.skillId);

  assert.equal(res.ok, true);
  assert.equal(state.heroes[0].skills[pick.skillId], 1, '技能等级应为 1');
  assert.equal(state.heroes[0].pendingLevels, 0, '待加点次数应减 1');
  assert.equal(res.level, 1);
});

test('验收2b：chooseSkill 发出 hero:levelup 事件', () => {
  const state = makeState();
  gainExp(state, 'hero_shu_0', 100);
  const opts = levelUpOptions(state, {}, 'hero_shu_0');

  let payload = null;
  const off = bus.on('hero:levelup', (p) => { payload = p; });
  chooseSkill(state, {}, 'hero_shu_0', opts[0].skillId);
  off();

  assert.ok(payload, '应发出 hero:levelup');
  assert.equal(payload.heroId, 'hero_shu_0');
  assert.equal(payload.skillId, opts[0].skillId);
  assert.equal(payload.level, 1);
  assert.equal(payload.pendingLevels, 0);
});

test('验收3：学 2 级行军后，M4 的 refreshMovePoints 恢复的行动力 = 20+8', () => {
  const state = makeState();
  state.heroes[0].skills.logistics = 2;

  refreshMovePoints(state, {}, 0);

  assert.equal(state.heroes[0].maxMovePoints, 20 + 8, '行动力应为 28');
  assert.equal(state.heroes[0].movePoints, 28);
});

test('验收3b：chooseSkill 学行军后立即抬高行动力上限并补足当前值', () => {
  const state = makeState({ movePoints: 5, maxMovePoints: 20 });
  state.heroes[0].pendingLevels = 1;

  const res = chooseSkill(state, {}, 'hero_shu_0', 'logistics');
  assert.equal(res.ok, true);
  // 行军 perLevel = 4 → 上限 24，当前值 5+4=9
  assert.equal(state.heroes[0].maxMovePoints, 24);
  assert.equal(state.heroes[0].movePoints, 9, '当前行动力应按差额补足');
});

test('验收3c：chooseSkill 学谋略后抬高法力上限并补足当前值', () => {
  const state = makeState({ mana: 4, maxMana: 10 });
  state.heroes[0].pendingLevels = 1;

  chooseSkill(state, {}, 'hero_shu_0', 'wisdom');
  // 谋略 perLevel = 10 → 上限 20，当前值 4+10=14
  assert.equal(state.heroes[0].maxMana, 20);
  assert.equal(state.heroes[0].mana, 14);
});

test('验收4：技能满级后不再出现在选项里', () => {
  const state = makeState();
  // 统帅 maxLevel=3，先点满
  state.heroes[0].skills.leadership = 3;
  state.heroes[0].pendingLevels = 1;

  const opts = levelUpOptions(state, {}, 'hero_shu_0');
  assert.equal(opts.length, 3);
  assert.ok(!opts.some((o) => o.skillId === 'leadership'), '满级技能不应出现');

  // 全部技能满级 → 没有候选
  const allMax = makeState({
    skills: Object.fromEntries(
      ['leadership', 'logistics', 'wisdom', 'finance', 'archery', 'valor', 'medicine', 'defense']
        .map((id) => [id, 3])
    ),
    pendingLevels: 1
  });
  assert.deepEqual(levelUpOptions(allMax, {}, 'hero_shu_0'), []);
});

test('chooseSkill：无待加点次数时拒绝', () => {
  const state = makeState();
  const res = chooseSkill(state, {}, 'hero_shu_0', 'leadership');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'noPendingLevel');
});

test('chooseSkill：英雄不存在 / 技能不存在 时拒绝', () => {
  const state = makeState();
  state.heroes[0].pendingLevels = 1;
  assert.equal(chooseSkill(state, {}, 'no_such_hero', 'leadership').reason, 'noHero');
  assert.equal(chooseSkill(state, {}, 'hero_shu_0', 'no_such_skill').reason, 'unknownSkill');
});

test('chooseSkill：满级技能不可再升', () => {
  const state = makeState({ skills: { leadership: 3 } });
  state.heroes[0].pendingLevels = 1;
  const res = chooseSkill(state, {}, 'hero_shu_0', 'leadership');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'maxLevel');
});

test('连升多点：每点消耗一次 pendingLevels', () => {
  const state = makeState();
  gainExp(state, 'hero_shu_0', 500); // 连升 2 级 → pendingLevels=2

  const o1 = levelUpOptions(state, {}, 'hero_shu_0');
  chooseSkill(state, {}, 'hero_shu_0', o1[0].skillId);
  assert.equal(state.heroes[0].pendingLevels, 1);
  // 快照第一次的等级（后面若再选同一技能，等级会变成 2）
  const firstSkillId = o1[0].skillId;
  const levelAfterFirst = state.heroes[0].skills[firstSkillId];
  assert.equal(levelAfterFirst, 1, '第一次选中的技能应升到 1 级');

  const o2 = levelUpOptions(state, {}, 'hero_shu_0');
  chooseSkill(state, {}, 'hero_shu_0', o2[0].skillId);
  assert.equal(state.heroes[0].pendingLevels, 0);

  // 注意：两次可能抽到**同一个**技能（levelUpOptions 是随机洗牌），
  // 那时它的等级会是 2，不能简单断言"两个技能之和 = 2"。
  if (o2[0].skillId === firstSkillId) {
    assert.equal(state.heroes[0].skills[o2[0].skillId], levelAfterFirst + 1,
      '同一技能被选中两次应再升 1 级');
  } else {
    assert.equal(state.heroes[0].skills[o2[0].skillId], 1, '第二次选中的技能应升到 1 级');
  }
});

// ══════════════════════════════════════════════
// skillBonus
// ══════════════════════════════════════════════

test('skillBonus：无该技能返回 0', () => {
  const state = makeState();
  assert.equal(skillBonus(state, 'hero_shu_0', 'armyAttack'), 0);
  assert.equal(skillBonus(state, 'hero_shu_0', 'rangedDamage'), 0);
});

test('skillBonus：统帅 2 级 → armyAttack = 2 × perLevel(1) = 2', () => {
  const state = makeState({ skills: { leadership: 2 } });
  assert.equal(skillBonus(state, 'hero_shu_0', 'armyAttack'), 2);
});

test('skillBonus：行军 2 级 → movePoints = 2 × 4 = 8', () => {
  const state = makeState({ skills: { logistics: 2 } });
  assert.equal(skillBonus(state, 'hero_shu_0', 'movePoints'), 8);
});

test('skillBonus：理财 3 级 → goldPerDay = 3 × 200 = 600', () => {
  const state = makeState({ skills: { finance: 3 } });
  assert.equal(skillBonus(state, 'hero_shu_0', 'goldPerDay'), 600);
});

test('skillBonus：只统计同效果类型的技能', () => {
  const state = makeState({ skills: { leadership: 2, logistics: 3, archery: 1 } });
  assert.equal(skillBonus(state, 'hero_shu_0', 'armyAttack'), 2, '统帅只影响 armyAttack');
  assert.equal(skillBonus(state, 'hero_shu_0', 'movePoints'), 12, '行军只影响 movePoints');
  assert.equal(skillBonus(state, 'hero_shu_0', 'rangedDamage'), 10, '弓术只影响 rangedDamage');
});

test('skillBonus：英雄不存在返回 0', () => {
  const state = makeState();
  assert.equal(skillBonus(state, 'no_such_hero', 'armyAttack'), 0);
});

test('skillBonus：不认识的效果类型返回 0', () => {
  const state = makeState({ skills: { leadership: 3 } });
  assert.equal(skillBonus(state, 'hero_shu_0', 'unknownType'), 0);
});

// ══════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════

test('upgradableSkills：已学未满级可升、未学可学、满级排除', () => {
  const state = makeState({ skills: { leadership: 2, wisdom: 3 } });
  const pool = upgradableSkills(state.heroes[0]);
  const byId = Object.fromEntries(pool.map((p) => [p.skillId, p]));

  assert.equal(byId.leadership.currentLevel, 2);
  assert.equal(byId.leadership.nextLevel, 3);
  assert.equal(byId.leadership.isNew, false);
  assert.equal(byId.wisdom, undefined, '满级技能不在池中');
  assert.equal(byId.logistics.isNew, true, '未学技能标记 isNew');
  assert.equal(byId.logistics.nextLevel, 1);
});

test('heroSkillLevel：未学技能为 0', () => {
  assert.equal(heroSkillLevel({ skills: { leadership: 2 } }, 'leadership'), 2);
  assert.equal(heroSkillLevel({ skills: {} }, 'leadership'), 0);
  assert.equal(heroSkillLevel(null, 'leadership'), 0);
});

test('getSkillDef：能查到技能定义', () => {
  const def = getSkillDef('leadership');
  assert.ok(def);
  assert.equal(def.name, '统帅');
  assert.equal(def.effect.type, 'armyAttack');
});

test('常量：基础值与候选数量', () => {
  assert.equal(BASE_MOVE_POINTS, 20);
  assert.equal(BASE_MANA, 10);
  assert.equal(LEVEL_UP_OPTION_COUNT, 3);
});

// ══════════════════════════════════════════════
// autoChooseSkill（电脑方英雄自动加点）
// ══════════════════════════════════════════════

test('autoChooseSkill：消耗一次待加点次数', () => {
  const state = makeState();
  state.heroes[0].pendingLevels = 1;

  const res = autoChooseSkill(state, {}, 'hero_shu_0');
  assert.equal(res.ok, true);
  assert.equal(state.heroes[0].pendingLevels, 0);
  assert.equal(state.heroes[0].skills[res.skillId], 1);
});

test('autoChooseSkill：优先加统帅（战斗向权重最高）', () => {
  const state = makeState();
  state.heroes[0].pendingLevels = 1;

  const res = autoChooseSkill(state, {}, 'hero_shu_0', { rng: fixedRng(0) });
  assert.equal(res.skillId, 'leadership', '统帅权重最高应被优先选中');
});

test('autoChooseSkill：无可加点次数或技能全满时安全返回', () => {
  const state = makeState();
  assert.equal(autoChooseSkill(state, {}, 'hero_shu_0').reason, 'noPendingLevel');
  assert.equal(autoChooseSkill(state, {}, 'no_such_hero').reason, 'noHero');
});

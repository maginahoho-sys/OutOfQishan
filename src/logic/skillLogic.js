import bus from '../core/EventBus.js';
import SKILL_TABLE from '../data/skills.json' with { type: 'json' };

/**
 * skillLogic —— 英雄成长与技能逻辑（纯 JS，禁止 import phaser）
 *
 * 交付进度：
 *   M6c：经验曲线与经验结算 —— expForLevel / gainExp
 *   M8（本次）：技能加点 —— levelUpOptions / chooseSkill / skillBonus
 *
 * 为什么经验部分先做：
 *   M6c 的 resolveBattle 要给胜方英雄发经验，若等 M8 才写就会缺"经验 → 等级"的中间层，
 *   所以这里先把 M8 契约里最稳定的两个函数落地，M8 在其上补齐技能部分。
 *
 * ── 技能表来源（重要）──────────────────────────────────────
 *   本模块用 **静态 import** 引入 src/data/skills.json，而不是读运行时 data.skills。
 *   原因：契约冻结了 `skillBonus(state, heroId, effectType)` 的签名（不带 data 参数），
 *   而技能加成必须知道 perLevel。若 skillBonus 去读 data、其他函数读静态表，
 *   两边一旦不一致就会出现"加成算得出、选项列不出"的错位。
 *   因此：**技能定义以静态表为唯一权威源**，data 参数只为契约签名保留。
 *   （DataLoader 仍会加载 skills.json 供 M7/M13 展示用，两份内容同源。）
 * ────────────────────────────────────────────────────────
 *
 * 经验规则（简化自英雄无敌4）：
 *   - 升到 level+1 级需要 level² × 100 点经验（1→2 需 100，2→3 需 400，3→4 需 900）
 *   - hero.exp 表示"距离下一级还差多少"，升级时扣掉门槛值，跨级可连升
 *   - 升级不自动加点，次数记在 hero.pendingLevels，由 chooseSkill 消耗
 *
 * 加点规则（简化自英雄无敌4）：
 *   - 每次升级从"可升级技能池"里随机给 3 个候选，玩家选 1 个
 *   - 可升级技能池 = 已学但未满级的技能（继续升）+ 尚未学过的技能（学新）
 *   - 满级技能不再出现在候选里
 */

/** 技能定义表（静态，权威源） */
const SKILLS = SKILL_TABLE;

/** skillId → 技能定义 的索引 */
const SKILL_MAP = new Map(SKILLS.map((s) => [s.id, s]));

/** 英雄每日基础行动力 */
export const BASE_MOVE_POINTS = 20;
/** 英雄基础法力上限 */
export const BASE_MANA = 10;
/** 每次升级给出的候选技能数量 */
export const LEVEL_UP_OPTION_COUNT = 3;

/**
 * 升到指定等级所需的经验
 * @param {number} level 当前等级（1 级升 2 级需 100）
 * @returns {number}
 */
export function expForLevel(level) {
  const lv = Math.max(1, Math.floor(Number(level) || 1));
  return lv * lv * 100;
}

/**
 * 结算战斗经验：写入 hero.exp，按经验门槛连续升级
 *
 * @param {object} state
 * @param {string} heroId
 * @param {number} exp 获得的经验（向下取整，负数按 0 处理）
 * @returns {number} 本次升级次数（0 表示没升级）
 */
export function gainExp(state, heroId, exp) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return 0;

  const amount = Math.max(0, Math.floor(Number(exp) || 0));
  if (amount === 0) return 0;

  hero.exp = (hero.exp || 0) + amount;

  // 连续升级：经验够就升，直到不够为止
  let levels = 0;
  while (hero.exp >= expForLevel(hero.level)) {
    hero.exp -= expForLevel(hero.level);
    hero.level = (hero.level || 1) + 1;
    levels += 1;
    if (levels >= 100) break; // 防御：异常经验不至于死循环
  }

  // 待加点次数（M8 的 chooseSkill 每选一次减 1）
  hero.pendingLevels = (hero.pendingLevels || 0) + levels;

  bus.emit('hero:exp', {
    heroId,
    gained: amount,
    level: hero.level,
    levelUps: levels,
    pendingLevels: hero.pendingLevels
  });

  return levels;
}

/**
 * 查技能定义
 * @param {string} skillId
 * @returns {object|undefined}
 */
export function getSkillDef(skillId) {
  return SKILL_MAP.get(skillId);
}

/**
 * 读取英雄某技能的当前等级（未学则为 0）
 * @param {object} hero
 * @param {string} skillId
 * @returns {number}
 */
export function heroSkillLevel(hero, skillId) {
  return hero?.skills?.[skillId] || 0;
}

/**
 * 列出英雄当前可升级/可学习的全部技能
 *
 * 池子构成：
 *   - 已学且未满级 → 可继续升级（currentLevel > 0）
 *   - 未学过的技能 → 可新学（currentLevel === 0）
 * 满级技能不在池中。
 *
 * @param {object} hero
 * @returns {Array<{skillId:string,name:string,currentLevel:number,nextLevel:number,maxLevel:number,desc:string,isNew:boolean}>}
 */
export function upgradableSkills(hero) {
  if (!hero) return [];
  const out = [];
  for (const def of SKILLS) {
    const max = def.maxLevel ?? 1;
    const cur = heroSkillLevel(hero, def.id);
    if (cur >= max) continue; // 满级不再出现
    out.push({
      skillId: def.id,
      name: def.name,
      currentLevel: cur,
      nextLevel: cur + 1,
      maxLevel: max,
      desc: def.desc || '',
      isNew: cur === 0
    });
  }
  return out;
}

/**
 * 生成升级选项：随机给 3 个候选
 *
 * 候选来自 upgradableSkills（已学可升 + 未学可学）；
 * 不足 3 个则有几个给几个（技能全满级时返回空数组）。
 *
 * @param {object} state
 * @param {object} data 数据表集合（保留以符合契约签名；技能定义以静态表为准）
 * @param {string} heroId
 * @param {object} [opts] { rng, count } rng 便于测试注入
 * @returns {Array<{skillId:string,name:string,currentLevel:number,nextLevel:number,maxLevel:number,desc:string,isNew:boolean}>}
 */
export function levelUpOptions(state, data, heroId, opts = {}) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return [];

  const pool = upgradableSkills(hero);
  if (pool.length === 0) return [];

  const rng = opts.rng || Math.random;
  const count = Math.max(1, Math.min(opts.count ?? LEVEL_UP_OPTION_COUNT, pool.length));

  // Fisher-Yates 洗牌后取前 count 个
  const shuffled = pool.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count);
}

/**
 * 选择加点：技能等级 +1、pendingLevels -1、应用即时效果
 *
 * 即时效果（M8 定案）：
 *   - 行军（movePoints）→ 抬高 maxMovePoints，并把新增的行动力补给当前 movePoints
 *   - 谋略（mana）      → 抬高 maxMana，并把新增的法力补给当前 mana
 *   上限提高时当前值按差额同步补足（不浪费新加的额度），且不会超过新上限。
 *
 * @param {object} state
 * @param {object} data 数据表集合（保留以符合契约签名）
 * @param {string} heroId
 * @param {string} skillId
 * @returns {{ok:boolean, reason?:string, level?:number, pendingLevels?:number}}
 *   reason: noHero / noPendingLevel / unknownSkill / maxLevel
 */
export function chooseSkill(state, data, heroId, skillId) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };
  if ((hero.pendingLevels || 0) <= 0) return { ok: false, reason: 'noPendingLevel' };

  const def = SKILL_MAP.get(skillId);
  if (!def) return { ok: false, reason: 'unknownSkill' };

  const cur = heroSkillLevel(hero, skillId);
  const max = def.maxLevel ?? 1;
  if (cur >= max) return { ok: false, reason: 'maxLevel' };

  // 升级技能
  if (!hero.skills) hero.skills = {};
  hero.skills[skillId] = cur + 1;
  hero.pendingLevels = (hero.pendingLevels || 0) - 1;

  // 应用即时效果
  applyImmediateEffects(state, hero);

  bus.emit('hero:levelup', {
    heroId,
    skillId,
    level: cur + 1,
    pendingLevels: hero.pendingLevels
  });

  return {
    ok: true,
    level: cur + 1,
    pendingLevels: hero.pendingLevels
  };
}

/**
 * 应用技能带来的即时效果（上限类）
 *
 * 目前只有两类上限会被技能影响：行动力与法力。
 * 抬高上限时按差额同步补足当前值，避免"上限涨了但这一回合用不到"。
 *
 * @param {object} state
 * @param {object} hero
 */
function applyImmediateEffects(state, hero) {
  // 行动力
  const oldMaxMp = hero.maxMovePoints ?? BASE_MOVE_POINTS;
  const newMaxMp = BASE_MOVE_POINTS + skillBonus(state, hero.id, 'movePoints');
  if (newMaxMp !== oldMaxMp) {
    hero.maxMovePoints = newMaxMp;
    const cur = hero.movePoints ?? 0;
    hero.movePoints = Math.min(newMaxMp, cur + (newMaxMp - oldMaxMp));
  }

  // 法力
  const oldMaxMana = hero.maxMana ?? BASE_MANA;
  const newMaxMana = BASE_MANA + skillBonus(state, hero.id, 'mana');
  if (newMaxMana !== oldMaxMana) {
    hero.maxMana = newMaxMana;
    const cur = hero.mana ?? 0;
    hero.mana = Math.min(newMaxMana, cur + (newMaxMana - oldMaxMana));
  }
}

/**
 * 查询技能对英雄的当前加成（供 M4/M6/M9 查询）
 *
 * 加成 = 该效果类型下所有技能「等级 × perLevel」之和。
 * 例：skillBonus(state, id, 'armyAttack') → 统帅等级 × perLevel 的总值；无该技能返回 0。
 *
 * @param {object} state
 * @param {string} heroId
 * @param {string} effectType 效果类型，见 skills.json 的 effect.type
 * @returns {number}
 */
export function skillBonus(state, heroId, effectType) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero || !effectType) return 0;

  let total = 0;
  for (const [skillId, level] of Object.entries(hero.skills || {})) {
    const def = SKILL_MAP.get(skillId);
    if (!def) continue;
    if (def.effect?.type !== effectType) continue;
    total += (level || 0) * (def.effect.perLevel ?? 0);
  }
  return total;
}

/**
 * 各效果类型的 AI 偏好权重（越高越优先加）
 * 电脑方英雄没有玩家来点，自动加点按这个权重挑。
 */
const AI_SKILL_WEIGHT = {
  armyAttack: 10,
  armyDefense: 9,
  meleeDamage: 8,
  rangedDamage: 7,
  movePoints: 5,
  mana: 4,
  goldPerDay: 3,
  healBonus: 2
};

/**
 * 电脑方英雄自动加点
 *
 * 从全部可升级技能里挑权重最高的（同权重按等级低者优先），
 * 而不是从 levelUpOptions 的 3 个随机候选里挑——避免电脑永远学不到想要的能力。
 *
 * @param {object} state
 * @param {object} data 数据表集合（保留以符合契约签名）
 * @param {string} heroId
 * @param {object} [opts] { rng } 同权重时的随机因子，便于测试
 * @returns {{ok:boolean, reason?:string, skillId?:string, level?:number}}
 */
export function autoChooseSkill(state, data, heroId, opts = {}) {
  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) return { ok: false, reason: 'noHero' };
  if ((hero.pendingLevels || 0) <= 0) return { ok: false, reason: 'noPendingLevel' };

  const pool = upgradableSkills(hero);
  if (pool.length === 0) return { ok: false, reason: 'noPendingLevel' };

  const rng = opts.rng || Math.random;
  let best = null;
  let bestScore = -Infinity;
  for (const cand of pool) {
    const def = SKILL_MAP.get(cand.skillId);
    const weight = AI_SKILL_WEIGHT[def?.effect?.type] ?? 1;
    // 同权重时，优先当前等级低的（先把一个技能练起来）
    const score = weight * 100 - cand.currentLevel + rng() * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  if (!best) return { ok: false, reason: 'noPendingLevel' };

  const res = chooseSkill(state, data, heroId, best.skillId);
  if (!res.ok) return res;
  return { ...res, skillId: best.skillId };
}

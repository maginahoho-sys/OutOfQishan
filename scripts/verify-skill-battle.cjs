/**
 * M8 战斗链路验证 —— 技能加点 → 加成真的进战斗
 *
 * 1. 直接构造一场战斗（玩家方统帅 3 级 / 弓术 3 级）
 * 2. 验证 stack.attack 已含统帅加成、damagePct 已含弓术/武勇加成
 * 3. 验证 computeDamage 的实际伤害含百分比加成
 * 4. 走一遍 resolveBattle：电脑方英雄升级后自动加点
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const URL = process.env.URL || 'http://localhost:5180/';
const CHROME = fs.readdirSync(path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141'))
  .map((d) => path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141', d,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((p) => fs.existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await wait(1800);

  const out = {};

  // ── 1. 技能加成进入战场 stack ──
  out.battleStack = await page.evaluate(async () => {
    const bl = await import('/src/logic/battleLogic.js');
    const res = await fetch('/src/data/units.json');
    const units = await res.json();
    const data = { units };

    const state = {
      meta: { day: 1, week: 1, currentPlayer: 0 },
      players: [
        { id: 0, faction: 'shu', isAI: false },
        { id: 1, faction: 'wei', isAI: true }
      ],
      heroes: [
        {
          id: 'hero_shu_0', playerId: 0, name: '刘备', level: 4, exp: 0, pendingLevels: 0,
          movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10,
          pos: { x: 3, y: 13 }, skills: { leadership: 3, archery: 3 }, spells: [], army: []
        },
        {
          id: 'hero_wei_0', playerId: 1, name: '曹操', level: 1, exp: 0, pendingLevels: 0,
          movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10,
          pos: { x: 26, y: 4 }, skills: {}, spells: [], army: []
        }
      ],
      towns: [], battle: null
    };

    const b = bl.initBattle(state,
      [{ unitId: 'shu_militia', count: 40 }, { unitId: 'shu_archer', count: 20 }],
      [{ unitId: 'wei_qingzhou', count: 40 }],
      { attackerHeroId: 'hero_shu_0', defenderHeroId: 'hero_wei_0', data });

    const melee = b.stacks.find((s) => s.unitId === 'shu_militia');
    const ranged = b.stacks.find((s) => s.unitId === 'shu_archer');
    const enemy = b.stacks.find((s) => s.side === 'defender');

    // 伤害对比：同样条件下，有/无百分比加成
    const rng = () => 0;
    const dmgWith = bl.computeDamage(ranged, enemy, { rng });

    // 去掉加成后再算一次
    const savedPct = ranged.damagePct;
    ranged.damagePct = 0;
    const dmgWithout = bl.computeDamage(ranged, enemy, { rng });
    ranged.damagePct = savedPct;

    return {
      meleeAttack: melee.attack,          // 乡勇基础 2 + 统帅 3 = 5
      meleeDamagePct: melee.damagePct,    // 近战 → 武勇加成（未学 → 0）
      rangedAttack: ranged.attack,        // 弓手基础 3 + 统帅 3 = 6
      rangedDamagePct: ranged.damagePct,  // 远程 → 弓术 3 级 × 10% = 30
      enemyAttack: enemy.attack,          // 守方无技能 → 基础 2
      dmgWith, dmgWithout
    };
  });

  // ── 2. resolveBattle：电脑方升级后自动加点 ──
  out.aiAutoSkill = await page.evaluate(async () => {
    const bl = await import('/src/logic/battleLogic.js');
    const res = await fetch('/src/data/units.json');
    const units = await res.json();
    const data = { units };

    const state = {
      meta: { day: 1, week: 1, currentPlayer: 0 },
      players: [
        { id: 0, faction: 'shu', isAI: false },
        { id: 1, faction: 'wei', isAI: true }
      ],
      heroes: [
        {
          id: 'hero_shu_0', playerId: 0, name: '刘备', level: 1, exp: 0, pendingLevels: 0,
          movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10,
          pos: { x: 3, y: 13 }, skills: {}, spells: [], army: [{ unitId: 'shu_wuhu', count: 30 }]
        },
        {
          id: 'hero_wei_0', playerId: 1, name: '曹操', level: 1, exp: 0, pendingLevels: 0,
          movePoints: 20, maxMovePoints: 20, mana: 10, maxMana: 10,
          pos: { x: 26, y: 4 }, skills: {}, spells: [], army: [{ unitId: 'wei_huwei', count: 30 }]
        }
      ],
      towns: [], battle: null
    };

    const b = bl.initBattle(state,
      [{ unitId: 'shu_wuhu', count: 30 }],
      [{ unitId: 'wei_huwei', count: 30 }],
      { attackerHeroId: 'hero_shu_0', defenderHeroId: 'hero_wei_0', data });

    // 强行判定守方获胜
    b.stacks.filter((s) => s.side === 'attacker').forEach((s) => { s.count = 0; });
    bl.checkBattleEnd(b);

    const r = bl.resolveBattle(state, data);
    const weiHero = state.heroes.find((h) => h.id === 'hero_wei_0');
    return {
      winner: r.winner,
      exp: r.exp,
      levelUps: r.levelUps,
      autoSkillHeroId: r.autoSkillHeroId,
      autoSkills: r.autoSkills,
      weiPending: weiHero?.pendingLevels ?? 'removed',
      weiSkills: weiHero?.skills ?? null,
      weiLevel: weiHero?.level ?? null
    };
  });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

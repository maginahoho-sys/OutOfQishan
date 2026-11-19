/**
 * M8 完整闭环验证 —— 打赢一场真实战斗 → 升级 → 加点 → 加成生效
 *
 * 走完整链路：
 *   战斗（玩家方取胜）→ resolveBattle 发经验 → 玩家方升级
 *   → 结算面板出现「技能加点」按钮 → 点击 → 面板打开 → 选技能
 *   → 英雄技能等级 +1、pendingLevels 归零 → 点确定回地图
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

  // ── 1. 布一场玩家方必胜的战斗（玩家 200 弓手 vs 电脑 10 乡勇）──
  out.start = await page.evaluate(async () => {
    const g = window.__game;
    const st = g.registry.get('state');
    const me = st.heroes.find((h) => h.playerId === 0);
    const foe = st.heroes.find((h) => h.playerId === 1);

    // 调整双方实力，保证玩家方获胜且经验足够升级（败军价值/10 ≥ 100）
    me.army = [{ unitId: 'shu_archer', count: 200 }];
    foe.army = [{ unitId: 'wei_qingzhou', count: 25 }];
    me.skills = {};
    me.level = 1;
    me.exp = 0;
    me.pendingLevels = 0;

    g.scene.getScene('MapScene').scene.start('BattleScene', { attackerId: me.id, defenderId: foe.id });
    await new Promise((r) => setTimeout(r, 700));
    const bs = g.scene.getScene('BattleScene');
    return {
      scene: g.scene.getScenes(true).map((s) => s.scene.key),
      stacks: bs.battle?.stacks.length ?? 0,
      atkCount: bs.battle?.stacks.find((s) => s.side === 'attacker')?.count,
      defCount: bs.battle?.stacks.find((s) => s.side === 'defender')?.count
    };
  });

  // ── 2. 让战斗打完（玩家方是攻方，AI 只驱动守方；玩家方需要手动出手）──
  out.fight = await page.evaluate(async () => {
    const g = window.__game;
    const bs = g.scene.getScene('BattleScene');
    const bl = await import('/src/logic/battleLogic.js');
    // 持续驱动玩家方单位出手（模拟点击攻击），直到分出胜负
    let guard = 0;
    while (bs.battle && !bs.battle.winner && guard++ < 300) {
      await new Promise((r) => setTimeout(r, 30));
      const cur = bl.currentStack(bs.battle);
      if (!cur) break;
      if (cur.side === 'attacker') {
        const targets = bl.attackableTargets(bs.battle, cur.id);
        if (targets.length > 0) {
          const res = bl.attackStack(bs.battle, g.registry.get('data'), cur.id, targets[0]);
          if (res.ok) bl.nextTurn(bs.battle, { action: 'attack' });
        } else {
          bl.nextTurn(bs.battle, { action: 'wait' });
        }
        bs.refresh();
      }
    }
    return {
      winner: bs.battle?.winner,
      rounds: bs.battle?.round,
      result: bs.result ? {
        winner: bs.result.winner,
        exp: bs.result.exp,
        levelUps: bs.result.levelUps,
        expHeroId: bs.result.expHeroId
      } : null
    };
  });
  await wait(900);

  // ── 3. 结算面板是否显示技能加点按钮 ──
  out.panel = await page.evaluate(() => {
    const bs = window.__game.scene.getScene('BattleScene');
    const texts = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text) texts.push(o.text);
        if (o.list) walk(o.list);
      }
    };
    walk(bs.children.list);
    return {
      hasResultTitle: texts.some((t) => t.includes('战果结算')),
      hasSkillBtn: texts.some((t) => t.includes('技能加点')),
      skillBtnText: texts.find((t) => t.includes('技能加点')) || null,
      expLine: texts.find((t) => t.includes('获得经验')) || null
    };
  });

  await page.screenshot({ path: 'scripts/shot-skill-result.png' });

  // ── 4. 点技能加点 → 面板打开 → 选一张卡 ──
  out.pick = await page.evaluate(async () => {
    const g = window.__game;
    const bs = g.scene.getScene('BattleScene');
    const st = g.registry.get('state');
    const hero = st.heroes.find((h) => h.id === bs.result?.expHeroId) || st.heroes.find((h) => h.playerId === 0);

    const before = { pending: hero.pendingLevels, skills: { ...hero.skills }, level: hero.level };

    // 触发技能加点按钮
    let btn = null;
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text && o.text.includes('技能加点') && o.input?.enabled) btn = o;
        if (o.list) walk(o.list);
      }
    };
    walk(bs.children.list);
    if (!btn) return { ok: false, reason: 'noBtn' };
    btn.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 500));

    // 找技能卡并点最左一张
    const cards = [];
    const walk2 = (list) => {
      for (const o of list) {
        if (o.type === 'Rectangle' && o.input?.enabled) {
          const w = o.width, h = o.height;
          if (w > 200 && w < 300 && h > 150 && h < 250) cards.push(o);
        }
        if (o.list) walk2(o.list);
      }
    };
    walk2(bs.children.list);
    cards.sort((a, b) => a.x - b.x);
    if (cards.length === 0) return { ok: false, reason: 'noCard', before };
    cards[0].emit('pointerdown');
    await new Promise((r) => setTimeout(r, 400));

    return {
      ok: true,
      before,
      after: { pending: hero.pendingLevels, skills: { ...hero.skills }, level: hero.level },
      cardCount: cards.length
    };
  });

  // ── 5. 点确定回地图 ──
  out.finish = await page.evaluate(async () => {
    const g = window.__game;
    const bs = g.scene.getScene('BattleScene');
    const st = g.registry.get('state');
    const hero = st.heroes.find((h) => h.playerId === 0);

    // 若还有剩余点数，先把面板关掉（选完）
    let guard = 0;
    while (hero.pendingLevels > 0 && guard++ < 6) {
      const cards = [];
      const walk = (list) => {
        for (const o of list) {
          if (o.type === 'Rectangle' && o.input?.enabled) {
            const w = o.width, h = o.height;
            if (w > 200 && w < 300 && h > 150 && h < 250) cards.push(o);
          }
          if (o.list) walk(o.list);
        }
      };
      walk(bs.children.list);
      if (cards.length === 0) break;
      cards.sort((a, b) => a.x - b.x);
      cards[0].emit('pointerdown');
      await new Promise((r) => setTimeout(r, 250));
    }

    // 点确定
    let ok = null;
    const walk2 = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text === '[确定]' && o.input?.enabled) ok = o;
        if (o.list) walk2(o.list);
      }
    };
    walk2(bs.children.list);
    if (ok) ok.emit('pointerdown');
    await new Promise((r) => setTimeout(r, 800));

    return {
      scene: g.scene.getScenes(true).map((s) => s.scene.key),
      finalPending: hero.pendingLevels,
      finalSkills: { ...hero.skills },
      finalLevel: hero.level
    };
  });

  await page.screenshot({ path: 'scripts/shot-skill-final.png' });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

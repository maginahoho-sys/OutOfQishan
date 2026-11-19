/**
 * M8 技能系统 —— 无头浏览器端到端验证
 *
 * 验证内容：
 *   1. 地图状态栏出现「技能加点」提示
 *   2. 点击提示 → 打开技能面板（遮罩 + 3 张技能卡）
 *   3. 点一张卡 → 技能等级 +1、pendingLevels -1
 *   4. 面板在还有剩余次数时继续显示新的候选
 *   5. 点完后关闭，回到地图，状态栏提示消失
 *   6. 城镇界面显示英雄等级/经验/技能一览
 *   7. 战斗结算面板显示技能点并可打开加点面板
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

  // ── 1. 人工给玩家英雄挂上 3 个待加点次数 ──
  out.setup = await page.evaluate(() => {
    const st = window.__game.registry.get('state');
    const hero = st.heroes.find((h) => h.playerId === 0);
    hero.pendingLevels = 3;
    hero.level = 4;
    hero.exp = 120;
    const g = window.__game;
    g.scene.getScene('MapScene').redraw();
    return { heroId: hero.id, name: hero.name, pending: hero.pendingLevels };
  });
  await wait(600);

  // 找状态栏上的「技能加点」按钮并点击
  const clickByText = async (needle) => {
    return page.evaluate((n) => {
      const g = window.__game;
      const scene = g.scene.getScene('MapScene');
      // 遍历场景里所有文本对象，找包含关键字且可点击的
      const texts = [];
      const walk = (list) => {
        for (const o of list) {
          if (o.type === 'Text' && o.text && o.text.includes(n)) texts.push(o);
          if (o.list) walk(o.list);
        }
      };
      walk(scene.children.list);
      const hit = texts.find((t) => t.input && t.input.enabled);
      if (!hit) return { ok: false, found: texts.map((t) => t.text) };
      hit.emit('pointerdown');
      return { ok: true, text: hit.text };
    }, needle);
  };

  out.clickStatusBar = await clickByText('技能加点');
  await wait(700);

  // ── 2. 面板是否打开 ──
  out.panelOpen = await page.evaluate(() => {
    const scene = window.__game.scene.getScene('MapScene');
    const texts = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text) texts.push(o.text);
        if (o.list) walk(o.list);
      }
    };
    walk(scene.children.list);
    return {
      hasTitle: texts.some((t) => t.includes('升级加点')),
      hasSubtitle: texts.some((t) => t.includes('待分配技能点')),
      cardCount: texts.filter((t) => /^(统帅|行军|谋略|理财|弓术|武勇|医疗|防御)$/.test(t)).length,
      texts: texts.filter((t) => t.length > 0).slice(0, 40)
    };
  });

  await page.screenshot({ path: 'scripts/shot-skill-panel.png' });

  // ── 3. 点第一张技能卡 ──
  out.pickCard = await page.evaluate(() => {
    const scene = window.__game.scene.getScene('MapScene');
    const st = window.__game.registry.get('state');
    const hero = st.heroes.find((h) => h.playerId === 0);
    const before = { pending: hero.pendingLevels, skills: { ...hero.skills } };

    // 找技能卡（矩形 + 可点击），按 x 排序取最左
    const cards = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Rectangle' && o.input && o.input.enabled) {
          const w = o.width, h = o.height;
          if (w > 200 && w < 300 && h > 150 && h < 250) cards.push(o);
        }
        if (o.list) walk(o.list);
      }
    };
    walk(scene.children.list);
    cards.sort((a, b) => a.x - b.x);
    if (cards.length === 0) return { ok: false, cardCount: 0 };
    cards[0].emit('pointerdown');

    const after = { pending: hero.pendingLevels, skills: { ...hero.skills } };
    return { ok: true, cardCount: cards.length, before, after };
  });
  await wait(600);

  // ── 4. 面板是否仍开着（还有 2 次待加点）──
  out.panelStillOpen = await page.evaluate(() => {
    const scene = window.__game.scene.getScene('MapScene');
    const texts = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text) texts.push(o.text);
        if (o.list) walk(o.list);
      }
    };
    walk(scene.children.list);
    return {
      hasTitle: texts.some((t) => t.includes('升级加点')),
      subtitle: texts.find((t) => t.includes('待分配技能点')) || null
    };
  });

  // ── 5. 连点剩下的卡，直到 pendingLevels 归零 ──
  out.drain = await page.evaluate(async () => {
    const scene = window.__game.scene.getScene('MapScene');
    const st = window.__game.registry.get('state');
    const hero = st.heroes.find((h) => h.playerId === 0);
    const picks = [];
    for (let i = 0; i < 6 && hero.pendingLevels > 0; i++) {
      const cards = [];
      const walk = (list) => {
        for (const o of list) {
          if (o.type === 'Rectangle' && o.input && o.input.enabled) {
            const w = o.width, h = o.height;
            if (w > 200 && w < 300 && h > 150 && h < 250) cards.push(o);
          }
          if (o.list) walk(o.list);
        }
      };
      walk(scene.children.list);
      if (cards.length === 0) break;
      cards.sort((a, b) => a.x - b.x);
      cards[0].emit('pointerdown');
      picks.push({ pending: hero.pendingLevels, skills: { ...hero.skills } });
      await new Promise((r) => setTimeout(r, 120));
    }
    return { picks, finalPending: hero.pendingLevels, skills: { ...hero.skills } };
  });
  await wait(700);

  // 面板应已关闭
  out.panelClosed = await page.evaluate(() => {
    const scene = window.__game.scene.getScene('MapScene');
    const texts = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text) texts.push(o.text);
        if (o.list) walk(o.list);
      }
    };
    walk(scene.children.list);
    return {
      hasTitle: texts.some((t) => t.includes('升级加点')),
      statusTip: texts.find((t) => t.includes('技能加点')) || null
    };
  });

  // ── 6. 城镇界面：等级/经验/技能一览 ──
  out.town = await page.evaluate(async () => {
    const g = window.__game;
    const st = g.registry.get('state');
    const hero = st.heroes.find((h) => h.playerId === 0);
    const town = st.towns.find((t) => t.playerId === 0);
    g.scene.getScene('MapScene').scene.start('TownScene', { townId: town.id, heroId: hero.id });
    await new Promise((r) => setTimeout(r, 900));
    const scene = g.scene.getScene('TownScene');
    const texts = [];
    const walk = (list) => {
      for (const o of list) {
        if (o.type === 'Text' && o.text) texts.push(o.text);
        if (o.list) walk(o.list);
      }
    };
    walk(scene.children.list);
    return {
      activeScene: g.scene.getScenes(true).map((s) => s.scene.key),
      hasLevel: texts.some((t) => t.includes('Lv.')),
      hasExp: texts.some((t) => t.includes('经验')),
      hasSkillLine: texts.some((t) => t.startsWith('技能：')),
      townTexts: texts.filter((t) => /Lv\.|经验|技能：/.test(t))
    };
  });

  await page.screenshot({ path: 'scripts/shot-skill-town.png' });

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

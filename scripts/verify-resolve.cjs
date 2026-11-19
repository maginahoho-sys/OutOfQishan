/**
 * 无头浏览器验证：M6c 战果结算
 *
 * 流程：构造一场「英雄 vs 英雄」战斗 → 让战斗结束 → 结算面板出现
 *      → 点「确定」回到地图 → 校验 state：败方英雄被移除、经验到账、state.battle 清空
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = fs.readdirSync(path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141'))
  .map((d) => path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141', d,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((p) => fs.existsSync(p));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new', args: ['--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
  await wait(1500);

  // 造一场可控战斗：攻方 1 个乡勇（少），守方 1 个青州兵（多），让攻方必输
  await page.evaluate(() => {
    const game = window.__game;
    const state = game.registry.get('state');
    state.heroes = [
      {
        id: 'hero_shu_0', name: '刘备', playerId: 0, level: 1, exp: 0, pendingLevels: 0,
        pos: { x: 3, y: 3 }, skills: {}, spells: [],
        army: [{ unitId: 'shu_militia', count: 5 }],
      },
      {
        id: 'hero_wei_0', name: '曹操', playerId: 1, level: 1, exp: 0, pendingLevels: 0,
        pos: { x: 9, y: 3 }, skills: {}, spells: [],
        army: [{ unitId: 'wei_qingzhou', count: 60 }],
      },
    ];
    game.scene.start('BattleScene', { attackerId: 'hero_shu_0', defenderId: 'hero_wei_0' });
  });
  await wait(1200);

  const before = await page.evaluate(() => {
    const g = window.__game;
    const s = g.scene.getScene('BattleScene');
    return {
      stacks: s.battle.stacks.map((x) => ({ name: x.unitName, side: x.side, count: x.count })),
      heroes: g.registry.get('state').heroes.map((h) => ({ id: h.id, name: h.name, level: h.level, exp: h.exp, army: h.army })),
    };
  });

  // 让战斗打完：玩家方由脚本代打，电脑方由场景自己的 AI 驱动
  await page.evaluate(async () => {
    const g = window.__game;
    const s = g.scene.getScene('BattleScene');
    const bl = await import('/src/logic/battleLogic.js');
    const ai = await import('/src/logic/battleAI.js');
    const data = g.registry.get('data');

    for (let i = 0; i < 200; i++) {
      if (!s.battle || s.battle.winner) break;
      const cur = bl.currentStack(s.battle);
      if (!cur) break;
      if (cur.side === 'attacker') {
        const r = ai.takeTurn(s.battle, data, cur.id);
        bl.nextTurn(s.battle, { action: r.action });
      } else {
        await new Promise((res) => setTimeout(res, 120)); // 等电脑 AI
      }
    }
  });
  await wait(1500);

  // 结算面板是否出现
  const panel = await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    const texts = s.hudLayer.list.map((o) => o.text).filter(Boolean);
    return {
      result: s.result ? {
        winner: s.result.winner,
        exp: s.result.exp,
        levelUps: s.result.levelUps,
        removedHeroes: s.result.removedHeroes,
        hiredHeroes: s.result.hiredHeroes,
      } : null,
      panelTexts: texts,
      stateBattle: window.__game.registry.get('state').battle,
    };
  });

  await page.screenshot({ path: 'scripts/shot-resolve.png' });

  // 点「确定」回地图
  const clicked = await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    const btn = s.hudLayer.list.find((o) => o.text === '[确定]');
    if (!btn) return false;
    btn.emit('pointerdown');
    return true;
  });
  await wait(1200);

  const after = await page.evaluate(() => {
    const g = window.__game;
    const st = g.registry.get('state');
    return {
      activeScene: g.scene.getScenes(true).map((x) => x.scene.key),
      heroes: st.heroes.map((h) => ({
        id: h.id, name: h.name, playerId: h.playerId, level: h.level, exp: h.exp,
        pendingLevels: h.pendingLevels, army: h.army, pos: h.pos,
      })),
      battle: st.battle,
    };
  });

  console.log(JSON.stringify({ before, panel, clicked, after, errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
/**
 * 无头浏览器验证：M6c 攻城战结算
 *
 * 流程：进攻敌方城镇 → 战斗结束 → 结算 → 校验城镇易主（playerId / faction 改判）
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

  // 造一场攻城战：蜀汉 60 汉中精骑 攻 许昌（驻军 10 青州兵）
  await page.evaluate(() => {
    const game = window.__game;
    const state = game.registry.get('state');
    state.heroes = [
      {
        id: 'hero_shu_0', name: '刘备', playerId: 0, level: 1, exp: 0, pendingLevels: 0,
        pos: { x: 26, y: 3 }, skills: {}, spells: [],
        army: [{ unitId: 'shu_hanzhong', count: 60 }],
      },
    ];
    state.towns = [
      {
        id: 'town_wei_0', playerId: 1, faction: 'wei', name: '许昌',
        pos: { x: 26, y: 3 }, buildings: ['hall'], recruitPool: [], builtToday: 0,
        garrison: [{ unitId: 'wei_qingzhou', count: 10 }],
      },
    ];
    game.scene.start('BattleScene', { attackerId: 'hero_shu_0', townId: 'town_wei_0' });
  });
  await wait(1200);

  // 驱动战斗直到分出胜负（双方都由脚本代打）
  await page.evaluate(async () => {
    const g = window.__game;
    const s = g.scene.getScene('BattleScene');
    const bl = await import('/src/logic/battleLogic.js');
    const ai = await import('/src/logic/battleAI.js');
    const data = g.registry.get('data');

    for (let i = 0; i < 300; i++) {
      if (!s.battle || s.battle.winner) break;
      const cur = bl.currentStack(s.battle);
      if (!cur) break;
      const r = ai.takeTurn(s.battle, data, cur.id);
      bl.nextTurn(s.battle, { action: r.action });
      await new Promise((res) => setTimeout(res, 30));
    }
  });
  await wait(1200);

  const result = await page.evaluate(() => {
    const g = window.__game;
    const s = g.scene.getScene('BattleScene');
    const st = g.registry.get('state');
    return {
      result: s.result ? {
        winner: s.result.winner,
        exp: s.result.exp,
        capturedTownId: s.result.capturedTownId,
        attackerArmy: s.result.attackerArmy,
        defenderArmy: s.result.defenderArmy,
      } : null,
      towns: st.towns.map((t) => ({ id: t.id, playerId: t.playerId, faction: t.faction, garrison: t.garrison })),
      heroes: st.heroes.map((h) => ({ id: h.id, name: h.name, level: h.level, exp: h.exp, army: h.army })),
      battle: st.battle,
    };
  });

  await page.screenshot({ path: 'scripts/shot-siege.png' });
  console.log(JSON.stringify({ result, errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

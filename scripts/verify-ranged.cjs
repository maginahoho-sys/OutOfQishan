/**
 * 无头浏览器验证：远程规则（射程内满伤 / 超射程减半 / 被近身仍可射击全场）
 * 用法：NODE_PATH=~/.workbuddy/binaries/node/workspace/node_modules node scripts/verify-ranged.cjs
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = fs.readdirSync(path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141'))
  .map((d) => path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141', d,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((p) => fs.existsSync(p));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--window-size=1400,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });

  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto('http://localhost:5178/', { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 1500));

  // 在页面里直接调用逻辑层做规则断言
  const result = await page.evaluate(async () => {
    const bl = await import('/src/logic/battleLogic.js');
    const data = {};
    for (const f of ['units', 'spells', 'skills', 'buildings', 'factions']) {
      const res = await fetch(`/src/data/${f}.json`);
      data[f] = await res.json();
    }
    const state = {
      meta: { day: 1, week: 1, currentPlayer: 0 },
      players: [{ id: 0, faction: 'shu', isAI: false }, { id: 1, faction: 'wei', isAI: true }],
      heroes: [], towns: [], battle: null,
    };
    const out = {};

    // 1) 射程内满伤 vs 超射程减半
    const b1 = bl.initBattle(state, [{ unitId: 'shu_archer', count: 20 }], [{ unitId: 'wei_qingzhou', count: 40 }], { data });
    const a1 = b1.stacks[0], d1 = b1.stacks[1];
    a1.pos = { x: 0, y: 0 }; d1.pos = { x: 10, y: 0 };
    const far = bl.attackStack(b1, data, a1.id, d1.id, { rng: () => 0 });
    out.far = { damage: far.damage, outOfRange: far.outOfRange };

    const b2 = bl.initBattle(state, [{ unitId: 'shu_archer', count: 20 }], [{ unitId: 'wei_qingzhou', count: 40 }], { data });
    const a2 = b2.stacks[0], d2 = b2.stacks[1];
    a2.pos = { x: 0, y: 0 }; d2.pos = { x: 5, y: 0 };
    const near = bl.attackStack(b2, data, a2.id, d2.id, { rng: () => 0 });
    out.near = { damage: near.damage, outOfRange: near.outOfRange };

    // 2) 被近身的远程仍能选全场目标
    const b3 = bl.initBattle(state, [{ unitId: 'shu_archer', count: 20 }], [{ unitId: 'wei_qingzhou', count: 40 }], { data });
    const a3 = b3.stacks[0], d3 = b3.stacks[1];
    a3.pos = { x: 4, y: 0 }; d3.pos = { x: 5, y: 0 }; // 贴脸
    out.engaged = bl.isEngaged(b3, a3);
    out.targetsWhenEngaged = bl.attackableTargets(b3, a3.id).length;
    const engagedShot = bl.attackStack(b3, data, a3.id, d3.id, { rng: () => 0 });
    out.engagedShot = { ok: engagedShot.ok, damage: engagedShot.damage, outOfRange: engagedShot.outOfRange };

    // 3) 远程被近身时反击减半
    const b4 = bl.initBattle(state, [{ unitId: 'shu_militia', count: 20 }], [{ unitId: 'wei_archer', count: 20 }], { data });
    const a4 = b4.stacks[0], d4 = b4.stacks[1];
    a4.pos = { x: 4, y: 0 }; d4.pos = { x: 5, y: 0 };
    const rt = bl.attackStack(b4, data, a4.id, d4.id, { rng: () => 0 });
    out.engagedRetaliate = rt.retaliate ? rt.retaliate.damage : null;

    // 4) 各兵种射程表
    out.ranges = data.units.filter((u) => u.abilities.includes('ranged'))
      .map((u) => `${u.name}:${u.range}`);

    // 5) 整场对战：电脑 AI 自动打完
    const b5 = bl.initBattle(state,
      [{ unitId: 'shu_militia', count: 30 }, { unitId: 'shu_archer', count: 15 }],
      [{ unitId: 'wei_qingzhou', count: 30 }, { unitId: 'wei_archer', count: 15 }],
      { data });
    const ai = await import('/src/logic/battleAI.js');
    let guard = 0;
    while (!b5.winner && guard++ < 600) {
      const cur = bl.currentStack(b5);
      if (!cur) break;
      ai.takeTurn(b5, data, cur.id);
      bl.nextTurn(b5, { action: 'attack' });
    }
    out.autoBattle = { winner: b5.winner, rounds: b5.round, steps: guard };
    out.logSample = b5.log.slice(-6).map((l) => l.text);

    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\n控制台错误：', errors.length ? errors : '无');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

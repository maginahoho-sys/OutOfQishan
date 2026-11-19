/**
 * 无头浏览器验证：实际游戏界面上的战斗场景
 * 走一遍「选中我方单位 → 看高亮 → 点击攻击」流程，确认新规则在 UI 里生效。
 */
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CHROME = fs.readdirSync(path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141'))
  .map((d) => path.join(os.homedir(), '.cache/puppeteer/chrome/mac_arm-133.0.6943.141', d,
    'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'))
  .find((p) => fs.existsSync(p));

const CELL = 64, GRID_X = 288, GRID_Y = 60;

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
  await new Promise((r) => setTimeout(r, 1500));

  // 直接切到 BattleScene，构造一场可控的战斗
  const setup = await page.evaluate(async () => {
    const scene = window.__game?.scene?.getScene('BattleScene');
    const game = window.__game;
    if (!game) return { error: 'no game handle' };
    const state = game.registry.get('state');
    const data = game.registry.get('data');
    // 构造两个英雄，各自带兵
    state.heroes = [
      { id: 'hero_shu_0', name: '刘备', playerId: 0, pos: { x: 3, y: 3 }, army: [
        { unitId: 'shu_archer', count: 20 }, { unitId: 'shu_militia', count: 30 } ] },
      { id: 'hero_wei_0', name: '曹操', playerId: 1, pos: { x: 9, y: 3 }, army: [
        { unitId: 'wei_qingzhou', count: 30 }, { unitId: 'wei_archer', count: 15 } ] },
    ];
    game.scene.start('BattleScene', { attackerId: 'hero_shu_0', defenderId: 'hero_wei_0' });
    return { ok: true };
  });
  await new Promise((r) => setTimeout(r, 1200));

  // 读取战场状态
  const before = await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    return s.battle.stacks.map((x) => ({
      id: x.id, name: x.unitName, side: x.side, pos: x.pos, range: x.range,
      ranged: x.abilities.includes('ranged'), count: x.count, acted: x.acted,
    }));
  });

  // 点击当前行动单位（第一个 stack），看高亮
  const cur = before.find((b) => b.side === 'attacker');
  // canvas 用了 Scale.FIT，CSS 像素与游戏逻辑坐标有缩放/偏移，需要换算
  const view = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const r = canvas.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  });
  const scale = view.w / 1280;
  const clickCell = async (cx, cy) => {
    const gx = GRID_X + cx * CELL + CELL / 2;
    const gy = GRID_Y + cy * CELL + CELL / 2;
    await page.mouse.click(view.left + gx * scale, view.top + gy * scale);
    await new Promise((r) => setTimeout(r, 350));
  };

  await clickCell(cur.pos.x, cur.pos.y);
  const sel = await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    return {
      selectedId: s.selectedId,
      moveCells: s.moveCells.length,
      targetIds: s.targetIds,
      hint: s.hudLayer.list.map((o) => o.text).filter(Boolean).join(' | '),
    };
  });

  // 点一个敌人攻击
  const enemy = before.find((b) => b.side === 'defender');
  await clickCell(enemy.pos.x, enemy.pos.y);
  const after = await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    return {
      log: s.battle.log.slice(-4).map((l) => l.text),
      stacks: s.battle.stacks.map((x) => ({ name: x.unitName, side: x.side, count: x.count })),
    };
  });

  await page.screenshot({ path: 'scripts/shot-battle.png' });
  console.log(JSON.stringify({ before, sel, after, errors }, null, 2));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

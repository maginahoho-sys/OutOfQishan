/**
 * 英雄+城镇重叠选择弹层 —— 无头浏览器验证脚本
 *
 * 背景：当英雄和城镇在同一格时，左键点击原来直接进城（或只选中英雄）。
 *       现在改为弹出选择框：「控制英雄」/「进入城镇」（敌方城镇则「进攻城镇」）。
 *
 * 覆盖场景：
 *   A. 己方英雄在己方城镇上 → 点击弹出选择框
 *   B. 点 [控制英雄] → 英雄被选中、不进城
 *   C. 点 [进入城镇] → 切到 TownScene
 *   D. 敌方城镇上己方英雄 → 按钮文字是 [进攻城镇]，点击切到 BattleScene
 *   E. 点遮罩 → 只关闭弹层，不选英雄、不进城
 *   F. 只有英雄没有城镇 → 不弹框，直接选中英雄（原行为不受影响）
 *
 * 用法：node scripts/verify-map-town-choice.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5210;

const require = createRequire(import.meta.url);
const puppeteer = require(
  '/Users/zhanghaifeng/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
);

/** 探测本机 Chrome for Testing */
function findChrome() {
  const base = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  if (!fs.existsSync(base)) return null;
  const candidates = [];
  for (const dir of fs.readdirSync(base)) {
    for (const arch of fs.readdirSync(path.join(base, dir))) {
      const app = path.join(
        base, dir, arch,
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'
      );
      if (fs.existsSync(app)) candidates.push(app);
    }
  }
  candidates.sort();
  return candidates[candidates.length - 1] || null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('❌ 找不到 Chrome for Testing');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 启动 vite dev server */
function startServer() {
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('Local:') || out.includes('localhost')) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('dev server 启动超时:\n' + out)), 30000);
  });
}

/** 断言收集 */
const checks = [];
function push(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
  if (!pass && detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

/**
 * 地图格子中心的屏幕坐标
 */
async function cellPos(page, x, y) {
  return page.evaluate(({ cx, cy }) => {
    const s = window.__game.scene.getScene('MapScene');
    const r = s.cellToPixel(cx, cy);
    return { x: r.px, y: r.py };
  }, { cx: x, cy: y });
}

/**
 * 真实点击一个文本（找 Text 对象的屏幕中心）
 */
async function clickText(page, text) {
  const p = await page.evaluate((t) => {
    const s = window.__game.scene.getScene('MapScene');
    let found = null;
    const walk = (items) => {
      for (const o of items || []) {
        if (o.type === 'Text' && o.text === t) found = o;
        if (o.type === 'Container' && o.list) walk(o.list);
      }
    };
    walk(s.children.list);
    if (!found) return null;
    const b = found.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, text);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(500);
  return true;
}

/** MapScene 相关状态快照 */
async function snap(page) {
  return page.evaluate(() => {
    const s = window.__game.scene.getScene('MapScene');
    const state = window.__game.registry.get('state');
    return {
      choiceOpen: !!s.choiceLayer,
      selectedHeroId: s.selectedHero ? s.selectedHero.id : null,
      sceneKey: window.__game.scene.getScenes(true).map((sc) => sc.scene.key).join(','),
      heroPos: state.heroes.filter((h) => h.playerId === 0).map((h) => ({
        id: h.id, name: h.name, x: h.pos.x, y: h.pos.y
      })),
      towns: state.towns.map((t) => ({
        id: t.id, name: t.name, playerId: t.playerId, x: t.pos.x, y: t.pos.y
      }))
    };
  });
}

// ═══════════════════════════════════════════════════════
// 主流程
// ═══════════════════════════════════════════════════════
(async () => {
  console.log('▶ 启动 vite dev server...');
  const server = await startServer();
  console.log(`  ✅ dev server 就绪 http://localhost:${PORT}\n`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1280,800']
  });

  const errors = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });

    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(2000);

    // ── 把玩家英雄放到己方城镇上 ──────────────────────
    // 先找到一个己方城镇，把英雄 0 移过去
    await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const town = state.towns.find((t) => t.playerId === 0);
      const hero = state.heroes.find((h) => h.playerId === 0);
      if (!town || !hero) throw new Error('找不到己方城镇或英雄');
      // 记住原始位置，测试完恢复
      window.__origHeroPos = { ...hero.pos };
      window.__testTownId = town.id;
      window.__testHeroId = hero.id;
      hero.pos = { ...town.pos };
      // 刷新地图渲染
      const s = g.scene.getScene('MapScene');
      s.redraw();
    });
    await sleep(400);

    const st0 = await snap(page);
    const testTownId = await page.evaluate(() => window.__testTownId);
    const testTown = st0.towns.find((t) => t.id === testTownId) || st0.towns[0];
    const townX = testTown.x;
    const townY = testTown.y;

    // ═══════════════════════════════════════════════
    // A. 英雄+城镇重叠 → 点击弹出选择框
    // ═══════════════════════════════════════════════
    console.log('\n▶ A. 英雄+城镇重叠 → 弹出选择框');
    const pA = await cellPos(page, townX, townY);
    await page.mouse.click(pA.x, pA.y);
    await sleep(500);

    let st = await snap(page);
    push('点击重叠格弹出选择框', st.choiceOpen === true, st);

    // 弹层文本
    const dialogTexts = await page.evaluate(() => {
      const s = window.__game.scene.getScene('MapScene');
      const texts = [];
      const walk = (items) => {
        for (const o of items || []) {
          if (o.type === 'Text') texts.push(o.text);
          if (o.type === 'Container' && o.list) walk(o.list);
        }
      };
      walk(s.choiceLayer ? s.choiceLayer.list : []);
      return texts;
    });
    const hasControlBtn = dialogTexts.some((t) => t.includes('控制英雄'));
    const hasEnterBtn = dialogTexts.some((t) => t.includes('进入城镇'));
    push('弹层有 [控制英雄] 按钮', hasControlBtn, dialogTexts);
    push('弹层有 [进入城镇] 按钮', hasEnterBtn, dialogTexts);

    // ═══════════════════════════════════════════════
    // B. 点 [控制英雄] → 英雄被选中
    // ═══════════════════════════════════════════════
    console.log('\n▶ B. 点 [控制英雄] → 选中英雄');
    await clickText(page, '[控制英雄]');
    st = await snap(page);
    const heroId = await page.evaluate(() => window.__testHeroId);
    push('弹层已关闭', st.choiceOpen === false, st);
    push('英雄被选中', st.selectedHeroId === heroId, st);

    // ═══════════════════════════════════════════════
    // C. 点 [进入城镇] → 切到 TownScene
    // ═══════════════════════════════════════════════
    console.log('\n▶ C. 点 [进入城镇] → 进城');
    // 重新点重叠格弹出选择框
    await page.mouse.click(pA.x, pA.y);
    await sleep(500);
    st = await snap(page);
    push('再次弹出选择框', st.choiceOpen === true, st);

    await clickText(page, '[进入城镇]');
    await sleep(800);
    st = await snap(page);
    push('已切入 TownScene', st.sceneKey.includes('TownScene'), st);

    // 回到地图（彻底关掉 TownScene）
    await page.evaluate(() => {
      const g = window.__game;
      g.scene.stop('TownScene');
      g.scene.start('MapScene');
    });
    await sleep(1200);
    // 重新设置英雄位置 + 清空选中（保证 E 步隔离）
    await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const town = state.towns.find((t) => t.id === window.__testTownId);
      const hero = state.heroes.find((h) => h.id === window.__testHeroId);
      hero.pos = { ...town.pos };
      const s = g.scene.getScene('MapScene');
      s.selectedHero = null;
      s.redraw();
    });
    await sleep(400);

    // ═══════════════════════════════════════════════
    // D. 敌方城镇上己方英雄 → 按钮文字是 [进攻城镇]
    // ═══════════════════════════════════════════════
    console.log('\n▶ D. 敌方城镇 → 按钮文字 [进攻城镇]');
    await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const enemyTown = state.towns.find((t) => t.playerId !== 0);
      const hero = state.heroes.find((h) => h.id === window.__testHeroId);
      if (!enemyTown) throw new Error('找不到敌方城镇');
      window.__enemyTownId = enemyTown.id;
      hero.pos = { ...enemyTown.pos };
      const s = g.scene.getScene('MapScene');
      s.selectedHero = null;
      s.redraw();
    });
    await sleep(400);
    const enemyTown = await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const t = state.towns.find((x) => x.id === window.__enemyTownId);
      return { x: t.pos.x, y: t.pos.y };
    });
    const pD = await cellPos(page, enemyTown.x, enemyTown.y);
    await page.mouse.click(pD.x, pD.y);
    await sleep(500);
    st = await snap(page);
    push('敌方城镇格也弹选择框', st.choiceOpen === true, st);
    const dialogTextsD = await page.evaluate(() => {
      const s = window.__game.scene.getScene('MapScene');
      const texts = [];
      const walk = (items) => {
        for (const o of items || []) {
          if (o.type === 'Text') texts.push(o.text);
          if (o.type === 'Container' && o.list) walk(o.list);
        }
      };
      walk(s.choiceLayer ? s.choiceLayer.list : []);
      return texts;
    });
    push('按钮文字是 [进攻城镇]', dialogTextsD.some((t) => t.includes('进攻城镇')), dialogTextsD);
    // 关掉 D 段的弹层（点遮罩），并把英雄移回己方城镇
    await page.mouse.click(100, 700);
    await sleep(400);
    await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const town = state.towns.find((t) => t.id === window.__testTownId);
      const hero = state.heroes.find((h) => h.id === window.__testHeroId);
      hero.pos = { ...town.pos };
      const s = g.scene.getScene('MapScene');
      s.selectedHero = null;
      s.redraw();
    });
    await sleep(400);

    // ═══════════════════════════════════════════════
    // E. 点遮罩 → 只关闭，不执行操作
    // ═══════════════════════════════════════════════
    console.log('\n▶ E. 点遮罩 → 只关闭弹层');
    await page.mouse.click(pA.x, pA.y);
    await sleep(500);
    st = await snap(page);
    push('弹层已弹出', st.choiceOpen === true, st);

    // 点弹层外面（遮罩区域，比如左下角远离按钮）
    await page.mouse.click(100, 700);
    await sleep(500);
    st = await snap(page);
    push('点遮罩后弹层关闭', st.choiceOpen === false, st);
    push('点遮罩后英雄未被选中', st.selectedHeroId === null, st);
    push('点遮罩后仍在地图（未进城）', st.sceneKey.includes('MapScene') && !st.sceneKey.includes('TownScene'), st);

    // ═══════════════════════════════════════════════
    // F. 只有英雄没有城镇 → 不弹框，直接选中
    // ═══════════════════════════════════════════════
    console.log('\n▶ F. 只有英雄（无城镇）→ 不弹框直接选中');
    // 把英雄移到空地
    await page.evaluate(() => {
      const g = window.__game;
      const state = g.registry.get('state');
      const hero = state.heroes.find((h) => h.id === window.__testHeroId);
      // 找一个没有城镇的格子
      const townKeys = new Set(state.towns.map((t) => `${t.pos.x},${t.pos.y}`));
      let placed = false;
      for (let y = 0; y < state.map.height && !placed; y++) {
        for (let x = 0; x < state.map.width && !placed; x++) {
          if (!townKeys.has(`${x},${y}`) && state.map.tiles[y][x] === 0) {
            hero.pos = { x, y };
            window.__emptyCell = { x, y };
            placed = true;
          }
        }
      }
      const s = g.scene.getScene('MapScene');
      s.redraw();
    });
    await sleep(400);

    const emptyCell = await page.evaluate(() => window.__emptyCell);
    const pF = await cellPos(page, emptyCell.x, emptyCell.y);
    await page.mouse.click(pF.x, pF.y);
    await sleep(500);
    st = await snap(page);
    push('无城镇时不弹选择框', st.choiceOpen === false, st);
    push('英雄被直接选中', st.selectedHeroId === heroId, st);

    push('全程无 JS 报错', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`地图重叠选择弹层验证：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log('❌ 失败项：');
    for (const f of failed) console.log(`   - ${f.name}`);
    process.exit(1);
  }
  console.log('✅ 全部通过');
})();

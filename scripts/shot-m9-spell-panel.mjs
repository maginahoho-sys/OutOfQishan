/**
 * M9 施法面板截图脚本
 *
 * 在无头浏览器里造一场战斗 → 打开施法面板 → 截图。
 * 产出：
 *   scripts/shot-m9-spell-panel.png       （4 个魔法，1 行 3 列 + 1 张）
 *   scripts/shot-m9-spell-panel-6.png     （6 个魔法，2 行 3 列）
 *
 * 用法：node scripts/shot-m9-spell-panel.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5197;

const require = createRequire(import.meta.url);
const puppeteer = require(
  '/Users/zhanghaifeng/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
);

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

function startDevServer() {
  const proc = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: '' }
  });
  return new Promise((resolve, reject) => {
    let out = '';
    const onData = (d) => {
      out += d.toString();
      if (out.includes('ready in') || out.includes('Local:')) resolve(proc);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('dev server 启动超时:\n' + out)), 30000);
  });
}

/** 重建英雄并进入战斗 */
async function setup(page, spells, mana) {
  await page.evaluate((spellsList, manaValue) => {
    const g = window.__game;
    const state = g.registry.get('state');
    state.heroes = [
      {
        id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备', level: 3,
        exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
        mana: manaValue, maxMana: 30, pos: { x: 3, y: 13 }, skills: {},
        spells: spellsList,
        army: [{ unitId: 'shu_militia', count: 10 }, { unitId: 'shu_archer', count: 6 }]
      },
      {
        id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 2,
        exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
        mana: 18, maxMana: 24, pos: { x: 26, y: 4 }, skills: {},
        spells: ['slow', 'haste', 'zhimang', 'huoji'],
        army: [{ unitId: 'wei_qingzhou', count: 10 }]
      }
    ];
    state.players = [
      { id: 0, faction: 'shu', isAI: false },
      { id: 1, faction: 'wei', isAI: true }
    ];
    g.scene.stop('MapScene');
    g.scene.start('BattleScene', { attackerId: 'hero_shu_0', defenderId: 'hero_wei_0' });
  }, spells, mana);
  await sleep(1400);

  await page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    let btn = null;
    s.hudLayer.list.forEach((o) => {
      if (o.type === 'Text' && o.text.includes('[施法]')) btn = o;
    });
    if (btn) btn.emit('pointerdown');
  });
  await sleep(700);
}

async function main() {
  console.log('▶ 启动 vite dev server...');
  const server = await startDevServer();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(1500);

    // 1) 4 个魔法
    await setup(page, ['heal', 'bless', 'huti', 'tianyou'], 26);
    const out1 = path.join(__dirname, 'shot-m9-spell-panel.png');
    await page.screenshot({ path: out1 });
    console.log(`✅ 已截图：${out1}`);

    // 2) 6 个魔法（满级蜀汉英雄的全部魔法）
    await setup(page, ['heal', 'bless', 'huti', 'quxie', 'fuhuo', 'tianyou'], 26);
    const out2 = path.join(__dirname, 'shot-m9-spell-panel-6.png');
    await page.screenshot({ path: out2 });
    console.log(`✅ 已截图：${out2}`);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error('截图脚本异常：', e);
  process.exit(1);
});

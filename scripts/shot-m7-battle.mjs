/**
 * M7 战场渲染截图脚本
 *
 * 产出两张图：
 *   shot-m7-battle.png       战斗中（选中远程单位：射程预览 + 目标环 + 战报）
 *   shot-m7-battle-settle.png 结算面板
 *
 * 用法：node scripts/shot-m7-battle.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5198;

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

const HEROES = [
  {
    id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备', level: 1,
    exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
    mana: 20, maxMana: 20, pos: { x: 3, y: 13 }, skills: {},
    spells: ['heal', 'bless', 'huti', 'tianyou'],
    army: [{ unitId: 'shu_archer', count: 12 }, { unitId: 'shu_militia', count: 8 }]
  },
  {
    id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 1,
    exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
    mana: 20, maxMana: 20, pos: { x: 26, y: 4 }, skills: {},
    spells: ['slow', 'haste', 'zhimang', 'huoji'],
    army: [{ unitId: 'wei_qingzhou', count: 15 }, { unitId: 'wei_archer', count: 9 }]
  }
];

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

    // ── 场景 1：战斗中（选中远程单位）──
    await page.evaluate((heroes) => {
      const g = window.__game;
      const state = g.registry.get('state');
      state.heroes = JSON.parse(JSON.stringify(heroes));
      state.players = [
        { id: 0, faction: 'shu', isAI: false },
        { id: 1, faction: 'wei', isAI: true }
      ];
      g.scene.stop('MapScene');
      g.scene.start('BattleScene', {
        attackerId: 'hero_shu_0',
        defenderId: 'hero_wei_0'
      });
    }, HEROES);
    await sleep(1500);

    // 选中弓手 → 显示射程预览 + 可移动格 + 目标环
    await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');
      const cur = battle.currentStack(s.battle);
      s.selectedId = cur.id;
      s.moveCells = battle.movableCells(s.battle, cur.id);
      s.targetIds = battle.attackableTargets(s.battle, cur.id);
      s.refresh();
    });
    await sleep(500);
    await page.screenshot({ path: 'scripts/shot-m7-battle.png' });
    console.log('  ✅ scripts/shot-m7-battle.png');

    // ── 场景 2：施法面板 ──
    await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      s.openSpellPanel();
    });
    await sleep(600);
    await page.screenshot({ path: 'scripts/shot-m7-spell.png' });
    console.log('  ✅ scripts/shot-m7-spell.png');

    // ── 场景 3：结算面板 ──
    await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      if (s.spellPanel) s.spellPanel.close(true);
      const battle = await import('/src/logic/battleLogic.js');
      for (const st of s.battle.stacks) {
        if (st.side === 'defender' && st.count > 0) st.count = 0;
      }
      battle.checkBattleEnd(s.battle);
      s.refresh();
    });
    await sleep(1200);
    await page.screenshot({ path: 'scripts/shot-m7-settle.png' });
    console.log('  ✅ scripts/shot-m7-settle.png');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  console.log('✅ 截图完成');
}

main().catch((e) => {
  console.error('截图脚本异常：', e);
  process.exit(1);
});

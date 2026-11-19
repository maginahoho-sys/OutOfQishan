/**
 * M14 像素美术截图脚本
 *
 * 产出两张图：
 *   shot-m14-map.png     大地图（地形瓦片 + 城镇 + 英雄头像 + 资源）
 *   shot-m14-battle.png  战场（地表瓦片 + 像素兵牌 + 阵营底台）
 *
 * ⚠️ 战场不能直接 g.scene.start('BattleScene', {...})：那样只传了英雄 id，
 *    没往 state.heroes 里塞带 army 的完整英雄数据，battleLogic 建不出 stack，
 *    场上一块兵牌都没有。必须照 shot-m7-battle.mjs 的做法：
 *    先注入 registry 里的 state.heroes / state.players，再启动场景。
 *
 * 用法：node scripts/shot-m14-art.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5207;

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

/** 注入用的一组英雄（带 army，才能在战场上生成 stack） */
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
  console.log(`  ✅ dev server 就绪 http://localhost:${PORT}`);
  await sleep(1200);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error('  [page error]', e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [console]', m.text());
      if (m.type() === 'warning' && String(m.text()).includes('pixelArt')) {
        console.warn('  [warn]', m.text());
      }
    });

    // ── 地图 ──
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await sleep(2500);
    await page.screenshot({ path: path.join(ROOT, 'shot-m14-map.png') });
    console.log('  ✓ shot-m14-map.png');

    // 报告贴图加载情况
    const info = await page.evaluate(() => {
      const g = window.__game;
      const s = g.scene.getScene('MapScene');
      const keys = Object.keys(g.textures.list).filter((k) => k.startsWith('px_'));
      return {
        loaded: keys.length,
        missing: keys.filter((k) => !g.textures.get(k) || !g.textures.get(k).key),
        mapAlive: !!s && !!s.state
      };
    });
    console.log('  · 已加载像素贴图：', info.loaded, '张');
    if (info.missing.length) console.warn('  · 异常贴图：', info.missing.join(','));

    // ── 战场：注入英雄数据 → 启动战斗 → 选中远程单位 ──
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
    await sleep(1800);

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
    await sleep(600);
    await page.screenshot({ path: path.join(ROOT, 'shot-m14-battle.png') });
    console.log('  ✓ shot-m14-battle.png');

    // 报告战场兵牌情况
    const binfo = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const views = [...s.unitViews.values()];
      return {
        stacks: s.battle.stacks.length,
        views: views.length,
        withIcon: views.filter((v) => !!v.icon).length,
        withBase: views.filter((v) => !!v.base).length,
        withDisc: views.filter((v) => !!v.disc).length
      };
    });
    console.log('  · 战场 stack：', binfo.stacks, '兵牌视图：', binfo.views,
      '（有立绘', binfo.withIcon, '，有底台', binfo.withBase, '，回退圆盘', binfo.withDisc, '）');
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  console.log('✅ 截图完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

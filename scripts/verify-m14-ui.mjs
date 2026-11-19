/**
 * M14 像素美术的无头浏览器验证脚本
 *
 * 目的：验证「像素美术资源」这条链路在**真实运行时**成立，
 *      并且美术资源**没有破坏**原有玩法（地图/战场/UI 组件）。
 *
 * 契约验收（docs/契约/M14-像素美术.md）：
 *   ① 资源清单与磁盘文件一一对应（不缺失、不多余）
 *   ② 地图地形瓦片 / 城镇 / 资源 / 英雄头像全部用上了像素贴图
 *   ③ 战场兵牌是「阵营底座 + 兵种立绘」，敌我可辨
 *   ④ 像素资源缺失时能优雅回退到 Graphics 色块（不白屏、不报错）
 *   ⑤ 加载资源不产生 404 / 运行时异常
 *
 * 用法：node scripts/verify-m14-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5208;

const require = createRequire(import.meta.url);
const puppeteer = require(
  '/Users/zhanghaifeng/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
);

/** 探测本机 Chrome for Testing 可执行文件 */
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

/** 断言结果收集 */
const checks = [];

/**
 * 记一条断言
 * @param {string} name 断言名
 * @param {boolean} pass 是否通过
 * @param {any} [detail] 附加信息
 */
function push(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '✅' : '❌'}${detail === undefined ? '' : ' ' + name}`);
  if (!pass) console.log(`      详情：${JSON.stringify(detail)}`);
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

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const errors = [];
  const failedUrls = new Set();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => {
    if (/favicon/i.test(r.url())) return;
    if (r.status() >= 400) failedUrls.add(r.url());
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/Failed to load resource/i.test(t)) {
      if (!failedUrls.size) return;
      errors.push(t);
      return;
    }
    errors.push(t);
  });

  try {
    // ═══════════════════════════════════════════════
    // A. 静态检查：资源清单 ↔ 磁盘文件
    // ═══════════════════════════════════════════════
    console.log('\n▶ A. 资源清单与磁盘文件');

    const assets = await import(
      new URL('../src/core/pixelArt.assets.js', import.meta.url).href
    );
    const PIXEL_DIR = path.join(ROOT, 'public', 'assets', 'pixel');

    const listed = Object.values(assets.PIXEL_ASSETS).map((d) => d.file);
    const onDisk = fs.readdirSync(PIXEL_DIR).filter((f) => f.endsWith('.png'));

    const missing = listed.filter((f) => !onDisk.includes(f));
    const extra = onDisk.filter((f) => !listed.includes(f));

    push('清单里的资源文件全部存在（无缺失）', missing.length === 0, { missing });
    push('磁盘上没有多余资源（无冗余）', extra.length === 0, { extra });
    push(
      `资源清单规模合理（${listed.length} 张）`,
      listed.length >= 80,
      { count: listed.length }
    );

    // 地形：5 种地形 × 变体数
    const terrainCounts = Object.entries(assets.TERRAIN_VARIANTS).map(
      ([k, v]) => [k, v.length]
    );
    push(
      '地形编号与变体齐全（平原/森林/山地/水域 各 4 变体，道路 1）',
      JSON.stringify(terrainCounts) === JSON.stringify([['0', 4], ['1', 4], ['2', 4], ['3', 4], ['4', 1]]),
      { terrainCounts }
    );

    // ═══════════════════════════════════════════════
    // B. 运行时：贴图全部加载
    // ═══════════════════════════════════════════════
    console.log('\n▶ B. 运行时贴图加载');

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => {
        const s = window.__game?.scene?.getScene('MapScene');
        return s && s.scene.isActive();
      },
      { timeout: 15000 }
    );
    await sleep(800);

    const tex = await page.evaluate(() => {
      const g = window.__game;
      const keys = Object.keys(g.textures.list).filter((k) => k.startsWith('px_'));
      const bad = keys.filter((k) => {
        const t = g.textures.get(k);
        return !t || !t.key || !(t.source && t.source[0]);
      });
      return { count: keys.length, bad, sample: keys.slice(0, 5) };
    });
    push(`所有 px_ 贴图加载成功（${tex.count} 张）`, tex.bad.length === 0, tex);

    // ═══════════════════════════════════════════════
    // C. 地图：地形瓦片 / 城镇 / 资源 / 英雄
    // ═══════════════════════════════════════════════
    console.log('\n▶ C. 地图场景');

    const map = await page.evaluate(() => {
      const g = window.__game;
      const s = g.scene.getScene('MapScene');

      // 统计场景里的像素贴图实例（按纹理键）
      const byKey = {};
      const walk = (items) => {
        for (const o of items || []) {
          if (o.type === 'Image' && o.texture && o.texture.key.startsWith('px_')) {
            byKey[o.texture.key] = (byKey[o.texture.key] || 0) + 1;
          }
          if (o.type === 'Container' && o.list) walk(o.list);
        }
      };
      walk(s.children.list);

      const terrainKeys = Object.keys(byKey).filter((k) => k.startsWith('px_terrain_'));
      const resKeys = Object.keys(byKey).filter((k) => k.startsWith('px_res_'));
      const townKeys = Object.keys(byKey).filter((k) => k.startsWith('px_town_'));
      const heroKeys = Object.keys(byKey).filter((k) => k.startsWith('px_hero_map_'));

      // 地图上是否每一格都有地形瓦片
      const { width, height } = s.state.map;
      const tiles = width * height;

      // 地形瓦片是否被放进了 groundLayer（而不是散在 scene 顶层）
      const ground = s.groundLayer ? s.groundLayer.list.length : -1;
      const topLevel = s.children.list.filter(
        (o) => o.type === 'Image' && o.texture && o.texture.key.startsWith('px_terrain_')
      ).length;

      return {
        tiles,
        terrainCount: terrainKeys.reduce((a, k) => a + byKey[k], 0),
        terrainKinds: terrainKeys.length,
        resCount: resKeys.reduce((a, k) => a + byKey[k], 0),
        townCount: townKeys.reduce((a, k) => a + byKey[k], 0),
        heroCount: heroKeys.reduce((a, k) => a + byKey[k], 0),
        groundLayerSize: ground,
        topLevelTerrain: topLevel
      };
    });

    push(
      `地图每格都有地形瓦片（${map.tiles} 格）`,
      map.terrainCount === map.tiles,
      map
    );
    push('地形瓦片用到了 5 种地形', map.terrainKinds >= 5, map);
    push('资源用了像素图标', map.resCount > 0, map);
    push('城镇用了像素城池', map.townCount > 0, map);
    push('英雄用了像素头像', map.heroCount > 0, map);
    push(
      '地形瓦片收在 groundLayer 里（没散在 scene 顶层）',
      map.groundLayerSize >= map.tiles && map.topLevelTerrain === 0,
      map
    );

    // ═══════════════════════════════════════════════
    // D. 战场：兵牌 = 底座 + 立绘
    // ═══════════════════════════════════════════════
    console.log('\n▶ D. 战场场景');

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

    const battle = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const views = [...s.unitViews.values()];
      const groundTiles = s.gridLayer
        ? s.gridLayer.list.filter(
            (o) => o.type === 'Image' && o.texture.key === 'px_ground_battle'
          ).length
        : -1;
      return {
        stacks: s.battle.stacks.length,
        views: views.length,
        withIcon: views.filter((v) => !!v.icon).length,
        withBase: views.filter((v) => !!v.base).length,
        withDisc: views.filter((v) => !!v.disc).length,
        factions: views.map((v) => v.faction),
        colors: views.map((v) => v.factionColor),
        // 底座必须比立绘大且位置更低，否则底座被盖住
        baseBigger: views.filter(
          (v) => v.base && v.icon &&
            v.base.displayWidth > v.icon.displayWidth &&
            v.base.y > v.icon.y
        ).length,
        groundTiles,
        gridSize: s.gridLayer ? s.gridLayer.list.length : -1
      };
    });

    push('战场生成了 stack 与兵牌视图', battle.stacks > 0 && battle.views === battle.stacks, battle);
    push('每个兵牌都有兵种立绘', battle.withIcon === battle.views, battle);
    push('每个兵牌都有阵营底座', battle.withBase === battle.views, battle);
    push('兵牌不再用 Graphics 色块圆盘', battle.withDisc === 0, battle);
    push(
      '底座比立绘大且位置更低（敌我可辨）',
      battle.baseBigger === battle.views,
      battle
    );
    push(
      '兵牌阵营分蜀/魏两色',
      new Set(battle.factions).size === 2 &&
        battle.factions.every((f) => f === 'shu' || f === 'wei'),
      battle
    );
    push(
      '兵牌配色按 playerId（蜀 0xc0392b / 魏 0x2980b9）',
      battle.colors.every((c, i) =>
        battle.factions[i] === 'shu' ? c === 0xc0392b : c === 0x2980b9),
      battle
    );
    push(
      '战场地面瓦片铺满 11×9 并收在 gridLayer',
      battle.groundTiles === 99,
      battle
    );

    // ═══════════════════════════════════════════════
    // E. 降级回退：资源缺失时退回 Graphics 色块
    // ═══════════════════════════════════════════════
    console.log('\n▶ E. 资源缺失时的降级回退');

    const fallback = await page.evaluate(async () => {
      const g = window.__game;
      const s = g.scene.getScene('BattleScene');
      // 假装资源没加载：把已加载的 px_ 纹理从缓存里摘掉
      const removed = [];
      for (const key of Object.keys(g.textures.list)) {
        if (!key.startsWith('px_')) continue;
        removed.push(key);
        g.textures.remove(key);
      }
      // 重建一个兵牌，模拟「资源缺失」
      const stack = s.battle.stacks[0];
      const mod = await import('/src/scenes/battleView.js');
      const v = mod.createUnitView(s, stack);
      const out = {
        removed: removed.length,
        hasIcon: !!v.icon,
        hasBase: !!v.base,
        hasDisc: !!v.disc,
        discColor: v.disc ? v.disc.fillColor : null
      };
      mod.destroyUnitView(s, v);
      return out;
    });

    push('回退：兵牌退化为 Graphics 色块圆盘', fallback.hasDisc === true, fallback);
    push('回退：不再引用像素立绘', fallback.hasIcon === false && fallback.hasBase === false, fallback);
    push(
      '回退：色块圆盘仍按阵营着色',
      fallback.discColor === 0xc0392b || fallback.discColor === 0x2980b9,
      fallback
    );

    // ═══════════════════════════════════════════════
    // F. 无运行时异常 / 无 404
    // ═══════════════════════════════════════════════
    console.log('\n▶ F. 运行时健康度');

    const realFailures = [...failedUrls];
    push('没有资源加载失败（404）', realFailures.length === 0, { failedUrls: realFailures });
    push('没有运行时异常', errors.length === 0, { errors: errors.slice(0, 5) });
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  // ═══════════════════════════════════════════════
  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`M14 验证：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    console.log('失败项：');
    failed.forEach((f) => console.log(`  ❌ ${f.name}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 全部通过');
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

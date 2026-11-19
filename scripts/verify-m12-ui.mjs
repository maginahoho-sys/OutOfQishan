/**
 * M12 存档系统的无头浏览器验证脚本
 *
 * 目的：验证 M12 在**真实运行时**（浏览器 + Phaser）可用，
 *       而不只是逻辑层单测通过。这里跑的是：
 *         存档 → 刷新页面 → 读档 → 局面完全恢复
 *         篡改 localStorage → 读档返回 corrupted 而不是崩溃
 *         listSaves 正确显示 4 个档位的占用情况
 *         自动存档（day:new 时写 auto 档）
 *
 * 契约验收（docs/契约/M12-存档.md）：
 *   ① 存档后刷新页面，读档能完全恢复（heroes/towns/资源一致）
 *   ② 篡改 localStorage 内容后读档返回 corrupted 而不是崩溃
 *   ③ listSaves 正确显示 4 个档位的占用情况
 *
 * 附加验证：
 *   D. URL 深链读档（?slot=N）能在刷新后直接回到存档局面
 *   E. 存档面板 UI 能打开、能存档、能读取
 *
 * 用法：node scripts/verify-m12-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5200;

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

/**
 * 页面内通用工具
 */
const PAGE_HELPERS = `
  // 局面快照：用来对比存档前后是否一致
  function snapState(g) {
    const st = g.registry.get('state');
    const p0 = st.players[0];
    const p1 = st.players[1];
    return {
      day: st.meta.day,
      week: st.meta.week,
      currentPlayer: st.meta.currentPlayer,
      gold: p0.gold,
      wood: p0.wood,
      ore: p0.ore,
      weiGold: p1.gold,
      heroes: st.heroes.map((h) => ({
        id: h.id,
        playerId: h.playerId,
        pos: { ...h.pos },
        level: h.level,
        exp: h.exp,
        mp: h.movePoints,
        army: JSON.parse(JSON.stringify(h.army || []))
      })),
      towns: st.towns.map((t) => ({
        id: t.id,
        pos: { ...t.pos },
        buildings: (t.buildings || []).slice(),
        pool: JSON.parse(JSON.stringify(t.recruitPool || []))
      })),
      objects: st.map.objects.length,
      objectIds: st.map.objects.map((o) => o.type + ':' + o.resource + '@' + o.pos.x + ',' + o.pos.y).sort(),
      gameOver: st.gameOver
    };
  }

  // 等条件成立（轮询，避免固定 sleep）
  function waitFor(fn, timeout = 12000, step = 120) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const tick = () => {
        let v = false;
        try { v = fn(); } catch (e) { v = false; }
        if (v) return resolve(true);
        if (performance.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, step);
      };
      tick();
    });
  }
`;

async function main() {
  console.log('▶ 启动 vite dev server...');
  const server = await startDevServer();
  console.log(`  ✅ dev server 就绪 http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const checks = [];
  const push = (name, ok, diag) => {
    checks.push([name, ok]);
    if (!ok && diag) console.log(`  🔍 诊断[${name}]：`, JSON.stringify(diag));
  };

  let failed = false;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    const errors = [];
    const failedUrls = new Set();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('response', (r) => {
      // favicon 本来就没有，404 属于无害噪音，不计入失败
      if (/favicon/i.test(r.url())) return;
      if (r.status() >= 400) failedUrls.add(r.url());
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/Failed to load resource/i.test(t)) {
        // 资源加载失败：如果失败清单里只有 favicon 就忽略
        if (!failedUrls.size) return;
        errors.push(t);
        return;
      }
      errors.push(t);
    });

    // ═══════════════════════════════════════════════
    // A. 逻辑层：saveGame / loadGame / listSaves 往返
    // ═══════════════════════════════════════════════
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(1800);

    const logic = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState } = fn();
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');

      // 清空所有存档位，保证从干净状态开始
      for (const slot of sl.SAVE_SLOTS) sl.deleteSave(slot);

      const st = g.registry.get('state');
      const before = snapState(g);

      // 存档前先改动一点局面，便于验证读档后能恢复
      st.players[0].gold = 7777;
      st.heroes[0].pos = { x: 3, y: 4 };
      const afterEdit = snapState(g);

      const saveR = sl.saveGame(st, 0);
      const list1 = sl.listSaves();
      const loadR = sl.loadGame(0);
      const afterLoad = loadR.ok ? snapStateOf(loadR.state) : null;

      /**
       * 对一个独立 state 对象做快照（读档回来的 state 不在 registry 里）
       */
      function snapStateOf(s) {
        const p0 = s.players[0];
        const p1 = s.players[1];
        return {
          day: s.meta.day,
          week: s.meta.week,
          gold: p0.gold,
          weiGold: p1.gold,
          heroes: s.heroes.map((h) => ({
            id: h.id,
            playerId: h.playerId,
            pos: { ...h.pos },
            level: h.level,
            exp: h.exp,
            mp: h.movePoints,
            army: JSON.parse(JSON.stringify(h.army || []))
          })),
          towns: s.towns.map((t) => ({
            id: t.id,
            pos: { ...t.pos },
            buildings: (t.buildings || []).slice(),
            pool: JSON.parse(JSON.stringify(t.recruitPool || []))
          })),
          objects: s.map.objects.length,
          objectIds: s.map.objects.map((o) => o.type + ':' + o.resource + '@' + o.pos.x + ',' + o.pos.y).sort()
        };
      }

      return {
        saveOk: saveR.ok,
        saveSlot: saveR.slot,
        saveLabel: saveR.label,
        listLen: list1.length,
        listSlots: list1.map((x) => (x ? x.slot : null)),
        list0: list1[0] ? { label: list1[0].label, hasTime: list1[0].savedAt > 0 } : null,
        loadOk: loadR.ok,
        loadReason: loadR.reason,
        before,
        afterEdit,
        afterLoad,
        // 非法 slot
        badSlot: sl.saveGame(st, 99).reason,
        // 空档位
        emptyReason: sl.loadGame(1).reason
      };
    }, PAGE_HELPERS);

    push('saveGame：存档成功并返回摘要', logic.saveOk === true && logic.saveLabel === '第1周第1天', logic);
    push(
      'loadGame：读回同一个局面（资源/英雄位置完全一致）',
      logic.loadOk === true &&
      logic.afterLoad !== null &&
      logic.afterLoad.gold === logic.afterEdit.gold &&
      logic.afterLoad.heroes[0].pos.x === logic.afterEdit.heroes[0].pos.x &&
      logic.afterLoad.heroes[0].pos.y === logic.afterEdit.heroes[0].pos.y &&
      JSON.stringify(logic.afterLoad.heroes) === JSON.stringify(logic.afterEdit.heroes) &&
      JSON.stringify(logic.afterLoad.towns) === JSON.stringify(logic.afterEdit.towns) &&
      logic.afterLoad.objects === logic.afterEdit.objects,
      { afterEdit: logic.afterEdit, afterLoad: logic.afterLoad }
    );
    push(
      '验收③：listSaves 显示 4 个档位',
      logic.listLen === 4,
      { listLen: logic.listLen, listSlots: logic.listSlots }
    );
    push(
      '验收③：已存的档位显示摘要与时间',
      logic.list0 && logic.list0.label === '第1周第1天' && logic.list0.hasTime === true,
      logic.list0
    );
    push('非法 slot 返回 invalidSlot（不抛错）', logic.badSlot === 'invalidSlot', logic.badSlot);
    push('空档位读取返回 empty', logic.emptyReason === 'empty', logic.emptyReason);

    // ═══════════════════════════════════════════════
    // B. 验收①：存档 → 刷新页面 → 读档，局面完全恢复
    // ═══════════════════════════════════════════════
    // 制造一个明显的局面：改资源、移动英雄、消耗资源
    const saved = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState } = fn();
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');

      const st = g.registry.get('state');
      // 攒一个"跑了一阵子"的局面
      st.players[0].gold = 5555;
      st.players[0].wood = 33;
      st.players[1].gold = 6666;
      st.heroes[0].pos = { x: 2, y: 2 };
      st.heroes[0].exp = 42;
      st.heroes[1].pos = { x: 9, y: 9 };
      st.towns[0].buildings = ['hall', 'shu_barracks1'];
      st.meta.day = 3;
      st.meta.week = 1;
      // 地图资源吃掉一个
      if (st.map.objects.length) st.map.objects.splice(0, 1);

      const before = snapState(g);
      const r = sl.saveGame(st, 0);
      return { before, saveOk: r.ok };
    }, PAGE_HELPERS);

    push('准备存档：局面改动并写入存档位 0', saved.saveOk === true, saved.before);

    // 刷新页面（模拟玩家关掉浏览器再回来）
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(1800);

    const afterReload = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState } = fn();
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');
      const r = sl.loadGame(0);
      return {
        // 刷新后是新开局，局面应该跟存档**不同**
        fresh: snapState(g),
        loadOk: r.ok,
        loadReason: r.reason,
        loaded: r.ok ? snapStateOf(r.state) : null
      };

      /**
       * 对一个独立 state 对象做快照（读档回来的 state 不在 registry 里）
       * 字段必须与 snapState 完全一致，否则比对会误判
       */
      function snapStateOf(s) {
        const p0 = s.players[0];
        const p1 = s.players[1];
        return {
          day: s.meta.day,
          week: s.meta.week,
          currentPlayer: s.meta.currentPlayer,
          gold: p0.gold,
          wood: p0.wood,
          ore: p0.ore,
          weiGold: p1.gold,
          heroes: s.heroes.map((h) => ({
            id: h.id,
            playerId: h.playerId,
            pos: { ...h.pos },
            level: h.level,
            exp: h.exp,
            mp: h.movePoints,
            army: JSON.parse(JSON.stringify(h.army || []))
          })),
          towns: s.towns.map((t) => ({
            id: t.id,
            pos: { ...t.pos },
            buildings: (t.buildings || []).slice(),
            pool: JSON.parse(JSON.stringify(t.recruitPool || []))
          })),
          objects: s.map.objects.length,
          objectIds: s.map.objects.map((o) => o.type + ':' + o.resource + '@' + o.pos.x + ',' + o.pos.y).sort(),
          gameOver: s.gameOver
        };
      }
    }, PAGE_HELPERS);

    push(
      '刷新页面后新开局与存档是不同的局面（存档确实写进了 localStorage）',
      afterReload.fresh.gold !== saved.before.gold ||
      afterReload.fresh.heroes[0].pos.x !== saved.before.heroes[0].pos.x,
      { fresh: afterReload.fresh, saved: saved.before }
    );
    push('刷新页面后仍能读出存档', afterReload.loadOk === true, afterReload);
    push(
      '验收①：读档后资源完全恢复',
      afterReload.loaded &&
      afterReload.loaded.gold === saved.before.gold &&
      afterReload.loaded.wood === saved.before.wood &&
      afterReload.loaded.weiGold === saved.before.weiGold,
      { loaded: afterReload.loaded, expected: saved.before }
    );
    push(
      '验收①：读档后英雄（位置/经验/兵力）完全恢复',
      afterReload.loaded &&
      JSON.stringify(afterReload.loaded.heroes) === JSON.stringify(saved.before.heroes),
      { loaded: afterReload.loaded?.heroes, expected: saved.before.heroes }
    );
    push(
      '验收①：读档后城镇（建筑）完全恢复',
      afterReload.loaded &&
      JSON.stringify(afterReload.loaded.towns) === JSON.stringify(saved.before.towns),
      { loaded: afterReload.loaded?.towns, expected: saved.before.towns }
    );
    push(
      '验收①：读档后地图资源状态恢复（被捡走的没回来）',
      afterReload.loaded &&
      afterReload.loaded.objects === saved.before.objects,
      { loaded: afterReload.loaded?.objects, expected: saved.before.objects }
    );
    push(
      '验收①：读档后日期恢复',
      afterReload.loaded && afterReload.loaded.day === saved.before.day,
      { loaded: afterReload.loaded?.day, expected: saved.before.day }
    );

    // ═══════════════════════════════════════════════
    // C. 验收②：篡改 localStorage → corrupted，不崩溃
    // ═══════════════════════════════════════════════
    const corrupted = await page.evaluate(async () => {
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');

      // 1. 篡改成非法 JSON
      localStorage.setItem('ooqs_save_0', '{这不是合法 JSON');
      const r1 = sl.loadGame(0);

      // 2. 篡改成结构不对的 JSON
      localStorage.setItem('ooqs_save_0', JSON.stringify({ hello: 'world' }));
      const r2 = sl.loadGame(0);

      // 3. 篡改版本号（先往槽位 1 存一个正常档，再改版本号）
      const st = g.registry.get('state');
      sl.saveGame(st, 1);
      const raw = JSON.parse(localStorage.getItem('ooqs_save_1'));
      localStorage.setItem('ooqs_save_1', JSON.stringify({ ...raw, version: 999 }));
      const r3 = sl.loadGame(1);

      // 4. 页面还活着吗？
      const alive = !!(g && g.registry.get('state'));

      return {
        r1: { ok: r1.ok, reason: r1.reason },
        r2: { ok: r2.ok, reason: r2.reason },
        r3: { ok: r3.ok, reason: r3.reason },
        alive,
        // listSaves 对损坏档位的标记
        summary: sl.listSaves().map((x) => (x ? { slot: x.slot, corrupted: !!x.corrupted, label: x.label } : null))
      };
    });

    push('验收②：非法 JSON → corrupted', corrupted.r1.ok === false && corrupted.r1.reason === 'corrupted', corrupted.r1);
    push('验收②：结构不对的 JSON → corrupted', corrupted.r2.ok === false && corrupted.r2.reason === 'corrupted', corrupted.r2);
    push('版本号不符 → versionMismatch', corrupted.r3.ok === false && corrupted.r3.reason === 'versionMismatch', corrupted.r3);
    push('验收②：读档失败后页面没有崩溃', corrupted.alive === true, corrupted);
    push(
      'listSaves 把损坏档位标成 corrupted（而不是静默当空）',
      corrupted.summary[0] && corrupted.summary[0].corrupted === true,
      corrupted.summary
    );

    // ═══════════════════════════════════════════════
    // D. URL 深链读档：?slot=0 刷新后直接回到存档局面
    // ═══════════════════════════════════════════════
    // 先写一个干净的存档
    await page.evaluate(async () => {
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');
      for (const slot of sl.SAVE_SLOTS) sl.deleteSave(slot);
      const st = g.registry.get('state');
      st.players[0].gold = 8888;
      st.meta.day = 4;
      sl.saveGame(st, 0);
    });

    await page.goto(`http://localhost:${PORT}/?slot=0`, { waitUntil: 'networkidle0' });
    await sleep(1800);

    const deepLink = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState } = fn();
      const g = window.__game;
      return snapState(g);
    }, PAGE_HELPERS);

    push(
      'D：URL 深链 ?slot=0 直接载入那一局',
      deepLink.gold === 8888 && deepLink.day === 4,
      deepLink
    );

    // 深链指向不存在的档位 → 回落到新开局，不崩
    await page.goto(`http://localhost:${PORT}/?slot=2`, { waitUntil: 'networkidle0' });
    await sleep(1800);
    const badDeepLink = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState };');
      const { snapState } = fn();
      const g = window.__game;
      return snapState(g);
    }, PAGE_HELPERS);

    push(
      'D：深链指向空档位时回落到新开局（不崩）',
      badDeepLink && badDeepLink.gold === 10000,
      badDeepLink
    );

    // ═══════════════════════════════════════════════
    // E. 存档面板 UI：能打开、能存档、能读取
    // ═══════════════════════════════════════════════
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(1800);

    const ui = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState, waitFor } = fn();
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');

      for (const slot of sl.SAVE_SLOTS) sl.deleteSave(slot);

      const ms = g.scene.getScene('MapScene');
      if (!ms) return { ok: false, reason: 'noMapScene' };

      // 改动局面（用于验证读档后恢复）
      const st = g.registry.get('state');
      st.players[0].gold = 24680;
      const before = snapState(g);

      // 打开面板
      ms.openSavePanel();
      const panelOpen = !!ms.savePanel;

      /**
       * 递归收集某个容器里的所有文本对象
       * 面板结构是 layer → rowLayer → 按钮文字（两层嵌套），要递归才找得到
       */
      function collectTexts(container) {
        const out = [];
        const walk = (list) => {
          for (const o of list || []) {
            if (o.type === 'Text') out.push(o);
            else if (o.type === 'Container') walk(o.list);
          }
        };
        walk(container ? container.list : []);
        return out;
      }

      // 面板层的 depth 是 960（与状态栏里的 [存档] 按钮区分开）
      const panelLayer = ms.children.list.find(
        (o) => o.type === 'Container' && o.depth === 960
      );
      const texts = collectTexts(panelLayer);
      const rows = texts.filter((t) => t.text === '[存档]').length;
      const btnSave = texts.find((t) => t.text === '[存档]');
      const btnLoad = texts.find((t) => t.text === '[读取]');

      // 点第一行的 [存档] 按钮
      if (btnSave) btnSave.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 200));

      const afterSave = sl.listSaves();
      const slot0 = afterSave[0];

      // 面板应还开着，且「读取」按钮现在可点
      const panelLayer2 = ms.children.list.find(
        (o) => o.type === 'Container' && o.depth === 960
      );
      const texts2 = collectTexts(panelLayer2);
      const loadBtn = texts2.find((t) => t.text === '[读取]');

      // 改掉当前局面，再读档，验证恢复
      g.registry.get('state').players[0].gold = 111;
      const dirty = snapState(g);

      if (loadBtn) loadBtn.emit('pointerdown');
      // 读档会重建 MapScene，等它起来
      const back = await waitFor(() => {
        const m = g.scene.getScene('MapScene');
        return m && m.scene.isActive() && m.state && m.state.players[0].gold === 24680;
      }, 8000);

      const after = snapState(g);

      return {
        panelOpen,
        panelFound: !!panelLayer,
        rows,
        saved: !!slot0,
        slot0Label: slot0 ? slot0.label : null,
        dirtyGold: dirty.gold,
        restored: back,
        afterGold: after.gold,
        afterDay: after.day
      };
    }, PAGE_HELPERS);

    push('E：点状态栏[存档]能打开存档面板', ui.panelOpen === true, ui);
    push('E：存档面板图层存在（depth 960）', ui.panelFound === true, ui);
    push('E：面板里有 4 行存档位（每行一个[存档]按钮）', ui.rows === 4, ui);
    push('E：点[存档]按钮能写入存档位', ui.saved === true, ui);
    push(
      'E：点[读取]能恢复之前的局面',
      ui.restored === true && ui.afterGold === 24680 && ui.dirtyGold === 111,
      ui
    );

    // ═══════════════════════════════════════════════
    // F. 自动存档：day:new 时写 auto 档
    // ═══════════════════════════════════════════════
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(1800);

    const auto = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snapState, waitFor };');
      const { snapState, waitFor } = fn();
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');

      for (const slot of sl.SAVE_SLOTS) sl.deleteSave(slot);

      const before = sl.listSaves();
      const ms = g.scene.getScene('MapScene');

      // 结束回合 → 电脑行动 → 回到玩家 0 时 day+1 → day:new → 自动存档
      ms.endTurn();
      const ok = await waitFor(() => {
        const st = g.registry.get('state');
        return st.meta.currentPlayer === 0 && !st.gameOver;
      }, 25000);

      const after = sl.listSaves();
      const autoSlot = after[3];

      return {
        beforeAuto: !!before[3],
        ok,
        autoSaved: !!autoSlot,
        autoSlot: autoSlot ? autoSlot.slot : null,
        autoLabel: autoSlot ? autoSlot.label : null,
        day: g.registry.get('state').meta.day
      };
    }, PAGE_HELPERS);

    push('F：day:new 之前自动位是空的', auto.beforeAuto === false, auto);
    push(
      'F：过一天后自动位写入了存档',
      auto.ok === true && auto.autoSaved === true && auto.autoSlot === 'auto',
      auto
    );

    // ═══════════════════════════════════════════════
    // G. 存档体积与稳定性
    // ═══════════════════════════════════════════════
    const size = await page.evaluate(async () => {
      const g = window.__game;
      const sl = await import('/src/logic/saveLogic.js');
      sl.saveGame(g.registry.get('state'), 0);
      const raw = localStorage.getItem('ooqs_save_0');
      return { bytes: raw ? raw.length : 0 };
    });

    push(
      'G：单个存档体积在 localStorage 限额内（< 200KB）',
      size.bytes > 0 && size.bytes < 200 * 1024,
      size
    );

    console.log('\n▶ M12 存档系统验证：');
    for (const [name, ok] of checks) {
      console.log((ok ? '  ✅ ' : '  ❌ ') + name);
      if (!ok) failed = true;
    }

    if (errors.length) {
      console.log('\n⚠️ 页面报错：');
      errors.slice(0, 10).forEach((e) => console.log('   ' + e));
      failed = true;
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  const total = checks.length;
  const pass = checks.filter(([, ok]) => ok).length;
  console.log(`\n${failed ? '❌' : '✅'} M12 验证：${pass}/${total} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

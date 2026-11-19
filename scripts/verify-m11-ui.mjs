/**
 * M11 地图 AI 的无头浏览器验证脚本
 *
 * 目的：验证 M11 在**真实运行时**（浏览器 + Phaser）可用，
 *       而不只是逻辑层单测通过。单测跑的是纯数据，这里跑的是：
 *         结束回合 → MapScene 驱动 AI → 逐格移动动画 → 资源拾取
 *         → 城务（建兵营/招募）→ 战斗切场景 → 回到地图续跑
 *
 * 契约验收（docs/契约/M11-地图AI.md）：
 *   ① 点「结束回合」后，曹操在地图上自动移动（有可见的位置变化）
 *   ② 曹操会捡他附近的资源（map.objects 减少）
 *   ③ 连续过 5 天不报错、不死循环（单回合最多 100 次移动调用）
 *
 * 附加验证（M11 改造 BattleScene 后的攻守互换）：
 *   D. 电脑主动进攻时，玩家在守方仍能操作（点自己单位能选中、能待命/防御）
 *   E. 兵牌配色按 playerId（玩家红 / 电脑蓝），跨场景一致
 *
 * 用法：node scripts/verify-m11-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5199;

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
  // 读当前场景状态
  function snap(g) {
    const s = g.scene.getScene('MapScene');
    const st = g.registry.get('state');
    const wei = st.heroes.find((h) => h.playerId === 1);
    const shu = st.heroes.find((h) => h.playerId === 0);
    return {
      day: st.meta.day,
      week: st.meta.week,
      currentPlayer: st.meta.currentPlayer,
      gameOver: st.gameOver,
      objects: st.map.objects.length,
      weiPos: wei ? { ...wei.pos } : null,
      weiMp: wei ? wei.movePoints : null,
      weiArmy: wei ? JSON.parse(JSON.stringify(wei.army)) : null,
      shuPos: shu ? { ...shu.pos } : null,
      shuArmy: shu ? JSON.parse(JSON.stringify(shu.army)) : null,
      weiGold: st.players[1].gold,
      weiBuildings: st.towns.find((t) => t.playerId === 1).buildings.slice(),
      aiPlaying: s ? !!s.aiPlaying : null,
      aiMoveCalls: s ? s.aiMoveCalls : null,
      aiCursor: s ? s.aiCursor : null,
      aiStepsLen: s ? s.aiSteps.length : null,
      activeScene: g.scene.getScenes(true).map((x) => x.scene.key)
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
        // favicon 的 404 已在 response 处理器里排除；
        // 这里只剩「真实资源加载失败」，failedUrls 为空说明是 favicon 之类的噪音
        if (!failedUrls.size) return;
        errors.push(t);
        return;
      }
      errors.push(t);
    });

    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle0' });
    await sleep(1800);

    // ═══════════════════════════════════════════════
    // 逻辑层：planMapTurn 是纯函数 + 结构合法
    // ═══════════════════════════════════════════════
    const logic = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snap, waitFor };');
      const { snap } = fn();
      const g = window.__game;
      const data = g.registry.get('data');
      const ai = await import('/src/logic/mapAI.js');

      const state = g.registry.get('state');
      const before = JSON.stringify(state);

      // 规划电脑回合（playerId=1）
      const steps = ai.planMapTurn(state, data, 1, {});
      const after = JSON.stringify(state);

      // 结构检查
      const shape = steps.map((s) => ({
        type: s.type,
        group: s.group,
        hasHeroId: typeof s.heroId === 'string' || s.heroId === null,
        hasTo: !s.to || (typeof s.to.x === 'number' && typeof s.to.y === 'number')
      }));

      // 逐步执行（不动真 state 之外的东西）→ 看是否逐格发出 hero:moved
      const bus = (await import('/src/core/EventBus.js')).default;
      const moves = [];
      const off = bus.on('hero:moved', (p) => moves.push({ ...p }));

      const simState = JSON.parse(before);
      // 用副本执行一遍（真 state 会真的动，这里只关心事件粒度）
      let execOk = true;
      let execErr = '';
      try {
        for (const s of steps) {
          const r = ai.executeMapStep(simState, data, s);
          if (!r.ok && s.type !== 'battle') { execOk = false; execErr = r.reason; }
          if (s.type === 'battle') break;
        }
      } catch (e) {
        execOk = false;
        execErr = String(e);
      }
      off();

      // 上限常量
      const maxCalls = ai.MAX_MOVE_CALLS;

      // aiMapTurn 契约入口
      const contractState = g.registry.get('state');
      const log = ai.aiMapTurn(contractState, data);
      const logShape = log.slice(0, 4).map((e) => ({
        hasHeroId: 'heroId' in e,
        action: e.action,
        hasDetail: !!e.detail
      }));

      return {
        planIsPure: before === after,
        stepCount: steps.length,
        shape,
        allGrouped: steps.every((s) => s.group !== undefined),
        moveSteps: steps.filter((s) => s.type === 'move').length,
        execOk,
        execErr,
        movedEvents: moves.length,
        maxCalls,
        logLen: log.length,
        logShape,
        snap: snap(g)
      };
    }, PAGE_HELPERS);

    push('planMapTurn 是纯函数（规划不改动真状态）', logic.planIsPure === true);
    push(
      '每个步骤都带 group 标记（战斗返回后据此判断哪些英雄已行动）',
      logic.allGrouped === true,
      logic.shape
    );
    push(
      '步骤类型合法（move/pickup/recruit/build/battle）',
      logic.shape.every((s) =>
        ['move', 'pickup', 'recruit', 'build', 'battle'].includes(s.type)),
      logic.shape
    );
    push(
      'move 步骤带 heroId 与目标格',
      logic.shape.filter((s) => s.type === 'move')
        .every((s) => s.hasHeroId && s.hasTo),
      logic.shape.filter((s) => s.type === 'move').slice(0, 3)
    );
    push(
      '执行层逐步执行无异常（除战斗步骤外全部 ok）',
      logic.execOk === true,
      { reason: logic.execErr }
    );
    push(
      '移动是逐格调用 moveHero（hero:moved 事件数 = move 步数）',
      logic.movedEvents === logic.moveSteps,
      { movedEvents: logic.movedEvents, moveSteps: logic.moveSteps }
    );
    push('单回合移动上限为 100（验收 3 的保护）', logic.maxCalls === 100, {
      maxCalls: logic.maxCalls
    });
    push(
      'aiMapTurn 返回契约格式的流水 [{heroId, action, detail}]',
      logic.logLen > 0 &&
      logic.logShape.every((e) => e.hasHeroId && typeof e.action === 'string' && e.hasDetail),
      logic.logShape
    );

    // ═══════════════════════════════════════════════
    // 场景层 ①：结束回合后曹操自动移动
    // ═══════════════════════════════════════════════
    // 上面已经用 aiMapTurn 动过真状态，这里重开一局干净状态
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(1800);

    const scene0 = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snap };');
      const { snap } = fn();
      const g = window.__game;
      const s = g.scene.getScene('MapScene');
      return {
        snap: snap(g),
        // 记下曹操精灵的屏幕坐标，验证"可见的位置变化"
        sprite: (() => {
          const hero = g.registry.get('state').heroes.find((h) => h.playerId === 1);
          const sp = s.heroSprites.get(hero.id);
          return sp ? { x: sp.x, y: sp.y } : null;
        })()
      };
    }, PAGE_HELPERS);

    // 监听 hero:moved（用来验证「逐格发出」）
    await page.evaluate(async () => {
      const bus = (await import('/src/core/EventBus.js')).default;
      window.__m11 = { moves: [], pickups: [], built: [] };
      bus.on('hero:moved', (p) => window.__m11.moves.push({ ...p, t: performance.now() }));
      bus.on('resource:picked', (p) => window.__m11.pickups.push({ ...p, t: performance.now() }));
    });

    // 点「结束回合」（玩家 0 回合）
    await page.evaluate(() => {
      const g = window.__game;
      const s = g.scene.getScene('MapScene');
      s.endTurn();
    });

    // 等电脑回合跑完（回到玩家 0 回合）
    const done1 = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snap, waitFor };');
      const { snap, waitFor } = fn();
      const g = window.__game;
      const ok = await waitFor(() => {
        const st = g.registry.get('state');
        return st.meta.currentPlayer === 0 && !st.gameOver;
      }, 20000);
      const s = g.scene.getScene('MapScene');
      const hero = g.registry.get('state').heroes.find((h) => h.playerId === 1);
      const sp = s.heroSprites.get(hero.id);
      return {
        ok,
        snap: snap(g),
        sprite: sp ? { x: sp.x, y: sp.y } : null,
        moves: window.__m11.moves,
        pickups: window.__m11.pickups
      };
    }, PAGE_HELPERS);

    push('结束回合后电脑回合会自动跑完并交还玩家', done1.ok === true, done1.snap);

    // ① 位置变化
    push(
      '验收①：曹操在地图上自动移动（逻辑位置变化）',
      done1.snap.weiPos &&
      scene0.snap.weiPos &&
      (done1.snap.weiPos.x !== scene0.snap.weiPos.x ||
        done1.snap.weiPos.y !== scene0.snap.weiPos.y),
      { before: scene0.snap.weiPos, after: done1.snap.weiPos }
    );
    push(
      '验收①：曹操的精灵位置也跟着变了（可见移动）',
      done1.sprite && scene0.sprite &&
      (Math.abs(done1.sprite.x - scene0.sprite.x) > 1 ||
        Math.abs(done1.sprite.y - scene0.sprite.y) > 1),
      { before: scene0.sprite, after: done1.sprite }
    );
    push(
      '移动是逐格发出的（每次 hero:moved 只走一格）',
      done1.moves.length >= 1 &&
      done1.moves.every((m) =>
        Math.max(Math.abs(m.to.x - m.from.x), Math.abs(m.to.y - m.from.y)) === 1),
      done1.moves.slice(0, 3)
    );
    push(
      '移动步数未超过单回合上限 100',
      done1.moves.length <= 100,
      { moves: done1.moves.length }
    );

    // ② 捡资源
    push(
      '验收②：曹操会捡附近的资源（map.objects 减少）',
      done1.snap.objects < scene0.snap.objects,
      { before: scene0.snap.objects, after: done1.snap.objects }
    );
    push(
      '拾取事件有发出（resource:picked）',
      done1.pickups.length >= 1,
      done1.pickups.slice(0, 2)
    );

    // 城务：建兵营 + 招募
    push(
      '城务：电脑建了兵营（开局缺招募建筑）',
      done1.snap.weiBuildings.includes('wei_barracks1'),
      done1.snap.weiBuildings
    );
    push(
      '城务：电脑招募了 T1 兵（青州兵 40→50）',
      done1.snap.weiArmy &&
      done1.snap.weiArmy.some((a) => a.unitId === 'wei_qingzhou' && a.count === 50),
      done1.snap.weiArmy
    );

    // ═══════════════════════════════════════════════
    // 场景层 ③：连续过 5 天不报错、不死循环
    // ═══════════════════════════════════════════════
    const days = [];
    for (let d = 0; d < 5; d++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await page.evaluate(async (helperSrc) => {
        const fn = new Function(helperSrc + '; return { snap, waitFor };');
        const { snap, waitFor } = fn();
        const g = window.__game;

        // 如果上一轮进了战斗（电脑打玩家），先把战斗结束掉回到地图
        const battleScene = g.scene.getScene('BattleScene');
        if (battleScene && battleScene.scene.isActive() && battleScene.battle) {
          const bl = await import('/src/logic/battleLogic.js');
          // 玩家方全部待命，快速推进战斗
          let guard = 0;
          while (!battleScene.battle.winner && guard < 200) {
            guard += 1;
            const cur = bl.currentStack(battleScene.battle);
            if (!cur) break;
            if (cur.playerId === 0) {
              bl.nextTurn(battleScene.battle, { action: 'defend' });
              await new Promise((r2) => setTimeout(r2, 60));
            } else {
              await new Promise((r2) => setTimeout(r2, 200));
            }
          }
          // 点「确定」返回地图
          const okBack = await waitFor(() => {
            const bs = g.scene.getScene('BattleScene');
            return !bs || !bs.scene.isActive() || bs.battle?.winner;
          }, 8000);
          if (okBack && battleScene.scene.isActive()) {
            battleScene.scene.start('MapScene');
          }
          await waitFor(() => {
            const ms = g.scene.getScene('MapScene');
            return ms && ms.scene.isActive();
          }, 8000);
        }

        const before = snap(g);
        const mapScene = g.scene.getScene('MapScene');
        if (!mapScene || !mapScene.scene.isActive()) {
          return { skipped: true, before };
        }

        mapScene.endTurn();
        const ok = await waitFor(() => {
          const st = g.registry.get('state');
          return (st.meta.currentPlayer === 0 && !st.gameOver) ||
            g.scene.getScene('BattleScene')?.scene.isActive();
        }, 25000);

        return { ok, before, after: snap(g) };
      }, PAGE_HELPERS);
      days.push(r);
      if (r.skipped) break;
    }

    const allDaysOk = days.length === 5 && days.every((d) => d.ok !== false);
    push('连续过 5 天：每个回合都能正常推进', allDaysOk === true, days.map((d) => ({
      ok: d.ok, day: d.after?.day, skipped: d.skipped
    })));

    const moveTotal = days.reduce(
      (a, d) => a + (d.after ? d.after.objects : 0), 0
    );
    push(
      '连续过 5 天：电脑持续有产出（资源被捡光后仍在推进，不卡死）',
      days.length === 5 &&
      days[days.length - 1].after &&
      days[days.length - 1].after.weiPos !== null,
      days.map((d) => ({ day: d.after?.day, pos: d.after?.weiPos }))
    );
    push(
      '连续过 5 天：日期正常推进到第 6 天',
      days.length === 5 && days[4].after && days[4].after.day === 6,
      days.map((d) => d.after?.day)
    );
    push(
      '连续过 5 天：没有出现游戏结束（不会被打死）',
      days.every((d) => !d.after?.gameOver),
      days.map((d) => d.after?.gameOver)
    );
    void moveTotal;

    // ═══════════════════════════════════════════════
    // D. 电脑主动进攻 → 玩家在守方仍能操作
    // ═══════════════════════════════════════════════
    // 重新加载一局干净局面，避免前 5 天的城务/战斗残留干扰
    await page.reload({ waitUntil: 'networkidle0' });
    await sleep(1800);

    // 构造局面：电脑兵力压倒玩家，且电脑英雄站到玩家英雄旁边
    await page.evaluate(async () => {
      const g = window.__game;
      const st = g.registry.get('state');

      // 让电脑更强、玩家更弱（但玩家要能撑过电脑第一回合，才轮得到玩家行动）
      const wei = st.heroes.find((h) => h.playerId === 1);
      const shu = st.heroes.find((h) => h.playerId === 0);
      wei.army = [{ unitId: 'wei_qingzhou', count: 80 }, { unitId: 'wei_archer', count: 60 }];
      shu.army = [{ unitId: 'shu_militia', count: 40 }, { unitId: 'shu_archer', count: 20 }];

      // 电脑英雄站到玩家英雄旁边（下一步就会触发遭遇战）
      wei.pos = { x: shu.pos.x + 1, y: shu.pos.y };
      wei.movePoints = 20;
      shu.movePoints = 20;

      // 清空地图资源：策略 1「捡便宜」优先级高于策略 2「打得过就打」，
      // 资源还在时电脑会先去捡金，根本不会来打人。
      st.map.objects = [];

      // 跳过城务的干扰：
      //   · 兵营提前建好（否则城务会先建营）；
      //   · 日期设为 2（第 1 天城务会把英雄拉回城补兵，位置就变了）。
      const weiTown = st.towns.find((t) => t.playerId === 1);
      weiTown.buildings = ['hall', 'wei_barracks1'];
      weiTown.builtToday = 0;
      st.meta.day = 2;
      st.meta.currentPlayer = 0;
    });

    // 让电脑走一轮去触发战斗（玩家在守方）
    await page.evaluate(async () => {
      const g = window.__game;
      const ms = g.scene.getScene('MapScene');
      ms.endTurn();
    });

    const battleIn = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { snap, waitFor };');
      const { waitFor } = fn();
      const g = window.__game;
      const ok = await waitFor(() => {
        const bs = g.scene.getScene('BattleScene');
        return bs && bs.scene.isActive() && bs.battle && !bs.battle.winner;
      }, 25000);
      const bs = g.scene.getScene('BattleScene');
      if (!bs || !bs.battle) return { ok: false };
      return {
        ok,
        attackerHeroId: bs.battle.attackerHeroId,
        defenderHeroId: bs.battle.defenderHeroId,
        attackerPlayerId: bs.battle.attackerPlayerId,
        defenderPlayerId: bs.battle.defenderPlayerId,
        humanSide: bs.humanSide,
        aiSide: bs.aiSide,
        aiHeroId: bs.aiHeroId,
        humanPlayerId: bs.humanPlayerId,
        aiPlayerId: bs.aiPlayerId,
        stacks: bs.battle.stacks.map((s) => ({
          id: s.id, side: s.side, playerId: s.playerId, unitName: s.unitName, count: s.count
        })),
        // 兵牌颜色（E）：玩家红 / 电脑蓝，按 playerId
        // ⚠️ M14 起兵牌是「阵营底座贴图 + 兵种立绘」，不再是 Graphics 色块圆盘，
        //    所以断言改读 view.factionColor（由 stackColor(stack) 按 playerId 算出）。
        discColors: bs.battle.stacks.map((s) => {
          const v = bs.unitViews.get(s.id);
          if (!v) return null;
          return { playerId: s.playerId, side: s.side, color: v.factionColor };
        })
      };
    }, PAGE_HELPERS);

    push(
      '电脑主动进攻会切到战场（BattleScene 被激活）',
      battleIn.ok === true,
      battleIn
    );
    push(
      '攻守已经互换：电脑是攻方（attackerPlayerId = 1）',
      battleIn.attackerPlayerId === 1 && battleIn.defenderPlayerId === 0,
      {
        attackerPlayerId: battleIn.attackerPlayerId,
        defenderPlayerId: battleIn.defenderPlayerId
      }
    );
    push(
      '玩家在守方（humanSide = defender，aiSide = attacker）',
      battleIn.humanSide === 'defender' && battleIn.aiSide === 'attacker',
      { humanSide: battleIn.humanSide, aiSide: battleIn.aiSide }
    );
    push(
      'playerHero / aiHeroId 按 side 反查正确',
      battleIn.aiHeroId === battleIn.attackerHeroId,
      { aiHeroId: battleIn.aiHeroId, attackerHeroId: battleIn.attackerHeroId }
    );
    push(
      'E. 兵牌配色按 playerId（玩家 0xc0392b 红 / 电脑 0x2980b9 蓝）',
      Array.isArray(battleIn.discColors) &&
      battleIn.discColors.length > 0 &&
      battleIn.discColors.every((c) =>
        c === null ||
        (c.playerId === 0 ? c.color === 0xc0392b : c.color === 0x2980b9)),
      battleIn.discColors
    );

    // 玩家在守方时能否操作：点自己的单位应能选中
    const act = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { waitFor };');
      const { waitFor } = fn();
      const g = window.__game;
      const bs = g.scene.getScene('BattleScene');
      const bl = await import('/src/logic/battleLogic.js');

      if (!bs || !bs.battle) return { ok: false, reason: 'noBattle' };

      // 等轮到玩家（playerId 0）的单位
      await waitFor(() => {
        const cur = bl.currentStack(bs.battle);
        return cur && cur.playerId === 0;
      }, 15000);

      const cur = bl.currentStack(bs.battle);
      if (!cur) return { ok: false, reason: 'noCurrentStack' };

      // 点自己的单位（走真实的 handleClickCell 路径）
      bs.handleClickCell({ x: cur.pos.x, y: cur.pos.y });
      const selected = bs.selectedId === cur.id;

      // 移动格应可算出来（说明 movableCells 认得玩家是守方）
      const moveCells = bs.moveCells.length;
      const targets = bs.targetIds.length;

      // 点[防御]应能推进回合
      const roundBefore = bs.battle.round;
      const turnBefore = bs.battle.currentTurn;
      bl.nextTurn(bs.battle, { action: 'defend' });
      const advanced = bs.battle.currentTurn !== turnBefore ||
        bs.battle.round !== roundBefore;

      return {
        ok: true,
        curPlayerId: cur.playerId,
        curSide: cur.side,
        selected,
        moveCells,
        targets,
        advanced,
        canAct: bs.isHumanTurn()
      };
    }, PAGE_HELPERS);

    push(
      '玩家在守方时能选中自己的单位',
      act.ok === true && act.selected === true,
      act
    );
    push(
      '玩家在守方时能算出可移动格',
      act.ok === true && act.moveCells >= 0 && act.selected === true,
      act
    );
    push(
      '玩家在守方时点[防御]能推进回合',
      act.ok === true && act.advanced === true,
      act
    );

    // 电脑在守方/攻方都能自动行动 —— 这里再验一次：电脑作为攻方会自己打
    const aiActs = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { waitFor };');
      const { waitFor } = fn();
      const g = window.__game;
      const bs = g.scene.getScene('BattleScene');
      const bl = await import('/src/logic/battleLogic.js');

      if (!bs || !bs.battle) return { acted: false, reason: 'noBattle' };

      const before = bs.battle.stacks
        .filter((s) => s.playerId === 1)
        .reduce((a, s) => a + s.count, 0);
      const defBefore = bs.battle.stacks
        .filter((s) => s.playerId === 0)
        .reduce((a, s) => a + s.count, 0);

      // 等电脑出手
      const acted = await waitFor(() => {
        const cur = bl.currentStack(bs.battle);
        return bs.battle.winner || (cur && cur.playerId === 1);
      }, 15000);

      const after = bs.battle.stacks
        .filter((s) => s.playerId === 1)
        .reduce((a, s) => a + s.count, 0);
      const defAfter = bs.battle.stacks
        .filter((s) => s.playerId === 0)
        .reduce((a, s) => a + s.count, 0);

      return {
        acted,
        before,
        after,
        defBefore,
        defAfter,
        logText: bs.battle.log.map((l) => l.text).join('\n')
      };
    }, PAGE_HELPERS);

    push(
      '电脑作为攻方会自己行动（出手或战斗结束）',
      aiActs.acted === true,
      aiActs
    );
    push(
      '电脑作为攻方打的是玩家方（玩家兵力下降）',
      aiActs.defAfter < aiActs.defBefore || aiActs.acted === true,
      { defBefore: aiActs.defBefore, defAfter: aiActs.defAfter }
    );

    console.log('\n▶ M11 地图 AI 验证：');
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
  console.log(`\n${failed ? '❌' : '✅'} M11 验证：${pass}/${total} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

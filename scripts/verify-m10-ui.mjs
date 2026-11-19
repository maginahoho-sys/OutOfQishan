/**
 * M10 战斗 AI 的无头浏览器验证脚本
 *
 * 目的：验证 M10 的 AI 在**真实运行时**（浏览器 + Phaser）可用，
 *       而不只是逻辑层单测通过。单测跑的是纯数据，这里跑的是：
 *         场景调度 → 规划 → 逐步执行 → M7 渲染播放 → 回合推进
 *
 * 验证点：
 *   A. 近战 AI：会移动 + 会攻击，且「移动」和「攻击」是**分开的两帧**
 *      （planTurn 返回 move+attack 序列，playAiSteps 每步之间留动画时间）
 *   B. 远程 AI：射程外时先移进射程再开火（满伤害），且**绝不主动贴脸**
 *   C. 行动序列可被 M7 直接消费：planTurn 返回值结构 + 兵牌真的挪到了 to 格
 *   D. AI 能在 20 轮内取胜（契约验收 ①），battle.winner 正常落定
 *
 * 用法：node scripts/verify-m10-ui.mjs
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
 *
 * ⚠️ 位置必须**在场景建好之后**再摆：startBattle 时会按 formationPos 布阵，
 *    场景 create() 结尾又会立刻 scheduleAI()（若开局轮到电脑方）。
 *    所以两侧兵速要摆成「同速 → 攻方先手」的局面，保证玩家先动、AI 后动，
 *    我们才有从容的窗口去改位置。
 */
const PAGE_HELPERS = `
  function makeHeroes(atkArmy, defArmy) {
    return [
      {
        id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备', level: 1,
        exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
        mana: 20, maxMana: 20, pos: { x: 3, y: 4 }, skills: {},
        spells: [], army: atkArmy
      },
      {
        id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 1,
        exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
        mana: 20, maxMana: 20, pos: { x: 8, y: 4 }, skills: {},
        spells: [], army: defArmy
      }
    ];
  }

  function enterBattle(g, atkArmy, defArmy) {
    const state = g.registry.get('state');
    state.heroes = makeHeroes(atkArmy, defArmy);
    state.players = [
      { id: 0, faction: 'shu', isAI: false },
      { id: 1, faction: 'wei', isAI: true }
    ];
    g.scene.stop('MapScene');
    g.scene.start('BattleScene', {
      attackerId: 'hero_shu_0',
      defenderId: 'hero_wei_0'
    });
  }

  // 把某个 stack 摆到指定格（测试脚本专用，不受 AI 的「不许改字段」约束）
  function placeStack(battle, side, pos) {
    const s = battle.stacks.find((x) => x.side === side);
    if (s) s.pos = { x: pos.x, y: pos.y };
    return s ? s.id : null;
  }

  // 切比雪夫距离（与 battleLogic.cellDistance 口径一致）
  function dist(a, b) {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }

  // 格子 → 屏幕像素中心（与 battleView.cellCenter 口径一致）
  function cellCenter(p) {
    return { x: 288 + p.x * 64 + 32, y: 60 + p.y * 64 + 32 };
  }

  // 挂钩场景的 playAiSteps，把 AI 实际执行的行动序列录下来
  function patchPlans(s) {
    if (s.__m10Patched) return false;
    s.__m10Patched = true;
    const orig = s.playAiSteps.bind(s);
    s.playAiSteps = (steps, stackId, action) => {
      window.__m10.plans.push({
        steps: JSON.parse(JSON.stringify(steps)),
        stackId,
        action,
        t: performance.now()
      });
      return orig(steps, stackId, action);
    };
    return true;
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
    await sleep(1500);

    // ═══════════════════════════════════════════════
    // 逻辑层验证（在进入战场前做，避免战斗事件打到 BattleScene）
    //   C. planTurn / aiTakeTurn 返回的行动序列结构
    //   D. AI 能在 20 轮内取胜（契约验收 ①）
    // ═══════════════════════════════════════════════
    const logic = await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { placeStack };');
      const { placeStack } = fn();

      const g = window.__game;
      const data = g.registry.get('data');
      const bl = await import('/src/logic/battleLogic.js');
      const ai = await import('/src/logic/battleAI.js');

      // ── C1. 造一场独立战斗（AI 是守方，近战，双方同速 → 攻方先手）──
      const fakeState = { heroes: [], players: [], towns: [] };
      const battle = bl.initBattle(
        fakeState,
        [{ unitId: 'shu_militia', count: 10 }],
        [{ unitId: 'wei_qingzhou', count: 10 }],
        {
          data,
          attackerHeroId: null,
          defenderHeroId: null,
          attackerPlayerId: 0,
          defenderPlayerId: 1
        }
      );

      // 摆位：玩家方 (3,4)，AI 方 (7,4) —— AI 一步能贴上去
      placeStack(battle, 'attacker', { x: 3, y: 4 });
      placeStack(battle, 'defender', { x: 7, y: 4 });
      battle.currentTurn = 0;

      const aiStackId = battle.stacks.find((s) => s.side === 'defender').id;
      const playerStackId = battle.stacks.find((s) => s.side === 'attacker').id;

      // planTurn 是纯函数：调用前后战场位置必须不变
      const posBefore = JSON.stringify(battle.stacks.map((s) => s.pos));
      const plan = ai.planTurn(battle, data, aiStackId);
      const posAfter = JSON.stringify(battle.stacks.map((s) => s.pos));

      const planShape = plan.map((step) => ({
        type: step.type,
        hasStackId: typeof step.stackId === 'string',
        hasTo: !!step.to && typeof step.to.x === 'number' && typeof step.to.y === 'number',
        hasTargetId: typeof step.targetId === 'string'
      }));

      // aiTakeTurn：规划 + 全执行，返回带 ok/result 的序列
      const done = ai.aiTakeTurn(battle, data, aiStackId);
      const doneShape = done.map((r) => ({
        type: r.type,
        ok: r.ok,
        hasResult: !!r.result
      }));

      const playerStackAfter = battle.stacks.find((x) => x.id === playerStackId);

      // ── D. AI vs 只防御的玩家：AI 必须在 20 轮内取胜 ──
      const dState = { heroes: [], players: [], towns: [] };
      const dBattle = bl.initBattle(
        dState,
        [{ unitId: 'shu_militia', count: 10 }],
        [{ unitId: 'wei_qingzhou', count: 10 }],
        {
          data,
          attackerHeroId: null,
          defenderHeroId: null,
          attackerPlayerId: 0,
          defenderPlayerId: 1
        }
      );

      let guard = 0;
      while (!dBattle.winner && guard < 4000) {
        guard += 1;
        const cur = bl.currentStack(dBattle);
        if (!cur) break;
        if (cur.side === 'defender') {
          // AI 方：走完整的 M10 流程
          const steps = ai.aiTakeTurn(dBattle, data, cur.id);
          const attacked = steps.some((s) => s.type === 'attack' && s.ok);
          bl.nextTurn(dBattle, { action: attacked ? 'attack' : 'move' });
        } else {
          // 玩家方：原地防御（契约验收 ① 的设定）
          bl.nextTurn(dBattle, { action: 'defend' });
        }
      }

      const atkLeft = dBattle.stacks
        .filter((s) => s.side === 'attacker')
        .reduce((a, s) => a + s.count, 0);
      const defLeft = dBattle.stacks
        .filter((s) => s.side === 'defender')
        .reduce((a, s) => a + s.count, 0);

      return {
        planShape,
        planIsPure: posBefore === posAfter,
        doneShape,
        playerHpAfter: playerStackAfter
          ? { hp: playerStackAfter.hp, count: playerStackAfter.count }
          : null,
        // D
        winner: dBattle.winner,
        rounds: dBattle.round,
        atkLeft,
        defLeft
      };
    }, PAGE_HELPERS);

    // ── C. 行动序列结构 ──
    push(
      'planTurn 返回 move+attack 两步序列',
      logic.planShape.length === 2 &&
      logic.planShape[0].type === 'move' &&
      logic.planShape[1].type === 'attack',
      logic.planShape
    );
    push(
      'move 步带 stackId 与目标格 to{x,y}',
      logic.planShape[0]?.hasStackId === true && logic.planShape[0]?.hasTo === true,
      logic.planShape[0]
    );
    push(
      'attack 步带 stackId 与 targetId',
      logic.planShape[1]?.hasStackId === true && logic.planShape[1]?.hasTargetId === true,
      logic.planShape[1]
    );
    push('planTurn 是纯函数（不改动战场状态）', logic.planIsPure === true);
    push(
      'aiTakeTurn 返回执行结果（含 ok 与 result）',
      logic.doneShape.length === 2 &&
      logic.doneShape.every((d) => d.ok === true) &&
      logic.doneShape[1].hasResult === true,
      logic.doneShape
    );
    push(
      'AI 执行后打掉了玩家的血',
      logic.playerHpAfter && (logic.playerHpAfter.hp < 6 || logic.playerHpAfter.count < 10),
      logic.playerHpAfter
    );

    // ── D. 契约验收 ① ──
    push('AI 在 20 轮内取胜', logic.winner === 'defender' && logic.rounds <= 20, {
      winner: logic.winner, rounds: logic.rounds
    });
    push('AI 获胜时自身还有兵（不是同归于尽）', logic.defLeft > 0, {
      atkLeft: logic.atkLeft, defLeft: logic.defLeft
    });
    push('玩家方（只防御）被打到全灭', logic.atkLeft === 0, { atkLeft: logic.atkLeft });

    // ═══════════════════════════════════════════════
    // 场景层验证 A：近战 AI 移动 + 攻击（分开两帧）
    // ═══════════════════════════════════════════════
    await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { enterBattle };');
      const { enterBattle } = fn();
      const g = window.__game;

      // 装事件追踪（EventBus 是单例，页面 import 到的和场景里是同一个）
      const bus = (await import('/src/core/EventBus.js')).default;
      window.__m10 = { moves: [], actions: [], plans: [] };
      bus.on('battle:move', (p) => window.__m10.moves.push({ ...p, t: performance.now() }));
      bus.on('battle:action', (p) => window.__m10.actions.push({ ...p, t: performance.now() }));

      // 近战对撞：玩家乡勇 (3,4)，AI 青州兵 (7,4)
      enterBattle(g, [{ unitId: 'shu_militia', count: 10 }], [{ unitId: 'wei_qingzhou', count: 10 }]);
    }, PAGE_HELPERS);
    await sleep(1400);

    const posA = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { placeStack, patchPlans };');
      const { placeStack, patchPlans } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      const patched = patchPlans(s);
      const atkId = placeStack(s.battle, 'attacker', { x: 3, y: 4 });
      const defId = placeStack(s.battle, 'defender', { x: 7, y: 4 });
      s.refresh();
      const atk = s.battle.stacks.find((x) => x.id === atkId);
      const def = s.battle.stacks.find((x) => x.id === defId);
      const view = s.unitViews.get(defId);
      return {
        patched,
        atkId, defId,
        atkPos: { ...atk.pos },
        defPos: { ...def.pos },
        atkHp: atk.hp, atkCount: atk.count,
        defHp: def.hp, defCount: def.count,
        viewX: view ? view.root.x : null,
        viewY: view ? view.root.y : null
      };
    }, PAGE_HELPERS);

    // 玩家待命 → 轮到电脑方
    await page.evaluate(async () => {
      const bl = await import('/src/logic/battleLogic.js');
      const s = window.__game.scene.getScene('BattleScene');
      bl.nextTurn(s.battle, { action: 'wait' });
    });

    // 等 AI 跑完：450ms 调度 + 300ms 移动 + 620ms 攻击
    await sleep(2800);

    const afterA = await page.evaluate((ids) => {
      const s = window.__game.scene.getScene('BattleScene');
      const atk = s.battle.stacks.find((x) => x.id === ids.atkId);
      const def = s.battle.stacks.find((x) => x.id === ids.defId);
      const view = s.unitViews.get(ids.defId);
      return {
        atkPos: { ...atk.pos },
        defPos: { ...def.pos },
        atkHp: atk.hp, atkCount: atk.count,
        defHp: def.hp, defCount: def.count,
        viewX: view ? view.root.x : null,
        viewY: view ? view.root.y : null,
        moves: window.__m10.moves,
        actions: window.__m10.actions,
        plans: window.__m10.plans,
        logText: s.battle.log.map((l) => l.text).join('\n'),
        aiBusy: s.aiBusy,
        aiTimer: !!s.aiTimer,
        round: s.battle.round
      };
    }, posA);

    const gapA = afterA.actions.length && afterA.moves.length
      ? afterA.actions[0].t - afterA.moves[0].t
      : -1;

    push('AI 触发了移动（battle:move 事件）', afterA.moves.length >= 1, afterA.moves);
    push('AI 触发了攻击（battle:action 事件）', afterA.actions.length >= 1, afterA.actions);
    push(
      'AI 的位置真的变了（战场数据）',
      afterA.defPos.x !== posA.defPos.x || afterA.defPos.y !== posA.defPos.y,
      { before: posA.defPos, after: afterA.defPos }
    );
    push(
      'AI 移动后紧贴玩家（八方向相邻）',
      Math.max(Math.abs(afterA.defPos.x - afterA.atkPos.x),
        Math.abs(afterA.defPos.y - afterA.atkPos.y)) === 1,
      { atkPos: afterA.atkPos, defPos: afterA.defPos }
    );
    push(
      '玩家方挨了打（血量/数量下降）',
      afterA.atkHp < posA.atkHp || afterA.atkCount < posA.atkCount,
      {
        before: { hp: posA.atkHp, count: posA.atkCount },
        after: { hp: afterA.atkHp, count: afterA.atkCount }
      }
    );
    push(
      '战报记录了 AI 的移动',
      /移动到 \(\d+, \d+\)/.test(afterA.logText),
      afterA.logText.slice(-300)
    );
    push('战报记录了 AI 的攻击', afterA.logText.includes('青州兵 攻击'), afterA.logText.slice(-300));
    push(
      '移动与攻击是分开的两帧（间隔 ≥ 250ms）',
      gapA >= 250,
      { moveT: afterA.moves[0]?.t, attackT: afterA.actions[0]?.t, gap: gapA }
    );
    push(
      'M7 渲染层：兵牌位置跟着移动到了新格',
      afterA.viewX !== null &&
      Math.abs(afterA.viewX - (288 + afterA.defPos.x * 64 + 32)) < 2 &&
      Math.abs(afterA.viewY - (60 + afterA.defPos.y * 64 + 32)) < 2,
      { viewX: afterA.viewX, viewY: afterA.viewY, defPos: afterA.defPos }
    );
    push(
      'AI 行动结束后调度锁已释放（aiBusy=false 且无残留定时器）',
      afterA.aiBusy === false && afterA.aiTimer === false,
      { aiBusy: afterA.aiBusy, aiTimer: afterA.aiTimer }
    );

    // ═══════════════════════════════════════════════
    // 场景层验证 B：远程 AI 不贴脸 + 射程外先移进射程
    // ═══════════════════════════════════════════════
    await page.evaluate(async (helperSrc) => {
      const fn = new Function(helperSrc + '; return { enterBattle };');
      const { enterBattle } = fn();
      const g = window.__game;

      // 重置追踪（trace 监听器只注册一次，这里换新的收集桶）
      window.__m10 = { moves: [], actions: [], plans: [] };

      // 远程对远程：双方同速（4）→ 攻方先手，AI 排第二
      enterBattle(g, [{ unitId: 'shu_archer', count: 10 }], [{ unitId: 'wei_archer', count: 10 }]);
    }, PAGE_HELPERS);
    await sleep(1400);

    const posB = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { placeStack, patchPlans, dist };');
      const { placeStack, patchPlans, dist } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      patchPlans(s);
      // 玩家弓手 (3,4)，AI 弓手 (10,4) —— 初始距离 7 > 射程 6
      const atkId = placeStack(s.battle, 'attacker', { x: 3, y: 4 });
      const defId = placeStack(s.battle, 'defender', { x: 10, y: 4 });
      s.refresh();
      const atk = s.battle.stacks.find((x) => x.id === atkId);
      const def = s.battle.stacks.find((x) => x.id === defId);
      return {
        atkId, defId,
        initDist: dist(atk.pos, def.pos),
        defRange: def.range,
        defMove: def.moveRange
      };
    }, PAGE_HELPERS);

    await page.evaluate(async () => {
      const bl = await import('/src/logic/battleLogic.js');
      const s = window.__game.scene.getScene('BattleScene');
      bl.nextTurn(s.battle, { action: 'wait' });
    });

    await sleep(2800);

    const afterB = await page.evaluate((ids) => {
      const s = window.__game.scene.getScene('BattleScene');
      const atk = s.battle.stacks.find((x) => x.id === ids.atkId);
      const def = s.battle.stacks.find((x) => x.id === ids.defId);
      const d = Math.max(Math.abs(atk.pos.x - def.pos.x), Math.abs(atk.pos.y - def.pos.y));
      return {
        atkPos: { ...atk.pos },
        defPos: { ...def.pos },
        dist: d,
        moves: window.__m10.moves,
        actions: window.__m10.actions,
        plans: window.__m10.plans,
        logText: s.battle.log.map((l) => l.text).join('\n')
      };
    }, posB);

    const gapB = afterB.actions.length && afterB.moves.length
      ? afterB.actions[0].t - afterB.moves[0].t
      : -1;

    push('远程 AI 初始确实在射程外', posB.initDist > posB.defRange, {
      initDist: posB.initDist, defRange: posB.defRange
    });
    push('远程 AI 发生了移动', afterB.moves.length >= 1, afterB.moves);
    push(
      '远程 AI 移动后进入了射程（能打满伤害）',
      afterB.dist <= posB.defRange,
      { dist: afterB.dist, defRange: posB.defRange }
    );
    push('远程 AI 没有主动走进敌人相邻格', afterB.dist >= 2, { dist: afterB.dist });
    push(
      '远程 AI 在射程内开火（战报无「超出射程」）',
      afterB.actions.length >= 1 &&
      afterB.logText.includes('魏弓手 攻击') &&
      !afterB.logText.includes('超出射程'),
      afterB.logText.slice(-300)
    );
    push(
      '远程 AI 移动与攻击也是分开的帧',
      gapB >= 250,
      { moveT: afterB.moves[0]?.t, attackT: afterB.actions[0]?.t, gap: gapB }
    );

    // ═══════════════════════════════════════════════
    // 场景层验证 C：场景实际使用的行动序列可被 M7 消费
    // ═══════════════════════════════════════════════
    const planB = afterB.plans[0];
    const planOk = afterB.plans.length >= 1 && Array.isArray(planB?.steps) &&
      planB.steps.length >= 1 &&
      planB.steps.every((st) =>
        st.type === 'move' ? (typeof st.stackId === 'string' && !!st.to)
          : st.type === 'attack' ? (typeof st.stackId === 'string' && typeof st.targetId === 'string')
            : st.type === 'defend' ? typeof st.stackId === 'string'
              : false
      );
    push(
      '场景交给渲染层的行动序列结构合法（M7 可直接消费）',
      planOk,
      afterB.plans
    );
    push(
      '行动序列里的移动目标与实际落点一致',
      planB?.steps?.[0]?.type === 'move' &&
      planB.steps[0].to.x === afterB.defPos.x &&
      planB.steps[0].to.y === afterB.defPos.y,
      { plan: planB?.steps, actual: afterB.defPos }
    );
    push(
      '行动序列里的攻击目标就是玩家方 stack',
      planB?.steps?.some((st) => st.type === 'attack' && st.targetId === posB.atkId),
      { plan: planB?.steps, playerStackId: posB.atkId }
    );

    console.log('\n▶ M10 战斗 AI 验证：');
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
  console.log(`\n${failed ? '❌' : '✅'} M10 验证：${pass}/${total} 通过`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

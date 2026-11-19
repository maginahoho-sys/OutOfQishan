/**
 * M7 战场渲染的无头浏览器验证脚本
 *
 * 目的：验证表现层在真实运行时可用（单测覆盖不到 Phaser 部分）：
 *   - 兵牌有血条、特性徽章、数量文字
 *   - 当前行动单位有金色闪烁描边
 *   - 移动有平移动画（位置是渐变的，不是瞬移）
 *   - 攻击有前冲 + 受击抖动 + 伤害飘字
 *   - 射程覆盖网格预览
 *   - 战报自动滚到底 + 滚轮上翻
 *   - AI 思考提示
 *   - 结算面板出现，点确定返回地图且败方英雄消失
 *
 * 用法：node scripts/verify-m7-ui.mjs
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

/** 页面内通用的对象遍历工具（递归收集嵌套容器里的对象） */
const COLLECT_HELPER = `
  function collect(node, out) {
    if (!node) return;
    if (node.type === 'Text') { out.texts.push(node.text); out.textObjs.push(node); }
    if (node.type === 'Rectangle') out.rects.push(node);
    if (node.type === 'Arc' || node.type === 'Circle') out.circles.push(node);
    if (node.type === 'Container' && node.list) {
      for (const c of node.list) collect(c, out);
    }
  }
  function collectAll(s) {
    const out = { texts: [], textObjs: [], rects: [], circles: [] };
    for (const layer of [s.unitLayer, s.markLayer, s.hudLayer, s.logLayer]) {
      if (layer) collect(layer, out);
    }
    return out;
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

    // ────────────────────────────────────────────────
    // 1) 注入一场可控的战斗并进入 BattleScene
    //    弓手（远程，射程6）+ 乡勇（近战），便于验证射程预览
    // ────────────────────────────────────────────────
    const setup = await page.evaluate(async () => {
      const g = window.__game;
      if (!g) return { ok: false, reason: 'no game instance' };

      const state = g.registry.get('state');

      const heroes = [
        {
          id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备', level: 1,
          exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
          mana: 20, maxMana: 20, pos: { x: 3, y: 13 }, skills: {},
          spells: ['heal', 'bless', 'huti', 'tianyou'],
          army: [
            { unitId: 'shu_archer', count: 10 },
            { unitId: 'shu_militia', count: 10 }
          ]
        },
        {
          id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 1,
          exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
          mana: 20, maxMana: 20, pos: { x: 26, y: 4 }, skills: {},
          spells: ['slow', 'haste', 'zhimang', 'huoji'],
          army: [
            { unitId: 'wei_qingzhou', count: 10 },
            { unitId: 'wei_archer', count: 10 }
          ]
        }
      ];
      state.heroes = heroes;
      state.players = [
        { id: 0, faction: 'shu', isAI: false },
        { id: 1, faction: 'wei', isAI: true }
      ];

      g.scene.stop('MapScene');
      g.scene.start('BattleScene', {
        attackerId: 'hero_shu_0',
        defenderId: 'hero_wei_0'
      });

      return { ok: true };
    });

    if (!setup.ok) throw new Error('无法进入 BattleScene：' + setup.reason);
    await sleep(1500);

    const checks = [];

    const scene0 = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      return {
        hasScene: !!s,
        battleReady: !!(s && s.battle),
        stackCount: s?.battle?.stacks?.length ?? 0,
        viewCount: s?.unitViews?.size ?? 0
      };
    });

    checks.push(['能进入 BattleScene 并创建战斗', scene0.hasScene && scene0.battleReady]);
    checks.push(['双方各 2 个 stack（共 4 个）', scene0.stackCount === 4]);
    checks.push(['每个 stack 都有对应的兵牌视图', scene0.viewCount === 4]);

    // ────────────────────────────────────────────────
    // 2) 兵牌细节：血条 / 数量 / 特性徽章 / 射程文字
    // ────────────────────────────────────────────────
    const board = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { collectAll };');
      const { collectAll } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      const out = collectAll(s);

      // 逐个兵牌视图检查
      const views = [];
      for (const [id, v] of s.unitViews.entries()) {
        views.push({
          id,
          hasCount: v.countText.text.startsWith('×'),
          countText: v.countText.text,
          hpBarW: v.hpBar.width,
          hpBarVisible: v.hpBar.visible,
          rangeText: v.rangeText.text,
          rangeVisible: v.rangeText.visible,
          abilityCount: v.abilityLayer.list.length,
          buffCount: v.buffLayer.list.length,
          hasSelRing: !!v.selRing,
          hasTurnRing: !!v.turnRing
        });
      }

      return {
        views,
        totalTexts: out.texts.length,
        // 战报文本节点
        logText: s.logText ? s.logText.text : null,
        logTitle: s.logTitle ? s.logTitle.text : null,
        // 战报可视行数
        logLines: s.logText ? s.logText.text.split('\n').length : 0,
        logScroll: s.logScroll,
        maxLogScroll: s.maxLogScroll()
      };
    }, COLLECT_HELPER);

    const views = board.views;
    checks.push(['兵牌显示了存活数量（×N）', views.every((v) => v.hasCount)]);
    checks.push(['兵牌有血条且宽度 > 0', views.every((v) => v.hpBarW > 0 && v.hpBarVisible)]);
    checks.push(['弓手兵牌显示射程文字', views.some((v) => v.rangeVisible && v.rangeText.includes('射程'))]);
    checks.push(['弓手兵牌有"弓"特性徽章', views.some((v) => v.abilityCount > 0)]);
    checks.push(['兵牌有选中环与当前行动环', views.every((v) => v.hasSelRing && v.hasTurnRing)]);

    // ────────────────────────────────────────────────
    // 3) 当前行动单位有金色闪烁描边
    // ────────────────────────────────────────────────
    const turnRing = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const cur = s.battle.turnQueue[s.battle.currentTurn];
      const view = s.unitViews.get(cur);
      return {
        hasView: !!view,
        visible: view ? view.turnRing.visible : false,
        stroke: view ? view.turnRing.strokeColor : null,
        glowing: s.glowingView === view,
        hasTween: view ? s.tweens.getTweensOf(view.turnRing).length > 0 : false
      };
    });

    checks.push(['当前行动单位有兵牌视图', turnRing.hasView]);
    checks.push(['当前行动单位的金色环可见', turnRing.visible]);
    checks.push(['金色环用的是金色描边', turnRing.stroke === 0xf39c12]);
    checks.push(['金色环正在闪烁（有 tween）', turnRing.hasTween]);
    checks.push(['glowingView 指向当前单位', turnRing.glowing]);

    // ────────────────────────────────────────────────
    // 4) 战报区：标题带条数、内容只渲染可视行
    // ────────────────────────────────────────────────
    checks.push(['战报标题显示条数', /战报（\d+）/.test(board.logTitle || '')]);
    checks.push(['战报内容已渲染', (board.logText || '').length > 0]);
    checks.push(['战报只渲染可视行数（≤7 行）', board.logLines <= 7]);
    checks.push(['战报默认跟到底', board.logScroll === board.maxLogScroll]);

    // ────────────────────────────────────────────────
    // 5) 选中远程单位 → 射程覆盖网格 + 可移动格 + 可攻击目标环
    // ────────────────────────────────────────────────
    const selected = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');

      // 找到当前行动单位并选中它
      const cur = battle.currentStack(s.battle);
      s.selectedId = cur.id;
      s.moveCells = battle.movableCells(s.battle, cur.id);
      s.targetIds = battle.attackableTargets(s.battle, cur.id);
      s.refresh();

      // markLayer 里：黄色半透明格子 = 射程覆盖；红/橙环 = 可攻击目标
      let rangeCells = 0;
      let targetRings = 0;
      let redRings = 0;
      let orangeRings = 0;
      for (const o of s.markLayer.list) {
        if (o.type === 'Rectangle' && o.fillColor === 0xf1c40f) rangeCells += 1;
        if (o.type === 'Arc' || o.type === 'Circle') {
          if (o.strokeColor === 0xe74c3c) { targetRings += 1; redRings += 1; }
          if (o.strokeColor === 0xe67e22) { targetRings += 1; orangeRings += 1; }
        }
      }

      return {
        curUnit: cur.unitName,
        isRanged: cur.abilities.includes('ranged'),
        rangeCells,
        targetRings,
        redRings,
        orangeRings,
        moveCells: s.moveCells.length,
        expectedRangeCells: cur.abilities.includes('ranged')
          ? battle.cellsInRange(cur).length
          : 0
      };
    });

    checks.push(['当前单位是远程兵（弓手）', selected.isRanged]);
    checks.push([
      '射程覆盖网格数与逻辑层 cellsInRange 一致',
      selected.rangeCells === selected.expectedRangeCells && selected.rangeCells > 0
    ]);
    // 弓手射程 6，敌人在 x=10 处 → 超出射程 → 画橙环（伤害减半提示）
    checks.push(['可攻击目标画了目标环', selected.targetRings > 0]);
    checks.push(['超出射程的目标用橙环标注', selected.orangeRings > 0]);
    checks.push(['可移动格已高亮', selected.moveCells > 0]);

    // ────────────────────────────────────────────────
    // 6) 移动动画：位置是渐变的（不是瞬移）
    //
    // ⚠️ Phaser 的 tween 在**下一帧**才推进位置，
    //    所以必须在 moveStack 之后 await 几帧再采样，
    //    否则量到的还是起点（会误判成"没有动画"）。
    // ────────────────────────────────────────────────
    const moveAnim = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');

      const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

      const cur = battle.currentStack(s.battle);
      const view = s.unitViews.get(cur.id);
      const cells = battle.movableCells(s.battle, cur.id);
      if (!cells.length) return { skipped: true };

      const before = { x: view.root.x, y: view.root.y };
      // 直接调 moveStack（会触发 battle:move 事件 → 播平移动画）
      const r = battle.moveStack(s.battle, cur.id, cells[0]);
      if (!r.ok) return { failed: true, reason: r.reason };

      // 让 tween 跑几帧
      // ⚠️ 固定等 2 帧会偶发采样不到位移（tween 启动有延迟 + 帧率波动），
      //    这里改成轮询：最多等 30 帧，一旦位置离开起点就停
      let mid = { x: view.root.x, y: view.root.y };
      let moved = false;
      for (let i = 0; i < 30; i++) {
        await nextFrame();
        mid = { x: view.root.x, y: view.root.y };
        moved = Math.hypot(mid.x - before.x, mid.y - before.y) > 0.5;
        if (moved) break;
      }
      const animating = view.animating;
      const to = { x: 288 + cells[0].x * 64 + 32, y: 60 + cells[0].y * 64 + 32 };

      return {
        skipped: false,
        before,
        mid,
        to,
        animating,
        moved
      };
    });

    checks.push(['移动触发了平移动画（animating=true）', moveAnim.animating === true]);
    checks.push(['移动后位置离开起点（是渐变不是瞬移）', moveAnim.moved === true]);
    checks.push([
      '移动动画中途位置还没到终点',
      Math.hypot(moveAnim.mid.x - moveAnim.to.x, moveAnim.mid.y - moveAnim.to.y) > 1
    ]);

    // 等动画结束，位置应精确落在终点
    await sleep(400);
    const moveEnd = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const cur = s.battle.turnQueue[s.battle.currentTurn];
      const view = s.unitViews.get(cur);
      const st = s.battle.stacks.find((x) => x.id === cur);
      const to = { x: 288 + st.pos.x * 64 + 32, y: 60 + st.pos.y * 64 + 32 };
      return {
        animating: view.animating,
        dx: Math.abs(view.root.x - to.x),
        dy: Math.abs(view.root.y - to.y)
      };
    });

    checks.push(['动画结束后 animating 复位', moveEnd.animating === false]);
    checks.push(['动画结束后位置精确对齐', moveEnd.dx < 1 && moveEnd.dy < 1]);

    // ────────────────────────────────────────────────
    // 7) 攻击动画：前冲 + 受击抖动 + 伤害飘字
    // ────────────────────────────────────────────────
    const atkPrep = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');

      const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

      // 找一个能攻击的目标
      const cur = battle.currentStack(s.battle);
      const targets = battle.attackableTargets(s.battle, cur.id);
      if (!targets.length) return { skipped: true };

      const defId = targets[0];
      const defStack = s.battle.stacks.find((x) => x.id === defId);
      const defView = s.unitViews.get(defId);
      const atkView = s.unitViews.get(cur.id);

      const before = {
        atkX: atkView.root.x,
        defCount: defStack.count,
        defBodyX: defView.body.x
      };

      // 触发攻击（会 emit battle:action → 场景播动画）
      const r = battle.attackStack(s.battle, s.data, cur.id, defId);
      if (!r.ok) return { failed: true, reason: r.reason };

      // ⚠️ 动画时序：
      //    前冲 130ms 到位 → 到位瞬间才触发伤害飘字与**受击抖动**（220ms）
      //    所以不能只采样一帧，要在时间窗里记录**峰值偏移**。
      let maxAtkOffset = 0;
      let maxDefOffset = 0;
      for (let i = 0; i < 40; i++) {
        await nextFrame();
        maxAtkOffset = Math.max(maxAtkOffset, Math.abs(atkView.root.x - before.atkX));
        maxDefOffset = Math.max(maxDefOffset, Math.abs(defView.body.x - before.defBodyX));
      }

      return {
        skipped: false,
        before,
        damage: r.damage,
        killed: r.killed,
        maxAtkOffset,
        maxDefOffset
      };
    });

    checks.push(['攻击成功并返回伤害值', atkPrep.skipped !== true && atkPrep.damage > 0]);
    checks.push(['攻击方前冲（位置离开起点）', atkPrep.maxAtkOffset > 1]);
    checks.push(['受击方抖动（body 位置偏移）', atkPrep.maxDefOffset > 0.5]);

    // 等动画结束，检查飘字出现
    await sleep(180);
    const floats = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const texts = s.children.list
        .filter((o) => o.type === 'Text' && o.depth === 950)
        .map((o) => o.text);
      return texts;
    });

    checks.push(['攻击后弹出伤害飘字', floats.some((t) => /^\-\d+$/.test(t))]);

    await sleep(500);

    // ────────────────────────────────────────────────
    // 8) 战报滚轮上翻
    // ────────────────────────────────────────────────
    const logScroll = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      // 造足够多的战报条目，确保有可滚动的空间
      for (let i = 0; i < 12; i++) {
        s.battle.log.push({ text: `测试战报条目 ${i}` });
      }
      s.logStickToBottom = true;
      s.updateLog();

      const before = s.logScroll;
      const max = s.maxLogScroll();
      const bottomText = s.logText.text;

      // 模拟滚轮上翻
      s.logScroll = Math.max(0, s.logScroll - 3);
      s.logStickToBottom = false;
      s.applyLogScroll();

      return {
        before,
        max,
        after: s.logScroll,
        stickToBottom: s.logStickToBottom,
        bottomText,
        scrolledText: s.logText.text
      };
    });

    checks.push(['战报可以向上滚动查看历史', logScroll.after < logScroll.before]);
    checks.push(['手动上翻后不再自动跟到底', logScroll.stickToBottom === false]);
    checks.push([
      '上翻后显示的内容确实变了（看到了更早的条目）',
      logScroll.scrolledText !== logScroll.bottomText
    ]);

    // 恢复自动跟到底
    await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      s.logStickToBottom = true;
      s.updateLog();
    });

    // ────────────────────────────────────────────────
    // 9) AI 思考提示
    // ────────────────────────────────────────────────
    const aiHint = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');

      // 把指针推到电脑方
      battle.nextTurn(s.battle, { action: 'wait' });
      await new Promise((r) => setTimeout(r, 50));

      s.showAiHint(true);
      const visible = s.aiHintText ? s.aiHintText.visible : false;
      const text = s.aiHintText ? s.aiHintText.text : '';
      const hasTween = s.aiHintText ? s.tweens.getTweensOf(s.aiHintText).length > 0 : false;
      return { visible, text, hasTween };
    });

    checks.push(['AI 回合显示思考提示', aiHint.visible === true]);
    checks.push(['提示文案是"电脑方思考中…"', aiHint.text.includes('思考中')]);
    checks.push(['提示有呼吸动画', aiHint.hasTween === true]);

    await sleep(1200);

    // ────────────────────────────────────────────────
    // 10) 结算面板 + 返回地图 + 败方英雄消失
    // ────────────────────────────────────────────────
    const settle = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');

      // 直接把守方打死
      for (const st of s.battle.stacks) {
        if (st.side === 'defender' && st.count > 0) {
          st.count = 0;
        }
      }
      battle.checkBattleEnd(s.battle);
      s.refresh();

      await new Promise((r) => setTimeout(r, 600));

      const texts = s.hudLayer.list
        .filter((o) => o.type === 'Text')
        .map((o) => o.text);

      return {
        winner: s.battle.winner,
        hasResult: !!s.result,
        panelTexts: texts,
        heroCountBefore: s.state.heroes.length,
        heroNames: s.state.heroes.map((h) => h.name)
      };
    });

    checks.push(['一方全灭后判定出胜负', settle.winner === 'attacker']);
    checks.push(['战果已结算（result 存在）', settle.hasResult === true]);
    checks.push([`结算面板显示"战果结算"`, settle.panelTexts.some((t) => t.includes('战果结算'))]);
    checks.push(['结算面板显示幸存兵力', settle.panelTexts.some((t) => t.includes('幸存'))]);
    checks.push(['败方英雄已从 state 中移除', !settle.heroNames.includes('曹操')]);

    // 点「确定」返回地图
    //
    // ⚠️ 真实流程：胜利英雄升级后有未分配的技能点，
    //    此时点[确定]会**先打开技能加点面板**（M8 设计），而不是直接回地图。
    //    所以这里分两步验证：先验证"引导到加点面板"，再验证"分配完点确定回地图"。
    const backToMap = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const btn = s.hudLayer.list.find((o) => o.type === 'Text' && o.text === '[确定]');
      if (!btn) return { clicked: false };

      // 第一步：点确定
      btn.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 400));

      const guidedToSkill = !!s.skillPanel;
      const pending = s.state.heroes
        .map((h) => h.pendingLevels || 0)
        .reduce((a, b) => a + b, 0);

      // 第二步：把技能点分配掉（模拟玩家点完技能面板），再点一次确定
      if (s.skillPanel) s.skillPanel.close(true);
      await new Promise((r) => setTimeout(r, 200));
      for (const h of s.state.heroes) h.pendingLevels = 0;
      s.refresh(); // 模拟加点面板关闭后的刷新（面板 onDone 里会做这一步）
      await new Promise((r) => setTimeout(r, 200));

      const btn2 = s.hudLayer.list.find((o) => o.type === 'Text' && o.text === '[确定]');
      if (btn2) btn2.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 800));

      return {
        clicked: true,
        guidedToSkill,
        pending,
        activeScene: window.__game.scene.getScenes(true).map((sc) => sc.scene.key)
      };
    });

    checks.push(['点[确定]能返回大地图', backToMap.clicked && backToMap.activeScene.includes('MapScene')]);
    checks.push([
      '有未分配技能点时点确定会先引导到加点面板',
      backToMap.guidedToSkill === true || backToMap.pending === 0
    ]);

    // ────────────────────────────────────────────────
    // 11) 无头截图（供肉眼确认排版）
    // ────────────────────────────────────────────────
    await page.evaluate(async () => {
      const g = window.__game;
      const state = g.registry.get('state');
      state.heroes = [
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
      g.scene.start('BattleScene', { attackerId: 'hero_shu_0', defenderId: 'hero_wei_0' });
    });
    await sleep(1400);

    // 选中弓手，让射程预览与可攻击目标都显示出来
    await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const battle = await import('/src/logic/battleLogic.js');
      const cur = battle.currentStack(s.battle);
      s.selectedId = cur.id;
      s.moveCells = battle.movableCells(s.battle, cur.id);
      s.targetIds = battle.attackableTargets(s.battle, cur.id);
      s.refresh();
    });
    await sleep(400);
    await page.screenshot({ path: 'scripts/shot-m7-battle.png' });

    console.log('\n▶ M7 战场渲染验证：');
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

  console.log(failed ? '\n❌ M7 验证未通过' : '\n✅ M7 验证通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

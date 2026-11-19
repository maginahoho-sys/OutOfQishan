/**
 * M9c 施法**真实鼠标点击**回归验证
 *
 * 为什么需要这个脚本（而不是沿用 verify-m9-ui.mjs 的 emit 写法）？
 *
 *   verify-m9-ui.mjs 用 `obj.emit('pointerdown')` 直接触发对象事件，
 *   那样**只会**跑对象自己的回调，不会走 Phaser 完整的事件分发链。
 *   而线上 bug 恰恰出在分发链的顺序上：
 *
 *     Phaser.InputPlugin.processDownEvents：
 *       ① 先对命中的 GameObject 发 pointerdown（魔法卡 onPick 在这里跑）
 *       ② 再对场景发 POINTER_DOWN（BattleScene 的格子点击处理器在这里跑）
 *
 *   点魔法卡时，①已经把面板关掉并进入选目标模式（castingSpellId 已设值），
 *   ②接着跑，看到 castingSpellId 非空、落点又不是合法目标 → cancelCasting()，
 *   把**刚建立**的施法模式当场取消。玩家看到的就是"点了魔法没反应"。
 *
 *   所以这里一律用 page.mouse.click（真实鼠标事件），才能覆盖这条链路。
 *
 * 覆盖：
 *   A. 攻方单体魔法：点[施法] → 点卡 → 点目标 → 法力扣减 / 目标回血
 *   B. 攻方 buff 魔法：buff 真的挂到目标身上
 *   C. 攻方群体魔法：无需选目标，点卡直接生效
 *   D. 守方（电脑主动进攻）：玩家照样能施法
 *   E. 选目标模式下点空白处能取消
 *   F. 面板打开时点战场不会误选中 / 误移动单位
 *
 * 用法：node scripts/verify-m9c-spell-click.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5209;
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
      const app = path.join(base, dir, arch,
        'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
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
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
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

/** 断言收集 */
const checks = [];
function push(name, pass, detail) {
  checks.push({ name, pass: !!pass, detail });
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
  if (!pass && detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
}

/**
 * 找场景里某个文本的屏幕坐标（供真实点击）
 * @param {string} text 文本内容
 * @param {boolean} [panelOnly] 只在弹层里找（避免和战场上的同名文本混淆）
 */
async function textPos(page, text, panelOnly = false) {
  return page.evaluate(({ t, panelOnly: po }) => {
    const s = window.__game.scene.getScene('BattleScene');
    let found = null;
    const walk = (items, inPanel) => {
      for (const o of items || []) {
        if (o.type === 'Text' && o.text === t && (!po || inPanel)) found = o;
        if (o.type === 'Container' && o.list) walk(o.list, inPanel || o.depth >= 900);
      }
    };
    walk(s.children.list, false);
    if (!found) return null;
    const b = found.getBounds();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }, { t: text, panelOnly });
}

/** 当前施法相关状态快照 */
async function snap(page) {
  return page.evaluate(() => {
    const s = window.__game.scene.getScene('BattleScene');
    const hero = s.playerHero;
    return {
      humanSide: s.humanSide,
      castingSpellId: s.castingSpellId,
      castTargetIds: s.castTargetIds ? [...s.castTargetIds] : [],
      selectedId: s.selectedId,
      panelOpen: !!s.spellPanel,
      mana: hero ? hero.mana : null,
      stacks: s.battle.stacks.map((x) => ({
        id: x.id, name: x.unitName, side: x.side, count: x.count,
        buffs: (x.buffs || []).map((b) => b.spellId)
      }))
    };
  });
}

/** 真实点击一个文本 */
async function clickText(page, text) {
  const p = await textPos(page, text);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(450);
  return true;
}

/** 真实点击某个 stack 所在格的中心 */
async function clickStack(page, stackId) {
  const p = await page.evaluate((id) => {
    const s = window.__game.scene.getScene('BattleScene');
    const t = s.battle.stacks.find((x) => x.id === id);
    if (!t) return null;
    const GRID_X = 288, GRID_Y = 60, CELL = 64;
    return { x: GRID_X + t.pos.x * CELL + CELL / 2, y: GRID_Y + t.pos.y * CELL + CELL / 2 };
  }, stackId);
  if (!p) return false;
  await page.mouse.click(p.x, p.y);
  await sleep(450);
  return true;
}

/**
 * 开一场战斗
 * @param {'attack'|'defend'} mode 玩家主动进攻 / 电脑主动进攻
 */
async function startBattle(page, mode) {
  await page.evaluate((m) => {
    const g = window.__game;
    const st = g.registry.get('state');
    const me = st.heroes.find((h) => h.playerId === 0);
    const foe = st.heroes.find((h) => h.playerId === 1);
    // 补全魔法池，便于覆盖单体 / 群体 / buff / debuff
    me.spells = ['heal', 'bless', 'huti', 'tianyou', 'quxie'];
    me.mana = 30; me.maxMana = 30;
    if (g.scene.getScene('BattleScene')) g.scene.stop('BattleScene');
    g.scene.start('BattleScene', m === 'attack'
      ? { attackerId: me.id, defenderId: foe.id }
      : { attackerId: foe.id, defenderId: me.id });
  }, mode);
  await sleep(1400);
}

async function main() {
  console.log('▶ 启动 vite dev server...');
  const server = await startDevServer();
  console.log(`  ✅ dev server 就绪 http://localhost:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle0' });
    await sleep(2500);

    // ═══════════════════════════════════════════════
    // A. 攻方单体魔法（治疗）
    // ═══════════════════════════════════════════════
    console.log('\n▶ A. 攻方 · 单体魔法（治疗）');
    await startBattle(page, 'attack');

    await clickText(page, '[施法]');
    let st = await snap(page);
    push('点[施法]能打开面板', st.panelOpen === true, st);

    await clickText(page, '治疗');
    st = await snap(page);
    push('点魔法卡后进入选目标模式（castingSpellId = heal）', st.castingSpellId === 'heal', st);
    push('合法目标已列出（本方 2 个 stack）', st.castTargetIds.length === 2, st.castTargetIds);
    push('面板已关闭', st.panelOpen === false, st);

    // 先把乡勇打掉一些血，好观察"回血"
    await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const t = s.battle.stacks.find((x) => x.id === 's0');
      t.count = Math.max(1, t.count - 10);
    });
    const before = await snap(page);
    const targetBefore = before.stacks.find((x) => x.id === 's0').count;

    await clickStack(page, 's0');
    st = await snap(page);
    const targetAfter = st.stacks.find((x) => x.id === 's0').count;
    push('点目标后法力被扣除（30 → 26）', st.mana === 26, { mana: st.mana });
    push('治疗生效：目标兵力回升', targetAfter > targetBefore, { targetBefore, targetAfter });
    push('施法模式已退出', st.castingSpellId === null, st);

    // ═══════════════════════════════════════════════
    // B. 攻方 buff 魔法（祝福）
    // ═══════════════════════════════════════════════
    console.log('\n▶ B. 攻方 · buff 魔法（祝福）');
    await startBattle(page, 'attack');
    await clickText(page, '[施法]');
    await clickText(page, '祝福');
    st = await snap(page);
    push('祝福进入选目标模式', st.castingSpellId === 'bless', st);
    await clickStack(page, 's0');
    st = await snap(page);
    const buffed = st.stacks.find((x) => x.id === 's0').buffs;
    push('祝福 buff 挂到了目标身上', buffed.includes('bless'), { buffs: buffed });
    push('祝福扣法力 3', st.mana === 27, { mana: st.mana });

    // ═══════════════════════════════════════════════
    // C. 攻方群体魔法（天佑，全体友军）
    // ═══════════════════════════════════════════════
    console.log('\n▶ C. 攻方 · 群体魔法（天佑）');
    await startBattle(page, 'attack');
    await clickText(page, '[施法]');
    await clickText(page, '天佑');
    st = await snap(page);
    push('群体魔法不进入选目标模式', st.castingSpellId === null, st);
    push('群体魔法直接扣法力 12', st.mana === 18, { mana: st.mana });
    const allies = st.stacks.filter((x) => x.side === 'attacker');
    push('全体友军都获得 buff', allies.every((x) => x.buffs.includes('tianyou')), { allies });

    // ═══════════════════════════════════════════════
    // D. 守方（电脑主动进攻）也能施法
    // ═══════════════════════════════════════════════
    console.log('\n▶ D. 守方（电脑主动进攻）');
    await startBattle(page, 'defend');
    st = await snap(page);
    push('玩家在守方', st.humanSide === 'defender', st);

    await clickText(page, '[施法]');
    st = await snap(page);
    push('守方能打开施法面板', st.panelOpen === true, st);

    await clickText(page, '护体');
    st = await snap(page);
    push('守方点魔法卡进入选目标模式', st.castingSpellId === 'huti', st);

    // 守方的 stack id 不一定是 s0，取第一个合法目标
    const defTarget = st.castTargetIds[0];
    await clickStack(page, defTarget);
    st = await snap(page);
    push('守方施法扣法力 4', st.mana === 26, { mana: st.mana });
    push('守方 buff 挂到了守方单位身上',
      st.stacks.filter((x) => x.side === 'defender').some((x) => x.buffs.includes('huti')),
      st.stacks);

    // ═══════════════════════════════════════════════
    // E. 选目标模式下点空白处能取消
    // ═══════════════════════════════════════════════
    console.log('\n▶ E. 取消施法');
    await startBattle(page, 'attack');
    await clickText(page, '[施法]');
    await clickText(page, '治疗');
    st = await snap(page);
    push('再次进入选目标模式', st.castingSpellId === 'heal', st);

    // 点战场中部一个空格（没有任何 stack）
    await page.mouse.click(700, 400);
    await sleep(400);
    st = await snap(page);
    push('点空白处取消施法', st.castingSpellId === null, st);
    push('取消施法不扣法力', st.mana === 30, { mana: st.mana });

    // ═══════════════════════════════════════════════
    // F. 面板打开时点战场不会误操作
    // ═══════════════════════════════════════════════
    console.log('\n▶ F. 面板打开时的点击隔离');
    await startBattle(page, 'attack');
    await clickText(page, '[施法]');
    st = await snap(page);
    push('面板已打开', st.panelOpen === true, st);

    // 面板打开时点一个本方单位所在格 —— 不该被选中
    // （点击先被面板遮罩接住 → 关面板；穿不透到战场，所以单位不会被选中）
    await clickStack(page, 's0');
    st = await snap(page);
    push('面板打开时点战场不会选中单位', st.selectedId === null, st);
    push('点面板外遮罩吞掉点击并关闭面板（不误触战场）', st.panelOpen === false, st);

    // 重新开面板，验证 [关闭] 按钮
    await clickText(page, '[施法]');
    st = await snap(page);
    push('重新打开面板', st.panelOpen === true, st);
    await clickText(page, '[关闭]');
    st = await snap(page);
    push('点[关闭]能关掉面板', st.panelOpen === false, st);
    push('关闭面板后也没有误选中单位', st.selectedId === null, st);

    push('全程无 JS 报错', errors.length === 0, errors.slice(0, 3));
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${'─'.repeat(56)}`);
  console.log(`M9c 施法点击回归：${checks.length - failed.length}/${checks.length} 通过`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ❌ ${f.name}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 全部通过');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * M13 UI 组件库的无头浏览器验证脚本
 *
 * 目的：验证 M13 的 6 个组件在**真实运行时**（浏览器 + Phaser）可用。
 * 跑的是 DemoScene（?demo=1），逐个组件做交互断言。
 *
 * 契约验收（docs/契约/M13-UI组件.md）：
 *   ① 在任意场景 demo 调用：按钮可点、禁用置灰；toast 能弹出；确认弹窗回调正确
 *   ② M5/M7 场景引入后不报 import 错误
 *
 * 覆盖组件：
 *   createButton   可点 / 禁用置灰 / setEnabled 切换 / setText 改字
 *   createPanel    标题栏 / 副标题 / 底部提示 / 内容区 body
 *   createUnitCard 色块 + 首字 + 数量 / setCount
 *   toast          直接调用能弹 / bus 'ui:toast' 也能触发
 *   confirmDialog  确定回调 / 取消回调
 *   createCounter  加减 / 边界禁用 / 上下限钳制
 *
 * 用法：node scripts/verify-m13-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5201;

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

/**
 * 启动 vite dev server
 */
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
 * 页面内工具：递归收集某个节点下的所有文本
 *
 * ⚠️ 节点可能是 Scene（用 children.list）或 Container（用 list），
 *    这里两种都兼容，否则收集场景里的按钮会静默返回空数组。
 */
const COLLECT_HELPER = `
  function collectTexts(node) {
    const out = [];
    const list = node ? (node.children ? node.children.list : node.list) : [];
    const walk = (items) => {
      for (const o of items || []) {
        if (o.type === 'Text') out.push(o);
        else if (o.type === 'Container' && o.list) walk(o.list);
      }
    };
    walk(list);
    return out;
  }
  function demoScene() {
    const s = window.__game.scene.getScene('DemoScene');
    return (s && s.scene.isActive()) ? s : null;
  }
`;

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
  console.log(`  ${pass ? '✅' : '❌'} ${name}`);
}

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

  try {
    // ═══════════════════════════════════════════════
    // A. 进入 DemoScene
    // ═══════════════════════════════════════════════
    await page.goto(`http://localhost:${PORT}/?demo=1`, { waitUntil: 'networkidle0' });
    await page.waitForFunction(
      () => {
        const s = window.__game?.scene?.getScene('DemoScene');
        return s && s.scene.isActive() && s.demoReady === true;
      },
      { timeout: 15000 }
    );

    const boot = await page.evaluate(() => {
      const s = window.__game.scene.getScene('DemoScene');
      return {
        active: s.scene.isActive(),
        ready: s.demoReady === true,
        childCount: s.children.list.length
      };
    });
    push('A：?demo=1 能进入 DemoScene', boot.active && boot.ready, boot);
    push('A：DemoScene 渲染出了元素', boot.childCount > 10, boot);

    // ═══════════════════════════════════════════════
    // B. createButton —— 可点 / 禁用 / setEnabled / setText
    // ═══════════════════════════════════════════════
    const btn = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();

      // 正常按钮：点它，看计数是否 +1
      const before = s.btnClickCount;
      s.btnNormal.emit('pointerdown');
      const afterClick = s.btnClickCount;

      // 禁用按钮：点它，计数不应变
      const disBefore = s.disabledClickCount;
      s.btnDisabled.emit('pointerdown');
      const disAfter = s.disabledClickCount;

      // 禁用态的视觉：底色应该是禁用色、文字应该是弱化色
      const disTexts = collectTexts(s.btnDisabled);
      const disLabel = disTexts.find((t) => t.text === '[禁用按钮]');
      const disAlpha = s.btnDisabled.alpha;
      const disBgColor = s.btnDisabled.list[0].fillColor;
      // ⚠️ Phaser 的 disableInteractive 是延迟移除，input 对象仍然存在，
      //    要看 input.enabled 才准
      const disInteractive = !!(s.btnDisabled.list[0].input?.enabled);

      // setEnabled(true) 后再点，应能触发
      s.btnDisabled.setEnabled(true);
      const enabledBg = s.btnDisabled.list[0].fillColor;
      const enabledInteractive = !!(s.btnDisabled.list[0].input?.enabled);
      const disBefore2 = s.disabledClickCount;
      s.btnDisabled.emit('pointerdown');
      const disAfter2 = s.disabledClickCount;

      // setText 改字
      s.btnNormal.setText('[改名了]');
      const renamed = collectTexts(s.btnNormal).some((t) => t.text === '[改名了]');

      return {
        afterClick,
        clickDelta: afterClick - before,
        disDelta: disAfter - disBefore,
        disAlpha,
        disBgColor,
        disInteractive,
        enabledBg,
        enabledInteractive,
        disDelta2: disAfter2 - disBefore2,
        renamed
      };
    }, COLLECT_HELPER);

    push('B：正常按钮点击后回调被触发', btn.clickDelta === 1, btn);
    push('B：禁用按钮点击不触发回调', btn.disDelta === 0, btn);
    push('B：禁用态置灰（整体透明度 < 1）', btn.disAlpha < 1, btn);
    push('B：禁用态底色是禁用色', btn.disBgColor === 0x1c2536, btn);
    push('B：禁用态不可交互（无 input）', btn.disInteractive === false, btn);
    push('B：setEnabled(true) 后恢复原底色', btn.enabledBg === 0x24365c, btn);
    push('B：setEnabled(true) 后恢复可交互', btn.enabledInteractive === true, btn);
    push('B：解除禁用后点击能触发回调', btn.disDelta2 === 1, btn);
    push('B：setText 能改按钮文字', btn.renamed === true, btn);

    // ═══════════════════════════════════════════════
    // C. createPanel —— 标题 / 副标题 / 提示 / body
    // ═══════════════════════════════════════════════
    const panel = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();
      const texts = collectTexts(s.panel.container);

      return {
        hasTitle: texts.some((t) => t.text.includes('createPanel 面板')),
        hasSubtitle: texts.some((t) => t.text.includes('副标题')),
        hasHint: texts.some((t) => t.text.includes('内容区')),
        hasInnerBtn: texts.some((t) => t.text === '[面板内按钮]'),
        bodyIsContainer: s.panel.body?.type === 'Container',
        bodyChildCount: s.panel.body?.list?.length ?? 0,
        depth: s.panel.container.depth,
        setTitleWorks: (() => {
          s.panel.setTitle('改了标题');
          const ok = collectTexts(s.panel.container).some((t) => t.text === '改了标题');
          s.panel.setTitle('② createPanel 面板');
          return ok;
        })(),
        setHintWorks: (() => {
          s.panel.setHint('改了提示');
          const ok = collectTexts(s.panel.container).some((t) => t.text === '改了提示');
          s.panel.setHint('内容区（body）由调用方自行填充');
          return ok;
        })()
      };
    }, COLLECT_HELPER);

    push('C：面板有标题', panel.hasTitle === true, panel);
    push('C：面板有副标题', panel.hasSubtitle === true, panel);
    push('C：面板有底部提示', panel.hasHint === true, panel);
    push('C：面板内容区 body 是容器', panel.bodyIsContainer === true, panel);
    push('C：body 里能放按钮', panel.bodyChildCount > 0 && panel.hasInnerBtn, panel);
    push('C：setTitle 能改标题', panel.setTitleWorks === true, panel);
    push('C：setHint 能改底部提示', panel.setHintWorks === true, panel);

    // ═══════════════════════════════════════════════
    // D. createUnitCard —— 色块 + 首字 + 数量 / setCount
    // ═══════════════════════════════════════════════
    const card = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();

      const texts = collectTexts(s.unitCard);
      // ⚠️ 立即取字符串快照：Phaser 的 Text.text 是活引用，
      //    后面 setCount 改了同一个对象，延后读取会拿到新值
      const before = texts.find((t) => t.text.startsWith('×'))?.text;
      const firstChar = texts.find((t) => t.text === '乡')?.text;
      // ⚠️ M14 起兵牌主体是「阵营底座贴图 + 兵种立绘」，
      //    不再有 Graphics 色块圆盘，阵营色改读 container.factionColor。
      const discColor = s.unitCard.factionColor;
      const iconKey = s.unitCard.iconKey ?? null;

      // 点「兵牌数量 +3」按钮，看数量有没有变
      const plusBtn = collectTexts(s).find((t) => t.text === '[兵牌数量 +3]');
      if (plusBtn) plusBtn.emit('pointerdown');

      const after = collectTexts(s.unitCard).find((t) => t.text.startsWith('×'))?.text;

      // 直接调 setCount
      s.unitCard.setCount(99);
      const after99 = collectTexts(s.unitCard).find((t) => t.text.startsWith('×'))?.text;

      return {
        beforeCount: before,
        firstChar,
        discColor,
        iconKey,
        afterCount: after,
        after99,
        hasSetCount: typeof s.unitCard.setCount === 'function'
      };
    }, COLLECT_HELPER);

    push('D：兵牌显示数量', card.beforeCount === '×12', card);
    push('D：兵牌显示兵种首字', card.firstChar === '乡', card);
    push('D：兵牌色块按阵营着色（蜀=红）', card.discColor === 0xc0392b, card);
    push('D：兵牌有 setCount 方法', card.hasSetCount === true, card);
    push('D：点「数量 +3」按钮后兵牌数量跟着变', card.afterCount === '×15', card);
    push('D：setCount 能改数量', card.after99 === '×99', card);
    // M14：兵牌带像素立绘（资源缺失时才退化为纯色块）
    push('D：兵牌带像素立绘（px_unit_*）', !!card.iconKey && card.iconKey.startsWith('px_unit_'), card);

    // ═══════════════════════════════════════════════
    // E. toast —— 直接调用 + bus 触发
    // ═══════════════════════════════════════════════
    const toastRes = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();

      const findToasts = () => s.children.list
        .filter((o) => o.type === 'Text' && /提示/.test(o.text))
        .map((o) => o.text);

      const beforeCount = findToasts().length;

      // 直接调用 toast
      const { toast } = await import('/src/scenes/ui/components.js');
      toast(s, '直接调用的测试提示');
      await new Promise((r) => setTimeout(r, 60));
      const afterDirect = findToasts();

      // 通过 bus 触发
      const { bus } = await import('/src/core/EventBus.js');
      bus.emit('ui:toast', { text: 'bus 触发的测试提示' });
      await new Promise((r) => setTimeout(r, 60));
      const afterBus = findToasts();

      return {
        beforeCount,
        hasDirect: afterDirect.some((t) => t.includes('直接调用的测试提示')),
        hasBus: afterBus.some((t) => t.includes('bus 触发的测试提示')),
        directCount: afterDirect.length,
        busCount: afterBus.length
      };
    }, COLLECT_HELPER);

    push('E：直接调用 toast 能弹出提示', toastRes.hasDirect === true, toastRes);
    push('E：bus ui:toast 也能触发提示', toastRes.hasBus === true, toastRes);

    // ═══════════════════════════════════════════════
    // F. confirmDialog —— 确定 / 取消回调
    // ═══════════════════════════════════════════════
    const dlg = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();

      // 打开弹窗
      const openBtn = collectTexts(s).find((t) => t.text === '[打开确认弹窗]');
      openBtn.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 100));

      const layer = s.confirmDialog;
      const texts = collectTexts(layer);
      const hasText = texts.some((t) => t.text.includes('确定要执行这个操作吗'));
      const okBtn = texts.find((t) => t.text === '[确定]');
      const cancelBtn = texts.find((t) => t.text === '[取消]');

      // 点「取消」
      cancelBtn.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 100));
      const afterCancel = s.confirmResult;
      const layerGone = !s.children.list.includes(layer);

      // 再打开一次，点「确定」
      openBtn.emit('pointerdown');
      await new Promise((r) => setTimeout(r, 100));
      const layer2 = s.confirmDialog;
      const texts2 = collectTexts(layer2);
      texts2.find((t) => t.text === '[确定]').emit('pointerdown');
      await new Promise((r) => setTimeout(r, 100));
      const afterConfirm = s.confirmResult;

      return {
        hasText,
        hasOkBtn: !!okBtn,
        hasCancelBtn: !!cancelBtn,
        afterCancel,
        layerGone,
        afterConfirm,
        depth: layer?.depth
      };
    }, COLLECT_HELPER);

    push('F：确认弹窗显示提示文字', dlg.hasText === true, dlg);
    push('F：确认弹窗有[确定]按钮', dlg.hasOkBtn === true, dlg);
    push('F：确认弹窗有[取消]按钮', dlg.hasCancelBtn === true, dlg);
    push('F：点[取消]触发取消回调', dlg.afterCancel === 'cancel', dlg);
    push('F：点[取消]后弹窗被销毁', dlg.layerGone === true, dlg);
    push('F：点[确定]触发确定回调', dlg.afterConfirm === 'confirm', dlg);
    push('F：确认弹窗在模态深度（1100）', dlg.depth === 1100, dlg);

    // ═══════════════════════════════════════════════
    // G. createCounter —— 加减 / 边界 / 钳制
    // ═══════════════════════════════════════════════
    const cnt = await page.evaluate(async (helper) => {
      const fn = new Function(helper + '; return { demoScene, collectTexts };');
      const { demoScene, collectTexts } = fn();
      const s = demoScene();
      const c = s.counter;

      const initial = c.getValue();

      // 点 [+] 三次
      const texts = collectTexts(c);
      const plus = texts.find((t) => t.text === '[+]');
      const minus = texts.find((t) => t.text === '[-]');
      plus.emit('pointerdown');
      plus.emit('pointerdown');
      plus.emit('pointerdown');
      const afterPlus = c.getValue();

      // 点 [-] 一次
      minus.emit('pointerdown');
      const afterMinus = c.getValue();

      // 边界：减到 0 应该被钳住并禁用 [-]
      for (let i = 0; i < 12; i++) minus.emit('pointerdown');
      const atMin = c.getValue();
      const minusDisabled = !c.list.find((o) =>
        o.type === 'Container' && o.list?.some((x) => x.text === '[-]')
      )?.list?.find((x) => x.text === '[-]')?.input;

      // 越界钳制
      c.setValue(999);
      const clampedHigh = c.getValue();
      c.setValue(-5);
      const clampedLow = c.getValue();

      // onChange 有没有被调用（文本刷新了）
      const shownText = collectTexts(c).find((t) => /^\d+$/.test(t.text))?.text;

      return {
        initial,
        afterPlus,
        afterMinus,
        atMin,
        clampedHigh,
        clampedLow,
        shownText,
        hasGetValue: typeof c.getValue === 'function',
        hasSetValue: typeof c.setValue === 'function'
      };
    }, COLLECT_HELPER);

    push('G：计数器初始值正确', cnt.initial === 3, cnt);
    push('G：点[+]能加', cnt.afterPlus === 6, cnt);
    push('G：点[-]能减', cnt.afterMinus === 5, cnt);
    push('G：减到下界被钳住（不小于 0）', cnt.atMin === 0, cnt);
    push('G：setValue 越界会被钳到上限', cnt.clampedHigh === 10, cnt);
    push('G：setValue 越界会被钳到下限', cnt.clampedLow === 0, cnt);
    push('G：数值文本同步更新', cnt.shownText === '0', cnt);

    // ═══════════════════════════════════════════════
    // H. 契约验收②：M5/M7 场景引入组件库后不报 import 错误
    // ═══════════════════════════════════════════════
    const importCheck = await page.evaluate(async () => {
      const results = {};
      const mods = [
        '/src/scenes/ui/components.js',
        '/src/scenes/ui/skillPanel.js',
        '/src/scenes/ui/spellPanel.js',
        '/src/scenes/ui/savePanel.js'
      ];
      for (const m of mods) {
        try {
          const mod = await import(m);
          results[m] = { ok: true, exports: Object.keys(mod).length };
        } catch (e) {
          results[m] = { ok: false, error: String(e) };
        }
      }
      // 检查组件库导出了契约要求的 6 个工厂函数
      try {
        const c = await import('/src/scenes/ui/components.js');
        const required = [
          'createButton', 'createPanel', 'createUnitCard',
          'toast', 'confirmDialog', 'createCounter'
        ];
        results.required = required.map((k) => ({ name: k, ok: typeof c[k] === 'function' }));
      } catch (e) {
        results.required = [{ name: 'import', ok: false, error: String(e) }];
      }
      return results;
    });

    for (const key of ['/src/scenes/ui/components.js', '/src/scenes/ui/skillPanel.js', '/src/scenes/ui/spellPanel.js', '/src/scenes/ui/savePanel.js']) {
      push(`H：${key.split('/').pop()} 能正常 import`, importCheck[key]?.ok === true, importCheck[key]);
    }
    const allRequired = (importCheck.required || []).every((r) => r.ok);
    push('H：契约要求的 6 个工厂函数全部导出', allRequired, importCheck.required);

    // ═══════════════════════════════════════════════
    // I. 页面无 JS 报错
    // ═══════════════════════════════════════════════
    push('I：页面运行期间无 JS 报错', errors.length === 0, { errors });

    await page.screenshot({ path: path.join(ROOT, 'scripts', 'shot-demo.png') });

  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  // ── 汇总 ──
  const pass = checks.filter((c) => c.pass).length;
  const fail = checks.length - pass;
  console.log('');
  if (fail === 0) {
    console.log(`✅ M13 验证：${pass}/${checks.length} 通过`);
  } else {
    console.log(`❌ M13 验证未通过：${pass}/${checks.length} 通过，${fail} 项失败`);
    for (const c of checks.filter((x) => !x.pass)) {
      console.log(`   ❌ ${c.name}`);
      if (c.detail) console.log(`      ${JSON.stringify(c.detail)}`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

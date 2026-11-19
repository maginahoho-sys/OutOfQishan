/**
 * M9 施法 UI 的无头浏览器验证脚本
 *
 * 目的：验证施法面板与选目标流程在真实运行时可用（而不只是逻辑层单测通过）：
 *   - 点「施法」按钮能打开面板
 *   - 面板列出英雄已习得的魔法，法力不足的置灰且不可点
 *   - 点魔法卡能进入「选目标」模式并高亮合法目标
 *   - 点高亮目标能真正施法（扣法力 + 战报 + 目标 hp 上升）
 *   - 群体魔法不需要选目标，直接施放
 *   - 电脑方每轮会自己施法
 *
 * 用法：node scripts/verify-m9-ui.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 5196;

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
 * 页面内通用的面板遍历工具
 *
 * 施法面板的节点是嵌套的：
 *   layer(depth 950) → [shade, panel, title, subtitle, hint, cardLayer]
 *   cardLayer → [bg, nameText, costText, line, desc, tagText] × N
 * 所以要递归收集，不能只看 layer.list。
 *
 * texts 收集字符串（断言文案用），textObjs 收集 Text 对象（要拿坐标时用）。
 *
 * @param {object} node Phaser.GameObjects.GameObject
 * @param {object} out 收集结果 { texts, textObjs, rects }
 */
const COLLECT_HELPER = `
  function collect(node, out) {
    if (!node) return;
    if (node.type === 'Text') { out.texts.push(node.text); out.textObjs.push(node); }
    if (node.type === 'Rectangle') out.rects.push(node);
    if (node.type === 'Container' && node.list) {
      for (const c of node.list) collect(c, out);
    }
  }
  function panelLayer(s) {
    return s.children.list.find((o) => o.type === 'Container' && o.depth === 950) || null;
  }
`;

/** 页面内收集面板内容（供各处 evaluate 复用） */
const COLLECT_PANEL = `
  const out = { texts: [], textObjs: [], rects: [] };
  collect(layer, out);
  return out;
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
    //    注意 startBattle 的参数名是 attackerId / defenderId
    //    （它自己去 hero.army 取军队，不能传 attackerArmy）
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
          army: [{ unitId: 'shu_militia', count: 10 }]
        },
        {
          id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 1,
          exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
          mana: 20, maxMana: 20, pos: { x: 26, y: 4 }, skills: {},
          spells: ['slow', 'haste', 'zhimang', 'huoji'],
          army: [{ unitId: 'wei_qingzhou', count: 10 }]
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

    const scene = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      return {
        hasScene: !!s,
        battleReady: !!(s && s.battle),
        round: s?.battle?.round,
        stackCount: s?.battle?.stacks?.length ?? 0,
        logCount: s?.battle?.log?.length ?? 0
      };
    });

    const checks = [];
    checks.push(['能进入 BattleScene 并创建战斗', scene.hasScene && scene.battleReady]);
    checks.push(['双方各 1 个 stack（共 2 个）', scene.stackCount === 2]);

    // ────────────────────────────────────────────────
    // 2) 点「施法」按钮 → 打开面板
    // ────────────────────────────────────────────────
    const clickByText = async (text) => page.evaluate((t) => {
      const s = window.__game.scene.getScene('BattleScene');
      let found = null;
      s.hudLayer.list.forEach((o) => {
        if (o.type === 'Text' && o.text.includes(t)) found = o;
      });
      if (!found) return false;
      found.emit('pointerdown');
      return true;
    }, text);

    const panelOpened = await clickByText('[施法]');
    checks.push(['点「施法」能打开面板', panelOpened]);
    await sleep(600);

    // ────────────────────────────────────────────────
    // 3) 检查面板内容
    // ────────────────────────────────────────────────
    const panelInfo = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { collect, panelLayer };');
      const { collect, panelLayer } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      if (!s.spellPanel) return { exists: false };
      const layer = panelLayer(s);
      if (!layer) return { exists: true, layerFound: false };
      const out = { texts: [], textObjs: [], rects: [] };
      collect(layer, out);
      return {
        exists: true,
        layerFound: true,
        texts: out.texts,
        rectCount: out.rects.length,
        // 有多少张卡是可点的（bg 矩形带 input）
        clickable: out.rects.filter((r) => r.input).length
      };
    }, COLLECT_HELPER);

    checks.push(['施法面板已创建', panelInfo.exists === true]);
    checks.push([
      '面板列出已习得魔法（治疗/祝福/护体/天佑）',
      panelInfo.texts?.some((t) => t.includes('治疗')) &&
      panelInfo.texts?.some((t) => t.includes('天佑'))
    ]);
    checks.push([
      '面板显示法力与本轮施法限制',
      panelInfo.texts?.some((t) => t.includes('法力')) &&
      panelInfo.texts?.some((t) => t.includes('本轮'))
    ]);
    checks.push([
      '面板标出群体魔法（无需选目标）',
      panelInfo.texts?.some((t) => t.includes('群体（无需选目标）'))
    ]);
    checks.push([
      '面板标出单体魔法（需选目标）',
      panelInfo.texts?.some((t) => t.includes('单体（需选目标）'))
    ]);

    // ────────────────────────────────────────────────
    // 3.5) 面板可以关闭（反悔不施法时也要能退出）
    // ────────────────────────────────────────────────
    const closed = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { collect, panelLayer };');
      const { collect, panelLayer } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      const layer = panelLayer(s);
      if (!layer) return { hasBtn: false };

      const out = { texts: [], textObjs: [], rects: [] };
      collect(layer, out);
      const btn = out.textObjs.find((o) => o.text === '[关闭]');
      if (!btn) return { hasBtn: false };

      btn.emit('pointerdown');
      return {
        hasBtn: true,
        spellPanelCleared: !s.spellPanel,
        layerGone: !panelLayer(s)
      };
    }, COLLECT_HELPER);

    checks.push(['面板有「[关闭]」按钮', closed.hasBtn === true]);
    checks.push([
      '点「[关闭]」能关掉面板且不施法',
      closed.spellPanelCleared === true && closed.layerGone === true
    ]);
    await sleep(300);

    // 重新打开面板，后面的用例还要用
    const reopened = await clickByText('[施法]');
    checks.push(['面板可以重新打开', reopened === true]);
    await sleep(500);

    // ────────────────────────────────────────────────
    // 4) 点「治疗」卡 → 进入选目标模式
    // ────────────────────────────────────────────────
    const pickedHeal = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { collect, panelLayer };');
      const { collect, panelLayer } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      const layer = panelLayer(s);
      if (!layer) return { ok: false, diag: 'no panel layer' };

      const out = { texts: [], textObjs: [], rects: [] };
      collect(layer, out);

      // 找到「治疗」这张卡的名字文本
      const nameText = out.textObjs.find((o) => o.text === '治疗');
      if (!nameText) {
        return { ok: false, diag: 'no 治疗 text; texts=' + JSON.stringify(out.texts) };
      }

      const diag = {
        nameX: nameText.x, nameY: nameText.y,
        rects: out.rects.map((r) => ({
          x: r.x, y: r.y, w: r.width, h: r.height, input: !!r.input
        }))
      };

      // 卡片底板是可交互的 Rectangle，x 与名字一致，y 在名字下方 67px
      const card = out.rects.find(
        (r) => r.input && Math.abs(r.x - nameText.x) < 2 && Math.abs(r.y - (nameText.y + 67)) < 3
      );
      if (!card) return { ok: false, diag: JSON.stringify(diag) };
      card.emit('pointerdown');
      return { ok: true, diag: '' };
    }, COLLECT_HELPER);

    if (!pickedHeal.ok) console.log('  🔍 诊断：', pickedHeal.diag);
    checks.push(['点魔法卡能选中魔法', pickedHeal.ok === true]);
    await sleep(500);

    const castingMode = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      return {
        spellId: s.castingSpellId,
        targetIds: s.castTargetIds,
        panelClosed: !s.spellPanel
      };
    });

    checks.push(['选中魔法后进入选目标模式', castingMode.spellId === 'heal']);
    checks.push(['合法目标已算出（友军 stack）', castingMode.targetIds?.length === 1]);
    checks.push(['施法面板已关闭', castingMode.panelClosed === true]);

    // 战场上的施法目标应该有紫色高亮环
    // 注意：Phaser 3.90 的 add.circle() 返回的是 Arc（type='Arc'），旧版是 'Circle'
    const purpleMark = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      let purple = 0;
      const dump = [];
      s.markLayer.list.forEach((o) => {
        dump.push({ type: o.type, stroke: o.strokeColor });
        if (['Arc', 'Circle'].includes(o.type) && o.strokeColor === 0x9b59b6) purple += 1;
      });
      return { purple, dump, targets: s.castTargetIds };
    });
    if (purpleMark.purple !== 1) {
      console.log('  🔍 诊断：', JSON.stringify(purpleMark));
    }
    checks.push(['战场高亮了施法目标（紫环）', purpleMark.purple === 1]);

    // ────────────────────────────────────────────────
    // 5) 点战场目标 → 真正施法
    // ────────────────────────────────────────────────
    const before = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const t = s.battle.stacks.find((x) => x.id === s.castTargetIds[0]);
      t.hp = 2; // 制造伤员
      const hero = s.state.heroes.find((h) => h.id === s.battle.attackerHeroId);
      return { hp: t.hp, mana: hero.mana, stackId: t.id };
    });

    await page.evaluate((stackId) => {
      const s = window.__game.scene.getScene('BattleScene');
      const st = s.battle.stacks.find((x) => x.id === stackId);
      s.handleClickCell({ x: st.pos.x, y: st.pos.y });
    }, before.stackId);

    await sleep(500);

    const after = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const hero = s.state.heroes.find((h) => h.id === s.battle.attackerHeroId);
      const t = s.battle.stacks.find((x) => x.side === 'attacker');
      return {
        hp: t.hp,
        mana: hero.mana,
        spellId: s.castingSpellId,
        castFlag: s.battle.spellCastThisTurn.attacker,
        logText: s.battle.log.map((l) => l.text).join('\n')
      };
    });

    checks.push(['点击目标能完成施法（退出选目标模式）', after.spellId === null]);
    checks.push(['施法后目标 hp 上升', after.hp > before.hp]);
    checks.push(['施法后法力减少 4 点', after.mana === before.mana - 4]);
    checks.push(['战报记录了施法', after.logText.includes('施放【治疗】')]);
    checks.push(['施法后标记本轮已施法', after.castFlag === true]);

    // ────────────────────────────────────────────────
    // 6) 群体魔法「天佑」直接施放（不进入选目标模式）
    // ────────────────────────────────────────────────
    const aoe = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const magic = await import('/src/logic/magicLogic.js');
      const hero = s.state.heroes.find((h) => h.id === s.battle.attackerHeroId);
      // 先重置本轮施法限制，模拟新一轮
      s.battle.spellCastThisTurn.attacker = false;
      const manaBefore = hero.mana;          // ← 施法前先记法力
      s.startCasting('tianyou', magic.getSpellDef('tianyou'));
      return {
        castingSpellId: s.castingSpellId,
        targetIds: s.castTargetIds,
        mana: manaBefore
      };
    });

    await sleep(400);

    const aoeAfter = await page.evaluate(async () => {
      const s = window.__game.scene.getScene('BattleScene');
      const ops = await import('/src/logic/stackOps.js');
      const hero = s.state.heroes.find((h) => h.id === s.battle.attackerHeroId);
      const ally = s.battle.stacks.find((x) => x.side === 'attacker');
      return {
        mana: hero.mana,
        // buff 是叠在 buffs 数组上的，用 buffModifier 读才是"含加成"的值
        attackBonus: ops.buffModifier(ally, 'attack'),
        buffCount: (ally.buffs || []).length,
        logText: s.battle.log.map((l) => l.text).join('\n')
      };
    });

    checks.push([
      '群体魔法直接施放（不进入选目标模式）',
      aoe.castingSpellId === null && aoe.targetIds.length === 0
    ]);
    checks.push(['群体魔法扣了法力（12 点）', aoeAfter.mana === aoe.mana - 12]);
    checks.push(['群体魔法给全员上了攻击加成（+3）', aoeAfter.attackBonus === 3]);
    checks.push(['群体魔法写入了 buffs', aoeAfter.buffCount === 1]);
    checks.push(['战报记录了群体施法', aoeAfter.logText.includes('施放【天佑】')]);

    // ────────────────────────────────────────────────
    // 7) 法力不足 → 所有卡片置灰且不可点
    // ────────────────────────────────────────────────
    const grey = await page.evaluate((helperSrc) => {
      const fn = new Function(helperSrc + '; return { collect, panelLayer };');
      const { collect, panelLayer } = fn();
      const s = window.__game.scene.getScene('BattleScene');
      const hero = s.state.heroes.find((h) => h.id === s.battle.attackerHeroId);

      hero.mana = 0;                        // 法力清零
      s.battle.spellCastThisTurn.attacker = false;
      s.openSpellPanel();

      const layer = panelLayer(s);
      if (!layer) return { opened: false };
      const out = { texts: [], textObjs: [], rects: [] };
      collect(layer, out);

      // 只数"魔法卡底板"（宽 260）是否可点；遮罩矩形宽 1280，是用来吞点击的
      const cardBgs = out.rects.filter((r) => r.input && r.width === 260);
      const anyClickable = cardBgs.length;
      const hint = out.texts.find((t) => t.includes('法力不足')) || '';

      // 收尾：关掉面板、恢复法力
      if (s.spellPanel) s.spellPanel.close(true);
      hero.mana = 20;
      return { opened: true, anyClickable, hint };
    }, COLLECT_HELPER);

    checks.push(['法力不足时面板仍能打开', grey.opened === true]);
    checks.push(['法力不足时所有魔法卡都不可点', grey.anyClickable === 0]);
    checks.push(['法力不足时给出提示文案', grey.hint.includes('法力不足')]);
    await sleep(400);

    // ────────────────────────────────────────────────
    // 8) 电脑方每轮自动施法
    // ────────────────────────────────────────────────
    const aiBefore = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const hero = s.state.heroes.find((h) => h.id === s.battle.defenderHeroId);
      const atk = s.battle.stacks.find((x) => x.side === 'attacker');
      return { mana: hero.mana, atkCount: atk.count };
    });

    // 结束玩家这一回合 → 指针移到电脑方 → 场景里的 scheduleAI 会驱动施法
    await page.evaluate(async () => {
      const battle = await import('/src/logic/battleLogic.js');
      const s = window.__game.scene.getScene('BattleScene');
      battle.nextTurn(s.battle, { action: 'wait' });
    });

    await sleep(1200); // 等 AI 的 450ms 延时动作跑完

    const aiAfter = await page.evaluate(() => {
      const s = window.__game.scene.getScene('BattleScene');
      const hero = s.state.heroes.find((h) => h.id === s.battle.defenderHeroId);
      const atk = s.battle.stacks.find((x) => x.side === 'attacker');
      return {
        mana: hero.mana,
        atkCount: atk.count,
        round: s.battle.round,
        logText: s.battle.log.map((l) => l.text).join('\n')
      };
    });

    checks.push(['电脑方自动施法（法力减少）', aiAfter.mana < aiBefore.mana]);
    checks.push(['电脑方施法写进了战报', aiAfter.logText.includes('曹操 施放【')]);
    checks.push(['伤害魔法打掉了敌兵', aiAfter.atkCount < aiBefore.atkCount]);
    checks.push(['电脑方每轮只施法 1 次', (aiAfter.logText.match(/曹操 施放【/g) || []).length === 1]);

    console.log('\n▶ 施法 UI 验证：');
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

  console.log(failed ? '\n❌ 施法 UI 验证未通过' : '\n✅ 施法 UI 验证通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

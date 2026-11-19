/**
 * M9 施法流程的无头浏览器验证脚本
 *
 * 目的：在真实运行时（Vite dev server + Chromium）里验证 M9 的施法链路是通的，
 * 而不只是单元测试通过。单元测试跑的是纯 JS 模块，这里验证的是：
 *   - JSON import attributes 在浏览器里能正常加载（spells.json）
 *   - magicLogic 在浏览器里能正常 import（无循环依赖导致的加载顺序问题）
 *   - 施法 → 扣法力 → 写战报 → 发 magic:cast 事件 → buff 生效 全链路通
 *
 * 用法：node scripts/verify-m9-browser.mjs
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

/**
 * 探测本机 Chrome for Testing 的可执行文件路径
 * puppeteer 的缓存目录带版本号，不能硬编码，所以按 glob 规则找。
 */
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
  // 取版本号最大的（目录名形如 mac_arm-133.0.x）
  candidates.sort();
  return candidates[candidates.length - 1] || null;
}

const CHROME = findChrome();
if (!CHROME) {
  console.error('❌ 找不到 Chrome for Testing（~/.cache/puppeteer/chrome）');
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
      if (out.includes('ready in') || out.includes('Local:')) {
        resolve(proc);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', reject);
    setTimeout(() => reject(new Error('dev server 启动超时:\n' + out)), 30000);
  });
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

  let failed = false;
  try {
    const page = await browser.newPage();
    const errors = [];
    // 收集所有失败请求的 URL（用于过滤 favicon 之类与 M9 无关的资源错误）
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
      // 资源加载失败类报错统一按 URL 判定是否与 M9 有关
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
    await sleep(1200);

    // 直接在页面里 import 逻辑层模块，验证浏览器运行时可用
    const result = await page.evaluate(async () => {
      const magic = await import('/src/logic/magicLogic.js');
      const battle = await import('/src/logic/battleLogic.js');
      const dataMod = await import('/src/data/spells.json', { with: { type: 'json' } }).catch(
        () => null
      );

      const spells = magic.getSpellDef('heal');
      const zh = magic.getSpellDef('zhimang');

      // 造一个最小战斗
      const state = {
        meta: { currentPlayer: 0, day: 1, week: 1 },
        players: [
          { id: 0, faction: 'shu', isAI: false },
          { id: 1, faction: 'wei', isAI: true }
        ],
        heroes: [
          {
            id: 'hero_shu_0', playerId: 0, faction: 'shu', name: '刘备', level: 1,
            exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
            mana: 20, maxMana: 20, pos: { x: 3, y: 13 },
            skills: {}, spells: ['heal', 'bless', 'huti', 'quxie', 'fuhuo'],
            army: [{ unitId: 'shu_militia', count: 10 }]
          },
          {
            id: 'hero_wei_0', playerId: 1, faction: 'wei', name: '曹操', level: 1,
            exp: 0, pendingLevels: 0, movePoints: 20, maxMovePoints: 20,
            mana: 20, maxMana: 20, pos: { x: 26, y: 4 },
            skills: {}, spells: ['slow', 'haste', 'zhimang'],
            army: [{ unitId: 'wei_qingzhou', count: 10 }]
          }
        ],
        towns: [],
        battle: null
      };

      const DATA = {
        units: (await import('/src/data/units.json', { with: { type: 'json' } })).default,
        spells: dataMod ? dataMod.default : null
      };

      const b = battle.initBattle(state, state.heroes[0].army, state.heroes[1].army, {
        attackerHeroId: 'hero_shu_0',
        defenderHeroId: 'hero_wei_0',
        attackerPlayerId: 0,
        defenderPlayerId: 1,
        data: DATA
      });

      const out = { spells: !!spells, zhimang: !!zh };

      // 1) 治疗：扣法力 + 回血 + 战报
      const target = b.stacks.find((s) => s.side === 'attacker');
      target.hp = 2;
      const manaBefore = state.heroes[0].mana;
      const r1 = magic.castSpell(state, DATA, 'hero_shu_0', 'heal', target.id);
      out.healOk = r1.ok;
      out.manaSpent = manaBefore - state.heroes[0].mana;
      out.hpRose = target.hp > 2;
      out.healLogged = b.log.some((l) => l.text.includes('施放【治疗】'));

      // 2) 每方每轮限施法 1 次
      //    注意 canCast 只查「已习得 + 法力够」，不查本轮是否已施法（契约签名不带 battle），
      //    所以这里用 hasCastThisTurn + 再次 castSpell 来验证限施法。
      out.castFlagSet = magic.hasCastThisTurn(b, 'hero_shu_0') === true;
      const r2 = magic.castSpell(state, DATA, 'hero_shu_0', 'bless', target.id);
      out.secondCastBlocked = r2.ok === false && r2.reason === 'spellLimitReached';

      // 3) 致盲：曹魏（守方）对蜀汉（攻方）施放 —— 致盲是 enemy 目标
      const atk = b.stacks.find((s) => s.side === 'attacker');
      const r3 = magic.castSpell(state, DATA, 'hero_wei_0', 'zhimang', atk.id);
      out.blindOk = r3.ok;
      out.blinded = magic.isBlinded(atk);

      // 4) 被致盲的单位不能攻击（也不能移动）
      const def = b.stacks.find((s) => s.side === 'defender');
      const r4 = battle.attackStack(b, DATA, atk.id, def.id);
      out.blindBlocksAttack = r4.ok === false && r4.reason === 'blinded';

      const mv = battle.moveStack(b, atk.id, { x: atk.pos.x + 1, y: atk.pos.y });
      out.blindBlocksMove = mv.ok === false && mv.reason === 'blinded';

      // 5) magic:cast 事件
      //    蜀汉方本轮已施过法（限 1 次），所以另起一场战斗来测事件
      let evt = null;
      const busMod = await import('/src/core/EventBus.js');
      const off = busMod.default.on('magic:cast', (p) => { evt = p; });
      const bEvt = battle.initBattle(state, state.heroes[0].army, state.heroes[1].army, {
        attackerHeroId: 'hero_shu_0', defenderHeroId: 'hero_wei_0',
        attackerPlayerId: 0, defenderPlayerId: 1, data: DATA
      });
      const evtTarget = bEvt.stacks.find((s) => s.side === 'defender');
      magic.castSpell(state, DATA, 'hero_shu_0', 'quxie', evtTarget.id);
      off();
      out.eventFired = !!evt && evt.spellId === 'quxie';

      // 6) buff 生命周期：3 轮后消失
      const b2 = battle.initBattle(state, state.heroes[0].army, state.heroes[1].army, {
        attackerHeroId: 'hero_shu_0', defenderHeroId: 'hero_wei_0',
        attackerPlayerId: 0, defenderPlayerId: 1, data: DATA
      });
      const ally2 = b2.stacks.find((s) => s.side === 'attacker');
      magic.castSpell(state, DATA, 'hero_shu_0', 'huti', ally2.id);
      const defBefore = battle.stackStat(ally2, 'defense');
      for (let i = 0; i < 3; i++) magic.tickBuffs(b2);
      out.buffExpired = ally2.buffs.length === 0;
      out.defenseRestored = battle.stackStat(ally2, 'defense') === defBefore - 2;

      // 7) 升级自动学魔法
      const gained = magic.grantSpellsForLevel(state, 'hero_shu_0');
      out.learned = Array.isArray(gained);

      return out;
    });

    const checks = [
      ['spells.json 在浏览器运行时可加载', result.spells],
      ['zhimang 魔法定义可读', result.zhimang],
      ['治疗施法成功', result.healOk === true],
      ['法力消耗 4 点', result.manaSpent === 4],
      ['目标 hp 上升', result.hpRose === true],
      ['战报记录施法', result.healLogged === true],
      ['施法后标记本轮已施法', result.castFlagSet === true],
      ['每轮限施法 1 次生效', result.secondCastBlocked === true],
      ['致盲施法成功', result.blindOk === true],
      ['isBlinded 判定为 true', result.blinded === true],
      ['被致盲单位无法攻击', result.blindBlocksAttack === true],
      ['被致盲单位无法移动', result.blindBlocksMove === true],
      ['magic:cast 事件已触发', result.eventFired === true],
      ['buff 3 轮后消失', result.buffExpired === true],
      ['buff 消失后属性复原', result.defenseRestored === true],
      ['grantSpellsForLevel 可用', result.learned === true]
    ];

    console.log('\n▶ 浏览器运行时验证：');
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

  console.log(failed ? '\n❌ M9 浏览器验证未通过' : '\n✅ M9 浏览器验证通过');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验证脚本异常：', e);
  process.exit(1);
});

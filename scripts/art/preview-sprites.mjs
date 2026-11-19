/**
 * preview-sprites.mjs —— 把一批 PNG 拼成总览图，方便肉眼检查
 *
 * 用法：node scripts/art/preview-sprites.mjs <目录> [输出路径] [每行个数] [放大倍数]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(
  '/Users/zhanghaifeng/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core'
);

function findChrome() {
  const base = path.join(process.env.HOME, '.cache', 'puppeteer', 'chrome');
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

const PAGE_FN = `
async function makeSheet(files, cols, zoom) {
  const loaded = [];
  for (const f of files) {
    const img = new Image();
    img.src = f.dataUrl;
    await img.decode();
    loaded.push(img);
  }
  const maxW = Math.max(...loaded.map(i => i.width));
  const maxH = Math.max(...loaded.map(i => i.height));
  const cell = maxW * zoom + 8;
  const rows = Math.ceil(loaded.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * cell;
  c.height = rows * cell;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  // 棋盘底
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      ctx.fillStyle = ((x >> 3) + (y >> 3)) % 2 === 0 ? '#20242c' : '#191d24';
      ctx.fillRect(x, y, 8, 8);
    }
  }
  loaded.forEach((img, i) => {
    const x = (i % cols) * cell + Math.floor((cell - img.width * zoom) / 2);
    const y = Math.floor(i / cols) * cell + Math.floor((cell - img.height * zoom) / 2);
    ctx.drawImage(img, x, y, img.width * zoom, img.height * zoom);
  });
  return c.toDataURL('image/png');
}
`;

async function main() {
  const dir = path.resolve(process.cwd(), process.argv[2] || 'tmp/pixel-test');
  const out = path.resolve(process.cwd(), process.argv[3] || path.join(dir, '_sheet.png'));
  const cols = Number(process.argv[4] || 8);
  const zoom = Number(process.argv[5] || 4);

  // 跳过下划线开头的文件（总览图自身）
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && !f.startsWith('_')).sort();
  if (!files.length) {
    console.log('· 目录里没有 PNG');
    return;
  }
  const payloads = files.map((f) => ({
    name: f,
    dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`
  }));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setContent('<html><body></body></html>');
    const dataUrl = await page.evaluate(
      new Function('files', 'cols', 'zoom', `${PAGE_FN}; return makeSheet(files, cols, zoom);`),
      payloads, cols, zoom
    );
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log(`✓ 总览 → ${path.relative(ROOT, out)}（${files.length} 张）`);
  } finally {
    await browser.close();
  }
}

main();

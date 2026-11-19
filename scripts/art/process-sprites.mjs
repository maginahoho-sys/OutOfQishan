/**
 * process-sprites.mjs —— AI 生成的图集 → 游戏用像素资源
 *
 * ── 为什么需要这一层？──────────────────────────────────────
 *   AI 生成的"像素画"有几个问题，直接贴进游戏是不行的：
 *     1. 背景不是透明的（是米白噪点底，还带水印）；
 *     2. 源分辨率很高（角色约 230~450px），要缩到 48/64px；
 *     3. 缩放后边缘会糊、颜色会太多，不像手绘像素画；
 *     4. 精灵可能**跨格溢出**（长柄武器伸到隔壁格），按格切会把它切断。
 *
 *   所以这里跑一条标准 sprite 流水线：
 *     ① 整张图去背景（flood fill，从画布边界往里灌）
 *     ② 去边缘杂色（defringe）
 *     ③ 连通域标记（CC labeling）—— 每个精灵是一个独立色块
 *     ④ 按「像素归属最多的格子」把色块分配给格子
 *        （这一步解决了跨格溢出：溢出的部分仍然属于原精灵）
 *     ⑤ 盒式降采样（area average，不是双线性）→ alpha 二值化 → 颜色量化
 *     ⑥ 补 1px 深色描边 → 输出 PNG
 *
 *   跑在 headless Chrome 里（Canvas 自带 PNG 编解码与图像运算），
 *   不引入任何图像处理依赖。
 *
 * 用法：
 *   node scripts/art/process-sprites.mjs [任务文件]
 *   默认任务文件：scripts/art/sprite-jobs.json
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

/** 探测本机 Chrome for Testing */
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

/**
 * 页面内的图像处理脚本（以字符串形式注入浏览器执行）
 */
const PAGE_FN = `
async function runJob(atlasDataUrl, job) {
  const img = new Image();
  img.src = atlasDataUrl;
  await img.decode();

  // ── 裁掉右下角水印区（AI 工具会打水印）──
  const W = img.width - (job.trimRight || 0);
  const H = img.height - (job.trimBottom || 0);

  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, W, H);

  // ① 去背景  ② 去杂色
  removeBackground(d, W, H);
  defringe(d, W, H);

  // ③ 连通域标记
  const blobs = labelBlobs(d, W, H, job.minBlob || 600);

  // ③' 过滤水印（AI 工具在右下角打水印，是一堆小色块）
  let kept = blobs;
  if (job.watermark) {
    const wx = W * (job.watermark.x || 0.70);
    const wy = H * (job.watermark.y || 0.84);
    const maxArea = job.watermark.maxArea || 4000;
    kept = blobs.filter((b) => {
      const area = (b.maxX - b.minX + 1) * (b.maxY - b.minY + 1);
      const inCorner = b.minX >= wx && b.minY >= wy;
      return !(inCorner && area <= maxArea);
    });
  }

  // ④ 把每个色块分配给「像素占比最高」的格子
  const cols = job.cols, rows = job.rows;
  const cw = W / cols, ch = H / rows;
  const byCell = new Map();
  for (const b of kept) {
    const counts = new Map();
    for (let i = 0; i < b.pixels.length; i++) {
      const p = b.pixels[i];
      const x = p % W, y = (p / W) | 0;
      const k = Math.floor(y / ch) * cols + Math.floor(x / cw);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let best = -1, bestN = 0;
    for (const [k, n] of counts) if (n > bestN) { bestN = n; best = k; }
    if (!byCell.has(best)) byCell.set(best, []);
    byCell.get(best).push(b);
  }

  const out = [];
  for (const cell of job.cells) {
    // ── 地形类：整格铺满，不抠背景、不裁切 ──
    if (job.fullCell) {
      const gx = cell.g % cols, gy = Math.floor(cell.g / cols);
      // inset：切掉 AI 画在格子边缘的深色边框，再铺满整格
      const inset = job.inset || 0;
      const cwI = Math.round(cw) - inset * 2;
      const chI = Math.round(ch) - inset * 2;
      let sx = Math.round(gx * cw) + inset;
      let sy = Math.round(gy * ch) + inset;
      let sw = cwI, sh = chI;

      // crop：只取格子里的一小块（用于「一格只要几棵树」这种放大源图）
      if (cell.crop) {
        const size = cell.crop.size;                 // 占格子的比例
        const fx = cell.crop.x === undefined ? 0.5 : cell.crop.x;
        const fy = cell.crop.y === undefined ? 0.5 : cell.crop.y;
        sw = Math.round(cwI * size);
        sh = Math.round(chI * size);
        sx = Math.round(gx * cw) + inset + Math.round((cwI - sw) * fx);
        sy = Math.round(gy * ch) + inset + Math.round((chI - sh) * fy);
      }

      const region = cropRegion(d, W, H, sx, sy, sw, sh);
      const target = cell.size || job.size || 40;
      const small = boxDownscale(region, target, target);
      quantize(small, job.levels === undefined ? 5 : job.levels);
      const o = document.createElement('canvas');
      o.width = target; o.height = target;
      const octx = o.getContext('2d');
      const id = octx.createImageData(target, target);
      id.data.set(small.data);
      octx.putImageData(id, 0, 0);
      out.push({ name: cell.name, png: o.toDataURL('image/png'), w: target, h: target });
      continue;
    }

    const blobsOfCell = byCell.get(cell.g) || [];
    if (!blobsOfCell.length) { out.push(null); continue; }

    // ⑤ 取该格所有色块的并集包围盒
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (const b of blobsOfCell) {
      if (b.minX < minX) minX = b.minX;
      if (b.minY < minY) minY = b.minY;
      if (b.maxX > maxX) maxX = b.maxX;
      if (b.maxY > maxY) maxY = b.maxY;
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;

    // 只把这些色块的像素拷出来（其余置透明）
    const cropped = cropBlobs(d, W, H, blobsOfCell, minX, minY, bw, bh);

    // 一个格子可以输出多个尺寸（战场 48 / 地图 40）
    const sizes = [{ size: cell.size || job.size || 48, name: cell.name }];
    for (const ex of cell.extraSizes || []) {
      sizes.push({ size: ex.size, name: ex.suffix ? cell.name.replace(/\\.png$/, ex.suffix + '.png') : cell.name });
    }

    for (const spec of sizes) {
      const scale = Math.min(spec.size / bw, spec.size / bh);
      const tw = Math.max(1, Math.round(bw * scale));
      const th = Math.max(1, Math.round(bh * scale));

      const small = boxDownscale(cropped, tw, th);

      // ⑥ 硬边 + 量化 + 描边
      binarizeAlpha(small);
      quantize(small, job.levels === undefined ? 5 : job.levels);
      if (job.outline !== false) outline(small, tw, th, job.outlineColor || '#141a21');

      const o = document.createElement('canvas');
      o.width = tw; o.height = th;
      const octx = o.getContext('2d');
      const id = octx.createImageData(tw, th);
      id.data.set(small.data);
      octx.putImageData(id, 0, 0);
      out.push({ name: spec.name, png: o.toDataURL('image/png'), w: tw, h: th });
    }
  }
  return out;

  // ══════════════════ 辅助函数 ══════════════════

  function isBg(r, g, b, a) {
    if (a < 12) return true;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    return mx >= 178 && (mx - mn) <= 58;
  }

  function removeBackground(d, w, h) {
    const px = d.data;
    const seen = new Uint8Array(w * h);
    const stack = [];
    for (let x = 0; x < w; x++) { stack.push(x, 0, x, h - 1); }
    for (let y = 0; y < h; y++) { stack.push(0, y, w - 1, y); }
    while (stack.length) {
      const y = stack.pop(), x = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const idx = y * w + x;
      if (seen[idx]) continue;
      const p = idx * 4;
      if (!isBg(px[p], px[p + 1], px[p + 2], px[p + 3])) continue;
      seen[idx] = 1;
      px[p + 3] = 0;
      stack.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
    }
  }

  function defringe(d, w, h) {
    const px = d.data;
    const kill = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] === 0) continue;
        if (!isBg(px[i], px[i + 1], px[i + 2], px[i + 3])) continue;
        const nb = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (px[(ny * w + nx) * 4 + 3] === 0) { kill.push(i); break; }
        }
      }
    }
    for (const i of kill) px[i + 3] = 0;
  }

  // 连通域标记：返回 [{pixels, minX, minY, maxX, maxY}]
  function labelBlobs(d, w, h, minSize) {
    const px = d.data;
    const labels = new Int32Array(w * h).fill(-1);
    const stack = new Int32Array(w * h);
    const blobs = [];
    for (let start = 0; start < w * h; start++) {
      if (labels[start] !== -1) continue;
      if (px[start * 4 + 3] === 0) { labels[start] = -2; continue; }
      const id = blobs.length;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = id;
      const pixels = [];
      let minX = w, minY = h, maxX = -1, maxY = -1;
      while (sp > 0) {
        const p = stack[--sp];
        const x = p % w, y = (p / w) | 0;
        pixels.push(p);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        if (x > 0) { const q = p - 1; if (labels[q] === -1 && px[q * 4 + 3] !== 0) { labels[q] = id; stack[sp++] = q; } }
        if (x < w - 1) { const q = p + 1; if (labels[q] === -1 && px[q * 4 + 3] !== 0) { labels[q] = id; stack[sp++] = q; } }
        if (y > 0) { const q = p - w; if (labels[q] === -1 && px[q * 4 + 3] !== 0) { labels[q] = id; stack[sp++] = q; } }
        if (y < h - 1) { const q = p + w; if (labels[q] === -1 && px[q * 4 + 3] !== 0) { labels[q] = id; stack[sp++] = q; } }
      }
      if (pixels.length >= minSize) {
        blobs.push({ pixels: Int32Array.from(pixels), minX, minY, maxX, maxY });
      } else {
        for (let i = 0; i < pixels.length; i++) labels[pixels[i]] = -2;
      }
    }
    return blobs;
  }

  // 把矩形区域拷成一张独立画布
  function cropRegion(d, w, h, sx, sy, sw, sh) {
    const out = new Uint8ClampedArray(sw * sh * 4);
    const src = d.data;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const si = ((sy + y) * w + (sx + x)) * 4;
        const oi = (y * sw + x) * 4;
        out[oi] = src[si]; out[oi + 1] = src[si + 1];
        out[oi + 2] = src[si + 2]; out[oi + 3] = src[si + 3];
      }
    }
    return { data: out, width: sw, height: sh };
  }

  // 把若干色块的像素拷到一张只含这些像素的画布
  function cropBlobs(d, w, h, blobs, minX, minY, bw, bh) {
    const out = new Uint8ClampedArray(bw * bh * 4);
    const src = d.data;
    for (const b of blobs) {
      for (let i = 0; i < b.pixels.length; i++) {
        const p = b.pixels[i];
        const x = p % w, y = (p / w) | 0;
        const o = ((y - minY) * bw + (x - minX)) * 4;
        out[o] = src[p * 4];
        out[o + 1] = src[p * 4 + 1];
        out[o + 2] = src[p * 4 + 2];
        out[o + 3] = src[p * 4 + 3];
      }
    }
    return { data: out, width: bw, height: bh };
  }

  // 盒式降采样（area average）：比双线性更锐，缩 5 倍也不糊
  function boxDownscale(d, tw, th) {
    const src = d.data;
    const out = new Uint8ClampedArray(tw * th * 4);
    for (let y = 0; y < th; y++) {
      const sy0 = Math.floor(d.height * y / th);
      const sy1 = Math.floor(d.height * (y + 1) / th);
      for (let x = 0; x < tw; x++) {
        const sx0 = Math.floor(d.width * x / tw);
        const sx1 = Math.floor(d.width * (x + 1) / tw);
        let r = 0, g = 0, b = 0, a = 0, n = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0; sx < sx1; sx++) {
            const i = (sy * d.width + sx) * 4;
            const al = src[i + 3] / 255;
            r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al;
            a += src[i + 3];
            n++;
          }
        }
        const o = (y * tw + x) * 4;
        if (!n) continue;
        const avgA = a / n;
        if (avgA < 4) { out[o + 3] = 0; continue; }
        const wsum = a / 255 || 1;
        out[o] = r / wsum;
        out[o + 1] = g / wsum;
        out[o + 2] = b / wsum;
        out[o + 3] = avgA;
      }
    }
    return { data: out, width: tw, height: th };
  }

  function binarizeAlpha(s) {
    const px = s.data;
    for (let i = 0; i < px.length; i += 4) px[i + 3] = px[i + 3] >= 128 ? 255 : 0;
  }

  function quantize(s, levels) {
    const step = 256 / (1 << levels);
    const px = s.data;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) continue;
      px[i] = Math.round(px[i] / step) * step;
      px[i + 1] = Math.round(px[i + 1] / step) * step;
      px[i + 2] = Math.round(px[i + 2] / step) * step;
    }
  }

  function outline(s, w, h, color) {
    const px = s.data;
    const hex = color.replace('#', '');
    const cr = parseInt(hex.slice(0, 2), 16);
    const cg = parseInt(hex.slice(2, 4), 16);
    const cb = parseInt(hex.slice(4, 6), 16);
    const add = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (px[i + 3] !== 0) continue;
        const nb = [[1,0],[-1,0],[0,1],[0,-1]];
        for (const [dx, dy] of nb) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          if (px[(ny * w + nx) * 4 + 3] !== 0) { add.push(i, cr, cg, cb); break; }
        }
      }
    }
    for (let k = 0; k < add.length; k += 4) {
      const i = add[k];
      px[i] = add[k + 1]; px[i + 1] = add[k + 2]; px[i + 2] = add[k + 3]; px[i + 3] = 255;
    }
  }
}
`;

/**
 * 跑一批图集任务
 * @param {object[]} jobs
 */
async function runJobs(jobs) {
  const chrome = findChrome();
  if (!chrome) throw new Error('找不到 Chrome for Testing');

  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const written = [];
  const failed = [];

  try {
    const page = await browser.newPage();
    page.on('console', (m) => {
      if (m.type() === 'error') console.error('  [page]', m.text());
    });
    page.on('pageerror', (e) => console.error('  [page]', e.message));
    await page.setContent('<html><body></body></html>');

    for (const job of jobs) {
      const src = path.resolve(ROOT, job.src);
      if (!fs.existsSync(src)) {
        failed.push(`${job.name}: 找不到源图 ${job.src}`);
        continue;
      }
      const b64 = fs.readFileSync(src).toString('base64');
      const dataUrl = `data:image/png;base64,${b64}`;

      let results;
      try {
        results = await page.evaluate(
          new Function('atlasDataUrl', 'job', `${PAGE_FN}; return runJob(atlasDataUrl, job);`),
          dataUrl,
          job
        );
      } catch (e) {
        failed.push(`${job.name}: 处理失败 ${e.message}`);
        continue;
      }

      let n = 0;
      for (const r of results) {
        if (!r) continue;
        const outPath = path.resolve(ROOT, job.outDir, r.name);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, Buffer.from(r.png.split(',')[1], 'base64'));
        written.push(path.relative(ROOT, outPath));
        n++;
      }
      console.log(`  ✓ ${job.name} → ${n}/${results.length} 张`);
    }
  } finally {
    await browser.close();
  }

  return { written, failed };
}

/**
 * 入口
 */
async function main() {
  const specPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(__dirname, 'sprite-jobs.json');

  if (!fs.existsSync(specPath)) {
    console.log('· 没有待处理任务，跳过');
    return;
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const jobs = spec.jobs || [];
  if (!jobs.length) {
    console.log('· 任务列表为空，跳过');
    return;
  }

  console.log(`▶ 处理 ${jobs.length} 组图集…`);
  const { written, failed } = await runJobs(jobs);
  console.log(`✓ 写出 ${written.length} 张资源`);
  for (const f of failed) console.error(`✗ ${f}`);
  if (failed.length) process.exitCode = 1;
}

main();

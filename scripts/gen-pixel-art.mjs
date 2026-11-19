#!/usr/bin/env node
/**
 * gen-pixel-art.mjs —— 生成**代码绘制**的像素资源（阵营底台等）
 *
 * 与 scripts/art/process-sprites.mjs 的分工：
 *   - process-sprites.mjs：处理 AI 生成的图集（兵种 / 英雄 / 地形 / 建筑 / 资源）
 *   - gen-pixel-art.mjs   ：生成程序化绘制的小图（阵营底台）
 *
 * 产物：public/assets/pixel/*.png
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from './lib/png.mjs';
import { buildUnitBase } from './lib/pixel-art.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'assets', 'pixel');

/** key → { 文件名, 构建器, 放大倍数 } */
const BUILT = {
  // 底座本身就是 64×64（正好一格），不再放大
  px_base_shu: { file: 'base_shu.png', build: () => buildUnitBase('shu'), scale: 1 },
  px_base_wei: { file: 'base_wei.png', build: () => buildUnitBase('wei'), scale: 1 }
};

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  let count = 0;
  let bytes = 0;
  for (const [key, def] of Object.entries(BUILT)) {
    const buf = def.build().scale(def.scale);
    const png = encodePNG(buf.w, buf.h, buf.toRGBA());
    fs.writeFileSync(path.join(OUT_DIR, def.file), png);
    count++;
    bytes += png.length;
  }

  console.log(`✓ 生成 ${count} 张程序化资源（${(bytes / 1024).toFixed(1)} KB）`);
  console.log(`  → ${path.relative(ROOT, OUT_DIR)}/`);
}

main();

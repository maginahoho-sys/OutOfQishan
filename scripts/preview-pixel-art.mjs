#!/usr/bin/env node
/**
 * preview-pixel-art.mjs —— 生成像素资源总览拼图
 *
 * 用法：node scripts/preview-pixel-art.mjs [输出路径]
 *
 * 把所有像素资源铺到一张深色底的大图上，方便肉眼检查风格是否统一、
 * 有没有画歪、配色是否清晰。纯调试用，不参与游戏运行。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodePNG } from './lib/png.mjs';
import { PixBuf } from './lib/pixbuf.mjs';
import {
  buildUnit,
  buildHero,
  buildTown,
  buildResource,
  buildTerrain,
  buildGround
} from './lib/pixel-art.mjs';
import { PIXEL_ASSETS, PIXEL_DIR } from '../src/core/pixelArt.assets.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** 预览放大倍数（1 = 原尺寸） */
const ZOOM = 2;
/** 每个格子的画布边长（像素） */
const CELL = 64;
/** 每行放几个 */
const COLS = 8;

const BUILDERS = {
  terrain: (arg) => buildTerrain(arg),
  ground: () => buildGround(),
  unit: (arg) => buildUnit(arg),
  hero: (arg) => buildHero(arg),
  town: (arg) => buildTown(arg),
  res: (arg) => buildResource(arg)
};

function main() {
  const outPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : path.join(ROOT, 'public', PIXEL_DIR, '_preview.png');

  const entries = Object.entries(PIXEL_ASSETS);
  const rows = Math.ceil(entries.length / COLS);
  const sheet = new PixBuf(COLS * CELL, rows * CELL);

  // 棋盘底
  for (let y = 0; y < sheet.h; y++) {
    for (let x = 0; x < sheet.w; x++) {
      sheet.set(x, y, ((x >> 3) + (y >> 3)) % 2 === 0 ? '#20242c' : '#191d24');
    }
  }

  entries.forEach(([key, def], i) => {
    const buf = BUILDERS[def.kind](def.arg);
    const col = i % COLS;
    const row = Math.floor(i / COLS);
    // 放大倍数：保证放大后仍能塞进格子
    const z = Math.max(1, Math.floor(CELL / Math.max(buf.w, buf.h)));
    const big = buf.scale(z);
    const ox = col * CELL + Math.floor((CELL - big.w) / 2);
    const oy = row * CELL + Math.floor((CELL - big.h) / 2);
    for (let y = 0; y < big.h; y++) {
      for (let x = 0; x < big.w; x++) {
        const c = big.get(x, y);
        if (c[3] === 0) continue;
        sheet.set(ox + x, oy + y, c);
      }
    }
  });

  fs.writeFileSync(outPath, encodePNG(sheet.w, sheet.h, sheet.toRGBA()));
  console.log(`✓ 预览拼图 → ${path.relative(ROOT, outPath)}（${sheet.w}×${sheet.h}）`);
}

main();

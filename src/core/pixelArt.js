/**
 * pixelArt —— 像素美术运行时（加载 + 显示）
 *
 * ── 设计要点 ────────────────────────────────────────────────
 *   1. **资源加载失败不能影响游戏**：所有像素图都是"锦上添花"，
 *      加载失败时各场景自动退回原来的 Graphics 色块占位。
 *      hasArt(scene, key) 就是这个开关。
 *   2. **NEAREST 过滤**：像素图必须用最近邻采样，否则缩放后边缘会糊。
 *      注意不能开 Phaser 的全局 pixelArt:true —— 那会把中文文字也变成锯齿状，
 *      所以这里只对精灵单独 setFilter。
 *   3. 纹理键与文件名分离：资源清单在 pixelArt.assets.js（纯数据，
 *      生成脚本与运行期共用），这里只负责加载与画图。
 */

import Phaser from 'phaser';
import {
  PIXEL_ASSETS,
  PIXEL_DIR,
  TERRAIN_VARIANTS,
  unitKey,
  unitMapKey,
  resKey,
  townKey,
  townMapKey,
  heroKey,
  heroMapKey,
  baseKey,
  terrainKey
} from './pixelArt.assets.js';

export {
  PIXEL_ASSETS, PIXEL_DIR, TERRAIN_VARIANTS,
  unitKey, unitMapKey, resKey, townKey, townMapKey, heroKey, heroMapKey, baseKey, terrainKey
};

/**
 * 把全部像素资源加入加载队列（BootScene.preload 调用）
 * @param {Phaser.Scene} scene
 */
export function loadPixelArt(scene) {
  for (const [key, def] of Object.entries(PIXEL_ASSETS)) {
    if (scene.textures.exists(key)) continue;
    scene.load.image(key, PIXEL_DIR + def.file);
  }
  // 资源缺失只警告，不中断（各场景会退回占位图）
  scene.load.on('loaderror', (file) => {
    console.warn('[pixelArt] 资源加载失败：', file && file.key, file && file.src);
  });
}

/**
 * 某个纹理键是否可用
 * @param {Phaser.Scene} scene
 * @param {string} key
 * @returns {boolean}
 */
export function hasArt(scene, key) {
  return !!key && !!scene && scene.textures.exists(key);
}

/**
 * 创建一个像素精灵
 *
 * @param {Phaser.Scene} scene
 * @param {string} key 纹理键
 * @param {number} x
 * @param {number} y
 * @param {number} size 显示边长（像素）
 * @param {number} [originX] 原点 x（默认居中）
 * @param {number} [originY] 原点 y
 * @returns {Phaser.GameObjects.Image|null} 纹理不存在时返回 null
 */
export function pixelSprite(scene, key, x, y, size, originX = 0.5, originY = 0.5) {
  if (!hasArt(scene, key)) return null;
  // ⚠️ Phaser 3.90 的 setFilter 在 **Texture** 上，GameObject 上没有这个方法。
  //    像素图必须最近邻采样，否则缩放后边缘会糊成一片。
  const tex = scene.textures.get(key);
  if (tex) tex.setFilter(Phaser.Textures.FilterMode.NEAREST);

  const img = scene.add.image(x, y, key).setOrigin(originX, originY);
  img.setDisplaySize(size, size);
  return img;
}

/**
 * 地形变体选择（按坐标做确定性伪随机，保证同一格每次刷新选到同一变体）
 *
 * 用坐标算而不是随机数，是为了让 redraw() 之后地形不会"跳变"。
 *
 * @param {number} tileId 地形编号
 * @param {number} x 格坐标 x
 * @param {number} y 格坐标 y
 * @returns {string|null} 纹理键
 */
export function terrainVariantKey(tileId, x, y) {
  const list = TERRAIN_VARIANTS[tileId];
  if (!list || !list.length) return null;
  // 简单散列：让相邻格的变体不同
  const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
  return list[h % list.length];
}

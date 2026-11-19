/**
 * pixelArt.assets.js —— 像素美术资源清单（**纯数据，不依赖 Phaser**）
 *
 * 这里是「哪些图、叫什么」的唯一真相来源：
 *   - 运行期（src/core/pixelArt.js）按这张表加载纹理；
 *   - 生成期（scripts/art/process-sprites.mjs + scripts/gen-pixel-art.mjs）按同一套命名产出 PNG。
 *
 * ⚠️ 本文件**不能 import phaser**：生成脚本要在 Node 里 import 它。
 *
 * ── 资源来源 ────────────────────────────────────────────────
 *   兵种 / 英雄 / 地形 / 建筑 / 资源  → AI 生成图集，经处理流水线切片
 *                                    （scripts/art/process-sprites.mjs）
 *   阵营底台                        → 代码绘制（scripts/gen-pixel-art.mjs）
 */

/** 资源文件所在目录（相对站点根） */
export const PIXEL_DIR = 'assets/pixel/';

/** 16 个兵种 id（与 src/data/units.json 一致） */
export const UNIT_IDS = [
  'shu_militia', 'shu_archer', 'shu_baidie', 'shu_crossbow',
  'shu_wudang', 'shu_fangshi', 'shu_wuhu', 'shu_hanzhong',
  'wei_qingzhou', 'wei_archer', 'wei_wuwei', 'wei_pili',
  'wei_hubao', 'wei_moushi', 'wei_huwei', 'wei_xiliang'
];

/** 8 位英雄 id（与 factions.json 的 heroPool 一致） */
export const HERO_IDS = [
  'liubei', 'zhugeliang', 'guanyu', 'zhangfei',
  'caocao', 'xiahoudun', 'zhangliao', 'xuhuang'
];

/** 7 种资源（与 townLogic 的资源类型一致） */
export const RESOURCE_IDS = [
  'gold', 'wood', 'ore', 'mercury', 'sulfur', 'crystal', 'gem'
];

/**
 * 地形编号 → 变体纹理键数组
 *
 * 与 src/data/map_default.json 的 tile 编号对应：
 *   0 平原 / 1 森林 / 2 山地 / 3 水域 / 4 道路
 * 每种地形有 4 个变体，按坐标伪随机取，避免整片地面重复感。
 */
export const TERRAIN_VARIANTS = {
  0: ['px_terrain_plain_0', 'px_terrain_plain_1', 'px_terrain_plain_2', 'px_terrain_plain_3'],
  1: ['px_terrain_forest_0', 'px_terrain_forest_1', 'px_terrain_forest_2', 'px_terrain_forest_3'],
  2: ['px_terrain_mountain_0', 'px_terrain_mountain_1', 'px_terrain_mountain_2', 'px_terrain_mountain_3'],
  3: ['px_terrain_water_0', 'px_terrain_water_1', 'px_terrain_water_2', 'px_terrain_water_3'],
  4: ['px_terrain_road']
};

/**
 * 资源清单
 *
 * key   Phaser 纹理键（scene.textures.exists(key) 可查）
 * file  public/assets/pixel/ 下的文件名
 */
export const PIXEL_ASSETS = (() => {
  /** @type {Record<string, {file: string}>} */
  const a = {};

  // ── 地形（40×40，地图格 40px，1:1 显示）──
  TERRAIN_VARIANTS[0].forEach((k, i) => { a[k] = { file: `terrain_plain_${i + 1}.png` }; });
  TERRAIN_VARIANTS[1].forEach((k, i) => { a[k] = { file: `terrain_forest_${i + 1}.png` }; });
  TERRAIN_VARIANTS[2].forEach((k, i) => { a[k] = { file: `terrain_mountain_${i + 1}.png` }; });
  TERRAIN_VARIANTS[3].forEach((k, i) => { a[k] = { file: `terrain_water_${i + 1}.png` }; });
  TERRAIN_VARIANTS[4].forEach((k) => { a[k] = { file: 'terrain_road.png' }; });

  // ── 战场地面（64×64，正好一格）──
  a.px_ground_battle = { file: 'ground_battle.png' };

  // ── 兵种：48×48（战场）+ 40×40（地图）──
  UNIT_IDS.forEach((id) => {
    a[`px_unit_${id}`] = { file: `unit_${id}.png` };
    a[`px_unit_map_${id}`] = { file: `unit_${id}_map.png` };
  });

  // ── 英雄：64×64（面板）+ 32×32（地图）──
  HERO_IDS.forEach((id) => {
    a[`px_hero_${id}`] = { file: `hero_${id}.png` };
    a[`px_hero_map_${id}`] = { file: `hero_${id}_map.png` };
  });

  // ── 城镇 / 建筑：48×48 + 32×32 ──
  ['shu', 'wei', 'village', 'tower'].forEach((f) => {
    a[`px_town_${f}`] = { file: `town_${f}.png` };
    a[`px_town_${f}_map`] = { file: `town_${f}_map.png` };
  });

  // ── 资源图标：32×32 ──
  RESOURCE_IDS.forEach((r) => { a[`px_res_${r}`] = { file: `res_${r}.png` }; });
  a.px_res_grain = { file: 'res_grain.png' };

  // ── 阵营底台：48×48 ──
  a.px_base_shu = { file: 'base_shu.png' };
  a.px_base_wei = { file: 'base_wei.png' };

  return a;
})();

/**
 * 英雄中文名 → 头像纹理键后缀
 *
 * 英雄名来自数据表（factions.json 的 heroPool / heroName），
 * 这里把中文名映射到像素画 id。
 */
export const HERO_KEY_BY_NAME = {
  刘备: 'liubei',
  诸葛亮: 'zhugeliang',
  关羽: 'guanyu',
  张飞: 'zhangfei',
  曹操: 'caocao',
  夏侯惇: 'xiahoudun',
  张辽: 'zhangliao',
  徐晃: 'xuhuang'
};

/** 兵种 id → 战场纹理键 */
export function unitKey(unitId) {
  return `px_unit_${unitId}`;
}

/** 兵种 id → 地图纹理键 */
export function unitMapKey(unitId) {
  return `px_unit_map_${unitId}`;
}

/** 资源类型 → 纹理键 */
export function resKey(resource) {
  return `px_res_${resource}`;
}

/** 阵营 → 城镇纹理键 */
export function townKey(faction) {
  return `px_town_${faction}`;
}

/** 阵营 → 城镇纹理键（地图版，32px） */
export function townMapKey(faction) {
  return `px_town_${faction}_map`;
}

/** 英雄名 → 纹理键（面板版 64px） */
export function heroKey(heroName) {
  const id = HERO_KEY_BY_NAME[heroName];
  return id ? `px_hero_${id}` : null;
}

/** 英雄名 → 纹理键（地图版 32px） */
export function heroMapKey(heroName) {
  const id = HERO_KEY_BY_NAME[heroName];
  return id ? `px_hero_map_${id}` : null;
}

/** 阵营 → 底台纹理键 */
export function baseKey(faction) {
  return `px_base_${faction}`;
}

/**
 * 取某个地形编号的变体纹理键
 * @param {number} tileId 地形编号
 * @param {number} variant 变体下标（0..3）
 * @returns {string|null}
 */
export function terrainKey(tileId, variant = 0) {
  const list = TERRAIN_VARIANTS[tileId];
  if (!list || !list.length) return null;
  return list[variant % list.length];
}

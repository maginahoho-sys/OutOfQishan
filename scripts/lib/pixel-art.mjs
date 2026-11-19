/**
 * pixel-art.mjs —— 像素美术定义
 *
 * 《出祁山》全部美术资源都是**代码生成**的像素画，不依赖任何外部图片。
 *
 * ── 为什么用代码画而不是切图？───────────────────────────────
 *   1) 本项目要能被「混元4flash 这类小模型」分模块实现，
 *      美术也必须是"读得懂、改得动"的文本代码，而不是一堆 PNG 二进制；
 *   2) 资源只有几十张、分辨率都很小（16~48px），参数化绘制比手绘更省事；
 *   3) 风格统一：所有图统一走一遍 outline（描边），像素风立刻成型。
 *
 * ── 尺寸约定 ────────────────────────────────────────────────
 *   地形  20×20 → PNG 40×40  （地图格 40px，1:1 显示）
 *   地面  16×16 → PNG 32×32  （战场格 64px，×2 显示）
 *   兵种  24×24 → PNG 48×48  （兵牌 48px，1:1 显示）
 *   底座  24×24 → PNG 48×48  （同上）
 *   英雄  16×16 → PNG 32×32  （地图格 40px 内显示）
 *   城镇  16×16 → PNG 32×32
 *   资源  16×16 → PNG 32×32
 *
 * 所有 PNG 都在放大后用最近邻采样，运行期再用 NEAREST 过滤，边缘不会糊。
 */

import { PixBuf, makeRng } from './pixbuf.mjs';

// ══════════════════════════════════════════════
// 调色板
// ══════════════════════════════════════════════

/** 全局通用色 */
export const PAL = {
  K: '#141a21',   // 描边（深墨）
  D: '#2b333d',   // 深色阴影
  SKIN: '#f0c8a0',
  SKIN_D: '#c78b60',
  HAIR: '#241b16',
  WHITE: '#f4f6f7',
  WHITE_D: '#d5dade',
  STEEL: '#93a1b0',
  STEEL_D: '#5d6b7a',
  GOLD: '#f5c542',
  GOLD_D: '#a87a1c',
  WOOD: '#7a5a34',
  WOOD_D: '#4a3524',
  SHU: '#d2452f', // 蜀红
  SHU_D: '#8f2c1e',
  WEI: '#3d8fd4', // 魏蓝
  WEI_D: '#205c8f'
};

// ══════════════════════════════════════════════
// 人物（兵种）绘制
// ══════════════════════════════════════════════

/**
 * 画一个直立人形（士兵底子）
 *
 * 24×24 画布，人物占中间 12×22。
 * 各部件位置（未骑乘时）：
 *   头   y3..8    x9..14
 *   躯干 y9..14   x8..15
 *   腿   y16..20  x9..11 / x12..14
 *   脚   y21..22
 *
 * @param {PixBuf} b 画布
 * @param {object} o 参数
 * @param {number} [oy] 整体纵向偏移（骑乘时用 -6 抬高）
 */
function drawBiped(b, o, oy = 0) {
  const cloth = o.cloth;
  const clothD = o.clothDark || o.cloth;
  const skin = o.skin || PAL.SKIN;
  const skinD = o.skinDark || PAL.SKIN_D;
  const hair = o.hair || PAL.HAIR;
  const metal = o.metal || PAL.STEEL;
  const metalD = o.metalDark || PAL.STEEL_D;

  // 披风（画在最底层）
  if (o.cape) b.rect(7, 8 + oy, 10, 9, o.cape);

  // 影子
  b.ellipse(11.5, 22.5, 6, 1.2, '#00000038');

  // 腿 / 长袍
  if (o.robe) {
    b.rect(8, 14 + oy, 8, 8, cloth);
    b.rect(7, 21 + oy, 10, 1, clothD);
    b.rect(8, 14 + oy, 8, 1, clothD);
  } else {
    b.rect(9, 16 + oy, 3, 5, clothD);
    b.rect(12, 16 + oy, 3, 5, clothD);
    b.rect(8, 21 + oy, 4, 2, '#241b16');
    b.rect(12, 21 + oy, 4, 2, '#241b16');
  }

  // 战裙
  if (!o.robe) b.rect(7, 14 + oy, 10, 3, clothD);

  // 躯干
  b.rect(8, 9 + oy, 8, 6, cloth);

  // 腰带
  b.rect(8, 13 + oy, 8, 1, o.belt || PAL.WOOD_D);

  // 胸甲 / 护肩
  if (o.armor) {
    b.rect(9, 10 + oy, 6, 4, metal);
    b.rect(10, 11 + oy, 4, 1, metalD);
    b.rect(6, 9 + oy, 2, 2, metal);
    b.rect(16, 9 + oy, 2, 2, metal);
  }

  // 手臂 + 手
  b.rect(6, 10 + oy, 2, 5, cloth);
  b.rect(16, 10 + oy, 2, 5, cloth);
  b.set(6, 15 + oy, skin);
  b.set(17, 15 + oy, skin);

  // 脖子 + 头
  b.rect(10, 8 + oy, 4, 1, skinD);
  b.rect(9, 3 + oy, 6, 6, skin);
  b.rect(9, 4 + oy, 1, 4, skinD);
  b.rect(14, 4 + oy, 1, 4, skinD);

  // 头发
  b.rect(9, 3 + oy, 6, 2, hair);
  b.rect(8, 4 + oy, 1, 2, hair);
  b.rect(15, 4 + oy, 1, 2, hair);

  // 五官
  b.set(10, 6 + oy, '#141a21');
  b.set(13, 6 + oy, '#141a21');
  b.set(10, 5 + oy, '#3a2a20');
  b.set(13, 5 + oy, '#3a2a20');
  b.rect(11, 8 + oy, 2, 1, '#a0522d');

  // 胡子
  if (o.beard === 'long') b.rect(10, 9 + oy, 4, 3, PAL.HAIR);
  else if (o.beard === 'short') b.rect(11, 9 + oy, 2, 1, '#3a2a20');
  else if (o.beard === 'full') b.rect(9, 8 + oy, 6, 2, PAL.HAIR);

  // 头饰
  drawHeadgear(b, o, oy);

  // 武器 / 盾
  drawWeapon(b, o, oy);
  drawShield(b, o, oy);
}

/**
 * 头饰
 * @param {PixBuf} b
 * @param {object} o
 * @param {number} oy
 */
function drawHeadgear(b, o, oy) {
  const metal = o.metal || PAL.STEEL;
  const metalD = o.metalDark || PAL.STEEL_D;
  const hat = o.hat || 'none';
  const hatColor = o.hatColor || '#a8762f';

  switch (hat) {
    case 'cap':
      // 斗笠：宽檐 + 尖顶
      b.rect(6, 3 + oy, 12, 1, hatColor);
      b.rect(8, 2 + oy, 8, 1, '#c08c3c');
      b.rect(9, 1 + oy, 6, 1, '#c08c3c');
      b.set(11, 0 + oy, '#c08c3c');
      break;
    case 'helm':
      // 铁盔
      b.rect(8, 2 + oy, 8, 4, metal);
      b.rect(9, 1 + oy, 6, 1, metal);
      b.rect(8, 2 + oy, 8, 1, metalD);
      b.set(7, 3 + oy, metal);
      b.set(16, 3 + oy, metal);
      b.rect(7, 4 + oy, 1, 2, metalD);
      b.rect(16, 4 + oy, 1, 2, metalD);
      break;
    case 'helm_plume':
      // 铁盔 + 盔缨
      b.rect(8, 3 + oy, 8, 3, metal);
      b.rect(9, 2 + oy, 6, 1, metal);
      b.rect(8, 3 + oy, 8, 1, metalD);
      b.set(7, 4 + oy, metal);
      b.set(16, 4 + oy, metal);
      b.rect(11, 0 + oy, 2, 3, o.crest || PAL.SHU);
      break;
    case 'band':
      // 束巾
      b.rect(9, 3 + oy, 6, 1, hatColor);
      b.rect(8, 3 + oy, 1, 1, hatColor);
      b.rect(15, 3 + oy, 1, 1, hatColor);
      break;
    case 'hood':
      // 兜帽 / 道巾
      b.rect(8, 2 + oy, 8, 3, hatColor);
      b.rect(8, 3 + oy, 1, 3, o.hatDark || hatColor);
      b.rect(15, 3 + oy, 1, 3, o.hatDark || hatColor);
      break;
    case 'crown':
      // 冠冕
      b.rect(9, 1 + oy, 6, 2, PAL.GOLD);
      b.rect(8, 1 + oy, 8, 1, PAL.GOLD_D);
      b.set(9, 0 + oy, PAL.GOLD);
      b.set(12, 0 + oy, PAL.GOLD);
      b.set(14, 0 + oy, PAL.GOLD);
      break;
    case 'none':
    default:
      break;
  }
}

/**
 * 武器（画在右手侧 x16..23）
 * @param {PixBuf} b
 * @param {object} o
 * @param {number} oy
 */
function drawWeapon(b, o, oy) {
  const metal = o.metal || PAL.STEEL;
  const weapon = o.weapon || 'none';

  switch (weapon) {
    case 'sword':
      b.rect(19, 4 + oy, 2, 10, metal);
      b.set(19, 3 + oy, metal);
      b.set(20, 3 + oy, metal);
      b.rect(18, 14 + oy, 4, 1, PAL.GOLD_D);
      b.rect(19, 15 + oy, 2, 2, PAL.WOOD_D);
      b.set(19, 17 + oy, PAL.GOLD_D);
      break;
    case 'spear':
      b.vline(20, 1 + oy, 20, PAL.WOOD);
      b.set(20, 0 + oy, metal);
      b.rect(19, 1 + oy, 3, 1, metal);
      b.set(20, 2 + oy, metal);
      b.set(20, 3 + oy, o.crest || PAL.SHU);
      b.set(19, 3 + oy, o.crest || PAL.SHU);
      break;
    case 'halberd':
      b.vline(21, 2 + oy, 19, PAL.WOOD);
      b.set(21, 1 + oy, metal);
      b.rect(17, 2 + oy, 4, 1, metal);
      b.rect(17, 3 + oy, 1, 3, metal);
      b.set(16, 2 + oy, metal);
      b.set(16, 3 + oy, metal);
      b.set(16, 4 + oy, metal);
      break;
    case 'bow': {
      // 弓身（左凸）+ 弓弦
      const top = 4 + oy;
      const bot = 16 + oy;
      for (let y = top; y <= bot; y++) {
        const t = (y - top) / (bot - top);
        const x = 22 - Math.round(3 * Math.sin(Math.PI * t));
        b.set(x, y, PAL.WOOD);
        b.set(x + 1, y, PAL.WOOD);
      }
      b.vline(22, top, bot - top + 1, '#c9b18a');
      b.rect(21, 9 + oy, 2, 2, PAL.WOOD_D);
      break;
    }
    case 'crossbow':
      // 立式诸葛连弩：竖直弩身 + 横向弩臂
      b.vline(20, 8 + oy, 8, PAL.WOOD);
      b.rect(16, 7 + oy, 9, 1, metal);
      b.set(16, 6 + oy, metal);
      b.set(24 - 1, 6 + oy, metal);
      b.hline(16, 8 + oy, 9, '#c9b18a');
      b.rect(19, 10 + oy, 3, 2, PAL.STEEL_D);
      break;
    case 'staff':
      b.vline(21, 4 + oy, 17, PAL.WOOD);
      b.circle(21, 3 + oy, 2.2, o.orb || '#9b59b6');
      b.set(20, 2 + oy, '#ffffff88');
      break;
    case 'fan':
      b.rect(16, 6 + oy, 7, 1, PAL.WHITE);
      b.rect(17, 7 + oy, 5, 1, PAL.WHITE_D);
      b.rect(18, 8 + oy, 3, 1, '#c6ccd1');
      b.rect(19, 9 + oy, 1, 1, '#c6ccd1');
      b.vline(19, 10 + oy, 4, PAL.WOOD_D);
      break;
    case 'none':
    default:
      break;
  }
}

/**
 * 盾牌（画在左手侧 x1..6）
 * @param {PixBuf} b
 * @param {object} o
 * @param {number} oy
 */
function drawShield(b, o, oy) {
  const metal = o.metal || PAL.STEEL;
  const metalD = o.metalDark || PAL.STEEL_D;
  switch (o.shield || 'none') {
    case 'round':
      b.circle(5, 12 + oy, 3.4, metal);
      b.ring(5, 12 + oy, 3.4, 2.4, metalD);
      b.circle(5, 12 + oy, 1.1, PAL.GOLD_D);
      break;
    case 'tower':
      b.rect(2, 7 + oy, 6, 11, metal);
      b.rect(2, 7 + oy, 6, 1, metalD);
      b.rect(2, 16 + oy, 6, 2, metalD);
      b.rect(3, 10 + oy, 4, 5, metalD);
      break;
    case 'none':
    default:
      break;
  }
}

/**
 * 战马（画在骑乘者身下）
 * @param {PixBuf} b
 */
function drawHorse(b) {
  b.rect(4, 15, 15, 5, '#7a4a2a');
  b.rect(4, 15, 15, 1, '#96603a');
  b.rect(1, 10, 4, 7, '#7a4a2a');
  b.rect(0, 11, 2, 4, '#96603a');
  b.set(0, 12, '#141a21');
  b.rect(4, 9, 2, 6, '#3a2a1a');
  b.rect(18, 13, 2, 5, '#3a2a1a');
  b.rect(4, 20, 2, 4, '#5e3a20');
  b.rect(8, 20, 2, 4, '#5e3a20');
  b.rect(13, 20, 2, 4, '#5e3a20');
  b.rect(16, 20, 2, 4, '#5e3a20');
}

/**
 * 翅膀（无当飞军）
 * @param {PixBuf} b
 */
function drawWings(b) {
  b.rect(1, 5, 2, 7, '#dfeef7');
  b.rect(3, 6, 2, 6, '#dfeef7');
  b.rect(5, 7, 2, 5, '#c9e0ee');
  b.rect(1, 4, 6, 1, '#f2f8fc');
  b.rect(21, 5, 2, 7, '#dfeef7');
  b.rect(19, 6, 2, 6, '#dfeef7');
  b.rect(17, 7, 2, 5, '#c9e0ee');
  b.rect(17, 4, 6, 1, '#f2f8fc');
}

/**
 * 霹雳车（投石车）—— 攻城器械，不画成人形
 * @param {PixBuf} b
 */
function drawCatapult(b) {
  // 底座与车轮
  b.rect(3, 17, 18, 3, '#6b4a2a');
  b.circle(6, 19, 2.6, '#4a3020');
  b.circle(17, 19, 2.6, '#4a3020');
  b.set(6, 19, '#8a6438');
  b.set(17, 19, '#8a6438');
  // 车身
  b.rect(7, 12, 10, 5, '#7a5a34');
  b.rect(7, 12, 10, 1, '#96693c');
  // 投臂
  b.line(11, 17, 19, 6, '#8a6438');
  b.line(12, 17, 20, 7, '#6b4a2a');
  // 配重与石弹
  b.rect(4, 8, 4, 4, PAL.STEEL_D);
  b.circle(20, 4, 2.2, PAL.STEEL);
  b.set(19, 3, '#c9d3dc');
}

// ══════════════════════════════════════════════
// 英雄头像（16×16）
// ══════════════════════════════════════════════

/**
 * 画一个半身像
 * @param {PixBuf} b 16×16
 * @param {object} o
 */
function drawPortrait(b, o) {
  const cloth = o.cloth;
  const clothD = o.clothDark || o.cloth;

  // 肩
  b.rect(2, 11, 12, 5, cloth);
  b.rect(3, 10, 10, 1, clothD);
  // 领口
  b.rect(6, 10, 4, 1, PAL.GOLD_D);
  // 脖子
  b.rect(6, 9, 4, 1, PAL.SKIN_D);
  // 头
  b.rect(4, 3, 8, 7, PAL.SKIN);
  b.rect(4, 4, 1, 4, PAL.SKIN_D);
  b.rect(11, 4, 1, 4, PAL.SKIN_D);
  b.set(3, 6, PAL.SKIN_D);
  b.set(12, 6, PAL.SKIN_D);
  // 发
  b.rect(4, 2, 8, 2, o.hair || PAL.HAIR);
  // 五官
  b.rect(5, 5, 2, 1, '#3a2a20');
  b.rect(9, 5, 2, 1, '#3a2a20');
  b.set(5, 6, '#141a21');
  b.set(10, 6, '#141a21');
  b.rect(7, 8, 2, 1, '#a0522d');
  // 胡子
  if (o.beard === 'long') b.rect(6, 9, 4, 4, PAL.HAIR);
  else if (o.beard === 'full') b.rect(5, 8, 6, 2, PAL.HAIR);
  else if (o.beard === 'short') b.rect(7, 9, 2, 1, '#3a2a20');

  // 头饰
  switch (o.hat || 'none') {
    case 'crown':
      // 冕冠
      b.rect(4, 0, 8, 2, PAL.GOLD);
      b.rect(3, 1, 10, 1, PAL.GOLD_D);
      b.set(4, 0, PAL.GOLD_D);
      b.set(11, 0, PAL.GOLD_D);
      break;
    case 'kerchief':
      // 纶巾
      b.rect(4, 1, 8, 2, '#e8e8e0');
      b.rect(5, 0, 6, 1, '#d8d8cc');
      b.rect(3, 2, 10, 1, '#cfcfc2');
      break;
    case 'band':
      // 巾（绿/黑）
      b.rect(4, 2, 8, 1, o.hatColor);
      b.rect(3, 2, 1, 1, o.hatColor);
      b.rect(12, 2, 1, 1, o.hatColor);
      break;
    case 'helm':
      // 铁盔
      b.rect(4, 1, 8, 3, PAL.STEEL);
      b.rect(5, 0, 6, 1, PAL.STEEL);
      b.rect(4, 1, 8, 1, PAL.STEEL_D);
      if (o.crest) {
        b.rect(7, 0, 2, 2, o.crest);
        b.set(7, 0, o.crest);
      }
      break;
    case 'eyepatch':
      // 夏侯惇：铁盔 + 眼罩
      b.rect(4, 1, 8, 3, PAL.STEEL);
      b.rect(5, 0, 6, 1, PAL.STEEL);
      b.rect(4, 1, 8, 1, PAL.STEEL_D);
      b.rect(5, 5, 6, 2, '#141a21');
      b.set(5, 6, '#141a21');
      break;
    default:
      break;
  }
}

// ══════════════════════════════════════════════
// 城镇 / 资源 / 底座 / 地面
// ══════════════════════════════════════════════

/**
 * 城镇（16×16）
 * @param {PixBuf} b
 * @param {string} color 阵营主色
 * @param {string} dark 阵营暗色
 */
function drawTown(b, color, dark) {
  // 城墙
  b.rect(2, 7, 12, 8, '#9a9a92');
  b.rect(2, 7, 12, 1, '#b0b0a6');
  // 雉堞
  for (let x = 2; x <= 12; x += 2) b.rect(x, 5, 2, 2, '#b0b0a6');
  // 角楼
  b.rect(1, 3, 4, 12, '#8a8a82');
  b.rect(11, 3, 4, 12, '#8a8a82');
  b.rect(1, 3, 4, 1, '#a0a098');
  b.rect(11, 3, 4, 1, '#a0a098');
  // 楼顶（阵营色）
  b.rect(0, 1, 6, 2, color);
  b.rect(10, 1, 6, 2, color);
  b.hline(0, 1, 6, dark);
  b.hline(10, 1, 6, dark);
  // 大门
  b.rect(6, 10, 4, 5, '#3a2a1a');
  b.rect(6, 10, 4, 1, '#241b16');
  // 旗帜
  b.vline(8, 0, 3, '#6b5a3a');
  b.rect(9, 0, 4, 3, color);
  b.set(12, 2, dark);
}

/**
 * 资源图标（16×16）
 * @param {PixBuf} b
 * @param {string} kind
 */
function drawResource(b, kind) {
  switch (kind) {
    case 'gold': {
      // 三枚金币
      b.circle(5, 11, 3.2, PAL.GOLD_D);
      b.circle(5, 11, 2.4, PAL.GOLD);
      b.circle(10, 9, 3.2, PAL.GOLD_D);
      b.circle(10, 9, 2.4, PAL.GOLD);
      b.circle(7, 13, 2.4, PAL.GOLD_D);
      b.circle(7, 13, 1.7, PAL.GOLD);
      b.set(9, 8, '#fff3b0');
      b.set(4, 10, '#fff3b0');
      break;
    }
    case 'wood': {
      // 原木
      b.rect(2, 7, 12, 5, '#9a6b33');
      b.rect(2, 7, 12, 1, '#b58247');
      b.rect(2, 11, 12, 1, '#7a5228');
      b.ellipse(2.5, 9.5, 1.6, 2.6, '#c08c3c');
      b.ellipse(2.5, 9.5, 0.9, 1.5, '#8a6024');
      break;
    }
    case 'ore': {
      // 矿石块
      b.rect(3, 8, 5, 5, '#6d7a85');
      b.rect(4, 7, 3, 1, '#8b98a6');
      b.rect(8, 10, 5, 4, '#5d6b7a');
      b.rect(9, 9, 3, 1, '#7f8c8d');
      b.set(5, 10, '#a9b6c3');
      break;
    }
    case 'mercury': {
      // 汞瓶
      b.rect(7, 3, 3, 2, '#cfe0ea');
      b.rect(6, 5, 5, 9, '#cfe0ea');
      b.rect(7, 8, 3, 5, '#9b59b6');
      b.rect(7, 8, 3, 1, '#c39bd8');
      b.vline(6, 5, 9, '#e8f2f7');
      b.rect(6, 3, 5, 1, '#5d6b7a');
      break;
    }
    case 'sulfur': {
      // 硫磺结晶
      b.rect(4, 8, 4, 6, '#e8d24a');
      b.rect(8, 10, 4, 4, '#d8c13a');
      b.rect(2, 10, 3, 4, '#f0dc6a');
      b.rect(5, 6, 3, 3, '#f5e37a');
      b.set(6, 9, '#fff8c8');
      break;
    }
    case 'crystal': {
      // 蓝水晶
      b.rect(5, 5, 6, 9, '#29b6f6');
      b.rect(6, 4, 4, 2, '#4fc3f7');
      b.rect(7, 3, 2, 2, '#81d4fa');
      b.vline(5, 6, 8, '#0288d1');
      b.vline(10, 6, 8, '#0288d1');
      b.set(7, 7, '#e1f5fe');
      break;
    }
    case 'gem': {
      // 红宝石
      b.rect(5, 5, 6, 2, '#e91e63');
      b.rect(4, 7, 8, 4, '#e91e63');
      b.rect(5, 11, 6, 3, '#c2185b');
      b.set(5, 6, '#ff8aab');
      b.set(7, 8, '#ff8aab');
      b.set(8, 8, '#ffb3c6');
      break;
    }
    default:
      break;
  }
}

/**
 * 阵营底盘（画在角色下面的圆盘）
 *
 * 之前是"圆盘 + 角色"两个对象叠放（圆盘是 Phaser 的 Circle 占位图），
 * 现在把阵营色**烘焙进贴图**：圆盘先画，角色后画并保留自己的描边。
 * 好处：少一个显示对象、描边不会被圆盘吃掉、阵营色一眼可辨。
 *
 * 圆盘结构（由外向内）：暗色外沿 → 阵营亮边（金/银）→ 阵营色底 → 高光
 *
 * @param {PixBuf} b
 * @param {string} color 阵营主色
 * @param {string} dark 阵营暗色
 * @param {string} trim 阵营亮边（蜀金 / 魏银）
 */
function drawFactionDisc(b, color, dark, trim) {
  const cx = b.w / 2;
  const cy = b.h / 2;
  const r = Math.min(b.w, b.h) / 2 - 0.5;
  b.circle(cx, cy, r, color);
  // 左上高光，让圆盘有点体积感
  b.circle(cx - r * 0.42, cy - r * 0.42, r * 0.32, '#ffffff22');
  // 外沿暗边 + 内侧阵营亮边
  b.ring(cx, cy, r, r - 1.6, dark);
  b.ring(cx, cy, r - 1.6, r - 2.6, trim);
}

// ══════════════════════════════════════════════
// 地形与地面
// ══════════════════════════════════════════════

/** 地形基色表 */
export const TERRAIN_COLORS = {
  plain: { base: '#6f9c4a', light: '#7cae54', dark: '#628a40' },
  forest: { base: '#41693a', light: '#3d7038', dark: '#2c5229' },
  mountain: { base: '#7c8478', light: '#9aa294', dark: '#5f675c' },
  water: { base: '#3a6ba8', light: '#4e86c4', dark: '#2b5384' },
  road: { base: '#b39a68', light: '#c9b488', dark: '#98804f' }
};

/**
 * 地形瓦片（20×20）
 * @param {PixBuf} b
 * @param {string} kind plain/forest/mountain/water/road
 */
function drawTerrain(b, kind) {
  const c = TERRAIN_COLORS[kind];
  const rng = makeRng(0x51ed + kind.length * 7919);
  b.rect(0, 0, 20, 20, c.base);

  switch (kind) {
    case 'plain':
      // 草丛与碎石
      for (let i = 0; i < 26; i++) {
        const x = Math.floor(rng() * 20);
        const y = Math.floor(rng() * 20);
        b.set(x, y, rng() > 0.5 ? c.light : c.dark);
      }
      for (let i = 0; i < 5; i++) {
        const x = Math.floor(rng() * 18);
        const y = Math.floor(rng() * 18);
        b.set(x, y, c.light);
        b.set(x, y + 1, c.dark);
      }
      break;
    case 'forest': {
      // 四棵树：树干 + 树冠
      const trees = [[4, 4], [13, 3], [6, 13], [15, 12]];
      for (const [tx, ty] of trees) {
        b.rect(tx + 1, ty + 4, 2, 3, '#4a3524');
        b.circle(tx + 1.5, ty + 2, 3.2, c.dark);
        b.circle(tx + 1.5, ty + 1.6, 2.2, c.light);
      }
      for (let i = 0; i < 18; i++) {
        b.set(Math.floor(rng() * 20), Math.floor(rng() * 20), c.light);
      }
      break;
    }
    case 'mountain': {
      // 三座石峰
      const peaks = [[5, 3, 5], [13, 5, 4], [3, 12, 4]];
      for (const [px, py, h] of peaks) {
        for (let i = 0; i < h; i++) {
          const w = 1 + i * 2;
          b.rect(px - Math.floor(w / 2), py + (h - 1 - i), w, 1, c.light);
        }
        b.set(px, py, '#c2c8bd');
      }
      for (let i = 0; i < 20; i++) {
        b.set(Math.floor(rng() * 20), Math.floor(rng() * 20), c.dark);
      }
      break;
    }
    case 'water': {
      // 波纹
      for (let y = 1; y < 20; y += 3) {
        for (let x = 0; x < 20; x++) {
          const off = (y / 3) % 2 === 0 ? 0 : 3;
          if ((x + off) % 6 < 3) b.set(x, y, c.light);
          if ((x + off) % 6 < 1) b.set(x, y + 1, c.dark);
        }
      }
      for (let i = 0; i < 10; i++) {
        b.set(Math.floor(rng() * 20), Math.floor(rng() * 20), c.light);
      }
      break;
    }
    case 'road':
      // 车辙与碎石
      b.rect(0, 9, 20, 2, c.dark);
      b.rect(0, 10, 20, 1, c.light);
      for (let i = 0; i < 18; i++) {
        b.set(Math.floor(rng() * 20), Math.floor(rng() * 20), rng() > 0.5 ? c.light : c.dark);
      }
      break;
    default:
      break;
  }
}

/**
 * 战场地面（16×16，可平铺）
 * @param {PixBuf} b
 */
function drawBattleGround(b) {
  const rng = makeRng(0x2f19a3);
  b.rect(0, 0, 16, 16, '#3f5230');
  // 泥土斑块
  b.ellipse(4, 5, 2.6, 1.8, '#4a3f2a');
  b.ellipse(11, 10, 3, 2, '#4a3f2a');
  b.ellipse(12, 3, 2, 1.4, '#4a3f2a');
  // 草
  for (let i = 0; i < 30; i++) {
    const x = Math.floor(rng() * 16);
    const y = Math.floor(rng() * 16);
    b.set(x, y, rng() > 0.45 ? '#4e6339' : '#354527');
  }
  for (let i = 0; i < 8; i++) {
    const x = Math.floor(rng() * 16);
    const y = Math.floor(rng() * 16);
    b.set(x, y, '#5c7442');
  }
}

// ══════════════════════════════════════════════
// 兵种定义表
// ══════════════════════════════════════════════

/**
 * 16 个兵种的像素画参数
 *
 * 蜀（生命）偏绿/红 + 羽饰；魏（守序）偏蓝/钢 + 冷色盔缨。
 */
export const UNIT_ART = {
  // ── 蜀汉 ──
  shu_militia: {
    cloth: '#6f7a45', clothDark: '#4f5830', hat: 'cap', hatColor: '#a8762f',
    weapon: 'sword', shield: 'none'
  },
  shu_archer: {
    cloth: '#4f7f34', clothDark: '#375c25', hat: 'band', hatColor: '#c8b45a',
    weapon: 'bow', shield: 'none'
  },
  shu_baidie: {
    cloth: '#b5372a', clothDark: '#8a2620', hat: 'helm_plume', crest: '#f0f0f0',
    metal: '#b9c4cf', metalDark: '#8593a3', weapon: 'halberd', shield: 'round'
  },
  shu_crossbow: {
    cloth: '#4a7a4f', clothDark: '#355a38', hat: 'band', hatColor: '#c8b45a',
    weapon: 'crossbow', shield: 'none'
  },
  shu_wudang: {
    cloth: '#3f7a52', clothDark: '#2c5a3c', hat: 'helm', crest: '#7fc79a',
    weapon: 'sword', shield: 'none', wings: true
  },
  shu_fangshi: {
    cloth: '#6b4a86', clothDark: '#4d3363', hat: 'hood', hatColor: '#7a5499',
    hatDark: '#5b3d73', weapon: 'staff', orb: '#9b59b6', robe: true
  },
  shu_wuhu: {
    cloth: '#a8342a', clothDark: '#7a221b', hat: 'helm_plume', crest: '#f5c542',
    metal: '#d7b45c', metalDark: '#a87a1c', weapon: 'spear', shield: 'none',
    armor: true, cape: '#8f2c1e', belt: '#f5c542'
  },
  shu_hanzhong: {
    cloth: '#a8342a', clothDark: '#7a221b', hat: 'helm', crest: '#f5c542',
    metal: '#c8d2dc', metalDark: '#8a97a5', weapon: 'spear', shield: 'none',
    mount: true, cape: '#8f2c1e'
  },

  // ── 曹魏 ──
  wei_qingzhou: {
    cloth: '#37618f', clothDark: '#2a4a6d', hat: 'helm', crest: '#5d6b7a',
    metal: '#9aa8b6', metalDark: '#65727f', weapon: 'sword', shield: 'round'
  },
  wei_archer: {
    cloth: '#3f5a72', clothDark: '#2d4356', hat: 'helm', crest: '#65727f',
    metal: '#9aa8b6', metalDark: '#65727f', weapon: 'bow', shield: 'none'
  },
  wei_wuwei: {
    cloth: '#35506e', clothDark: '#273d54', hat: 'helm_plume', crest: '#4a8fd4',
    metal: '#b3c0cd', metalDark: '#7d8b99', weapon: 'sword', shield: 'round',
    armor: true
  },
  wei_pili: {
    special: 'catapult'
  },
  wei_hubao: {
    cloth: '#2f5d8c', clothDark: '#22456a', hat: 'helm_plume', crest: '#3d8fd4',
    metal: '#a8b5c2', metalDark: '#6f7d8b', weapon: 'sword', shield: 'none',
    mount: true, cape: '#22456a'
  },
  wei_moushi: {
    cloth: '#4a4a72', clothDark: '#353550', hat: 'hood', hatColor: '#575780',
    hatDark: '#3f3f63', weapon: 'fan', robe: true
  },
  wei_huwei: {
    cloth: '#2b3f57', clothDark: '#1f2f42', hat: 'helm_plume', crest: '#f5c542',
    metal: '#c3cedb', metalDark: '#8a97a5', weapon: 'halberd', shield: 'tower',
    armor: true, cape: '#1f2f42'
  },
  wei_xiliang: {
    cloth: '#3a4a5e', clothDark: '#2a3746', hat: 'helm', crest: '#4a8fd4',
    metal: '#c8d2dc', metalDark: '#8a97a5', weapon: 'spear', shield: 'none',
    mount: true, armor: true, cape: '#2a3746'
  }
};

/**
 * 8 位英雄的头像参数
 */
export const HERO_ART = {
  liubei: { cloth: '#4f7f34', clothDark: '#375c25', hat: 'crown', hair: '#241b16', beard: 'short' },
  zhugeliang: { cloth: '#d8dcd2', clothDark: '#b4b9ae', hat: 'kerchief', hair: '#241b16', beard: 'short' },
  guanyu: { cloth: '#3f7a52', clothDark: '#2c5a3c', hat: 'band', hatColor: '#1e6b4a', hair: '#241b16', beard: 'long' },
  zhangfei: { cloth: '#3a3a44', clothDark: '#282830', hat: 'band', hatColor: '#1b1b1f', hair: '#1b1b1f', beard: 'full' },
  caocao: { cloth: '#5b4a86', clothDark: '#413466', hat: 'crown', hair: '#241b16', beard: 'short' },
  xiahoudun: { cloth: '#37618f', clothDark: '#2a4a6d', hat: 'eyepatch', hair: '#241b16' },
  zhangliao: { cloth: '#2f5d8c', clothDark: '#22456a', hat: 'helm', crest: '#d2452f', hair: '#241b16' },
  xuhuang: { cloth: '#3a4a5e', clothDark: '#2a3746', hat: 'helm', crest: '#3d8fd4', hair: '#241b16', beard: 'full' }
};

/**
 * 阵营配色（底座 / 城镇 / 旗帜）
 */
export const FACTION_ART = {
  shu: { color: PAL.SHU, dark: PAL.SHU_D, trim: '#f5c542' },
  wei: { color: PAL.WEI, dark: PAL.WEI_D, trim: '#d5dde5' }
};

/** 从兵种 id 推断阵营（shu_ / wei_ 前缀） */
function factionOfUnit(unitId) {
  return String(unitId).startsWith('wei_') ? 'wei' : 'shu';
}

/** 从英雄 id 推断阵营 */
function factionOfHero(heroId) {
  const weiHeroes = ['caocao', 'xiahoudun', 'zhangliao', 'xuhuang'];
  return weiHeroes.includes(heroId) ? 'wei' : 'shu';
}

// ══════════════════════════════════════════════
// 构建器（key → 画布）
// ══════════════════════════════════════════════

/**
 * 兵种图标 24×24
 *
 * 结构：阵营圆盘（底） + 角色（面，保留描边）
 * @param {string} unitId
 * @returns {PixBuf}
 */
function buildUnit(unitId) {
  const def = UNIT_ART[unitId];
  const b = new PixBuf(24, 24);
  if (!def) return b;

  // 角色单独画到一张画布上并描边，再叠到圆盘上
  const ch = new PixBuf(24, 24);
  if (def.special === 'catapult') {
    drawCatapult(ch);
  } else {
    if (def.mount) drawHorse(ch);
    if (def.wings) drawWings(ch);
    drawBiped(ch, def, def.mount ? -6 : 0);
  }
  ch.outline(PAL.K);

  const f = FACTION_ART[factionOfUnit(unitId)];
  drawFactionDisc(b, f.color, f.dark, f.trim);
  b.blit(ch);
  return b;
}

/**
 * 英雄头像 16×16（阵营圆盘 + 半身像）
 * @param {string} heroId
 * @returns {PixBuf}
 */
function buildHero(heroId) {
  const b = new PixBuf(16, 16);
  const ch = new PixBuf(16, 16);
  drawPortrait(ch, HERO_ART[heroId] || {});
  ch.outline(PAL.K);

  const f = FACTION_ART[factionOfHero(heroId)];
  drawFactionDisc(b, f.color, f.dark, f.trim);
  b.blit(ch);
  return b;
}

/** 城镇 16×16 */
function buildTown(faction) {
  const b = new PixBuf(16, 16);
  const f = FACTION_ART[faction];
  drawTown(b, f.color, f.dark);
  b.outline(PAL.K);
  return b;
}

/** 资源 16×16 */
function buildResource(kind) {
  const b = new PixBuf(16, 16);
  drawResource(b, kind);
  b.outline(PAL.K);
  return b;
}

/**
 * 阵营底台（24×24 → 48×48）
 *
 * AI 生成的兵种立绘是「独立人物」，没有底色。
 * 这个椭圆底台画在人物脚下，让敌我一眼可辨（蜀红 / 魏蓝），
 * 视觉上就是《英雄无敌4》那种「军团棋子站在彩色底座上」的感觉。
 *
 * @param {PixBuf} b
 * @param {string} faction 'shu' | 'wei'
 */
function drawUnitBase(b, faction) {
  const f = FACTION_ART[faction] || FACTION_ART.shu;
  const cy = 19.5;
  b.ellipse(12, cy, 10.5, 4.2, f.dark);
  b.ellipse(12, cy - 0.4, 9.4, 3.4, f.color);
  b.ellipse(12, cy - 1.2, 6.2, 1.7, f.trim + '66');
  // 高光
  b.ellipse(9.5, cy - 1.6, 2.6, 0.8, '#ffffff33');
}

/**
 * 阵营底座 64×64 —— 战场格正好一格（64px），1:1 显示不糊
 *
 * ⚠️ 尺寸是刻意定的：
 *   - 底座 64px（等于一格），立绘 48px 站在上面；
 *   - 底座比立绘**大**，且中心偏下（cy=40），立绘下缘落在底座上沿 ——
 *     这样才有「军团棋子站在底座上」的层次，而不是两张图叠在一起。
 *   - 早期版本底座 48px 与立绘同尺寸同位置 → 完全被盖住，敌我分不清。
 */
function buildUnitBase(faction) {
  const f = FACTION_ART[faction] || FACTION_ART.shu;
  const b = new PixBuf(64, 64);

  const cx = 32;
  const cy = 40;      // 椭圆中心：整体偏下，给立绘让出上半部分
  const rx = 29;
  const ry = 13;

  // ① 深色描边（先画一圈更大的暗椭圆当外框）
  b.ellipse(cx, cy, rx + 1.5, ry + 1.5, '#1b222c');
  // ② 底座主体
  b.ellipse(cx, cy, rx, ry, f.color);
  // ③ 底部暗面（让底座有厚度）
  b.ellipse(cx, cy + 3.5, rx - 2, ry - 3, f.dark);
  // ④ 顶面亮色
  b.ellipse(cx, cy - 1.5, rx - 3, ry - 4, f.color);
  // ⑤ 内圈装饰环
  b.ellipse(cx, cy - 2, rx - 9, ry - 8, f.trim + '55');
  // ⑥ 高光
  b.ellipse(cx - 9, cy - 6, 7, 2.4, '#ffffff38');
  b.ellipse(cx + 11, cy - 3, 4, 1.6, '#ffffff22');

  return b;
}

/** 地形 20×20 */
function buildTerrain(kind) {
  const b = new PixBuf(20, 20);
  drawTerrain(b, kind);
  return b;
}

/** 战场地面 16×16 */
function buildGround() {
  const b = new PixBuf(16, 16);
  drawBattleGround(b);
  return b;
}

export {
  buildUnit, buildHero, buildTown, buildResource, buildTerrain, buildGround, buildUnitBase
};

/**
 * battleView —— 战场兵牌渲染（M7 / M14）
 *
 * 职责：把一个 stack 画成一块"兵牌"，并在数据变化时**增量刷新**。
 *
 * ── 为什么必须是"持久化视图"而不是"每次重画"？──────────────
 *   M7 要做移动/攻击/受击动画，而动画是对 Phaser 的显示对象跑 tween。
 *   如果每次刷新都 removeAll(true) 把兵牌全部销毁重建，
 *   tween 的目标对象会在动画播到一半时被销毁 —— 表现为"单位瞬移"、"动画不播"。
 *
 *   所以这里的设计是：
 *     - 每个 stack 对应一个 UnitView 对象（容器 + 子对象），**只建一次**；
 *     - 数据变了 → 只改文字 / 颜色 / 血条宽度，**不动对象引用**；
 *     - stack 全灭 → 播淡出动画后再销毁。
 *
 *   由此 BattleScene 只需维护一个 Map<stackId, UnitView>，
 *   刷新时遍历 map 做 diff（新增 / 更新 / 移除），动画对象始终存活。
 *
 * 兵牌内容（契约 M7「兵牌细节」）：
 *   - 阵营底台（蜀红 / 魏蓝的椭圆底座，敌我一眼可辨）
 *   - 兵种立绘（M14：AI 生成的 48×48 像素精灵）
 *   - 存活数量
 *   - 血条（存活数 / 开战数）
 *   - buff 徽章（增益绿 / 减益红 / 致盲紫）
 *   - 特性徽章（远程 / 飞行 / 双击 / 不反击）
 *   - 射程值（远程单位才有）
 */

import { isBlinded } from '../logic/stackOps.js';
import { hasAbility, stackRange } from '../logic/battleLogic.js';
import { pixelSprite, unitKey, baseKey } from '../core/pixelArt.js';

/** 格子尺寸 */
export const CELL = 64;
/** 战场网格左上角 */
export const GRID_X = 288;
/** 战场网格上边缘 */
export const GRID_Y = 60;

/**
 * 阵营配色
 *
 * ⚠️ M11 起改为**按 playerId 配色**，不再按 side：
 *   side（attacker/defender）只是战场站位，跟"谁是人"无关。
 *   电脑主动进攻时，电脑是 attacker —— 若按 side 配色，玩家的兵牌会变蓝，
 *   和 MapScene 上"玩家=红 / 电脑=蓝"的阵营配色对不上，玩家会误以为自己的兵变阵营了。
 *   所以这里统一按 playerId 取色，跨场景视觉一致。
 */
const PLAYER_COLOR = {
  0: 0xc0392b, // 玩家（蜀）红
  1: 0x2980b9 // 电脑（魏）蓝
};

/** 兜底色（未知 playerId 时用中性灰） */
const FALLBACK_COLOR = 0x7f8c8d;

/**
 * 取一个 stack 的兵牌颜色
 * @param {object} stack 战场 stack 数据（带 playerId / side）
 * @returns {number} 0xRRGGBB
 */
export function stackColor(stack) {
  return PLAYER_COLOR[stack?.playerId] ?? FALLBACK_COLOR;
}

/**
 * 取一个 stack 所属阵营（'shu' | 'wei'）
 *
 * 玩家（playerId 0）是蜀，电脑（playerId 1）是魏。
 * @param {object} stack
 * @returns {string}
 */
export function stackFaction(stack) {
  return stack?.playerId === 1 ? 'wei' : 'shu';
}

/**
 * 特性徽章：兵种特性 → 徽章文字
 * 徽章画在兵牌左上角的小方块里
 */
const ABILITY_BADGES = [
  { key: 'ranged', text: '弓', color: 0x8e44ad },
  { key: 'fly', text: '飞', color: 0x16a085 },
  { key: 'twoAttack', text: '双', color: 0xd35400 },
  { key: 'noRetaliation', text: '免', color: 0xc0392b }
];

/**
 * buff 属性 → 徽章文字
 * stat 与 magicLogic.applyBuff 的 statName 对应，但这里用单字更紧凑
 */
const STAT_BADGE = {
  attack: '攻',
  defense: '防',
  speed: '速',
  damageMax: '伤',
  canAct: '盲'
};

/**
 * 格子坐标 → 屏幕像素中心
 * @param {{x:number,y:number}} pos
 * @returns {{x:number,y:number}}
 */
export function cellCenter(pos) {
  return {
    x: GRID_X + pos.x * CELL + CELL / 2,
    y: GRID_Y + pos.y * CELL + CELL / 2
  };
}

/**
 * 创建一个 stack 的兵牌视图
 *
 * @param {Phaser.Scene} scene
 * @param {object} stack 战场 stack 数据
 * @returns {object} UnitView
 */
export function createUnitView(scene, stack) {
  const c = cellCenter(stack.pos);

  // 根容器：位置随 stack.pos 变化
  const root = scene.add.container(c.x, c.y);

  // 兵牌主体 —— 单独一层，便于做受击抖动而不影响容器位置
  const body = scene.add.container(0, 0);

  const color = stackColor(stack);
  const faction = stackFaction(stack);

  // ── 阵营底座 + 兵种立绘（M14）──
  // 底座 64px（正好一格），立绘 48px 站在上面 —— 这就是《英雄无敌4》的"军团棋子"造型。
  // ⚠️ 底座必须比立绘大、且立绘上移，否则底座会被立绘完全盖住（敌我分不清）。
  const base = pixelSprite(scene, baseKey(faction), 0, 8, 64);
  const icon = pixelSprite(scene, unitKey(stack.unitId), 0, -6, 48);

  // 立绘缺失时的回退：色块圆盘 + 兵种首字
  let fallbackDisc = null;
  let nameText = null;
  if (!icon) {
    fallbackDisc = scene.add.circle(0, -3, CELL / 2 - 8, color);
    nameText = scene.add.text(0, -10, stack.unitName.slice(0, 1), {
      fontSize: '16px',
      color: '#fff'
    }).setOrigin(0.5);
  }

  // 致盲灰纱：盖在兵牌上，一眼看出"这单位动不了"
  const blindVeil = scene.add.rectangle(0, -4, 52, 52, 0x5d6d80, 0).setVisible(false);

  // 存活数量
  const countText = scene.add.text(0, 14, `×${stack.count}`, {
    fontSize: '13px',
    color: '#fff',
    stroke: '#101418',
    strokeThickness: 3
  }).setOrigin(0.5);

  body.add([base, icon, fallbackDisc, nameText, blindVeil, countText].filter(Boolean));

  // 选中描边（黄色）：常态隐藏，选中时显示
  // ⚠️ add.circle 默认是白色实心填充，必须显式把填充透明，否则会盖住兵牌
  const selRing = scene.add.circle(0, 0, CELL / 2 - 5, 0xffffff, 0)
    .setStrokeStyle(3, 0xf1c40f)
    .setVisible(false);

  // 当前行动单位的金色描边（会做闪烁动画）
  const turnRing = scene.add.circle(0, 0, CELL / 2 - 6, 0xffffff, 0)
    .setStrokeStyle(3, 0xf39c12)
    .setVisible(false);

  // 血条：存活数 / 开战数
  const BAR_W = CELL - 18;
  const hpBarBg = scene.add.rectangle(0, 26, BAR_W, 4, 0x111111, 0.85);
  const hpBar = scene.add.rectangle(-BAR_W / 2, 26, BAR_W, 4, 0x2ecc71)
    .setOrigin(0, 0.5);

  // 射程文字（远程单位才有）
  const rangeText = scene.add.text(0, -25, '', {
    fontSize: '10px',
    color: '#f39c12',
    stroke: '#101418',
    strokeThickness: 3
  }).setOrigin(0.5).setVisible(false);

  // buff 徽章容器（右上角）
  const buffLayer = scene.add.container(CELL / 2 - 16, -CELL / 2 + 6);
  // 特性徽章容器（左上角）
  const abilityLayer = scene.add.container(-CELL / 2 + 10, -CELL / 2 + 8);

  root.add([selRing, turnRing, body, hpBarBg, hpBar, rangeText, buffLayer, abilityLayer]);

  const view = {
    id: stack.id,
    root,
    body,
    /** 兵种立绘（资源缺失时为 null） */
    icon,
    /** 阵营底台 */
    base,
    /** 致盲灰纱 */
    blindVeil,
    /** 回退用色块圆盘（有像素资源时为 null） */
    disc: fallbackDisc,
    /** 阵营色（供自动化脚本断言"兵牌配色按 playerId"） */
    factionColor: color,
    faction,
    nameText,
    countText,
    selRing,
    turnRing,
    hpBarBg,
    hpBar,
    rangeText,
    buffLayer,
    abilityLayer,
    /** 上次刷新时的 buff 签名，用于判断要不要重建徽章 */
    buffSig: '',
    /** 上次刷新时的特性签名 */
    abilitySig: '',
    /** 动画占用标记：动画播放期间不要覆盖位置 */
    animating: false,
    /** 已进入死亡流程（淡出中） */
    dying: false
  };

  // 特性徽章只建一次（abilities 不会变）
  buildAbilityBadges(scene, view, stack);

  refreshUnitView(scene, view, stack, { isCurrent: false, isSelected: false });

  return view;
}

/**
 * 构建特性徽章（ranged / fly / twoAttack / noRetaliation）
 * @param {Phaser.Scene} scene
 * @param {object} view
 * @param {object} stack
 */
function buildAbilityBadges(scene, view, stack) {
  const sig = (stack.abilities || []).join(',');
  if (sig === view.abilitySig) return;
  view.abilitySig = sig;
  view.abilityLayer.removeAll(true);

  (stack.abilities || []).forEach((ab, i) => {
    const badge = ABILITY_BADGES.find((b) => b.key === ab);
    if (!badge) return;
    const g = scene.add.container(0, i * 11);
    const bg = scene.add.rectangle(0, 0, 11, 11, badge.color, 0.95);
    const t = scene.add.text(0, 0, badge.text, {
      fontSize: '9px',
      color: '#fff'
    }).setOrigin(0.5);
    g.add([bg, t]);
    view.abilityLayer.add(g);
  });
}

/**
 * 增量刷新一个兵牌视图
 *
 * 只改内容，不重建对象 —— 这样 tween 动画不会被打断。
 *
 * @param {Phaser.Scene} scene
 * @param {object} view
 * @param {object} stack
 * @param {{isCurrent?:boolean, isSelected?:boolean}} flags
 */
export function refreshUnitView(scene, view, stack, flags = {}) {
  const isCurrent = !!flags.isCurrent;
  const isSelected = !!flags.isSelected;

  // 位置（动画中不覆盖，由 tween 控制）
  if (!view.animating && !view.dying) {
    const c = cellCenter(stack.pos);
    view.root.x = c.x;
    view.root.y = c.y;
  }

  // 数量文字
  view.countText.setText(`×${stack.count}`);

  // 血条：存活数 / 开战数
  // ⚠️ Rectangle 的 width 直接赋值不会更新几何，必须用 setSize
  const total = Math.max(1, stack.initialCount ?? stack.count ?? 1);
  const ratio = Math.max(0, Math.min(1, (stack.count || 0) / total));
  const barW = CELL - 18;
  view.hpBar.setSize(Math.max(0, barW * ratio), 4);
  view.hpBar.setPosition(-barW / 2 + (barW * ratio) / 2, 26);
  // 血量越低颜色越红
  view.hpBar.setFillStyle(ratio > 0.6 ? 0x2ecc71 : (ratio > 0.3 ? 0xf39c12 : 0xe74c3c), 1);

  // 选中 / 当前 的描边
  view.selRing.setVisible(isSelected);
  view.turnRing.setVisible(isCurrent && !isSelected);

  // 射程文字（远程单位才有）
  const ranged = hasAbility(stack, 'ranged');
  const range = stackRange(stack);
  if (ranged && range > 1) {
    view.rangeText.setText(`射程${range}`);
    view.rangeText.setVisible(true);
  } else {
    view.rangeText.setVisible(false);
  }

  // buff 徽章（有变化才重建）
  const sig = (stack.buffs || [])
    .map((b) => `${b.spellId}:${b.stat}:${b.value}:${b.turnsLeft}`)
    .join('|');
  if (sig !== view.buffSig) {
    view.buffSig = sig;
    view.buffLayer.removeAll(true);
    (stack.buffs || []).forEach((b, i) => {
      const text = STAT_BADGE[b.stat] || b.stat.slice(0, 1);
      // 增益（value>0）绿色、减益（value<0）红色、致盲（canAct）紫色
      const color = b.stat === 'canAct'
        ? 0x9b59b6
        : (b.value > 0 ? 0x2ecc71 : 0xe74c3c);
      const g = scene.add.container(0, -i * 11);
      const bg = scene.add.rectangle(0, 0, 11, 11, color, 0.95);
      const t = scene.add.text(0, 0, text, {
        fontSize: '9px',
        color: '#fff'
      }).setOrigin(0.5);
      g.add([bg, t]);
      view.buffLayer.add(g);
    });
  }

  // 致盲：兵牌整体蒙一层灰纱，一眼能看出"这单位动不了"
  if (isBlinded(stack)) {
    view.blindVeil.setFillStyle(0x5d6d80, 0.55);
    view.blindVeil.setVisible(true);
    if (view.disc) view.disc.setFillStyle(0x5d6d80, 1);
  } else {
    view.blindVeil.setVisible(false);
    if (view.disc) view.disc.setFillStyle(stackColor(stack), 1);
  }
}

/**
 * 销毁一个兵牌视图（不含淡出动画）
 * @param {Phaser.Scene} scene
 * @param {object} view
 */
export function destroyUnitView(scene, view) {
  if (!view) return;
  try {
    // 先停掉所有挂在该视图上的 tween，否则销毁后会继续改已释放的对象
    scene.tweens.killTweensOf(view.root);
    scene.tweens.killTweensOf(view.body);
    scene.tweens.killTweensOf(view.turnRing);
    view.root.destroy(true);
  } catch {
    /* 场景已关闭时忽略 */
  }
}

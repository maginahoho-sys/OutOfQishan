import { heroSpells, canCast, hasCastThisTurn } from '../../logic/magicLogic.js';
import { createPanel, createButton, THEME, DEPTH } from './components.js';

/**
 * spellPanel —— 施法面板（M9）
 *
 * 提供一个"选魔法"的弹层，供 BattleScene 使用：
 *   - 列出英雄已习得的所有魔法（名称 / 法力消耗 / 目标类型 / 效果说明）
 *   - 法力不足的魔法**置灰且不可点**
 *   - 本轮已施法过时，所有魔法都置灰（每方每轮限施法 1 次）
 *   - 点一张魔法卡 → 回调 onPick(spellId, def)，由调用方决定后续
 *     （单体目标进"选目标"模式，群体魔法直接施放）
 *
 * 用法：
 *   openSpellPanel(scene, {
 *     state, battle, heroId,
 *     onPick(spellId, def),   // 玩家选了某个魔法
 *     onCancel()              // 玩家点了关闭
 *   });
 *
 * 本文件属于渲染层：只调用逻辑层函数，不直接改 state。
 *
 * 图层结构（与 skillPanel 保持一致的写法）：
 *   layer（depth 950）
 *     ├ shade  遮罩（可点 = 关闭面板）
 *     ├ panel  底板
 *     ├ title / subtitle / hint  文本
 *     └ cardLayer  容器（每次刷新只重建这一层）
 *
 * ── 布局 ──────────────────────────────────────────────
 * 魔法数量随英雄等级增长（蜀汉 1~3 级共 6 个魔法），
 * 横向一排排不下，所以用**网格**：每行最多 MAX_COLS 张，
 * 面板宽高按实际行列数算出来（面板尺寸在打开时一次算好，之后不再变）。
 */

/** 单张魔法卡尺寸 */
const CARD_W = 260;
const CARD_H = 190;
/** 卡片间距 */
const GAP_X = 24;
const GAP_Y = 22;
/** 每行最多几张卡 */
const MAX_COLS = 3;
/** 面板上部（标题 + 副标题）预留高度 */
const HEADER_H = 110;
/** 面板下部（提示行）预留高度 */
const FOOTER_H = 70;
/** 面板最小宽度（魔法很少时不至于太窄） */
const MIN_PANEL_W = 620;
/** 面板左右最小留白（屏幕宽 1280） */
const SIDE_MARGIN = 60;

/** 目标类型 → 中文 */
const TARGET_NAME = {
  ally: '单个友军',
  enemy: '单个敌军',
  allAllies: '全体友军',
  allEnemies: '全体敌军'
};

/** 目标类型 → 是否群体（群体魔法不需要选目标） */
function isAoe(target) {
  return target === 'allAllies' || target === 'allEnemies';
}

/**
 * 按魔法数量算网格布局
 *
 * @param {number} count 魔法数量
 * @returns {{cols:number, rows:number, cardsW:number, cardsH:number, panelW:number, panelH:number}}
 */
function computeLayout(count) {
  const n = Math.max(1, count);
  const cols = Math.min(n, MAX_COLS);
  const rows = Math.ceil(n / cols);
  const cardsW = cols * CARD_W + (cols - 1) * GAP_X;
  const cardsH = rows * CARD_H + (rows - 1) * GAP_Y;
  return {
    cols,
    rows,
    cardsW,
    cardsH,
    panelW: Math.max(MIN_PANEL_W, Math.min(1280 - SIDE_MARGIN, cardsW + 64)),
    panelH: HEADER_H + cardsH + FOOTER_H
  };
}

/**
 * 打开施法面板
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {object} opts
 * @param {object} opts.state GameState
 * @param {object} opts.battle 战场状态
 * @param {string} opts.heroId 施法英雄 id
 * @param {Function} [opts.onPick] 选中魔法时的回调 (spellId, def) => void
 * @param {Function} [opts.onCancel] 关闭时的回调
 * @returns {object|null} 面板控制器 { close, refresh, destroy }
 */
export function openSpellPanel(scene, opts) {
  const { state, battle, heroId } = opts;
  const onPick = opts.onPick || (() => {});
  const onCancel = opts.onCancel || (() => {});

  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) {
    onCancel();
    return null;
  }

  const CENTER_X = 640;
  const CENTER_Y = 400;

  // 布局按已习得魔法数量一次算好（面板开着期间魔法列表不会变）
  const spellCount = heroSpells(hero).length;
  const L = computeLayout(spellCount);
  const panelTop = CENTER_Y - L.panelH / 2;
  const panelBottom = CENTER_Y + L.panelH / 2;
  /** 第 i 张卡的左上角坐标 */
  const cardPos = (i) => ({
    x: CENTER_X - L.cardsW / 2 + CARD_W / 2 + (i % L.cols) * (CARD_W + GAP_X),
    y: panelTop + HEADER_H + CARD_H / 2 + Math.floor(i / L.cols) * (CARD_H + GAP_Y)
  });

  /** 是否已经关闭 */
  let closed = false;

  /**
   * 关闭面板并回调
   * @param {boolean} cancelled 是否是玩家主动取消
   */
  function close(cancelled = true) {
    if (closed) return;
    closed = true;
    panelCtl.container.destroy(true);
    if (cancelled) onCancel();
  }

  // ── 面板骨架（M13：走组件库）──
  // 施法面板沿用原有布局：不画标题栏底条，标题贴在面板顶沿
  const panelCtl = createPanel(scene, CENTER_X, CENTER_Y, L.panelW, L.panelH, '', {
    depth: 950,
    header: false,
    titleY: panelTop + 34,
    subtitleY: panelTop + 66,
    hintY: panelBottom - 34,
    onClose: () => close(true)
  });
  const layer = panelCtl.container;
  const { body: cardLayer } = panelCtl;

  /**
   * 画一张魔法卡
   * @param {object} def 魔法定义
   * @param {number} index 卡片序号（0 起）
   * @param {boolean} usable 是否可用（法力够 + 本轮没施过法）
   */
  function drawCard(def, index, usable) {
    const { x, y } = cardPos(index);

    // 卡底（点击热区）：可用时蓝边，不可用时灰边
    const bg = scene.add.rectangle(x, y, CARD_W, CARD_H, usable ? 0x24365c : 0x1c2536, 0.95)
      .setStrokeStyle(2, usable ? 0x3498db : 0x4a5568);
    if (usable) {
      bg.setInteractive({ useHandCursor: true });
    }

    const nameColor = usable ? '#f1c40f' : '#5d6d80';
    const nameText = scene.add.text(x, y - CARD_H / 2 + 28, def.name, {
      fontSize: '18px', color: nameColor
    }).setOrigin(0.5);

    // 法力消耗 + 目标类型
    const costColor = usable ? '#9fb3d8' : '#5d6d80';
    const costText = scene.add.text(
      x, y - CARD_H / 2 + 56,
      `法力 ${def.manaCost}　${TARGET_NAME[def.target] || def.target}`,
      { fontSize: '13px', color: costColor }
    ).setOrigin(0.5);

    const line = scene.add.rectangle(x, y - CARD_H / 2 + 74, CARD_W - 32, 1, 0x3a5a8a, 0.8);

    const desc = scene.add.text(x, y - 4, def.desc || '', {
      fontSize: '13px',
      color: usable ? '#d5e1f2' : '#5d6d80',
      align: 'center',
      wordWrap: { width: CARD_W - 34 }
    }).setOrigin(0.5);

    // 群体魔法加个标记，避免玩家以为还要选目标
    const tagText = scene.add.text(
      x, y + CARD_H / 2 - 22,
      isAoe(def.target) ? '群体（无需选目标）' : '单体（需选目标）',
      { fontSize: '11px', color: usable ? '#5d7ea8' : '#4a5568' }
    ).setOrigin(0.5);

    cardLayer.add([bg, nameText, costText, line, desc, tagText]);

    // 点击 → 施法
    if (usable) {
      bg.on('pointerdown', () => {
        if (closed) return;
        close(false); // 不是取消，是"选中了"
        onPick(def.id, def);
      });
    }
  }

  /**
   * 刷新面板内容
   */
  function refresh() {
    cardLayer.removeAll(true);

    const spells = heroSpells(hero);
    const alreadyCast = hasCastThisTurn(battle, heroId);
    const mana = hero.mana ?? 0;
    const maxMana = hero.maxMana ?? 10;

    panelCtl.setTitle(`${hero.name} 施法`);
    panelCtl.setSubtitle(
      `法力 ${mana} / ${maxMana}　已习得 ${spells.length} 个魔法` +
      (alreadyCast ? '　（本轮已施法）' : '　（本轮可施法 1 次）')
    );

    // 右上角固定一个「[关闭]」按钮：反悔不施法时也要能退出面板
    const closeBtn = createButton(
      scene,
      CENTER_X + L.panelW / 2 - 44,
      panelTop + 34,
      '[关闭]',
      () => close(true),
      { width: 62, height: 28, color: THEME.muted, borderColor: THEME.disabledBorder, fontSize: '15px' }
    );
    cardLayer.add(closeBtn);

    if (spells.length === 0) {
      panelCtl.setHint('没有已习得的魔法');
      return;
    }

    spells.forEach((def, i) => {
      // 可用条件：法力够 + 本轮还没施过法 + 魔法已习得
      const usable = !alreadyCast && canCast(state, heroId, def.id).ok;
      drawCard(def, i, usable);
    });

    if (alreadyCast) {
      panelCtl.setHint('本轮已施法过，下一轮才能再次施法');
    } else if (spells.every((d) => !canCast(state, heroId, d.id).ok)) {
      panelCtl.setHint('法力不足，无法施放任何魔法');
    } else {
      panelCtl.setHint('点击魔法卡施法（灰色表示法力不足或本轮已施法）');
    }
  }

  refresh();

  return {
    close: (cancelled = true) => close(cancelled),
    refresh,
    destroy: () => layer.destroy(true)
  };
}

import { levelUpOptions, chooseSkill, getSkillDef } from '../../logic/skillLogic.js';
import { createPanel, createButton, THEME, DEPTH } from './components.js';

/**
 * skillPanel —— 技能加点面板（M8）
 *
 * 提供一个可复用的"选技能"弹层：
 *   - 遮罩 + 标题 + 3 张技能卡（名称 / 等级变化 / 效果说明）
 *   - 点卡片即调用 skillLogic.chooseSkill
 *   - 若英雄还有剩余待加点次数，就地刷新卡片继续选
 *   - 全部点完（或无候选）时关闭面板，回调 onDone
 *
 * 用法：
 *   openSkillPanel(scene, { state, data, heroId, onDone });
 *
 * 本文件属于渲染层：只调用逻辑层函数，不直接改 state。
 *
 * 图层结构：
 *   layer（depth 900）
 *     ├ shade  遮罩（半透明黑，压住场景内容）
 *     ├ panel  底板
 *     ├ title / subtitle / hint  文本
 *     └ cardLayer  容器（每次刷新只重建这一层，避免误删固定元素）
 */

/** 面板宽高 */
const PANEL_W = 900;
const PANEL_H = 420;
/** 面板中心 */
const CENTER_X = 640;
const CENTER_Y = 400;
/** 单张技能卡尺寸 */
const CARD_W = 260;
const CARD_H = 200;

/**
 * 打开技能加点面板
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {object} opts
 * @param {object} opts.state GameState
 * @param {object} opts.data 数据表集合
 * @param {string} opts.heroId 要加点的英雄 id
 * @param {Function} [opts.onDone] 面板关闭时的回调（参数：是否点完了所有技能点）
 * @returns {object|null} 面板控制器 { close, refresh, destroy }；英雄不存在时返回 null
 */
export function openSkillPanel(scene, opts) {
  const { state, data, heroId } = opts;
  const onDone = opts.onDone || (() => {});

  const hero = state?.heroes?.find((h) => h.id === heroId);
  if (!hero) {
    onDone(false);
    return null;
  }

  /** 是否已经关闭 */
  let closed = false;

  /** 当前这轮展示的候选 */
  let options = [];

  /**
   * 关闭面板并回调
   * @param {boolean} done 是否点完了所有技能点
   */
  function close(done) {
    if (closed) return;
    closed = true;
    panelCtl.container.destroy(true);
    onDone(done);
  }

  // ── 面板骨架（M13：走组件库）──
  // 技能面板沿用原有布局：不画标题栏底条，标题贴在面板顶沿
  const panelCtl = createPanel(scene, CENTER_X, CENTER_Y, PANEL_W, PANEL_H, '', {
    depth: 900,
    header: false,
    titleY: CENTER_Y - PANEL_H / 2 + 34,
    subtitleY: CENTER_Y - PANEL_H / 2 + 66,
    hintY: CENTER_Y + PANEL_H / 2 - 28,
    shade: true
  });
  const layer = panelCtl.container;
  const { body: cardLayer } = panelCtl;

  /**
   * 画一张技能卡
   * @param {object} opt levelUpOptions 的单项
   * @param {number} index 卡片序号（0 起）
   */
  function drawCard(opt, index) {
    const total = options.length;
    const gap = 24;
    const totalW = total * CARD_W + (total - 1) * gap;
    const startX = CENTER_X - totalW / 2 + CARD_W / 2;
    const x = startX + index * (CARD_W + gap);
    const y = CENTER_Y + 12;

    const def = getSkillDef(opt.skillId);
    const isNew = opt.currentLevel === 0;

    // 卡底（点击热区）
    const bg = scene.add.rectangle(x, y, CARD_W, CARD_H, isNew ? 0x1f4a3d : 0x24365c, 0.95)
      .setStrokeStyle(2, isNew ? 0x2ecc71 : 0x3498db);
    bg.setInteractive({ useHandCursor: true });

    const nameText = scene.add.text(x, y - CARD_H / 2 + 30, opt.name, {
      fontSize: '18px', color: isNew ? '#2ecc71' : '#f1c40f'
    }).setOrigin(0.5);

    const lvText = scene.add.text(
      x,
      y - CARD_H / 2 + 60,
      isNew ? '未学习' : `Lv.${opt.currentLevel} → Lv.${opt.nextLevel}`,
      { fontSize: '13px', color: '#9fb3d8' }
    ).setOrigin(0.5);

    const line = scene.add.rectangle(x, y - CARD_H / 2 + 78, CARD_W - 32, 1, 0x3a5a8a, 0.8);

    const desc = scene.add.text(x, y - 6, opt.desc || '', {
      fontSize: '13px', color: '#d5e1f2', align: 'center', wordWrap: { width: CARD_W - 34 }
    }).setOrigin(0.5);

    const typeText = scene.add.text(x, y + CARD_H / 2 - 24, def?.effect?.type || '', {
      fontSize: '11px', color: '#5d7ea8'
    }).setOrigin(0.5);

    cardLayer.add([bg, nameText, lvText, line, desc, typeText]);

    // 点击 → 加点
    bg.on('pointerdown', () => {
      if (closed) return;
      const res = chooseSkill(state, data, heroId, opt.skillId);
      if (!res.ok) return;
      if ((hero.pendingLevels || 0) > 0) {
        refresh(); // 还有剩余次数 → 继续选
      } else {
        close(true); // 点完了 → 关闭
      }
    });
  }

  /**
   * 刷新面板内容（重新生成候选并重画卡片）
   */
  function refresh() {
    cardLayer.removeAll(true);

    const pending = hero.pendingLevels || 0;
    options = pending > 0 ? levelUpOptions(state, data, heroId) : [];

    panelCtl.setTitle(`${hero.name} 升级加点`);
    panelCtl.setSubtitle(pending > 0
      ? `待分配技能点：${pending} 次　（本次可从 ${options.length} 个候选中选 1 个）`
      : '技能点已分配完毕');
    if (options.length === 0) {
      panelCtl.setHint('没有可分配的技能（技能已全满级）');
      const closeBtn = createButton(scene, CENTER_X, CENTER_Y + 60, '[关闭]', () => close(true), {
        width: 110, height: 38, color: THEME.gold, fontSize: '16px'
      });
      cardLayer.add(closeBtn);
      return;
    }

    options.forEach((opt, i) => drawCard(opt, i));
    panelCtl.setHint('点击一张技能卡即可加点');
  }

  refresh();

  return {
    close: (done = false) => close(done),
    refresh,
    destroy: () => layer.destroy(true)
  };
}

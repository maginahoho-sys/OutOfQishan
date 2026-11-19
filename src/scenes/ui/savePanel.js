import {
  saveGame,
  loadGame,
  listSaves,
  deleteSave,
  formatSavedAt,
  SAVE_SLOTS,
  AUTO_SLOT
} from '../../logic/saveLogic.js';
import { createPanel, createButton, THEME, DEPTH } from './components.js';

/**
 * savePanel —— 存档 / 读档面板（M12）
 *
 * 提供一个存档管理弹层，供 MapScene 使用：
 *   - 列出 3 个手动存档位 + 1 个自动存档位
 *   - 每个位显示摘要（第X周第X天）+ 存档时间；空位显示"空"
 *   - [存档] 按钮：把当前局面写进该位
 *   - [读取] 按钮：读档并回调 onLoad(state)，由调用方重建场景
 *   - [删除] 按钮：清掉该位
 *
 * 自动位（auto）不允许手动存档（它由每天开始时自动写入），只允许读取 / 删除。
 *
 * 用法：
 *   openSavePanel(scene, {
 *     state,
 *     onLoad(state),   // 玩家点了「读取」且读档成功
 *     onCancel()       // 玩家点了关闭
 *   });
 *
 * 本文件属于渲染层：只调用逻辑层函数，不直接改 state。
 *
 * 图层结构（与 skillPanel / spellPanel 保持一致的写法）：
 *   layer（depth 960）
 *     ├ shade  遮罩（可点 = 关闭面板）
 *     ├ panel  底板
 *     ├ title / subtitle / hint  文本
 *     └ rowLayer  容器（每次刷新只重建这一层）
 */

/** 面板宽高 */
const PANEL_W = 720;
const PANEL_H = 460;
/** 面板中心 */
const CENTER_X = 640;
const CENTER_Y = 400;
/** 单行高度 */
const ROW_H = 82;
/** 行间距 */
const ROW_GAP = 12;

/**
 * 档位显示名
 * @param {number|string} slot
 * @returns {string}
 */
function slotName(slot) {
  if (slot === AUTO_SLOT) return '自动存档';
  const idx = SAVE_SLOTS.indexOf(slot);
  return idx >= 0 ? `存档位 ${idx + 1}` : `存档位 ${slot}`;
}

/**
 * 打开存档面板
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {object} opts
 * @param {object} opts.state GameState（存档内容来源）
 * @param {Function} [opts.onLoad] 读档成功的回调 (state) => void
 * @param {Function} [opts.onCancel] 关闭时的回调
 * @returns {object|null} 面板控制器 { close, refresh, destroy }
 */
export function openSavePanel(scene, opts) {
  const { state } = opts;
  const onLoad = opts.onLoad || (() => {});
  const onCancel = opts.onCancel || (() => {});

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
  // 存档面板沿用原有布局：不画标题栏底条，标题贴在面板顶沿
  const panelCtl = createPanel(scene, CENTER_X, CENTER_Y, PANEL_W, PANEL_H, '存档 / 读档', {
    depth: 960,
    header: false,
    titleY: CENTER_Y - PANEL_H / 2 + 34,
    subtitleY: CENTER_Y - PANEL_H / 2 + 66,
    hintY: CENTER_Y + PANEL_H / 2 - 28,
    onClose: () => close(true)
  });
  const layer = panelCtl.container;
  const { body: rowLayer } = panelCtl;

  panelCtl.setTitle('存档 / 读档');
  panelCtl.setSubtitle('每天开始时会自动写入「自动存档」位');
  panelCtl.setHint('读取存档会覆盖当前进度，确认后再操作');

  // 右上角固定一个「[关闭]」按钮
  const closeBtn = createButton(
    scene,
    CENTER_X + PANEL_W / 2 - 44,
    CENTER_Y - PANEL_H / 2 + 34,
    '[关闭]',
    () => close(true),
    { width: 64, height: 28, color: THEME.muted, borderColor: THEME.disabledBorder, fontSize: '15px' }
  );
  layer.add(closeBtn);

  /** 行区域顶部 */
  const rowTop = CENTER_Y - PANEL_H / 2 + 100;

  /**
   * 画一行存档位
   * @param {object|null} info listSaves 的对应项；null 表示空位
   * @param {number} index 行序号
   */
  function drawRow(info, index) {
    // listSaves 的顺序固定为 [0, 1, 2, 'auto']，行序即槽位序
    const slot = info ? info.slot : SAVE_SLOTS[index];
    const y = rowTop + index * (ROW_H + ROW_GAP) + ROW_H / 2;
    const occupied = !!info && !info.corrupted;
    const corrupted = !!info && info.corrupted;

    // 行底板
    const bg = scene.add.rectangle(CENTER_X, y, PANEL_W - 60, ROW_H, occupied ? 0x24365c : 0x1c2536, 0.95)
      .setStrokeStyle(2, corrupted ? 0xe74c3c : occupied ? 0x3498db : 0x4a5568);

    // 左侧：位名 + 摘要
    const nameText = scene.add.text(
      CENTER_X - PANEL_W / 2 + 48, y - 16, slotName(slot),
      { fontSize: '17px', color: occupied ? '#f1c40f' : '#95a5a6' }
    ).setOrigin(0, 0.5);

    let desc;
    if (corrupted) desc = '存档损坏，无法读取';
    else if (occupied) desc = `${info.label}　${formatSavedAt(info.savedAt)}`;
    else desc = '空';
    const descText = scene.add.text(
      CENTER_X - PANEL_W / 2 + 48, y + 12, desc,
      { fontSize: '13px', color: corrupted ? '#e74c3c' : occupied ? '#d5e1f2' : '#5d6d80' }
    ).setOrigin(0, 0.5);

    // 右侧：三个操作按钮（M13：走组件库）
    const btnY = y;
    const btnX = CENTER_X + PANEL_W / 2 - 80;

    const isAuto = slot === AUTO_SLOT;
    const canWrite = !isAuto;                     // 自动位不手动写
    const canRead = occupied;                    // 只有有效存档能读
    const canDelete = !!info;                    // 有内容（含损坏）才能删

    const btnSave = createButton(scene, btnX - 160, btnY, '[存档]', () => {
      const r = saveGame(state, slot);
      if (r.ok) {
        panelCtl.setHint(`已保存到 ${slotName(slot)}（${r.label}）`);
        refresh();
      } else {
        panelCtl.setHint(saveErrorText(r.reason));
      }
    }, { width: 62, height: 30, color: THEME.green, borderColor: 0x2ecc71, fontSize: '14px' });
    if (!canWrite) btnSave.setEnabled(false);

    const btnLoad = createButton(scene, btnX - 80, btnY, '[读取]', () => {
      const r = loadGame(slot);
      if (r.ok) {
        close(false);
        onLoad(r.state);
      } else {
        panelCtl.setHint(saveErrorText(r.reason));
      }
    }, { width: 62, height: 30, color: THEME.blue, borderColor: 0x3498db, fontSize: '14px' });
    if (!canRead) btnLoad.setEnabled(false);

    const btnDel = createButton(scene, btnX, btnY, '[删除]', () => {
      const r = deleteSave(slot);
      panelCtl.setHint(r.ok ? `已删除 ${slotName(slot)}` : saveErrorText(r.reason));
      refresh();
    }, { width: 62, height: 30, color: THEME.red, borderColor: 0xe74c3c, fontSize: '14px' });
    if (!canDelete) btnDel.setEnabled(false);

    rowLayer.add([bg, nameText, descText, btnSave, btnLoad, btnDel]);
  }

  /**
   * 把逻辑层的 reason 翻成中文提示
   * @param {string} reason
   * @returns {string}
   */
  function saveErrorText(reason) {
    return {
      invalidSlot: '存档位非法',
      invalidState: '当前局面无法保存',
      serializeFailed: '局面包含无法序列化的数据，保存失败',
      quotaExceeded: '浏览器存储空间已满，保存失败',
      storageError: '读写存档时出错',
      empty: '该存档位是空的',
      corrupted: '存档已损坏，无法读取',
      versionMismatch: '存档版本与当前游戏不一致，无法读取'
    }[reason] || '操作失败';
  }

  /**
   * 刷新面板内容
   */
  function refresh() {
    rowLayer.removeAll(true);

    const list = listSaves();
    // listSaves 的顺序固定为 [0, 1, 2, 'auto']
    list.forEach((info, i) => drawRow(info, i));

    panelCtl.setSubtitle('每天开始时会自动写入「自动存档」位');
    panelCtl.setHint('读取存档会覆盖当前进度，确认后再操作');
  }

  refresh();

  return {
    close: (cancelled = true) => close(cancelled),
    refresh,
    destroy: () => layer.destroy(true)
  };
}

import {
  createButton,
  createPanel,
  createUnitCard,
  toast,
  confirmDialog,
  createCounter,
  THEME,
  DEPTH
} from './ui/components.js';
import { bus } from '../core/EventBus.js';

/**
 * DemoScene —— UI 组件库演示场景（M13）
 *
 * 把 components.js 的 6 个组件全部摆在一屏里，方便肉眼检查与自动化验证：
 *   1. createButton   按钮（可点 / 禁用置灰）
 *   2. createPanel    面板（标题栏 + 内容区）
 *   3. createUnitCard 兵牌（色块 + 首字 + 数量）
 *   4. toast          提示浮层（也能被 bus 'ui:toast' 触发）
 *   5. confirmDialog  确认弹窗
 *   6. createCounter  数量选择器
 *
 * 进入方式：URL 加 ?demo=1
 *
 * 本场景是**纯展示**：不读 state、不调逻辑层。
 */
export default class DemoScene extends Phaser.Scene {
  constructor() {
    super('DemoScene');
  }

  create() {
    const cx = 640;

    // 调试计数：自动化脚本读取
    this.btnClickCount = 0;
    this.disabledClickCount = 0;
    this.unitCount = 12;
    this.confirmResult = null;

    // ── 标题 ──
    this.add.text(cx, 28, 'UI 组件库演示（M13）', {
      fontSize: '24px', color: THEME.gold
    }).setOrigin(0.5);

    this.add.text(cx, 58, '左半屏：按钮 / 数量选择器 / 兵牌　　右半屏：面板 / toast / 确认弹窗', {
      fontSize: '14px', color: THEME.muted
    }).setOrigin(0.5);

    // ── 1. 按钮 ──
    this.add.text(120, 100, '① 按钮', { fontSize: '16px', color: THEME.light }).setOrigin(0.5);
    this.btnNormal = createButton(this, 120, 145, '[正常按钮]', () => {
      this.btnClickCount += 1;
      this.btnCountText.setText(`正常按钮点击次数：${this.btnClickCount}`);
    }, { width: 150, height: 40 });
    this.btnDisabled = createButton(this, 120, 200, '[禁用按钮]', () => {
      this.disabledClickCount += 1;
    }, { width: 150, height: 40, disabled: true });
    this.btnCountText = this.add.text(120, 234, '正常按钮点击次数：0', {
      fontSize: '13px', color: THEME.faint
    }).setOrigin(0.5);
    this.btnDisabledCountText = this.add.text(120, 254, '禁用按钮点击次数：0', {
      fontSize: '13px', color: THEME.faint
    }).setOrigin(0.5);

    // 切换禁用态的按钮（用来验证 setEnabled）
    this.btnToggle = createButton(this, 120, 295, '[切换禁用态]', () => {
      const next = !this.btnDisabled.getEnabled();
      this.btnDisabled.setEnabled(next);
      this.btnToggleStateText.setText(`禁用按钮当前：${next ? '禁用' : '可用'}`);
    }, { width: 150, height: 38, color: THEME.blue });
    this.btnToggleStateText = this.add.text(120, 327, '禁用按钮当前：禁用', {
      fontSize: '13px', color: THEME.faint
    }).setOrigin(0.5);

    // ── 6. 数量选择器 ──
    this.add.text(120, 380, '⑥ 数量选择器', { fontSize: '16px', color: THEME.light }).setOrigin(0.5);
    this.counter = createCounter(this, 120, 425, 0, 10, 3, (v) => {
      this.counterValueText.setText(`当前数量：${v}`);
    }, { width: 170 });
    this.counterValueText = this.add.text(120, 460, '当前数量：3', {
      fontSize: '13px', color: THEME.faint
    }).setOrigin(0.5);

    // ── 3. 兵牌 ──
    this.add.text(120, 510, '③ 兵牌', { fontSize: '16px', color: THEME.light }).setOrigin(0.5);
    this.unitCard = createUnitCard(this, 100, 565, { name: '乡勇', faction: 'shu' }, this.unitCount, { size: 64 });
    this.unitCard2 = createUnitCard(this, 190, 565, { name: '青州兵', faction: 'wei' }, 7, { size: 64 });
    createButton(this, 145, 640, '[兵牌数量 +3]', () => {
      this.unitCount += 3;
      this.unitCard.setCount(this.unitCount);
      this.unitCard2.setCount(Math.max(0, this.unitCount - 5));
    }, { width: 160, height: 36, color: THEME.blue });

    // ── 2. 面板 ──
    const p = createPanel(this, 900, 330, 520, 300, '② 面板', {
      depth: DEPTH.panel,
      shade: false
    });
    this.panel = p;
    p.container.setTitle('② createPanel 面板');
    p.container.setSubtitle('标题栏 + 副标题 + 底部提示 + 内容区');
    p.container.setHint('内容区（body）由调用方自行填充');
    // 内容区里塞一个按钮，验证 body 可用（body 容器位于 0,0，坐标与场景一致）
    const innerBtn = createButton(this, 900, 430, '[面板内按钮]', () => {
      toast(this, '面板内按钮被点击');
    }, { width: 160, height: 38, color: THEME.green });
    p.body.add(innerBtn);

    // ── 4. toast ──
    this.add.text(900, 520, '④ 提示浮层', { fontSize: '16px', color: THEME.light }).setOrigin(0.5);
    createButton(this, 830, 565, '[直接 toast]', () => {
      toast(this, '这是一条直接调用的提示');
    }, { width: 150, height: 38, color: THEME.green });
    createButton(this, 990, 565, '[bus 触发]', () => {
      // 任何模块都可以这样触发提示
      bus.emit('ui:toast', { text: '这是通过 bus ui:toast 触发的提示' });
    }, { width: 150, height: 38, color: THEME.blue });

    // ── 5. 确认弹窗 ──
    this.add.text(900, 625, '⑤ 确认弹窗', { fontSize: '16px', color: THEME.light }).setOrigin(0.5);
    createButton(this, 900, 670, '[打开确认弹窗]', () => {
      this.openConfirm();
    }, { width: 180, height: 38, color: THEME.gold });
    this.confirmResultText = this.add.text(900, 712, '确认弹窗结果：（未选择）', {
      fontSize: '13px', color: THEME.faint
    }).setOrigin(0.5);

    // ── 返回地图 ──
    createButton(this, 120, 730, '[返回地图]', () => {
      this.scene.start('MapScene');
    }, { width: 160, height: 38, color: THEME.muted, borderColor: THEME.disabledBorder });

    // 调试钩子：自动化脚本读取
    this.demoReady = true;
  }

  /**
   * 打开确认弹窗（演示回调）
   */
  openConfirm() {
    this.confirmResult = null;
    this.updateConfirmText();
    this.confirmDialog = confirmDialog(
      this,
      '确定要执行这个操作吗？',
      () => { this.confirmResult = 'confirm'; this.updateConfirmText(); },
      () => { this.confirmResult = 'cancel'; this.updateConfirmText(); }
    );
  }

  /**
   * 刷新确认结果文本
   */
  updateConfirmText() {
    const t = this.confirmResultText;
    if (!t) return;
    t.setText(`确认弹窗结果：${this.confirmResult || '（未选择）'}`);
  }
}

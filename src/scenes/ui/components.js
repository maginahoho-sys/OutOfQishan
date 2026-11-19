import { bus } from '../../core/EventBus.js';
import { pixelSprite, unitKey, baseKey } from '../../core/pixelArt.js';

/**
 * components.js —— 通用 UI 组件库（M13）
 *
 * 一套占位风格的纯展示组件，供 TownScene / BattleScene / MapScene / 各种弹窗复用。
 * 风格：深色底(0x16213e)、白字、金色(0xf1c40f)强调、蜀汉红/曹魏蓝阵营色。
 *
 * 设计约定：
 *   - 全部是**工厂函数**（返回 Container / GameObject），不导出类。
 *     理由：Phaser 的显示对象必须挂到具体 scene 上，用类反而要处理 scene 绑定。
 *   - **不读 state、不调逻辑层**，纯展示。数据由调用方算好传进来。
 *   - 中文注释。
 *
 * ── 图层深度约定 ───────────────────────────────────────
 *   地图/战场上的实体元素：0 ~ 100
 *   HUD（状态栏、按钮栏）：200
 *   弹层（技能/施法/存档）：900 ~ 960
 *   浮层提示（toast）：1000
 *   模态对话框（confirm）：1100
 */

/**
 * 统一的配色表（所有组件共用，改这里就能全局换肤）
 */
export const THEME = {
  /** 面板底色 */
  panelBg: 0x16213e,
  /** 面板描边（金色） */
  panelBorder: 0xf1c40f,
  /** 次级面板底色（卡片、列表行） */
  cardBg: 0x24365c,
  /** 失效态底色 */
  disabledBg: 0x1c2536,
  /** 失效态描边 */
  disabledBorder: 0x4a5568,
  /** 遮罩底色与透明度 */
  shade: 0x000000,
  shadeAlpha: 0.6,

  /** 主强调色（标题、选中） */
  gold: '#f1c40f',
  /** 正文白 */
  white: '#ffffff',
  /** 次级正文 */
  light: '#d5e1f2',
  /** 弱化正文 */
  muted: '#95a5a6',
  /** 更弱的灰 */
  faint: '#5d6d80',
  /** 成功绿 */
  green: '#2ecc71',
  /** 强调蓝（可点按钮） */
  blue: '#3498db',
  /** 危险红 */
  red: '#e74c3c',
  /** 分割线 */
  divider: 0x3a5a8a,

  /** 阵营色（蜀汉红 / 曹魏蓝） */
  factionColor: {
    shu: 0xc0392b,
    wei: 0x2980b9
  },
  /** 阵营色（文本形式） */
  factionText: {
    shu: '#e74c3c',
    wei: '#3498db'
  }
};

/**
 * 资源中文名（全局共用一份，避免各场景各写一遍）
 */
export const RES_NAMES = {
  gold: '金',
  wood: '木',
  ore: '矿',
  mercury: '汞',
  sulfur: '硫',
  crystal: '晶',
  gem: '宝'
};

/**
 * 各类浮层的默认深度
 */
export const DEPTH = {
  /** 弹层（技能/施法/存档面板） */
  panel: 900,
  /** 浮层提示 */
  toast: 1000,
  /** 模态对话框 */
  modal: 1100
};

/**
 * 创建一个按钮：矩形底 + 文字，支持禁用态
 *
 * 返回的 Container 上挂了：
 *   - setEnabled(bool)  切换可用 / 禁用（禁用时置灰且不响应点击）
 *   - setText(string)   改按钮文字
 *   - getEnabled()      查当前是否可用
 *
 * 注意：内部的文字对象**也**单独注册了 pointerdown，
 *      这样自动化脚本直接对文字 emit('pointerdown') 也能触发（见 scripts/verify-*.mjs）。
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {number} x 中心 x 坐标
 * @param {number} y 中心 y 坐标
 * @param {string} text 按钮文字
 * @param {Function} [onClick] 点击回调
 * @param {object} [opts]
 * @param {number} [opts.width=120] 按钮宽
 * @param {number} [opts.height=36] 按钮高
 * @param {boolean} [opts.disabled=false] 初始是否禁用
 * @param {string} [opts.color] 文字颜色（默认金色）
 * @param {number} [opts.bgColor] 底色（默认次级面板色）
 * @param {number} [opts.borderColor] 描边色（默认蓝）
 * @param {string} [opts.fontSize='15px']
 * @returns {Phaser.GameObjects.Container} 按钮容器
 */
export function createButton(scene, x, y, text, onClick, opts = {}) {
  const width = opts.width ?? 120;
  const height = opts.height ?? 36;
  const color = opts.color || THEME.gold;
  const bgColor = opts.bgColor ?? THEME.cardBg;
  const borderColor = opts.borderColor ?? 0x3498db;
  const fontSize = opts.fontSize || '15px';

  const container = scene.add.container(x, y);

  // 底板（点击热区）
  const bg = scene.add.rectangle(0, 0, width, height, bgColor, 0.95)
    .setStrokeStyle(2, borderColor);
  // 文字（单独一层，方便改色）
  const label = scene.add.text(0, 0, text, {
    fontSize,
    color
  }).setOrigin(0.5);

  container.add([bg, label]);

  /** 当前是否可用 */
  let enabled = !opts.disabled;
  /** 业务回调（禁用时不会被调用） */
  const handler = typeof onClick === 'function' ? onClick : () => {};

  /**
   * 实际点击处理：禁用时直接忽略
   */
  function fire() {
    if (!enabled) return;
    handler();
  }

  bg.setInteractive({ useHandCursor: true });
  bg.on('pointerdown', fire);
  // 文字也注册一份：自动化脚本习惯直接对 Text 触发 pointerdown
  label.setInteractive({ useHandCursor: true });
  label.on('pointerdown', fire);
  // 容器上也转发一份：Phaser 的事件**不冒泡**，
  // 对 Container emit('pointerdown') 不会触发子对象上的监听器。
  // 业务上「点按钮」指的是点这个按钮整体，所以容器也要能触发。
  container.on('pointerdown', fire);

  /**
   * 判断某个显示对象当前是否可交互
   *
   * ⚠️ Phaser 的 disableInteractive 是**延迟移除**（下一个 game step 才真正生效），
   *    而且 gameObject.input 对象在禁用后依然存在，
   *    所以不能用 `!!obj.input` 判断，要看 `obj.input.enabled`。
   *
   * @param {Phaser.GameObjects.GameObject} obj
   * @returns {boolean}
   */
  function isInteractive(obj) {
    return !!(obj.input && obj.input.enabled);
  }

  /**
   * 切换可用 / 禁用
   * @param {boolean} value
   */
  function setEnabled(value) {
    enabled = !!value;
    if (enabled) {
      bg.setFillStyle(bgColor, 0.95);
      bg.setStrokeStyle(2, borderColor);
      label.setColor(color);
      container.setAlpha(1);
      // 恢复可交互
      if (!isInteractive(bg)) bg.setInteractive({ useHandCursor: true });
      if (!isInteractive(label)) label.setInteractive({ useHandCursor: true });
    } else {
      bg.setFillStyle(THEME.disabledBg, 0.95);
      bg.setStrokeStyle(2, THEME.disabledBorder);
      label.setColor(THEME.faint);
      container.setAlpha(0.75);
      // 真正不可点：摘掉交互
      if (isInteractive(bg)) bg.disableInteractive();
      if (isInteractive(label)) label.disableInteractive();
    }
  }

  /**
   * 改按钮文字
   * @param {string} value
   */
  function setText(value) {
    label.setText(value);
  }

  // 挂到容器上（Phaser 允许给任意 GameObject 挂自定义方法）
  container.setEnabled = setEnabled;
  container.setText = setText;
  container.getEnabled = () => enabled;

  setEnabled(enabled);

  return container;
}

/**
 * 创建一个带标题栏的面板：圆角矩形容器
 *
 * 返回 { container, body }：
 *   - container  外层容器（含遮罩 + 底板 + 标题栏 + body）
 *   - body       内容区容器，调用方往里塞东西
 *
 * 另外附带 title / subtitle / hint 三个文本对象与 setTitle / setSubtitle / setHint 方法，
 * 三个弹层（技能/施法/存档）的标题区就统一走这里。
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {number} x 面板中心 x
 * @param {number} y 面板中心 y
 * @param {number} width 面板宽
 * @param {number} height 面板高
 * @param {string} title 标题文字（空字符串则不画标题栏）
 * @param {object} [opts]
 * @param {number} [opts.depth=900] 面板所在深度
 * @param {boolean} [opts.shade=true] 是否画遮罩
 * @param {boolean} [opts.header=true] 是否画标题栏底条
 * @param {number} [opts.titleY] 标题 y（默认在标题栏中央）
 * @param {number} [opts.subtitleY] 副标题 y
 * @param {number} [opts.hintY] 底部提示 y
 * @param {Function} [opts.onClose] 点遮罩时的回调
 * @param {number} [opts.radius=14] 圆角半径
 * @returns {{container: Phaser.GameObjects.Container, body: Phaser.GameObjects.Container}}
 */
export function createPanel(scene, x, y, width, height, title, opts = {}) {
  const depth = opts.depth ?? DEPTH.panel;
  const radius = opts.radius ?? 14;

  const container = scene.add.container(0, 0).setDepth(depth);

  // 遮罩：吞掉点击，防止误触场景下层
  let shade = null;
  if (opts.shade !== false) {
    shade = scene.add.rectangle(x, y, 1280, 800, THEME.shade, THEME.shadeAlpha);
    shade.setInteractive();
    if (typeof opts.onClose === 'function') {
      shade.on('pointerdown', () => opts.onClose());
    }
  }

  // 底板：圆角矩形（Phaser 3.90 的 Rectangle 用 setRounded 设圆角）
  const panel = scene.add.rectangle(x, y, width, height, THEME.panelBg, 0.98)
    .setStrokeStyle(2, THEME.panelBorder)
    .setRounded(radius);

  // 标题栏
  const HEADER_H = 46;
  const headerY = y - height / 2 + HEADER_H / 2;
  let header = null;
  if (opts.header !== false) {
    header = scene.add.rectangle(x, headerY, width - 4, HEADER_H, THEME.cardBg, 0.9)
      .setRounded(Math.min(radius, 10));
  }
  const titleText = scene.add.text(x, opts.titleY ?? headerY, title || '', {
    fontSize: '22px', color: THEME.gold
  }).setOrigin(0.5);

  // 副标题（标题下方一行小字）
  const subtitleText = scene.add.text(
    x, opts.subtitleY ?? (y - height / 2 + HEADER_H + 24), '',
    { fontSize: '14px', color: THEME.light }
  ).setOrigin(0.5);

  // 底部提示行
  const hintText = scene.add.text(x, opts.hintY ?? (y + height / 2 - 28), '', {
    fontSize: '13px', color: THEME.muted
  }).setOrigin(0.5);

  // 内容区（调用方往里塞）
  const body = scene.add.container(0, 0);

  container.add([shade, panel, header, titleText, subtitleText, hintText, body].filter(Boolean));
  /**
   * 设置标题
   * @param {string} value
   */
  function setTitle(value) {
    titleText.setText(value);
  }

  /**
   * 设置副标题
   * @param {string} value
   */
  function setSubtitle(value) {
    subtitleText.setText(value);
  }

  /**
   * 设置底部提示
   * @param {string} value
   */
  function setHint(value) {
    hintText.setText(value);
  }

  container.setTitle = setTitle;
  container.setSubtitle = setSubtitle;
  container.setHint = setHint;
  container.titleText = titleText;
  container.subtitleText = subtitleText;
  container.hintText = hintText;
  container.shade = shade;
  container.body = body;

  // 方法同时挂在返回对象上，调用方两种写法都能用
  return {
    container,
    body,
    titleText,
    subtitleText,
    hintText,
    shade,
    setTitle,
    setSubtitle,
    setHint
  };
}

/**
 * 解析兵种 id
 *
 * 优先用 unitDef.id；没有 id 时（例如 DemoScene 只传了 {name:'乡勇'}），
 * 到 registry 里的数据表按名字反查。查不到就返回 null（走占位回退）。
 *
 * @param {Phaser.Scene} scene
 * @param {object} unitDef
 * @returns {string|null}
 */
function resolveUnitId(scene, unitDef) {
  if (!unitDef) return null;
  if (unitDef.id) return unitDef.id;
  const data = scene.registry.get('data');
  const units = (data && data.units) || [];
  const hit = units.find((u) => u.name === unitDef.name);
  return hit ? hit.id : null;
}

/**
 * 创建兵牌：兵种立绘（像素图）+ 兵种首字 + 数量
 *
 * 返回的 Container 上挂了 setCount(n) 用于改数量。
 *
 * M14：有像素资源时用「阵营底台 + 兵种立绘」代替色块圆盘；
 *      资源缺失时退回原来的色块 + 首字。
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {number} x 中心 x
 * @param {number} y 中心 y
 * @param {object} unitDef 兵种定义（units.json 的一项，需含 name / faction）
 * @param {number} count 数量
 * @param {object} [opts]
 * @param {number} [opts.size=56] 兵牌直径
 * @returns {Phaser.GameObjects.Container} 兵牌容器
 */
export function createUnitCard(scene, x, y, unitDef, count, opts = {}) {
  const size = opts.size ?? 56;
  const faction = unitDef?.faction || 'shu';
  const color = THEME.factionColor[faction] ?? 0x7f8c8d;

  const container = scene.add.container(x, y);

  // 兵种 id：优先用 unitDef.id，没有就按名字到数据表里查
  const unitId = resolveUnitId(scene, unitDef);

  const parts = [];
  let icon = null;
  if (unitId) {
    // 底座要比立绘大、且立绘上移 —— 否则底座被完全盖住，看不出阵营
    const baseSize = Math.round(size * 0.95);
    const iconSize = Math.round(size * 0.62);
    const base = pixelSprite(scene, baseKey(faction), 0, Math.round(size * 0.1), baseSize);
    icon = pixelSprite(scene, unitKey(unitId), 0, -Math.round(size * 0.13), iconSize);
    if (icon) {
      if (base) parts.push(base);
      parts.push(icon);
    }
  }

  if (!icon) {
    // 回退：色块底
    parts.push(scene.add.circle(0, 0, size / 2, color));
  }

  // 兵种首字（有立绘时放左下角，没有立绘时放正中偏上，与旧版一致）
  const hasIcon = parts.some((p) => p.type === 'Image');
  const nameText = scene.add.text(
    hasIcon ? -size * 0.36 : 0,
    hasIcon ? size * 0.34 : -size * 0.13,
    (unitDef?.name || '?').slice(0, 1),
    {
      fontSize: `${Math.round(size * (hasIcon ? 0.2 : 0.32))}px`,
      color: THEME.white,
      stroke: '#101418',
      strokeThickness: hasIcon ? 2 : 0
    }
  ).setOrigin(0.5);

  // 数量
  const countText = scene.add.text(hasIcon ? size * 0.22 : 0, hasIcon ? size * 0.34 : size * 0.24, `×${count}`, {
    fontSize: `${Math.round(size * 0.22)}px`, color: '#ffe',
    stroke: '#101418',
    strokeThickness: hasIcon ? 2 : 0
  }).setOrigin(0.5);

  container.add([...parts, nameText, countText]);

  /** 阵营色（供自动化脚本断言"兵牌配色按阵营"） */
  container.factionColor = color;
  /** 兵种立绘纹理键（无立绘时为 null） */
  container.iconKey = icon ? icon.texture.key : null;

  /**
   * 改数量
   * @param {number} n
   */
  function setCount(n) {
    countText.setText(`×${n}`);
  }

  container.setCount = setCount;
  container.getCount = () => count;

  return container;
}

/**
 * 提示浮层：屏幕上方飘过一行字，2 秒淡出
 *
 * 同时订阅 bus 的 'ui:toast' 事件 —— 任何模块 emit('ui:toast', { text }) 都能弹。
 * 订阅是**每个场景一次**（用 WeakMap 记录），场景关闭时自动解绑，避免监听泄漏。
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {string} text 提示文字
 * @param {object} [opts]
 * @param {number} [opts.x=640] 起始 x
 * @param {number} [opts.y=60] 起始 y
 * @param {number} [opts.toY=20] 飘到的 y
 * @param {number} [opts.duration=2000] 动画时长（毫秒）
 * @param {string} [opts.color='#ffffff'] 文字颜色
 * @param {string} [opts.background='#00000099'] 文字背景色
 * @param {number} [opts.depth=1000] 深度
 * @returns {Phaser.GameObjects.Text} 提示文本对象
 */
export function toast(scene, text, opts = {}) {
  ensureToastListener(scene);

  const x = opts.x ?? 640;
  const y = opts.y ?? 60;
  const toY = opts.toY ?? 20;
  const duration = opts.duration ?? 2000;

  const t = scene.add.text(x, y, text, {
    fontSize: opts.fontSize || '15px',
    color: opts.color || THEME.white,
    backgroundColor: opts.background || '#00000099',
    padding: { x: 10, y: 4 }
  }).setOrigin(0.5).setDepth(opts.depth ?? DEPTH.toast);

  scene.tweens.add({
    targets: t,
    y: toY,
    alpha: 0,
    duration,
    onComplete: () => t.destroy()
  });

  return t;
}

/**
 * 每个场景订阅 bus 'ui:toast' 的记录表
 * WeakMap 保证场景被销毁后条目可回收
 * @type {WeakMap<object, Function>}
 */
const toastListeners = new WeakMap();

/**
 * 确保某场景已订阅 bus 的 'ui:toast' 事件（幂等）
 *
 * 场景若设置了 `scene.toastOptions`（如 BattleScene 要避开底部操作栏），
 * bus 触发的提示会沿用这份设置。
 *
 * @param {Phaser.Scene} scene
 */
function ensureToastListener(scene) {
  if (!scene || toastListeners.has(scene)) return;
  const off = bus.on('ui:toast', (payload) => {
    const msg = typeof payload === 'string' ? payload : payload?.text;
    if (msg) toast(scene, msg, scene.toastOptions || {});
  });
  toastListeners.set(scene, off);
  // 场景 shutdown 时解绑
  scene.events.once('shutdown', () => {
    off();
    toastListeners.delete(scene);
  });
}

/**
 * 确认弹窗：遮罩 + 文字 + 确定 / 取消按钮
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {string} text 提示文字
 * @param {Function} [onConfirm] 点「确定」的回调
 * @param {Function} [onCancel] 点「取消」的回调
 * @param {object} [opts]
 * @param {string} [opts.confirmText='确定']
 * @param {string} [opts.cancelText='取消']
 * @param {number} [opts.width=520] 弹窗宽
 * @param {number} [opts.height=220] 弹窗高
 * @returns {Phaser.GameObjects.Container} 弹窗容器（带 destroy 方法）
 */
export function confirmDialog(scene, text, onConfirm, onCancel, opts = {}) {
  const width = opts.width ?? 520;
  const height = opts.height ?? 220;
  const confirmText = opts.confirmText || '确定';
  const cancelText = opts.cancelText || '取消';

  const CENTER_X = 640;
  const CENTER_Y = 400;

  const layer = scene.add.container(0, 0).setDepth(DEPTH.modal);

  const shade = scene.add.rectangle(CENTER_X, CENTER_Y, 1280, 800, THEME.shade, THEME.shadeAlpha);
  shade.setInteractive();

  const panel = scene.add.rectangle(CENTER_X, CENTER_Y, width, height, THEME.panelBg, 0.99)
    .setStrokeStyle(2, THEME.panelBorder)
    .setRounded(14);

  const msg = scene.add.text(CENTER_X, CENTER_Y - 34, text || '', {
    fontSize: '17px', color: THEME.light,
    align: 'center', wordWrap: { width: width - 60 }
  }).setOrigin(0.5);

  // 两个按钮
  const btnY = CENTER_Y + height / 2 - 48;
  const btnOk = createButton(scene, CENTER_X - 70, btnY, `[${confirmText}]`, () => {
    close();
    if (typeof onConfirm === 'function') onConfirm();
  }, { width: 120, height: 38, color: THEME.green, borderColor: 0x2ecc71 });
  const btnCancel = createButton(scene, CENTER_X + 70, btnY, `[${cancelText}]`, () => {
    close();
    if (typeof onCancel === 'function') onCancel();
  }, { width: 120, height: 38, color: THEME.muted, borderColor: THEME.disabledBorder });

  layer.add([shade, panel, msg, btnOk, btnCancel]);

  /** 是否已关闭 */
  let closed = false;

  /**
   * 关闭弹窗
   */
  function close() {
    if (closed) return;
    closed = true;
    layer.destroy(true);
  }

  // 点遮罩 = 取消
  shade.on('pointerdown', () => {
    close();
    if (typeof onCancel === 'function') onCancel();
  });

  layer.close = close;
  // ⚠️ 不要把 layer.destroy 覆盖成自引用箭头函数（layer.destroy(true) 会自我递归到栈溢出）。
  //    Phaser 自带的 destroy 就够用，这里只额外保证 close 的幂等。
  const originalDestroy = layer.destroy.bind(layer);
  layer.destroy = (fromScene) => {
    closed = true;
    return originalDestroy(fromScene);
  };

  return layer;
}

/**
 * 数量选择器：[-] 数值 [+]
 *
 * 返回的 Container 上挂了：
 *   - getValue()   当前值
 *   - setValue(n)  直接设值（会触发 onChange）
 *   - setEnabled(bool) 禁用整个控件
 *
 * @param {Phaser.Scene} scene 宿主场景
 * @param {number} x 中心 x
 * @param {number} y 中心 y
 * @param {number} min 最小值
 * @param {number} max 最大值
 * @param {number} initial 初始值
 * @param {Function} [onChange] 值变化时的回调 (value) => void
 * @param {object} [opts]
 * @param {number} [opts.step=1] 步长
 * @param {number} [opts.width=150] 控件总宽
 * @returns {Phaser.GameObjects.Container} 计数器容器
 */
export function createCounter(scene, x, y, min, max, initial, onChange, opts = {}) {
  const step = opts.step ?? 1;
  const width = opts.width ?? 150;
  const change = typeof onChange === 'function' ? onChange : () => {};

  const container = scene.add.container(x, y);

  // 底板
  const bg = scene.add.rectangle(0, 0, width, 38, THEME.cardBg, 0.9)
    .setStrokeStyle(2, 0x3498db);

  /** 当前值（钳在 [min, max] 内） */
  let value = Math.min(max, Math.max(min, initial));

  const btnW = 38;
  const btnH = 30;

  // [-] 按钮
  const btnMinus = createButton(scene, -width / 2 + btnW / 2 + 4, 0, '[-]', () => {
    stepBy(-step);
  }, { width: btnW, height: btnH, color: THEME.gold, borderColor: 0x3498db, fontSize: '16px' });

  // [+] 按钮
  const btnPlus = createButton(scene, width / 2 - btnW / 2 - 4, 0, '[+]', () => {
    stepBy(step);
  }, { width: btnW, height: btnH, color: THEME.gold, borderColor: 0x3498db, fontSize: '16px' });

  // 中间数值
  const valueText = scene.add.text(0, 0, String(value), {
    fontSize: '17px', color: THEME.white
  }).setOrigin(0.5);

  container.add([bg, btnMinus, valueText, btnPlus]);

  /**
   * 调整数值并通知
   * @param {number} delta
   */
  function stepBy(delta) {
    const next = Math.min(max, Math.max(min, value + delta));
    if (next === value) return;
    value = next;
    valueText.setText(String(value));
    refreshButtons();
    change(value);
  }

  /**
   * 根据当前值刷新 +/- 的可用态（到边界就禁用）
   */
  function refreshButtons() {
    btnMinus.setEnabled(value > min);
    btnPlus.setEnabled(value < max);
  }

  /**
   * 直接设值
   * @param {number} n
   */
  function setValue(n) {
    const next = Math.min(max, Math.max(min, n));
    if (next === value) return;
    value = next;
    valueText.setText(String(value));
    refreshButtons();
    change(value);
  }

  /**
   * 禁用 / 启用整个控件
   * @param {boolean} enabled
   */
  function setEnabled(enabled) {
    btnMinus.setEnabled(enabled && value > min);
    btnPlus.setEnabled(enabled && value < max);
    valueText.setColor(enabled ? THEME.white : THEME.faint);
  }

  container.getValue = () => value;
  container.setValue = setValue;
  container.setEnabled = setEnabled;

  refreshButtons();

  return container;
}

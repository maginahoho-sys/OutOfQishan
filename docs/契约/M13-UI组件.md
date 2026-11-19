# M13 · UI 组件库（Phaser）—— 已交付版

> 交付 `src/scenes/ui/components.js` + `src/scenes/DemoScene.js`。
> 依赖：Phaser + `src/core/EventBus.js`（只为了订阅 `ui:toast`，不依赖逻辑层）。

## 目标

一套占位风格的通用组件，供 TownScene / BattleScene / MapScene / 各种弹窗复用。
风格：深色底(0x16213e)、白字、金色(0xf1c40f)强调、蜀汉红/曹魏蓝阵营色。

## 目录

- [导出清单](#导出清单)
- [组件详解](#组件详解)
- [接入现状](#接入现状)
- [验收结果](#验收结果)
- [契约偏差](#契约偏差)
- [踩坑记录](#踩坑记录)

---

## 导出清单

### 工厂函数（契约要求的 6 个）

| 函数 | 签名 | 返回 | 附加方法 |
|---|---|---|---|
| `createButton` | `(scene, x, y, text, onClick, opts)` | `Container` | `setEnabled(bool)` / `setText(str)` / `getEnabled()` |
| `createPanel` | `(scene, x, y, width, height, title, opts)` | `{container, body}` | `setTitle` / `setSubtitle` / `setHint` / `titleText` / `subtitleText` / `hintText` / `shade` |
| `createUnitCard` | `(scene, x, y, unitDef, count, opts)` | `Container` | `setCount(n)` |
| `toast` | `(scene, text, opts)` | `Text` | — |
| `confirmDialog` | `(scene, text, onConfirm, onCancel, opts)` | `Container` | `close()` |
| `createCounter` | `(scene, x, y, min, max, initial, onChange, opts)` | `Container` | `getValue()` / `setValue(n)` / `setEnabled(bool)` |

### 共享常量

```js
export const THEME = { /* 统一配色：面板底/描边/文字/阵营色… */ };
export const DEPTH = { panel: 900, toast: 1000, modal: 1100 };
export const RES_NAMES = { gold: '金', wood: '木', ore: '矿', mercury: '汞', sulfur: '硫', crystal: '晶', gem: '宝' };
```

`RES_NAMES` 把原先散在 `townLogic.js` / `MapScene.js`（2 处）里的资源中文名映射收拢成一份。

---

## 组件详解

### createButton

矩形底 + 文字，支持禁用态。

```js
const btn = createButton(scene, 120, 145, '[正常按钮]', () => {
  toast(scene, '按钮被点击');
}, { width: 150, height: 40 });

btn.setEnabled(false);   // 置灰 + 真正不可点（摘掉 input）
btn.setEnabled(true);    // 恢复
btn.setText('[改名了]');
```

**opts**：`width=120` `height=36` `disabled=false` `color` `bgColor` `borderColor` `fontSize='15px'`

**禁用态的三重表现**：底色换成 `0x1c2536`、描边换成 `0x4a5568`、文字换成弱化灰 `#5d6d80`、整体透明度 0.75，
并且**摘掉底板与文字的 input**（不只是变灰，是真的点不动）。

**点击事件挂在三处**：底板 Rectangle、文字 Text、**容器 Container**。
容器那份是必须的 —— Phaser 的事件**不冒泡**，只挂在子对象上会导致「对按钮整体 emit('pointerdown')」不触发。

### createPanel

带标题栏的圆角矩形容器。

```js
const p = createPanel(scene, 640, 400, 720, 460, '存档 / 读档', {
  depth: 960,
  header: false,              // 不画标题栏底条（沿用旧弹层布局时用）
  titleY, subtitleY, hintY,   // 标题/副标题/底部提示的 y 坐标
  shade: true,                // 是否画遮罩
  onClose: () => close(true)  // 点遮罩的回调
});

p.container.setTitle('存档 / 读档');
p.container.setSubtitle('……');
p.container.setHint('……');
p.body.add(someGameObject);   // 内容区往这里塞
```

**opts**：`depth=900` `shade=true` `header=true` `titleY` `subtitleY` `hintY` `onClose` `radius=14`

### createUnitCard

兵牌：色块 + 兵种首字 + 数量。色块按 `unitDef.faction` 着色（蜀红 / 魏蓝）。

```js
const card = createUnitCard(scene, 100, 565, { name: '乡勇', faction: 'shu' }, 12, { size: 64 });
card.setCount(15);   // 数量文本跟着变
```

### toast

屏幕上方飘过一行字，2 秒淡出。

```js
toast(scene, '直接调用的提示');
bus.emit('ui:toast', { text: '任何模块都能触发' });   // 等价路径
```

**opts**：`x=640` `y=60` `toY=20` `duration=2000` `color` `background` `fontSize` `depth=1000`

**bus 订阅是每场景一次**（WeakMap 记录），场景 shutdown 时自动解绑，不会监听泄漏。
场景若设置了 `scene.toastOptions`，bus 触发的提示会沿用这份设置（BattleScene 用它避开底部操作栏）。

### confirmDialog

遮罩 + 文字 + 确定/取消按钮。

```js
const dlg = confirmDialog(scene, '确定要执行这个操作吗？',
  () => console.log('确定'),
  () => console.log('取消')
);
```

**opts**：`confirmText='确定'` `cancelText='取消'` `width=520` `height=220`

点遮罩 = 取消。回调只会被调用一次。

### createCounter

`[-] 数值 [+]`。

```js
const c = createCounter(scene, 120, 425, 0, 10, 3, (v) => {
  console.log('变成', v);
}, { width: 170, step: 1 });

c.getValue();      // 3
c.setValue(999);   // 钳到 10
```

**opts**：`step=1` `width=150`

到上下界时对应的按钮自动禁用。`setValue` 越界会被钳制，且**只有值真的变了才触发 onChange**。

---

## 接入现状

组件库不是「造了但没人用」，已经实际接进现有代码：

| 位置 | 改动 |
|---|---|
| `MapScene.toast()` | 改为 `components.toast` |
| `BattleScene.toast()` | 改为 `components.toast`（保留战场下沿 596 / 金色 / 不透明黑底的原视觉） |
| `TownScene.toast()` | 改为 `components.toast`（提示仍挂 `toastLayer`，跟界面一起销毁） |
| `savePanel.js` | 面板骨架换成 `createPanel`；三个操作按钮换成 `createButton` |
| `skillPanel.js` | 面板骨架换成 `createPanel`；空态「[关闭]」换成 `createButton` |
| `spellPanel.js` | 面板骨架换成 `createPanel`；右上角「[关闭]」换成 `createButton` |
| `TownScene` 招募面板 | 数量步进器换成 `createCounter`；**改数量不再整行重绘**，改为局部刷新总价与招募按钮可用态 |
| `MapScene` / `TownScene` | 资源中文名映射改用 `RES_NAMES` |
| `DemoScene` | 新增，`?demo=1` 直达，展示全部 6 个组件 |

**重构中保持不变的外部行为**（避免打破既有验证脚本）：
- 三套弹层的**图层深度**不变（skillPanel 900 / spellPanel 950 / savePanel 960）
- 按钮**文字**不变（`[存档]` `[读取]` `[删除]` `[关闭]` …）
- 弹层标题/副标题/提示的**位置**不变（用 `titleY/subtitleY/hintY` 精调）
- `openSkillPanel/openSpellPanel/openSavePanel` 的**函数签名与返回值**不变

---

## 验收结果

契约两条验收标准全部达成，见 `scripts/verify-m13-ui.mjs`（**46/46 通过**，端口 5201）。

### 验收①：demo 场景里各组件行为正确

| 组 | 覆盖 |
|---|---|
| A | `?demo=1` 能进入 DemoScene；元素渲染正常 |
| B | 按钮可点 / 禁用置灰 / 禁用时不触发回调 / `setEnabled` 双向切换 / `setText` 改字 |
| C | 面板标题、副标题、底部提示、内容区 body、`setTitle` / `setHint` |
| D | 兵牌数量 / 首字 / 阵营着色 / `setCount` / 点按钮后数量联动 |
| E | `toast` 直接调用能弹；`bus.emit('ui:toast')` 也能弹 |
| F | 确认弹窗文字 / 确定按钮 / 取消按钮 / 确定回调 / 取消回调 / 关闭后销毁 / 模态深度 1100 |
| G | 计数器初始值 / 加减 / 下界钳制 / 上下界越界钳制 / 数值文本同步 |
| H | 四个 UI 模块能正常 import；契约要求的 6 个工厂函数全部导出 |
| I | 页面运行期间无 JS 报错 |

### 验收②：M5/M7 场景引入组件库后不报 import 错误

- `components.js` / `skillPanel.js` / `spellPanel.js` / `savePanel.js` 四个模块动态 import 全部成功
- 全量回归：M9b 16 + M7 48 + M9 30 + M10 28 + M11 31 + M12 29 + **M13 46** 全过

### 其他回归

| 项目 | 结果 |
|---|---|
| `npm test` | **253/253** |
| `npm run check` | ✅ 数据表全部通过 |
| `npm run build` | ✓ 2.48s |

---

## 契约偏差

1. **额外导出 `THEME` / `DEPTH` / `RES_NAMES`** —— 契约只列了 6 个工厂函数。统一配色与图层深度散落在各处会导致后期换肤/改层级要翻遍全项目，集中成常量是必要补充。
2. **`toast` 增加 `opts` 参数** —— 契约签名是 `toast(scene, text)`。三个场景原本的提示位置/配色/时长各不相同（MapScene 上方飘、BattleScene 战场下沿金色、TownScene 顶部 72px），硬统一会让 BattleScene 的提示被底部操作栏挡住。加可选参数让各场景保留习惯的同时共用一套实现。
3. **`toast` 额外订阅 bus `ui:toast`** —— 契约要求「同时订阅 bus 的 'ui:toast' 事件，任一模块都能触发」。订阅是**每场景一次**（WeakMap 去重），不是每次调用都订阅，否则会重复弹。
4. **`createPanel` 返回值多于 `{container, body}`** —— 额外提供 `titleText` / `subtitleText` / `hintText` / `shade` 与 `setTitle` / `setSubtitle` / `setHint`，三套弹层的标题区就统一走这里，不必各写一遍。
5. **`createPanel` 支持 `header` / `titleY` / `subtitleY` / `hintY`** —— 三套旧弹层的标题布局各不相同（施法面板标题贴在顶沿、存档面板有独立副标题行）。不提供位置参数就只能接受统一布局，那会改变既有界面并打破依赖文本坐标的验证脚本。
6. **`createButton` 的点击事件同时挂在容器上** —— Phaser 事件不冒泡，只挂子对象时「对按钮整体 emit('pointerdown')」不触发。挂三处是刻意的冗余。
7. **`createUnitCard` 按 `faction` 着色，而非按 `tier`** —— 契约只说「色块+首字」。按阵营着色（蜀红/魏蓝）与全游戏的阵营配色一致，比按兵阶配色更容易辨认敌我。

---

## 踩坑记录

### 1. Phaser 的 `disableInteractive` 是**延迟**移除

```js
bg.disableInteractive();
// 此刻 bg.input 仍然是对象！只是 input.enabled = false
// 而且真正从 input manager 移除要等到下一个 game step
```

**判断可交互要看 `obj.input.enabled`，不能看 `!!obj.input`。**

### 2. Phaser 的事件**不冒泡**

`container.on('pointerdown', ...)` 不会因为点了容器里的 Rectangle 而触发。
自动化脚本习惯「找到按钮 → emit('pointerdown')」，如果按钮逻辑挂在子对象上，
脚本对**容器** emit 就完全没反应 —— 排查时极容易误判成「回调没写对」。

修法：组件库把同一个 `fire` 同时挂在底板、文字、容器三处。

### 3. Phaser 3.90 的圆角矩形是 `setRounded`，不是 `setRadius`

```js
scene.add.rectangle(x, y, w, h, color)
  .setStrokeStyle(2, border)
  .setRounded(14);      // ✅
// .setRadius(14)       // ❌ TypeError: setRadius is not a function
```

### 4. 覆盖 Phaser 的 `destroy` 会自引用栈溢出

```js
layer.destroy = () => layer.destroy(true);   // ❌ 无限递归
```

必须先 `bind` 原方法再包一层：

```js
const originalDestroy = layer.destroy.bind(layer);
layer.destroy = (fromScene) => { closed = true; return originalDestroy(fromScene); };
```

### 5. `Text.text` 是**活引用**

```js
const t = findText();     // 拿到 Text 对象
const snapshot = t.text;  // ✅ 立即取字符串
const later = t.text;     // ❌ 延后读取可能已是新值
```

自动化脚本里做「改之前 / 改之后」对比时，必须在改动前把字符串取出来。

### 6. 自动化脚本遍历场景要兼容 Scene 与 Container

Scene 没有 `.list`，容器在 `scene.children.list`。
只写 `node.list` 会让「收集场景里所有按钮」静默返回空数组 —— 断言失败但看不出原因。

```js
const list = node ? (node.children ? node.children.list : node.list) : [];
```

---

## 遗留与后续

- **组件库没有单测**：组件依赖 Phaser 运行时，无法用 `node --test` 跑。
  验证完全依赖 `scripts/verify-m13-ui.mjs`（无头 Chrome，46 条断言）。
  若后续引入 Phaser 的 headless mock，可把部分断言下沉到单测。
- **`createUnitCard` 未接入战斗场景**：M7 的兵牌由 `battleView.js` 单独实现
  （要带血条、特性徽章、选中描边、当前行动闪烁，比通用组件复杂）。
  两者形态相近但需求不同，暂不强行合并。
- **美术仍是占位风格**：所有组件都是色块 + 文字，没有图标与图片资源。
  接入正式素材时，`THEME` 常量表是统一的改造入口。

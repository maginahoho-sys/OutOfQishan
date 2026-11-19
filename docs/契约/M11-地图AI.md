# M11 · 地图 AI（纯 JS，禁止 import phaser）— 已交付

> 交付 `src/logic/mapAI.js`（836 行，纯 JS）+ `src/logic/mapAI.test.js`（21 项单测）
> 依赖：M2（findPath / pathCost / moveHero / reachableTiles / pickUpResource）、
> M4（canAfford）、M5（recruit / construct）、M6（armyValue）。
> 渲染层接入：`src/scenes/MapScene.js`（电脑回合驱动）、`src/scenes/BattleScene.js`（攻守泛化）。

---

## 一、分层结构

M11 沿用 M10 确立的「规划层 / 执行层」两段式。规划层只算不做，执行层执行单步，
渲染层再把单步拆成动画播放。三者严格分离，规划层因此可以做**影子状态仿真**。

| 层 | 位置 | 职责 | 是否改 state |
|---|---|---|---|
| 规划层 | `mapAI.js` → `planMapTurn` / `planHeroTurn` | 算出整回合的行动序列（走哪、打谁、攻城、招兵） | ❌ 不改（只读真 state + 改影子副本 sim） |
| 执行层 | `mapAI.js` → `executeMapStep` / `aiMapTurn` | 执行序列中的**一步**（逐格移动 / 拾取 / 招兵 / 建营） | ✅ 改，但**只允许通过 M2/M4/M5 的导出函数** |
| 渲染层 | `MapScene.js` | 逐步播放序列、播动画、切战斗场景、战斗后回来续跑 | ✅ 改（渲染状态） |

### 导出的接口清单

```js
/** 单回合最多移动调用次数，超出强制停止（验收 3） */
export const MAX_MOVE_CALLS = 100;

/** 规划单个英雄的完整行动（纯函数） */
export function planHeroTurn(state, data, hero) → Array<Step>

/** 规划电脑玩家的完整回合（纯函数） */
export function planMapTurn(state, data, playerId?, opts?) → Array<Step>

/** 执行行动序列中的一步 */
export function executeMapStep(state, data, step) → { ok, reason?, type, ... }

/** 契约入口：规划 + 依次执行，返回行动流水 */
export function aiMapTurn(state, data) → Array<{ heroId, action, detail }>
```

### Step 结构

```js
{
  type: 'move' | 'pickup' | 'recruit' | 'build' | 'battle',
  heroId: string | null,       // build 步骤为 null
  group: 'city' | heroId,      // 见下文「group 标记」
  // move:    to: {x,y}
  // pickup:  pos: {x,y}
  // recruit: townId, unitId, count
  // build:   townId, buildingId
  // battle:  targetType: 'hero'|'town', targetId
}
```

---

## 二、策略（每个英雄按顺序执行，命中即停）

| # | 策略 | 判定条件 | 动作 |
|---|---|---|---|
| 0 | **城务**（每回合先做，见「与契约顺序的差异」） | 缺 T1 招募建筑；且 `meta.day === 1`（产量刚刷新） | 建兵营；派英雄进城补满一队 T1 兵 |
| 1 | **捡便宜** | `reachableTiles` 内有未捡资源，且逐格路径消耗 ≤ 行动力 | 走最近的去捡（`pickUpResource`） |
| 2 | **打得过就打** | 可达范围内有敌方英雄，且己方 `armyValue` > 敌方 × **1.2** | 移动到位后触发战斗 |
| 3 | **攻城** | 己方 `armyValue` > **3000**，且能走到敌方城镇 | 移动到位后触发攻城战 |
| 4 | **否则推进** | 以上都不命中 | 沿 `findPath` 往最近敌方城镇推进，行动力用完为止 |

### 阈值表

| 常量 | 值 | 含义 |
|---|---|---|
| `FIGHT_VALUE_RATIO` | 1.2 | 主动开战的战力倍数门槛（己方 > 敌方 × 1.2） |
| `SIEGE_VALUE_MIN` | 3000 | 攻城所需的最低 `armyValue` |
| `STACK_TARGET` | 10 | 「补满一队」的目标数量（口径对齐 M5 验收「招募 10 个乡勇」） |
| `MAX_MOVE_CALLS` | 100 | 单回合移动调用上限，超出强制停止（验收 3） |

---

## 三、约束与实现要点

### 1. 只通过 M2/M4/M5 的导出函数写状态

- 移动 → `moveHero`（M2）
- 拾取 → `pickUpResource`（M2）
- 招兵 → `recruit`（M5）
- 建营 → `construct`（M5）
- `armyValue`（M6）只做**读取**，用于算战力门槛
- `canAfford`（M4）只做**读取**，用于判断钱够不够

### 2. 移动一步一调用 `moveHero`

规划层把路径拆成逐格 step，执行层每步调一次 `moveHero`，
因此 `hero:moved` 事件**逐格发出**，界面能看到电脑一格一格走。

### 3. 成本口径差异（易踩坑）

`moveHero` 内部按 `pathCost` 计费：连续同地形合并后向上取整（道路 2 格 = 1 点）。
但本模块**逐格**调用 `moveHero`，每次只走一格，单格成本是：

| 地形 | 单格成本 |
|---|---|
| 道路 | 1 点 |
| 平原 | 1 点 |
| 森林 | 2 点 |
| 山地 / 水域 | ∞（不可通行） |

所以规划预算用 `pathStepCost`（逐格累加），**不能**直接用 `reachableTiles` 的 `cost`
（那是连续口径，会偏乐观）。`reachableTiles` 只用来做**候选粗筛**，再用 `pathStepCost` **精确校验**。

### 4. 影子状态仿真（sim）

一个回合里英雄会移动、进城、补兵，这些都会改变后续决策依据
（比如补完兵 `armyValue` 涨了，可能就够资格攻城了）。

所以规划层不直接读真 state，而是先造一份**深拷贝 sim**，在 sim 上逐步「预演」每一步，
等真执行时结果完全一致。规划层只读真 state，真 state 一个字节都不改。

`makeSim(state, data)` 必须携带 `units` / `buildings`：
招募单价来自 `data.units`，不带上会算成 0 金，「钱不够」的判断就失效了。

### 5. `group` 标记（战斗中断续跑的关键）

每个 step 都带一个 `group` 字段：

- `group === 'city'` → 城务步骤（建兵营 / 回城补兵）
- `group === heroId` → 该英雄的行动步骤

电脑发起战斗 → 切到 BattleScene → MapScene 被销毁 → 战斗结算后 `scene.start('MapScene')`
重新创建。要在回来后接着跑剩余英雄，就得知道「哪些英雄已经行动完了」。

判定方法：战斗步骤一定是它所属那一组的**最后一步**（打得过就打 / 攻城都是
「先走完路，最后一步开打」），所以「该组最后一步的下标 < 当前游标」
就等价于「这个英雄已经行动完了」。

⚠️ 城务组不参与判断：城务里可能也有某个英雄的移动（回城补兵），
但那不代表它的战术回合也做完了。

### 6. 续跑信息放 registry

`this.registry` 是 Phaser 的全局注册表，场景切换不丢。用它存续跑信息：

```js
registry.set('mapAiResume', { skipHeroIds, skipCity, moveCalls });
```

MapScene 的 `create()` 里**总是**取走这个 key（哪怕游戏已结束），
否则它会残留在 registry 里，下一局开局时被误读。

### 7. 不读写玩家私有决策

只读公开状态（英雄位置/兵力、城镇、资源池、地图对象），
不读也不改玩家 0 的操作意图。

---

## 四、与原契约的差异（已确认，按本实现为准）

| 项 | 原契约 | 本实现 | 原因 |
|---|---|---|---|
| 城务时机 | 策略 5：「城中无英雄驻守且轮到新一周」时招募 | 城务作为**策略 0**每回合先做；招兵限定 `meta.day === 1`（产量池每周一刷新） | ① 兵营是招兵前提，开局没有兵营 → 必须先建；② M5 规则 4「建招募建筑立刻有产量」→ 建完当回合就能招；③ 「新一周」= 产量刚刷新 = 每周一，否则会天天把英雄拉回城 |
| 补兵前提 | 「城中无英雄驻守」 | 改为「派一个英雄**走到**城里」 | M5 的 `recruit` 硬约束：英雄必须站在城镇格上才算进城。所以城务包含「回城移动」步骤 |
| 「补满一队」的量 | 未明确 | 10 个（`STACK_TARGET`） | 对齐 M5 验收标准「招募 10 个乡勇：扣 400 金、英雄军队乡勇 40→50」 |
| 战斗触发 | 「移动并触发战斗」 | 规划层只产出 battle **意图**，由场景层决定何时切 BattleScene | 逻辑层不碰 M6 战场状态；战斗要切场景，渲染层才有动画上下文 |
| 攻城门槛 | 「己方 aiValue 总和 > 3000 且能走到玩家城镇」 | 同上，但 `armyValue` 用 M6 的权威口径 | `armyValue` = Σ(`unit.aiValue` × count)，与契约「aiValue 总和」一致 |

---

## 五、渲染层接入（MapScene）

### 状态字段

```js
this.aiPlaying       // 电脑回合是否正在播放（播放期间锁定玩家输入）
this.aiSteps         // 行动队列（来自 planMapTurn）
this.aiCursor        // 队列游标
this.aiSkipHeroIds   // 已行动过的英雄（战斗返回后重规划用）
this.aiCityDone      // 城务是否已做过
this.aiMoveCalls     // 本回合累计移动次数（上限保护要跨战斗累计）
this.aiTimer         // 启动定时器句柄（防重复调度）
```

### 关键方法

| 方法 | 职责 |
|---|---|
| `scheduleAiTurn(resume)` | 排一个 300ms 后的启动定时器，`aiTimer` 做互斥（create 续跑路径与 onTurnStart 常规路径共用） |
| `startAiTurn(resume)` | 防重入 → 调 `planMapTurn` → 存队列 → `playNextAiStep()` |
| `playNextAiStep()` | 取下一步，按类型分发执行，每步之间留动画时间 |
| `skipGroupRemain(step)` | 某步失败 → 按 `group` 跳过同组剩余步骤（换下一个英雄继续） |
| `animateHeroStep(hero, from, to)` | 单格移动动画（110ms）。**与玩家版 `animateMove` 不同：不触发格子交互**，战斗由计划里的 battle 步骤显式触发 |
| `startAiBattle(step)` | 算出已完成英雄 → 写 registry → 切 BattleScene |
| `finishAiTurn()` | 清队列 → `endTurnLogic` 把回合交还玩家（保证一个电脑回合只 endTurn 一次） |

### 时序

```
玩家点[结束回合]
  → endTurnLogic：切到电脑（1 号），日期不变
  → emit 'turn:start' → MapScene.onTurnStart → scheduleAiTurn()
  → 300ms 后 startAiTurn()
  → planMapTurn 生成整回合序列（真 state 不变）
  → playNextAiStep() 逐步播放：
       move   → executeMapStep → animateHeroStep（110ms/格）
       pickup → executeMapStep → toast + 重画资源
       build  → executeMapStep → toast
       recruit→ executeMapStep → toast
       battle → executeMapStep → startAiBattle → 切 BattleScene
  → 队列走完 → finishAiTurn() → endTurnLogic：切回玩家，日期 +1
```

---

## 六、战斗层的攻守泛化（配套改造）

电脑作为**进攻方**时，BattleScene 里玩家是守方（`side === 'defender'`）。
原实现有 5 处「玩家 = 攻方」的硬编码，全部改为按 `playerId` 泛化：

| 位置 | 原写法 | 现写法 |
|---|---|---|
| `scheduleAI` | `defenderPlayerId ?? 1` | `this.aiPlayerId`（找 `isAI` 的玩家） |
| `aiCast` | `this.battle?.defenderHeroId` | `this.aiHeroId`（按 `aiSide` 反查） |
| `handleClickCell` 分支 4 | `stack.side === 'attacker'` | `stack.playerId === this.humanPlayerId` |
| `enterAttackMode` | `cur.side !== 'attacker'` | `cur.playerId !== this.humanPlayerId` |
| `playerHero` getter | `attackerHeroId` | 按 `humanSide` 反推取 `attackerHeroId` 或 `defenderHeroId` |
| 顶栏「（攻）/（守）」与兵力条 | 写死攻方红 / 守方蓝 | 按 `humanSide` 决定「我方」标在哪一边、取哪边的兵力 |

新增 getter：`aiPlayerId` / `humanPlayerId` / `humanSide` / `aiSide` / `aiHeroId` / `isHumanTurn()`。

**逻辑层本来就兼容**（无需改动）：

- `battleLogic.buildSide` 已写 `stack.playerId`（该方所属玩家）
- `battleLogic.formationPos(side, index, total)` 只按 side 定位（左=攻方 / 右=守方），与身份无关
- `stackOps.buildTurnQueue` 同速攻方先 —— 英雄无敌式先手规则，非玩家身份假设
- `battleAI.planTurn` 用 `s.side !== stack.side` 判敌人
- `magicLogic.heroSide(battle, heroId)` 按 attacker/defender 英雄 id 反查

### 兵牌配色改为按 playerId

原 `battleView.js` 的 `SIDE_COLOR` 按 side 配色（攻方红 / 守方蓝）。
电脑进攻时玩家是守方 → **玩家的兵牌会变蓝**，与 MapScene 的
「玩家=红 / 电脑=蓝」阵营配色对不上，玩家会误以为自己的兵变阵营了。

已改为按 `stack.playerId` 取色：

```js
const PLAYER_COLOR = { 0: 0xc0392b, 1: 0x2980b9 };  // 玩家红 / 电脑蓝
export function stackColor(stack) {
  return PLAYER_COLOR[stack?.playerId] ?? FALLBACK_COLOR;
}
```

### 回合守卫

操作按钮 `[待命] / [防御] / [施法]` 在非玩家回合禁用（`alpha = 0.4`），
点击时 toast「还没轮到我方行动」。原因：电脑作为进攻方时战斗是
「电脑先动、玩家后动」，玩家在电脑回合里点按钮会把电脑这一手抢掉。

---

## 七、验收结果

### 逻辑层单测（21 项，`src/logic/mapAI.test.js`）

全部通过。覆盖：`planMapTurn` 纯函数性、策略 1~5 各自命中、
`aiMapTurn` 流水格式、逐格 `moveHero`、城务建营 + 同回合招兵、
单回合 100 次移动上限、英雄站上城镇格后仍能移动出城（不卡死）。

### 浏览器端验证（31 项，`scripts/verify-m11-ui.mjs`）

全部通过（`npm run verify:m11`）。覆盖：

| 组 | 断言 |
|---|---|
| 逻辑层 | `planMapTurn` 纯函数、每步带 `group`、步骤类型合法、逐步执行无异常、`hero:moved` 事件数 = move 步数、`MAX_MOVE_CALLS === 100`、`aiMapTurn` 流水格式 |
| 验收 ① | 结束回合后电脑回合自动跑完并交还玩家、曹操逻辑位置变化、精灵位置变化（可见移动）、移动逐格发出、步数 ≤ 100 |
| 验收 ② | `map.objects` 减少、`resource:picked` 事件发出 |
| 城务 | 电脑建了 `wei_barracks1`、电脑招募 T1 兵（青州兵 40→50） |
| 验收 ③ | 连过 5 天每回合正常推进、日期推进到第 6 天、不卡死、不游戏结束 |
| 攻守泛化 | 电脑进攻切战场、`attackerPlayerId = 1`、`humanSide = defender` / `aiSide = attacker`、`aiHeroId` 反查正确、玩家在守方能选中自己的单位、能算可移动格、点[防御]能推进回合、电脑作为攻方自己行动且打的是玩家方 |
| 配色 | 兵牌按 playerId（玩家 `0xc0392b` / 电脑 `0x2980b9`） |

### 5 天行为实录（默认地图，逻辑层模拟）

| 天 | 行为 | 结果 |
|---|---|---|
| 1 | 建青州营（550 金 + 5 矿）→ 派曹操进城 → 招 10 个青州兵（450 金）→ 走 6 格去 (24,6) 捡金 600 | 曹操兵 40→50，金 10000→10100 |
| 2 | 走 11 格去 (18,11) 捡矿 8 | 金 10600 |
| 3 | 走 17 格去 (6,12) 捡金 600 | 金 11700 |
| 4 | 走 11 格去 (11,6) 捡木 8 | 金 12200 |
| 5 | 走 15 格到 (3,13)（刘备身旁）→ 触发战斗 | 进入 BattleScene，电脑是攻方 |

资源全部捡完后，电脑转向推进 / 主动开战，不会空转。

---

## 八、遗留与后续

- **电脑只有一个英雄**：开局双方各 1 个武将，所以「轮流行动」目前只跑一个。
  后续用 M5 的 `hireHero` 扩军后，多英雄轮流、逐个 `group` 续跑的逻辑已就位。
- **城务每回合都跑**：目前 `planCityDefense` 每次都检查建营，
  已建过就不会重复建（`built.has(buildingId)` 会挡住），但函数调用本身有开销。
- **战斗中断续跑只覆盖「切场景回来」这一种中断**：其他中断（如玩家在战斗中手动退出）
  尚未处理。
- **M12 存档**：`state` 已是纯数据（`AI_RESUME_KEY` 存在 registry，不在 state 里），
  存档无需额外处理续跑信息。

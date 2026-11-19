# M10 · 战斗 AI（纯 JS，禁止 import phaser）✅ 已交付

> 交付 `src/logic/battleAI.js`（重写）。依赖：M6（只用它的导出函数，不碰内部）、M9（沿用 `aiCastSpell`）。
>
> 📌 **M9 已附带交付电脑施法**：`battleAI.aiCastSpell(state, data, heroId)`（每轮至多施法 1 次，
> 优先级：伤害魔法打残血敌人 → 减益（致盲优先）→ 治疗伤员 → 全员满血才增益）。
> M10 **沿用**这个函数（优先级已扩展，见下文「与 M9 的关系」）。
>
> 📌 **M10 已交付**：完整策略（选靶评分 / 走位评估 / 集火）+ **规划层与执行层分离**，
> 行动序列可被 M7 逐步播放。`takeTurn` 旧签名保留（兼容层），`aiTakeTurn` 新增。

---

## 一、架构：规划层 / 执行层 / 兼容层

M10 最重要的结构决策是**把"想干什么"和"真去做"拆开**：

| 层 | 函数 | 职责 | 是否改战场 |
|---|---|---|---|
| **规划层** | `planTurn(battle, data, stackId)` | 纯函数：选谁打、走到哪，返回行动序列 | ❌ 绝不 |
| **执行层** | `executeStep(battle, data, step)` | 执行序列中的**一步** | ✅ |
| | `aiTakeTurn(battle, data, stackId)` | 规划 + 全部执行，返回带结果的序列 | ✅ |
| **兼容层** | `takeTurn(battle, data, stackId)` | M6b 旧签名，一次做完（不适合做动画） | ✅ |
| | `actIfAI(battle, data, aiPlayerId)` | 判断当前单位是否归 AI，是则行动 | ✅ |

为什么必须拆开：一次性执行完「移动 + 攻击」的话，移动补间（220ms）和攻击前冲
（130ms + 180ms）会 tween 同一个兵牌对象，两段动画叠在一起，看起来像"瞬移 + 抽搐"。
拆开后 M7 可以逐步播：移动补间播完 → 停 300ms → 再播前冲。

---

## 二、导出的函数清单

### 规划层（纯函数）

```js
/**
 * 规划一个 stack 的完整行动
 * @param {object} battle
 * @param {object} data
 * @param {string} [stackId] 不给则取 currentStack
 * @returns {Array<object>} 行动序列，空数组表示无事可做
 *   { type:'move',   stackId, to:{x,y} }
 *   { type:'attack', stackId, targetId }
 *   { type:'defend', stackId }
 */
export function planTurn(battle, data, stackId)
```

### 执行层

```js
/**
 * 执行行动序列中的一步
 * @returns {{ok:boolean, reason?:string, type:string, stackId:string,
 *            from?:object, to?:object, targetId?:string, result?:object}}
 */
export function executeStep(battle, data, step)

/**
 * 电脑方一个 stack 的完整回合（规划 + 全执行）
 * @returns {Array<object>} 执行后的序列，元素结构同 planTurn，额外带 ok / result
 */
export function aiTakeTurn(battle, data, stackId)
```

### 兼容层（M6b 起的旧签名，签名未改）

```js
export function takeTurn(battle, data, stackId)
// → { action: 'attack'|'move'|'defend'|'wait', targetId?, result? }

export function actIfAI(battle, data, aiPlayerId)
// → boolean，当前行动单位是否属于 AI 方且已被处理
```

### 评估工具（供单测与调试用，也方便别的模块复用）

```js
export function estimateDamage(attacker, defender, opts)  // 期望伤害
export function stackTotalHp(stack)                        // 剩余总生命
export function scoreTarget(battle, data, atk, atkPos, tgt) // 选靶评分
export function pickTarget(battle, data, atk, atkPos, pool) // 挑最优目标
export function summarizeAction(steps)                     // 'attack'|'move'|'defend'|'wait'
export function getFocusTarget(battle)                     // 当前集火目标
export function setFocusTarget(battle, stackId)            // 设置集火目标
```

### M9 沿用（未改动）

```js
export function aiCastSpell(state, data, heroId)
```

---

## 三、策略实现

### 3.1 预估伤害（与 M6 同源，不会漂移）

契约要求 `(damageMin+damageMax)/2 × count × 攻防修正`，射程外再 ×0.5。

**实现方式是复用 M6 的 `computeDamage`，只把随机数换掉**：

```js
const lo = computeDamage(attacker, defender, { ...opts, rng: () => 0 });          // → damageMin
const hi = computeDamage(attacker, defender, { ...opts, rng: () => 0.999999 });   // → damageMax
const hits = hasAbility(attacker, 'twoAttack') ? 2 : 1;   // twoAttack 攻击两次
return Math.max(1, ((lo + hi) / 2) * hits);
```

这样伤害公式**只有一份实现**，AI 的预估不会和实际结算脱节。
`twoAttack` 的翻倍在 `estimateDamage` 里显式补上（`computeDamage` 只算单次命中，
两次循环在 `attackStack` 里做）。

### 3.2 选靶评分（`scoreTarget`）

| 项 | 分值 | 说明 |
|---|---|---|
| 一击必杀 | **+1000** | 预估伤害 ≥ 目标剩余总生命 |
| 射程内 | **+400** | 射程内是满攻击力，射程外减半 |
| 集火中 | **+150** | 其他 AI 单位正在打这个目标 |
| 对方是远程兵 | **+100** | 先拆输出点 |
| 兵种价值 | **0~200** | `aiValue / 10`，上限 200 |
| 残血 | **0~80** | `(1 - 剩余血比) × 80` |

对应契约「能打到就打」的四级优先：
**能一击打死 > 射程内 > 远程/高 aiValue 目标 > 血量最少**（残血项覆盖最后一条）。

目标剩余总生命的算法（`stackTotalHp`）：因为 `applyDamage` 是"队首兵逐个吸收、
阵亡后下一个满血补位"，所以：

```
剩余总生命 = stack.hp + (stack.count - 1) × stack.maxHp
```

### 3.3 近战走位（`planMeleeTurn`）

1. 已经贴着敌人 → 直接开火（不移动）。
2. 没贴着 → 在 `movableCells` 里给每个候选格打分：
   - `+200 + scoreTarget(移动后位置)`：这一步能贴上敌人且能打出好伤害
   - `-距离 × 20`：越近越好
   - `-贴脸敌人数 × 8`：别被围住
   - `-50`：没更近就别乱走
3. 移动后如果能贴上敌人 → **追加一次攻击**（移动不结束回合）。
4. 哪都去不了 → 防御。

### 3.4 远程走位（`planRangedTurn`）

1. **射程内有敌人 → 就地开火，不移动**（契约：远程兵优先待在能覆盖敌人的位置）。
2. 射程内没人 → 候选格**统一过滤掉所有敌人相邻格**（见 3.5），然后两档评分：
   - 能覆盖到敌人：`covered.length × 1000 + 最近距离 × 10 - 路程 × 2`
     （覆盖的敌人越多越好；其次尽量远、最后少走路）
   - 还够不到射程：`最近距离 × -100 - 路程 × 2`（朝敌人推进，仍然不贴脸）
3. 移动后重新评估射程：进射程就打满伤，否则打半伤（远程可打全场）。
4. 一步都不够 → 防御。

### 3.5 远程兵绝不主动贴脸

候选格在评分**之前**就被过滤掉所有 `isAdjacent(c, e.pos)` 的格子。
即使所有候选格都是贴脸格，也宁可在原地打半伤也不送脸
（贴脸会被近战打，而且自己的反击还要再减半）。

> 这条是契约验收标准 ② 的硬要求，实现上放在**候选生成阶段**而不是"扣分"，
> 保证不可能漏判。

### 3.6 集火（focus fire）

AI 攻击成功后把目标记进集火表，后续单位优先打它（评分 +150）。

集火表用**模块内的 `WeakMap<object, string>`**（battle 对象 → 目标 stack id）：

- 契约限定 AI 不得修改 battle 内部字段（`defending` 除外），挂字段会污染战场数据（battle 要能存档）；
- 用 WeakMap 既能让多个 AI 单位共享同一目标，又不会写进 `state.battle`；
- 目标阵亡时 `getFocusTarget` 自动失效并清理。

---

## 四、与契约的两处偏差（已确认，按本项目实际实现）

### 4.1 距离度量：切比雪夫，不是曼哈顿

契约原文写「选离最近敌人**曼哈顿**距离最小的格子移动」，
但本项目是**八方向移动**，`movableCells`（BFS）与 `cellDistance` 用的是同一种切比雪夫度量：

```js
export function cellDistance(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
```

八方向移动下曼哈顿距离会**低估可达性**（斜着走 3 步就到，曼哈顿算 6 步），
按曼哈顿挑格子会选出走不到的位置。故实现统一用切比雪夫，与 M6 口径一致。

### 4.2 允许直接写的字段：只有 `stack.defending`

契约明确「不许直接改 battle 内部字段（defending 除外）」，
所以 `executeStep` 的 `defend` 分支直接写 `stack.defending = true`，其余一律走 M6 的导出函数。

---

## 五、与 M9 的关系

`aiCastSpell`（M9）**一字未改**，在场景层的调用顺序是：

```
scheduleAI() → 延时 450ms → aiCast()（M9 施法）→ planTurn()（M10 规划）→ 逐步执行
```

即「电脑方每轮至多施法 1 次」这条 M9 规则仍然成立，施法发生在该单位行动之前。

M10 只在**选靶**时把"对方是远程兵"作为一个加分项（+100），
让 AI 优先拆掉对方的弓手/霹雳车/谋士这类输出点。

---

## 六、场景层接入（M7 播放）

`src/scenes/BattleScene.js` 改了 4 处：

| 改动 | 说明 |
|---|---|
| `init()` 新增 `aiTimer` / `aiBusy` | AI 调度互斥锁 |
| `scheduleAI()` 重写 | 加锁 → 延时 450ms → 施法 → 规划 → 逐步执行 |
| 新增 `playAiSteps(steps, stackId, action)` | 逐步执行，每步之间留动画时间 |
| 新增 `finishAiTurn(stackId, action)` | 序列播完 → 推进回合 → 继续驱动下一个 AI 单位 |

**逐步播放的时序**：

| 步骤 | 延时 | 理由 |
|---|---|---|
| move | 300ms | 移动补间 220ms，要播完 |
| attack | 620ms | 前冲 130ms + 归位 180ms + 受击抖动 + 伤害飘字 |
| 其他 | 120ms | 防御 / 待命 |

**为什么需要互斥锁**：`nextTurn()` 内部会 `bus.emit('battle:turn')`，
BattleScene 监听这个事件时会调 `scheduleAI()`；而 `finishAiTurn` 又显式调一次
`scheduleAI()`。两条路径都会排一个 `delayedCall(450)` 定时器 →
同一个 AI 单位被行动两次（或跳过单位）。
所以 `scheduleAI` 开头 `if (this.aiTimer || this.aiBusy) return;`，
`finishAiTurn` 里先清 `aiBusy` 再 `nextTurn`。

---

## 七、验收结果

### 7.1 单元测试

`src/logic/battleAI.turn.test.js` —— **25 项全过**（独立的测试文件，不与 M9 的施法测试混在一起）：

- `estimateDamage`：期望值 / 超射程减半 / `twoAttack` 翻倍
- `stackTotalHp`：队首兵 + 满血补位兵
- `scoreTarget`：一击必杀分最高
- `pickTarget`：同分按 id 排序，行为可复现
- `planTurn` 近战四场景：相邻直接打 / 推进 / 一步贴上后同回合追加攻击 / 无路可走→防御
- `planTurn` 远程四场景：射程内原地开火 / 不进相邻格 / 射程外先移进射程 / 够不到则推进
- `executeStep` 三种 / `aiTakeTurn` 返回 move+attack 序列 / `summarizeAction`
- `takeTurn` 旧签名 / `actIfAI`
- **契约 4 条验收标准的逐条断言**

### 7.2 契约验收标准逐条核对

| # | 验收标准 | 结果 |
|---|---|---|
| ① | 10乡勇(AI) vs 10乡勇(玩家不动只防御)，AI 能在 20 轮内获胜 | ✅ **8~10 轮**取胜，AI 零损 |
| ② | AI 远程兵不会主动走进敌人相邻格 | ✅ 候选格统一过滤贴脸格 |
| ③ | AI 远程兵在射程外时优先移动到射程内再开火 | ✅ 移动后 `outOfRange === false`，战报无「超出射程」 |
| ④ | `aiTakeTurn` 返回值能被 M7 直接消费播放 | ✅ 场景层逐步播放，移动与攻击间隔 ≥ 250ms |

### 7.3 浏览器验证

`scripts/verify-m10-ui.mjs`（puppeteer-core 无头 Chrome）—— **28 项全过**：

- **逻辑层**：planTurn 序列结构 / 纯函数性（调用前后战场位置不变） /
  aiTakeTurn 返回带 ok+result 的结果 / 契约验收 ① 的 20 轮内取胜
- **场景层 A（近战）**：AI 触发 `battle:move` 与 `battle:action` 事件 /
  位置真的变了 / 移动后紧贴玩家 / 玩家掉血 / 战报有移动与攻击记录 /
  **移动与攻击是分开的两帧（间隔 ≥ 250ms）** / 兵牌渲染位置跟到了新格 /
  行动结束后调度锁已释放
- **场景层 B（远程）**：初始确实在射程外 / 发生了移动 / 移动后进入射程 /
  **没有走进敌人相邻格** / 射程内开火（战报无「超出射程」）/ 移动与攻击分开帧
- **消费契约**：场景交给渲染层的行动序列结构合法 /
  序列里的移动目标与实际落点一致 / 攻击目标就是玩家方 stack

### 7.4 全量回归

| 项目 | 结果 |
|---|---|
| `npm test` | **210 / 210 通过**（M10 新增 25 项） |
| `npm run check` | ✅ 数据表全部校验通过 |
| `npm run build` | ✅ built in 2.46s |
| `scripts/verify-m10-ui.mjs` | ✅ 28 / 28 |
| `scripts/verify-m7-ui.mjs` | ✅ 48 / 48（回归，改了 `scheduleAI`） |
| `scripts/verify-m9-ui.mjs` | ✅ 30 / 30（回归） |
| `scripts/verify-m9-browser.mjs` | ✅ 16 / 16（回归） |

---

## 八、遗留与后续

- **曼哈顿 vs 切比雪夫**：实现按切比雪夫（见 4.1）。若后续 M11 地图 AI 需要真曼哈顿，
  记得两个模块的口径要分开写清楚，别互相套用。
- **AI 的"等待最优解"**：目前是贪心 + 启发式（一步 lookahead），不做两回合预测。
  战斗规模（11×9、每方 2~4 个 stack）下够用。
- **M11 地图 AI**（电脑方在地图上怎么走）还没做，是下一个模块。

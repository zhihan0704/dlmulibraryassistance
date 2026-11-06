# 座位状态映射研究（Evidence Set #1）

| 项 | 值 |
|---|---|
| 状态 | **NEEDS_REVIEW** —— 未达到可编码为「空闲/占用」的证据强度 |
| 证据来源 | `research/phase2/evidence/seat-dom.json`（SHA256 `f9e62cc98c9726a85df22b6d9829f150aa8cb8c856fd2abb6153c5e88be0286c`） |
| 采集时刻 | 2026-11-01T10:24:17.514Z（北京时间 18:24:17） |
| 采集路由 | `#/ic/seatPredetermine/100455855`（电子阅览室） |
| 样本量 | 152 个座位，1 组时点 |
| 配套接口样本 | `seats-safe.json`（同日 18:23:50，152 条，`devStatus` 全 0、`resvInfo` 已被脱敏清空） |

## 1. 实测交叉表

DOM 节点上的 `class` 与 `title`（悬停提示）联合统计：

| class | 有空闲时段 | 无空闲（"空闲时间：无"） | 无 title | 合计 |
|---|---|---|---|---|
| `yellow` | 44 | **52** | 0 | 96 |
| `yellowGreen` | **46** | 0 | 0 | 46 |
| `green` | 0 | 0 | **10** | 10 |
| 合计 | 90 | 52 | 10 | 152 |

辅助数据：

- 第一段空闲时段的起点分布：`21:30`×26、`20:30`×14、**`18:24`×12**、`21:00`×8、`18:30`×6 …
- `18:24` 恰好等于采集时刻，与前端 `getFreeArray()` 中「查询当天则从当前时间+1 分钟起算」的逻辑吻合。

## 2. 可以确立的结论（证据支持）

1. **`devStatus = 0` 与座位是否被预约无关。**
   同一时刻，152 条接口记录的 `devStatus` 全部为 `0`，而 DOM 上却有 10 个 `green`、46 个 `yellowGreen`、52 个「全天无空闲」的座位。
   → 这是对红线「不得把 `devStatus=0` 当空闲」的**实证支持**，不再是纯理论警告。

2. **`green` 不等于「现在空闲」。**
   `green` 的 10 个座位**完全没有 title**，对应组件在 `resvInfo` 为空时只返回座位名。也就是说 `green` 表示「该日没有任何预约记录」，而不是「此刻可约」。反例：12 个座位的空闲区间从 `18:24`（当前时刻）开始，它们仍属 `yellow`/`yellowGreen`，因为当天存在（已结束的）预约记录。

3. **`className` 不能作为可用性判据。**
   `yellow` 内部同时包含「全天再无可约时段」（52 个）与「仅剩极短空闲」（44 个，多为 `21:30-21:40`）两种完全不同的情形。同一个类名覆盖了相反的业务含义。

4. **DOM 里唯一可靠的可约性信息是 title 里的空闲区间文本**，而不是颜色类。若只做 DOM 读取，应解析该文本而非 `className`。

## 3. 仍然未知（禁止推断）

| 未知项 | 说明 |
|---|---|
| `yellowGreen` 的确切含义 | 46 个全部「有空闲」，但为何不同于 `yellow` 未确认 |
| `resvStatus` 位掩码语义 | 前端可见 `128` / `64` / `2048` / `4` 四种位检测，含义全未确认 |
| 是否有第三种来源影响颜色 | 可能还受登录态、资格、日期窗口影响 |
| 时变行为 | 仅 1 个时点，无法确认状态何时刷新 |

## 4. 前端源码给出的参考逻辑（静态取证，非现场验证）

`chunk-03e59dfa` 的 `handleItemClass()` 依据 `resvInfo + resvRule + openTimes + onlyView` 计算类名，返回值域为
`gray` / `yellow` / `yellowGreen` / `green` / `noopenlook`；
`chunk-8395d758` 的 `getFreeArray()` 用 `(128 & resvStatus) <= 0` 过滤后合并区间，得出空闲时段。

> 注意：该函数中 `yellowGreen` 的判定由 4 个 OR 条件组成，其中两条在多数情况下恒真。
> 因此**不应照搬前端逻辑**——前端算出的类名本身就不是一个干净的语义标签。

## 5. 对扩展的约束

在拿到**至少第二组**不同时点的现场证据、并能解释 `resvStatus` 位掩码之前：

- 所有座位状态**一律 `UNKNOWN`**；
- 不显示「空闲 / 占用 / 可预约」字样；
- 只展示客观可数事实：「座位总数」「含预约记录的座位数」「无预约记录的座位数」「空闲时段文本」；
- 任何映射表都保持 `NEEDS_REVIEW`。

## 6. 第二组证据需要采集什么

1. 同一房间、**另一个时点**（最好跨越一个整点，观察状态迁移）的 `seat-dom.json` 同构样本。
2. `/ic-web/reserve` 的**未脱敏 `resvInfo`**（至少 `resvStatus`、`startTime`、`endTime`；**不要** `trueName`/`logonName`）。
3. 若可行，同一时刻对某一个座位手动作业（如现场机签到/暂离）后观察 `resvStatus` 变化 —— 但这属于**用户本人正常使用**，需用户自行操作，扩展不参与。

## 7. 补充：接口 schema 已确认（2026-11-02）

从 `research/phase2/evidence/network-after-login.json` 中还原出 `/ic-web/reserve` 的**记录下来的真实 schema**
（该文件只保留字段名与类型，**不含值**）：

```
data: array[152]
  └ item:
      devId: number, devSn: number, devName: string
      devStatus: number, devProp: number, openState: number
      coordinate: string, roomId: number, roomName: string
      openStart: string, openEnd: string, onlyView: boolean
      resvRule: { minResvTime: number, maxResvTime: number, earliestResvTime: number,
                  latestResvTime: number, cancelTime: number, earlyInTime: number,
                  laterLineTime: number, timeInterval: number, ... }
      openTimes: array[{ openStartTime: string, openEndTime: string, openLimit: number }]
      resvInfo: array[{ uuid: string, resvId: number, startTime: string, endTime: string,
                        title: object, trueName: object, logonName: object,
                        resvStatus: number, resvEndRealTime: object, devId: number }]
      pointSize / textSize: { 1: number, 2: number, 4: number }
      icon / addServices / deviceAttributes / endDayOpenInfo / maintenanceTime: object|null
```

**这解决了什么**：扩展的规范化器字段假设与实际接口一致（`devId` 是 number、`coordinate` 是
`"x,y"` 字符串、`resvInfo` 是对象数组、`resvStatus` 是 number）。已据此在 `tests/live.test.ts`
加入一条「按真实 schema 构造」的用例，并断言冗余字段与他人身份字段全部被丢弃。

**这不解决什么**：schema 只说明**有哪些字段、什么类型**，不说明 `resvStatus` 的位含义。
因此状态映射仍为 `NEEDS_REVIEW`，`status` 仍恒为 `UNKNOWN`。

## 8. 证据集 #2：真站实时采集（2026-11-02 12:47）

详见 `research/live/2026-11-02/ANALYSIS.md`（SHA256 `3975888c…`）。要点：

| 观察 | 值 | 影响 |
|---|---|---|
| `resvStatus` 实测取值 | **1027**（299 条）与 **1093**（119 条） | 首次拿到真值 |
| 位检测 | 1027 = 1+2+1024；1093 = 1+4+64+1024；**均不含 128** | 位 128 本次未被触发 |
| `resvInfo` 覆盖 | 152/152 座均有，1–4 条不等 | **推翻「resvInfo 非空 = 被占」** |
| `devStatus` | 152 个全 0 | 与 #1 一致 |
| `openState` | 152 个全 1 | 仍无法区分任何情况 |
| 空闲推算 vs 网页渲染 | **120 / 32 完全相等** | `resvInfo` 是唯一权威占用来源 |
| `className` 反解 | 扫描 583 组参数无命中 | **不实现映射**，状态仍 `UNKNOWN` |

仍未知：`1093` 与 `1027` 的业务差异（签到？使用中？）、位 64 与位 4 的含义。

# 预约规则核验（第三阶段）

| 项 | 值 |
|---|---|
| 状态 | 多条规则 **CONFLICT / UNKNOWN** → 一律保持 `NEEDS_REVIEW` |
| 官方来源 | `research/phase2/evidence/help-text.txt`（SHA256 `e1c81b6d…`，站内帮助页原文） |
| 接口来源 | `research/phase2/evidence/seats-safe.json`（`resvRule` 实测字段值） |
| 代码来源 | 6 个已采集前端资源（`chunk-03e59dfa`、`chunk-bea8137a`、`chunk-d317799e` 等） |
| 采集时间 | 2026-11-01 |

> **本文件只做核验，不产出可执行规则。** 结论中凡标 `NEEDS_REVIEW` 的，代码里不得取其一端。

## 1. 单位问题已用代码确定（不再是猜测）

此前所有报告都停在「单位未确认」。本次从三处前端代码交叉确认：

```js
// chunk-d317799e：直接把字段拼上「分钟」单位显示
minResvTime + $t("common_unit_m")      // common_unit_m = 分钟
maxResvTime + $t("common_unit_m")

// chunk-03e59dfa：按「分钟」拆分天/时/分（1440 分钟 = 1 天）
d = Math.floor(x / 1440)
h = Math.floor(x % 1440 / 60)
m = Math.floor(x % 1440 % 60)

// chunk-bea8137a：与时间差直接比较，单位是 minute
diff(..., "minute") < resvRule.minResvTime
moment(t.startTime).add(resvRule.minResvTime, "minutes")
```

**结论：`minResvTime` / `maxResvTime` / `earliestResvTime` / `cancelTime` / `timeInterval` 的单位都是分钟。**

`earliestResvTime` 另有整日判据：`if (i % 1440 === 0) moment().add(i / 1440, "days")` —— 1440 分钟即 1 天。

## 2. 逐条核验表

| # | 规则 | 官方帮助页原文 | 接口实测值 | 前端如何使用 | 判定 |
|---|---|---|---|---|---|
| 1 | 最短预约时长 | 「预约可选时长为 **1–4 小时**」 | `minResvTime = 30` | `diff(start,end,'minute') < 30` → 判为不可选 | 🔴 **CONFLICT**：接口允许 30 分钟，帮助页写 1 小时起 |
| 2 | 最长预约时长 | 「1–4 小时」 | `maxResvTime = 240` | 240 分钟 = 4 小时 | 🟢 **CONFIRMED**（上下限一致） |
| 3 | 提前预约 | 「可**提前一天**预约」 | `earliestResvTime = 1440` | `%1440===0` → `add(1,'days')` | 🟢 **CONFIRMED** |
| 4 | 最晚预约 | 未提及 | `latestResvTime = 0` | 与 `earliest` 同为 0 时显示「今天」 | 🟡 **UNKNOWN**：0 是「无限」还是「仅当天」未确认 |
| 5 | 时间粒度 | 未提及 | `timeInterval = 5` | `timeInterval < 1 ? 1 : parseInt(...)` 作为步长 | 🟢 **CONFIRMED（数值）**，帮助页未写 |
| 6 | 取消截止 | 「预约生效时间为开始时间前 **10 分钟**，只能生效前取消」 | `cancelTime = 15` | 以分钟显示，且显示值会 `- sysConfig.cancelTimeReduceMinutes` | 🔴 **CONFLICT / UNKNOWN**：15 ≠ 10；显示值还被未采集的 `sysConfig` 修正 |
| 7 | 签到宽限 | 「提前 **10** 分钟或延迟 **15** 分钟」 | `earlyInTime = 10`、`laterLineTime = 600` | **前端资源中零引用** | 🟡 **UNKNOWN**：`earlyInTime=10` 数值吻合但无代码佐证；`600` 既非 15 分钟也非 15 秒 |
| 8 | 开放 / 闭馆时间 | 「结束时间为闭馆时间（周一到周日 **21.50**）」 | 2026-11-01（周日）08:30–21:40；2026-11-02（周一）**07:30**–21:40 | 页面按 `openTimes` 渲染 | 🟢 **开放时段 CONFIRMED**（两次真站样本与 `openScope` 完全吻合）；🔴 闭馆 **21:50 vs 21:40 仍 CONFLICT** |
| 9 | 每日累计上限 | 未提及 | `maxResvTimeEveryday = null` | **前端零引用** | 🟡 **UNKNOWN** |
| 10 | 违规与封禁 | 「违规满 **5** 次限制使用 **3** 天」 | 无对应接口字段 | — | 🟡 **UNKNOWN**：无接口/代码证据 |
| 11 | 暂离时长 | 「普通 30 分钟；11:00–13:00 与 16:30–18:30 保留 90 分钟」 | 无对应字段 | — | 🟡 **UNKNOWN**：同上 |
| 12 | 可预约日期范围 | 「提前一天」 | 由 `latestResvTime` / `earliestResvTime` 推出 | `handleItemClass` 用 `ceilDay` 限定日期窗口 | 🟡 **UNKNOWN**：`ceilDay` 边界公式未完全还原 |

## 3. 结论

**只有 4 条可以被认定为确认（#2、#3、#5，以及 #1 的上限部分）。**

两条硬冲突（#1 下限、#8 闭馆时间）**无法通过代码或帮助页自行消解**：

- #1：帮助页说 1 小时，接口允许 30 分钟。可能是帮助页陈旧，也可能是该房间单独放宽。**两种解释都有道理，所以不能选。**
- #8：21:50 与 21:40 差 10 分钟，疑似「闭馆时间」与「该阅览室开放结束时间」不是同一个概念。

因此 `reservation-rules` 的对外表现保持不变：

- `createPreview()` 的 `rule` 恒为 `NEEDS_REVIEW`；
- `executeAllowed` 恒为 `false`；
- 界面不显示「可预约 / 不可预约」，只显示 `UNKNOWN`。

## 4. 要真正消解冲突还需要什么

| 冲突 | 需要的证据 |
|---|---|
| #1 最短时长 | 登录后在页面上实际尝试「30 分钟」与「60 分钟」两笔预约的**前端反应**（不提交），看是否被拦；或找到校方最新版规则页 |
| #8 闭馆时间 | 电子阅览室页面 `/openTimes` 的实时值 + 图书馆官方开放时间公告 |
| #6 取消截止 | 页面上「取消」按钮出现/消失的时间边界 |
| #7 签到宽限 | 签到页文案或校方规则 |

> 这些都需要**用户本人登录并正常使用**，扩展不参与，也不代替提交。

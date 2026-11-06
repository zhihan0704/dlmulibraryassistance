# 实时数据通道（被动旁路观测）

## 1. 设计原则

**只读网页自己已经产生的数据，扩展永不主动请求。**

| 约束 | 实现方式 |
|---|---|
| 只用正常页面访问产生的数据 | 包装 XHR / fetch，读页面**已收到**的响应正文 |
| 不构造 / 不重放 / 不探测接口 | 代码中没有 URL 拼接、没有请求发送、没有参数构造 |
| 不绕过认证 | 完全不接触 Cookie / Token；`withCredentials` 由页面自理 |
| 不读取他人隐私 | `resvInfo` 中的 `title` / `trueName` / `logonName` 在页内即被丢弃 |
| 权限最小化 | 零新增权限（MAIN world 是声明式的，不需要 `scripting`） |
| 兼容 `connect-src 'none'` | 扩展自身零网络请求，CSP 无需放宽 |

## 2. 通路

```
页面 (MAIN world)                      ISOLATED world          侧边栏
─────────────────                      ──────────────          ──────
图书馆网页自己的 axios
      │ GET /ic-web/reserve 响应
      ▼
hook.js  ──window.postMessage──▶  content.js
（document_start，包装 XHR/fetch）      │ 校验 origin + 结构
                                        │ normalizeReservePayload()
                                        │ 仅存内存（不落盘）
                                        ├──chrome.runtime.onMessage──▶ live-panel.ts
                                        └──LIVE_UPDATE 广播──────────▶ 自动刷新
```

关键点：

- `hook.js` 必须 `run_at: document_start`，否则页面的首个请求已经发出。
- MAIN world 与 ISOLATED world **不能共享 JS 变量**，只能通过 `window.postMessage` 通信。
- `content.js` 在 `document_idle` 才就绪，因此 `hook` 保留最近 3 次响应（`lsa:want-buffer`），
  由 `content.js` 启动时主动索取，避免早期响应丢失。
- 实时快照**只存内存**：不写 `chrome.storage`、不写日志，关闭标签页即消失。

## 3. 文件职责

| 文件 | 世界 | 职责 |
|---|---|---|
| `src/content/reserve-hook.ts` | MAIN | 包装 `XMLHttpRequest.prototype.open/send` 与 `window.fetch`；只匹配路径后缀 `/ic-web/reserve` |
| `src/core/live-seats.ts` | 共用 | 纯函数：定位座位数组、规范化、丢弃身份字段、汇总。可 Node 测试 |
| `src/content/index.ts` | ISOLATED | 校验消息来源、解析、缓存、响应 `GET_LIVE` / `READ_PAGE_SEATS` |
| `src/sidepanel/live-panel.ts` | 侧边栏 | 渲染实时/DOM 两块信息、实时座位地图（按网页坐标定位）、搜索与选中详情、失败原因 |
| `scripts/check-extension.mjs` | — | 校验 manifest 结构、文件齐备、hook 不使用 `chrome.*`、权限未扩大 |

## 3.1 侧边栏展示什么

| 区域 | 内容 | 数据来源 |
|---|---|---|
| 页面 DOM | 路由、房间标题、座位数、状态类分布、带空闲时段的座位数、读取时刻 | 当前标签页 DOM |
| 响应旁路 | 是否已安装、捕获次数、捕获时刻、实时座位数、房间分布、含/无预约记录的座位数 | 网页自身响应 |
| **实时座位地图** | 152 个座位按 `coordinate` 百分比定位；点击显示 `devId`、开放起止、预约时间记录条数与具体时段；支持按编号搜索 | 网页自身响应 |

两个地图**不会混淆**：

- 历史快照地图用实线绿色边框（`.real-seat`），位于「真实座位 · 历史快照」区块；
- 实时地图用**虚线冷色边框**（`.live-seat`），位于「实时数据 · 当前页面」区块。

所有座位一律 `UNKNOWN`，不因是否有预约记录而改变颜色或文案。
「预约时间记录 N 条」只陈述事实，不翻译成「占用 / 空闲 / 可预约」。

## 4. 失败与边界行为

| 情形 | 表现 |
|---|---|
| 页面尚未请求过 reserve | 显示「未捕获到」，并提示刷新页面 |
| 响应结构异常 | 显示最近一次解析失败原因；**保留**上一次成功快照 |
| 旧快照 + 新解析失败 | 界面同时显示快照时间与错误，不静默替换 |
| content script 未注入 | 侧边栏提示「请在图书馆页面按 F5 刷新」 |
| 非目标网站 | 显示「当前不是目标网站」，不发任何消息 |

## 5. 手工验证步骤（必须人工执行）

因扩展只在 `https://seats.dlmu.edu.cn/*` 注入，且数据依赖登录态，**自动化测试无法覆盖真站**。验证方法：

1. 打开 Edge → `edge://extensions` → 开启「开发人员模式」→「加载解压缩的扩展」→ 选择
   `library-seat-assistant/dist`。
2. 在扩展管理页点击「服务工作进程 / Service Worker」，确认无报错。
3. 打开 <https://seats.dlmu.edu.cn/#/ic/home>，**人工登录**（扩展不代登录、不接触凭据）。
4. 进入「一楼 · 电子阅览室」座位页（`#/ic/seatPredetermine/100455855`）。
5. 在扩展管理页「详情」→ 固定到工具栏 → 点击图标打开侧边栏。
6. 侧边栏「实时数据 · 当前页面」应显示：
   - 页面路由 = `#/ic/seatPredetermine/100455855`
   - DOM 座位数 = 152
   - 响应旁路 = 已安装并运行；实时座位数 = 152
   - 房间分布含「电子阅览室 100455855 ×152」
7. 按 F5 刷新页面 → 捕获时刻应更新（验证刷新后重新取数）。
8. 关闭再打开浏览器 → 重新进入页面 → 数据应再次出现（验证无持久化残留也不会坏）。

若第 6 步「响应旁路 = 未捕获到」，说明 hook 未生效：检查 manifest 是否为 `world: "MAIN"`、
`run_at: "document_start"`，以及 Edge 版本 ≥ 111（本机 156，满足）。

## 6. 未验证项（截至本阶段）

- 真站上 hook 是否真的命中 `/ic-web/reserve`（需人工登录）。
- `resvInfo` 的真实结构与 `resvStatus` 位域含义。
- 页面刷新后重新请求的时机与频率。
- Chrome（本机未安装）与 Edge 原生工具栏点击、原生侧边栏行为。

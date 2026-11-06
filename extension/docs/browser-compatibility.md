# 浏览器兼容性说明

| 项 | 值 |
|---|---|
| 声明的最低版本 | `minimum_chrome_version: "111"`（`world: "MAIN"` 需要 Chromium 111+） |
| 已实测浏览器 | Microsoft Edge **156.0.4314.58**（Chromium 156 内核） |
| 未实测浏览器 | Google Chrome（品牌版）——**本机未安装** |
| 实测方式 | `scripts/e2e-live.mjs`、`scripts/e2e-restart.mjs`（Playwright 驱动） |

## 1. 已实测的能力（Edge 156）

| 能力 | 结果 | 证据 |
|---|---|---|
| 加载未打包扩展 | ✅ | Service Worker 立即注册，扩展 ID 正常 |
| manifest 被接受（含 `world: MAIN`） | ✅ | 无加载错误，hook 正常注入 |
| 内容脚本按 `matches` 注入 | ✅ | 4 个标签页中仅目标源被注入 |
| 侧边栏文档加载 | ✅ | 标题正确、UI 渲染完整 |
| MAIN world hook 捕获 XHR | ✅ | 捕获 `/ic-web/reserve` 并去重 |
| 消息链路（content ↔ 侧边栏） | ✅ | `GET_LIVE` / `READ_PAGE_SEATS` 均通 |
| 页面 DOM 变化后自动更新 | ✅ | `MutationObserver` 触发、面板自动刷新 |
| Service Worker 重建 | ✅ | 关闭浏览器后重启，工作进程重新注册 |
| 重启后任务恢复 | ✅ | 任务仍在、状态 `WAITING`、未被误执行 |

## 2. 未实测的能力

| 能力 | 为什么没测 | 风险判断 |
|---|---|---|
| Google Chrome 品牌版 | 本机未安装 | **低**。Edge 与 Chrome 同为 Chromium，扩展引擎、manifest 解析、`sidePanel` API、MAIN world 注入是同一套代码。品牌差异主要在 Google 服务集成与企业策略，不在 MV3 能力 |
| 原生工具栏点击 | 系统级交互，Playwright 无法驱动浏览器 UI 外壳 | **中**。`setPanelBehavior({openPanelOnActionClick:true})` 是文档化 API，但未亲眼看到面板弹出 |
| 原生 Side Panel（非标签页形式） | 同上；测试里只能把侧边栏当作普通标签页打开 | **中**。数据链路已验证，布局在窄面板下是否溢出未验证 |
| 工具栏图标显示 | 需要目视 | **低**。三尺寸 PNG 均在 manifest 中正确引用 |
| 真实站点上的注入 | 需要登录 | **中**。本地伪造页面走的是同一套 `matches` 规则，但不能证明真站 DOM 结构一致 |

## 3. 为什么没有下载 Chromium 来「补测 Chrome」

考虑过用 Playwright 下载 Chromium 做对照测试，最终没有做，理由：

1. **信息增量接近零**——Edge 156 就是 Chromium 156，扩展运行时同源；
2. 即便测了 Chromium，也**仍然不是** Google Chrome 品牌版，结论仍要写「Chrome 未验证」；
3. 会往本机写入约 150MB 浏览器缓存，属于对用户机器的额外改动。

因此本节明确：**「Chrome 兼容性」保持未验证**，但把风险定位到「品牌差异」而非「MV3 支持」。

## 4. 若要真正完成 Chrome 验收

1. 安装 Google Chrome（≥111）；
2. `chrome://extensions` → 开发者模式 → 加载 `dist`；
3. 打开图书馆页面并登录，固定扩展图标，点击打开侧边栏；
4. 确认四项：页面路由、DOM 座位数 152、响应旁路已运行、实时座位数 152。

以上 4 步需要人工完成，无法用脚本替代。

## 5. 结论：Chrome 项以「已评估、未实测、经用户确认接受」关闭

2026-11-02，用户明确决定**不安装 Chrome**，接受以 Edge 156 的实测结果作为浏览器兼容性依据。

因此本项的最终状态是：

| 项 | 状态 |
|---|---|
| Edge / Chromium 内核 | ✅ 已实测（9 项能力，见 §1） |
| Google Chrome 品牌版 | ⬜ **未实测**，经用户确认接受，不作为遗留缺陷 |
| 原生工具栏点击 / 原生侧边栏 | ⬜ 未实测（系统级交互，无法自动化） |

残余风险已定位清楚：**MV3 与 `world: MAIN` 的支持不是风险**（Edge 156 已证），
风险只可能来自 Google 特有的商店/企业策略，与本地加载未打包扩展无关。

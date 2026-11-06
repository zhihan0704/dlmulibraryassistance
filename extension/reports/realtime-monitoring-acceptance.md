# 2.1 实时监听与可靠性验收

验收日期为 2026-11-06（北京时间）。基线 `b9a203ce4e49b011838d2162404065d7667b4902`，本地分支 `feature/2.1-realtime-monitoring`。原独立 `index.html` 保留在工作区。远程发布留待用户决定。

## A. 交付与修改文件

| 范围 | 修改文件（相对于 `extension`） |
| --- | --- |
| 页面及适配 | `src/content/reserve-hook.ts`、`src/content/index.ts`、`src/adapters/dlmu-adapter.ts`、`src/shared/live-monitor.ts` |
| 状态与数据 | `src/core/seat-observation.ts`、`src/core/live-seats.ts`、`src/core/event-monitor.ts` |
| 后台和本地任务 | `src/background/daily-booking-controller.ts`、`src/storage/daily-booking-db.ts` |
| 侧栏 | `src/sidepanel/live-panel.ts`、`src/sidepanel/daily-booking-panel.ts`、`src/sidepanel/main.ts` |
| 测试 | `tests/hook.test.ts`、`tests/seat-observation.test.ts`、`tests/daily-booking-controller.test.ts`、`scripts/e2e-live.mjs`、`scripts/e2e-daily-booking.mjs` |
| 版本与命令 | `manifest.json`、`public/manifest.json`、`package.json`、`package-lock.json` |
| 文档 | `README.md`、`docs/architecture.md`、`docs/live-data-channel.md`、`docs/realtime-monitoring-architecture.md`、`docs/realtime-monitoring-research.md`、本报告 |

## B. 实时监听

XHR 与 fetch 仅观察网页自然产生的精确 GET 响应，转发前裁剪字段，原始网页响应完整返回。捕获编号用于去除缓冲重放，路由变化使旧响应失效。DOM 使用同一观察器处理当前区域，前台时防抖批量读取，忽略不相关节点变更。

Edge 合成用例中，152 个座位及含预约的座位数保持相同，目标座位的 09:00–11:00 改成 10:00–12:00，产生一个座位变化。相同数据重排只更新观察时间，重投同一捕获不增加计数。目标座位 `title` 变化可以单独识别。错误响应保留上次成功样本并标记无有效新鲜度。

侧栏展示 XHR/fetch 计数、捕获时间、DOM 观察时间、目标座位变化、过期和认证状态。所有本机时刻用北京时间显示。服务器更新时间缺少证据，始终单独标为未取得。DLMU WebSocket 和 SSE 支持状态为 `UNKNOWN`。

## C. 可靠性

- MV3 任务设置与阶段领取保存在 IndexedDB。Worker 唤醒重建未来闹钟。浏览器实际启动时仍可在当日尚有效的阶段内检查，错过窗口后不补执行。07:55、08:00、08:01 安排保留。
- 阶段键使用任务、目标日期、座位、时段和阶段。读租约可有限续查。导航和提醒先通过独立的一次性标记领取，改绑与重启不会清除同日的领取记录。两个独立 IndexedDB 连接同时争抢时只有一个取得租约。
- 可见认证跳转或精确 401 持久化读取暂停，保留任务。403 只表示受限和待核验。新鲜、非空、无结构冲突的官方个人预约页面读取才解除暂停，随后重新采集。仅有旧记录、登录后空表或域名命中时继续待核验。
- Windows 同名任务恰有一个。读取结果为 `Ready`，下次 2026-11-07 07:55，`WakeToRun=true`，`InteractiveToken`，`LeastPrivilege`，错过不补跑，`IgnoreNew`。上次结果 `0x41303` 表示尚未运行。启动器只向 Edge 传学校首页 URL，实际配置选择由 Edge 决定。Preview 与 PowerShell 5.1 模拟均通过，实机启动和唤醒待观察。 [Windows 唤醒说明](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-waketorun)
- 可预约性继续为 `UNKNOWN`。现有动态时段算法使用有时区的半开区间，对过期、覆盖不足、身份不匹配、资格或规则缺证的输入拒绝推荐。

## D. 研究

逐一核验 Element Alert、Page Monitor、UCL Library Booker、Library Reservation Bot 和 LibrarySeatReservation 的固定提交、许可证和实际代码。仅参考观察器清理、持久化恢复、时间段约束及事件隔离。参考源码、刷新循环、提交操作和推送协议均未纳入扩展。详见[研究记录及源代码链接](../docs/realtime-monitoring-research.md)。

## E. 测试

| 命令或检查 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| `npm ci` | 安装成功 | 0 | 0 |
| `npm run test` | 123 | 0 | 0 |
| `npm run test:history`（`DLMU_LEGACY_ROOT` 指向原研究目录） | 65 | 0 | 0 |
| `npm run build` | 类型检查与三个构建通过 | 0 | 0 |
| `npm run check` | 16 | 0 | 0 |
| `npm run build:mobile` | 类型检查与构建通过 | 0 | 0 |
| `npm run test:daily:edge` | 8 | 0 | 0 |
| `npm run test:e2e` | 41 | 0 | 0 |
| `npm run test:restart` | 9 | 0 | 0 |
| `npm run test:extension-product` | 11 | 0 | 0 |
| `npm run test:product` | 17 | 0 | 0 |
| `npm run test:mobile` | 13 | 0 | 0 |
| `node scripts/security-scan.mjs` | 65 个文件通过模式检查 | 0 | 0 |

浏览器测试使用隔离配置、本地页面和拦截的合成响应。历史测试只读引用原目录的本机夹具，没有修改或导出原始证据。真实学校账号与预约流程不参与自动测试。

## F. 人工验收

| 项目 | 状态 |
| --- | --- |
| 日常 Edge 配置与学校页被动响应捕获 | PENDING |
| 实际手动刷新后收到新响应 | PENDING |
| 真实座位 DOM 变化触发 | PENDING |
| 真实人工登录恢复与个人预约复核 | PENDING |
| 2026-11-07 07:55 启动、配置选择和睡眠唤醒 | PENDING |

[日常 Edge 操作步骤](../docs/live-data-channel.md)

## G. 生产状态

辅助模式，正式自动提交禁用。权限、目标主机范围与 `connect-src 'none'` 保持原配置。监听未新增独立请求、服务器连接或自动刷新。保留原 2.0 辅助导航。此次验收仅使用合成预约数据，未触及真实预约、取消、签到或暂离。

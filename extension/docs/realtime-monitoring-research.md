# 2.1 实时监听技术研究

核验日期为 2026-11-06（北京时间）。以下 GitHub 版本以本轮浅克隆的 HEAD 为准，日期为对应提交的提交者日期。逐一用 `git ls-tree` 核查许可证文件，并用 `git show HEAD:<path>` 阅读固定版本源码。提交日期仅表示本次读到的维护快照。源码只用于设计对照，未执行参考项目或读取其个人配置。

## 参考项目的代码证据

| 项目与版本 | 许可证核验 | 实际代码与局限 | 本轮采用 |
| --- | --- | --- | --- |
| Element Alert，`24bdf956d80552ed1de0874539b8914317d42ead`，2025-10-25 | 提交树根目录的 [LICENSE](https://github.com/tomohiro-owada/element-alert/blob/24bdf956d80552ed1de0874539b8914317d42ead/LICENSE) 为 MIT | 每条匹配 URL 的规则用自身 selector 找目标节点，按规则 ID 保留上次 `textContent`，变化后通知并更新比较值。停止时断开观察器及清除定时器。后台通知历史最多保留 50 条。该实现还对每条规则周期检查 DOM，并跨脚本发送原始新旧文本。 [监听与停止](https://github.com/tomohiro-owada/element-alert/blob/24bdf956d80552ed1de0874539b8914317d42ead/content-v2.js#L49-L170) · [通知历史](https://github.com/tomohiro-owada/element-alert/blob/24bdf956d80552ed1de0874539b8914317d42ead/background.js#L160-L173) | 借鉴按身份保存比较基线和生命周期清理。共享已有 DOM 观察器，按座位进行字段比较和防抖。变化通知只传身份与时刻，周期检查及原文转发不纳入。 |
| Page Monitor，`5888c49aa599054534e1b33835eef69bc91830e6`，2026-09-15 | 提交树根目录的 [LICENSE](https://github.com/kingwatam/page-monitor/blob/5888c49aa599054534e1b33835eef69bc91830e6/LICENSE) 为 MIT | `chrome.storage.local` 保存监控项、暂停状态及 busy 标记。`onAlarm` 找到监控项后解析标签页并触发重新加载。`onStartup` 读取保存配置和重建 Alarm，也会重新加载已存在标签。先读后写的 busy 标记没有原子领取保证。 [Alarm 分发](https://github.com/kingwatam/page-monitor/blob/5888c49aa599054534e1b33835eef69bc91830e6/background.js#L60-L75) · [启动恢复](https://github.com/kingwatam/page-monitor/blob/5888c49aa599054534e1b33835eef69bc91830e6/background.js#L260-L286) | 借鉴持久化配置和启动恢复。阶段唯一键与 IndexedDB 事务承担幂等，学校页面刷新仍由用户发起。 |
| UCL Library Booker，`635eb8e611e2768f25f8985b8feec6697a660e2c`，2026-05-06 | 递归检查该提交树，未见 `LICENSE`、`COPYING` 或 `NOTICE`，未确认源码授权 | Playwright 使用配置目录启动持久浏览器上下文。可用时段先从页面提取，再以该站 30 分钟步长检查连续性。单窗口选择先按较长时长再按较早起点排序。多窗口计划包含剩余次数和配额的搜索状态。 [持久上下文](https://github.com/MuhammadMaazA/librarybot/blob/635eb8e611e2768f25f8985b8feec6697a660e2c/src/booker.js#L389-L400) · [单窗口排序](https://github.com/MuhammadMaazA/librarybot/blob/635eb8e611e2768f25f8985b8feec6697a660e2c/src/booker.js#L1541-L1572) · [连续性及计划](https://github.com/MuhammadMaazA/librarybot/blob/635eb8e611e2768f25f8985b8feec6697a660e2c/src/booker.js#L1669-L1745) | 仅参考先验证连续覆盖再比较候选的结构。沿用本项目已经存在的时间轴和资格门槛，时段建议保持同一座位和用户时长。独立浏览器配置、自动流程、UCL 配额及 30 分钟步长不纳入。 |
| Library Reservation Bot，`c647212d32f7146ca98b226b2f788ce98782bf87`，2026-07-25 | 递归检查该提交树，未见 `LICENSE`、`COPYING` 或 `NOTICE`，未确认源码授权 | Python 用 `ZoneInfo` 计算下一次 08:00，由进程睡眠到下一阶段，再执行单次任务。执行过程中区分找不到按钮与 Playwright 超时，分别发 Telegram 通知，最终关闭浏览器上下文。提交步骤后发送成功文字，源码同时提示检查页面或邮件，尚不足以证明服务器最终确认。 [日程计算](https://github.com/PGL7/library-reservation-bot/blob/c647212d32f7146ca98b226b2f788ce98782bf87/library_reservation_bot.py#L55-L66) · [超时与收尾](https://github.com/PGL7/library-reservation-bot/blob/c647212d32f7146ca98b226b2f788ce98782bf87/library_reservation_bot.py#L302-L358) | 仅参考阶段化任务、超时区分和本地提醒。日程仍按本项目既有安排，人工核对结果来源。进程常驻等待、自动登录、提交、第三方通知及整页截图不纳入。 |
| LibrarySeatReservation，`14230f105f2f8a023e02c1922145e014d30ca660`，2022-01-14 | 递归检查该提交树，未见 `LICENSE`、`COPYING` 或 `NOTICE`，未确认源码授权 | Angular 队列服务使用 RxJS WebSocket 连接自有网关。Java 网关 `/queue` 维护加入时间及会话集合，通知队列人数变化。后台另外通过 RSocket 给管理员页面发送数据库变化，预约 DAO 以数据库查询做日聚合。前端、网关及后端均由项目控制。 [队列客户端](https://github.com/n3d1117/LibrarySeatReservation/blob/14230f105f2f8a023e02c1922145e014d30ca660/frontend/src/app/services/queue.service.ts) · [网关](https://github.com/n3d1117/LibrarySeatReservation/blob/14230f105f2f8a023e02c1922145e014d30ca660/gateway/src/main/java/queue/QueueSocketHandler.java) · [RSocket 通知](https://github.com/n3d1117/LibrarySeatReservation/blob/14230f105f2f8a023e02c1922145e014d30ca660/backend/src/main/java/rsocket/RSocketNotifier.java) · [日聚合](https://github.com/n3d1117/LibrarySeatReservation/blob/14230f105f2f8a023e02c1922145e014d30ca660/backend/src/main/java/dao/ReservationDao.java#L89-L110) | 仅参考事件通道与存量快照分离的架构。自有网关、队列协议、管理员连接和服务端聚合依赖站点控制权，不纳入扩展。 |

MIT 项目只作为技术参考。本轮未引入这些项目的代码或新依赖。其余三个项目的公开可读性不能作为源码再分发授权。

## 技术选择对照

| 技术 | 原理 | 优点 | 局限 | 2.1 决策 |
| --- | --- | --- | --- | --- |
| XHR/fetch 被动旁路 | 在页面已有请求的成功响应上读取白名单数据，在 MAIN world 过滤后交给 ISOLATED world 校验 | 能保留座位及时间段结构，不增加学校请求 | 依赖页面自然产生的 `GET /ic-web/reserve`，不能保证到达频率或完整时段覆盖 | 主通道。逐座位比较身份和原始字段，按本机捕获时刻判断新鲜度。 |
| `MutationObserver` | 浏览器将目标 DOM 的节点和属性变化送到观察回调 | 页面发生变化时快速响应，无网络开销 | 仅反映页面视图。重排、无关节点和格式变化会产生噪声，颜色和标题不能证明预约资格 | 第二通道。相关节点过滤、防抖、字段规范化、路由隔离和观察器生命周期清理。 [MDN MutationObserver](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver) |
| WebSocket | 双向持久连接，应用处理消息和连接生命周期 | 若官方提供接口，可由服务器及时发出变化 | 依赖服务器支持及消息契约，传统 API 不提供自动背压 | DLMU 未证实，保持待核验。无新增连接。 [MDN WebSocket](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket) |
| SSE | `EventSource` 读取服务器单向推送的事件流 | 适合单向更新和简单事件通知 | 需要官方事件流端点及事件数据契约 | DLMU 未证实，保持待核验。无新增连接。 [MDN Server-sent events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events) |
| 自适应轮询 | 根据响应状态调整主动读取间隔 | 在已有明确接口许可时，可覆盖不主动更新的页面 | 每次主动请求都占用资源，受频率限制、会话和恢复状态约束 | 本轮仅研究。未来需获得允许的接口及频率依据，使用请求总量上限、指数退避、随机抖动，并遵循 `429` 的可选 `Retry-After`。 [MDN 429](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status/429) |
| 页面刷新 | 重新加载页面，由学校网页发起其原有数据读取 | 用户可自主触发一次新读取 | 可能中断表单或登录，重复刷新增加请求 | 由用户操作。侧栏读取已捕获数据不能算服务器刷新。 |

## 浏览器与操作系统的约束

- Content script 的 ISOLATED world 和页面脚本变量隔离，双方仍可访问同一 DOM。读取页面原有响应需要最小 MAIN world 旁路。进入 ISOLATED world 的消息按来源、路由、时刻和结构再次校验，收到页面消息本身不能证明预约结果。 [Chrome Content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- MV3 Service Worker 可在空闲时终止，进程全局变量会随之丢失。状态恢复以 IndexedDB 记录和可重建的命名 Alarm 为准。事件到达后应验证期限、事务领取状态及是否已经处理。 [Chrome Service Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
- Chrome Alarm 不负责把睡眠设备唤醒。设备恢复后，错过的 Alarm 可能被补发，重复 Alarm 不会重放全部期间。`persistAcrossSessions` 有浏览器和版本限制，启动时重新核对关键 Alarm 比依赖此选项可靠。实时监听使用页面事件，不靠高频 Alarm 保活。 [Chrome Alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)
- Windows 任务计划的 `WakeToRun` 表达在任务执行时唤醒的设置。唤醒时屏幕可能仍关着。系统设置和实际机器条件须通过实机观察确认，任务 XML 或脚本 Preview 不能证明 2026-11-07 07:55 已真实唤醒。 [Microsoft TaskSettings.WakeToRun](https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-waketorun)

## DLMU 的证据边界

现有项目资料和代码能够支持对学校页面原有 `GET /ic-web/reserve` 的观察，以及对已经渲染的座位 DOM 的比较。现有记录没有可复核的学校 WebSocket 握手、SSE 流或消息格式证据，结论为 `UNKNOWN`，不等同于学校一定未提供这些协议。本轮未探测学校地址或创建连接。 [现有通道说明](live-data-channel.md)

响应捕获时间和 DOM 观察时间均由客户端记录。只有取得可信服务器时间戳才可标注服务器更新时间。座位数量不变不能证明座位状态没变，空预约列表、颜色和原始状态码也不能单独证明可以预约。使用完整日期、明确偏移及半开区间处理可核验时间轴。数据过期、覆盖不足、资格不明或规则冲突时应保留 `UNKNOWN` 或 `NEEDS_REVIEW`。 [2.1 架构](realtime-monitoring-architecture.md)

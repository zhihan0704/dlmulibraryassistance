# 扩展与移动端架构

扩展在 Edge 或 Chromium 中运行，移动网页在浏览器中独立运行。两端使用二维码或 JSON 交接最少预约字段，各自保存本地数据。移动网页没有图书馆认证能力。历史座位快照、模拟任务和当前页面观察各有独立来源。

| 模块 | 实际职责 |
| --- | --- |
| `reserve-hook.ts` | MAIN world 被动观察学校页面的既有 XHR 与 fetch 响应，在发送前裁剪字段 |
| `content/index.ts`、`DlmuAdapter` | 隔离环境校验当前路由、解析可见座位与个人预约、维护本标签的网络和 DOM 观察 |
| `seat-observation.ts` | 按座位比较字段、去重、判断新鲜度和会话状态 |
| `live-panel.ts` | 读取当前标签缓存，展示观察来源、时间、错误、座位和变化 |
| `daily-booking-controller.ts`、`daily-booking-db.ts` | 每日提醒、浏览器闹钟重建、辅助核对、会话暂停和事务去重 |
| `product-controller.ts`、`product-db.ts` | 本地预约与现场签到准备、二维码交接、提醒和核验历史 |
| `alarm-manager.ts`、`task-manager.ts` | 历史本地模拟预约流程和测试 |

每日任务使用北京时间 07:55、08:00、08:01 的单次浏览器闹钟，按次日使用日期计算。Windows 任务请求在 07:55 打开学校首页。两者的唤醒条件独立。Worker 重启从 IndexedDB 读设置和领取记录，并重建未来闹钟。

当前为辅助模式。预约资格与时段规则仍需学校证据。空档算法按 `[start,end)` 计算，要求可信来源、完整覆盖、新鲜度和已核验规则。现有响应没有提供足够证据用于动态推荐。详见[实时监听架构](realtime-monitoring-architecture.md)与[数据通道](live-data-channel.md)。

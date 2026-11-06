# architecture

Side Panel → runtime 消息 → Service Worker 串行任务队列 → chrome.storage.local / chrome.alarms。Content Script 仅在精确目标源响应页面快照；不改 DOM。页面到真实接口链路未实现。模拟引擎完全本地运行。

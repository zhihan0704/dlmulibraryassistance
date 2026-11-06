# 日常 Edge 配置与每日启动

在平时使用的 Microsoft Edge 窗口打开 `edge://extensions`。开启开发人员模式后选择「加载解压缩的扩展」，选中构建产物中的 `dist` 目录。可以把扩展固定到工具栏。需要登录学校时，请在这个 Edge 配置的官方网页中人工完成登录。扩展入口会在同一个 Edge 配置里读取当前页面可见的预约数据。

启动器会用 Edge 的常规启动方式打开 [学校预约首页](https://seats.dlmu.edu.cn/#/ic/home)。同一配置已有进程时，Edge 通常会接收这次打开页面的请求。安装了多个 Edge 配置时，实际窗口和标签由 Edge 的配置选择行为决定。请核对打开窗口的头像和扩展图标，并让日常配置作为常规入口。任务动作只负责启动浏览器，扩展的页面处理仍须满足其本身的验证条件。

## 预览和安装

把扩展包解压到准备长期保留的位置。从仓库根目录打开 Windows PowerShell 后，先查看触发时间和唤醒设置。

```powershell
powershell.exe -NoLogo -NoProfile -File .\extension\scripts\Register-DailyEdgeTask.ps1 -Preview
```

确认 `FirstShanghai` 是下一次北京时间 07:55 后，用正在使用 Edge 的 Windows 用户执行注册。

```powershell
powershell.exe -NoLogo -NoProfile -File .\extension\scripts\Register-DailyEdgeTask.ps1
```

任务名称为 `DLMU Library Assistant 2.0 Daily Edge`。任务在该用户的交互登录会话中以普通权限运行。注册后不要移动安装目录。需要移动时，先移除任务，在新目录重新执行注册。

触发点保存为 UTC 的 23:55，对应下一天的北京时间 07:55。任务引擎以 UTC 偏移解释触发点。启动器再独立核对北京时间和首次触发点，允许的时间窗口从 07:55:00 到 08:00:59。错过计划启动不会自动补跑。同一天只会发起一次 Edge 启动请求。标记文件存放在 `%LOCALAPPDATA%\DLMULibraryAssistance\daily-edge-opened.txt`，内容只有北京时间日期。[Microsoft Task Scheduler 时间偏移说明](https://learn.microsoft.com/en-us/windows/win32/api/taskschd/nf-taskschd-itrigger-get_startboundary)

默认申请睡眠唤醒。实际唤醒取决于设备固件、当前睡眠状态、电源计划和 Windows 唤醒计时器。运行时需要用户仍处于登录状态。希望仅在电脑本来就醒着时尝试启动，可用 `-NoWake` 重新注册。

```powershell
powershell.exe -NoLogo -NoProfile -File .\extension\scripts\Register-DailyEdgeTask.ps1 -NoWake
```

## 核对状态和移除

```powershell
Get-ScheduledTask -TaskName 'DLMU Library Assistant 2.0 Daily Edge'
Get-ScheduledTaskInfo -TaskName 'DLMU Library Assistant 2.0 Daily Edge'
Export-ScheduledTask -TaskName 'DLMU Library Assistant 2.0 Daily Edge'
```

任务的 `NextRunTime` 按本机时区显示。导出的 XML 中应能找到 UTC `StartBoundary`、`InteractiveToken` 和 `LeastPrivilege`。在允许时间外手动运行任务时，启动器会退出，正常情况不会弹出浏览器。真实的页面和登录状态在下一次触发后从 Edge 中检查。

```powershell
powershell.exe -NoLogo -NoProfile -File .\extension\scripts\Remove-DailyEdgeTask.ps1
```

移除仅作用于本应用和当前用户匹配的同名任务。Windows 或学校设备策略拒绝脚本或任务注册时，请保留系统策略并联系设备管理员核对。

## 开发验证

```powershell
pwsh.exe -NoLogo -NoProfile -File .\extension\scripts\Test-DailyEdgeTask.ps1
```

测试用临时标记和模拟进程调用覆盖时区偏移、日期切换、时间窗口、注册参数、重复启动和失败回滚。测试不注册任务，不打开 Edge，也不向学校发送请求。

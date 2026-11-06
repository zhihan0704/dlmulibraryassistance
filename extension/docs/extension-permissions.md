# 1.0.0 扩展权限

storage保存原模拟任务/偏好；alarms安排本地提醒；sidePanel呈现界面；activeTab在用户打开扩展后读取当前标签；notifications显示本机提醒。host_permissions和content_scripts仅https://seats.dlmu.edu.cn/*。不申请Cookie、history、downloads或所有网站权限。扩展页面connect-src none，PWA仅自身静态资源网络访问。SSO域不额外注入脚本。

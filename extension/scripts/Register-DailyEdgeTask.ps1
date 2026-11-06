[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Preview,
    [switch]$NoWake
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DailyEdge.psm1') -Force
$sid = Get-DlmuCurrentSid
$launcher = (Get-Item -LiteralPath (Join-Path $PSScriptRoot 'Open-DailyEdge.ps1')).FullName
$powerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShell -PathType Leaf)) {
    throw '此计划任务需要 Windows PowerShell 5.1。'
}
$plan = New-DlmuTaskPlan -Launcher $launcher -PowerShell $powerShell -Sid $sid -Wake (-not $NoWake)
if ($Preview) {
    return $plan
}
Get-DlmuEdgePath | Out-Null
$existing = Get-ScheduledTask -TaskName $plan.Name -TaskPath $plan.Path -ErrorAction SilentlyContinue
if ($existing -and -not (Test-DlmuOwnedTask -Task $existing -Sid $sid)) {
    throw '发现其他任务使用相同名称，已保留该任务。请在任务计划程序中核对后再安装。'
}
if ($PSCmdlet.ShouldProcess($plan.Name, '注册或更新每天北京时间 07:55 启动 Edge 的任务')) {
    Register-ScheduledTask -TaskName $plan.Name -TaskPath $plan.Path -Xml $plan.Xml -Force:([bool]$existing) -ErrorAction Stop | Out-Null
    Get-ScheduledTask -TaskName $plan.Name -TaskPath $plan.Path |
        Select-Object TaskName, TaskPath, State, @{Name='FirstShanghai';Expression={$plan.FirstShanghai}}, @{Name='WakeToRun';Expression={$plan.Wake}}
}

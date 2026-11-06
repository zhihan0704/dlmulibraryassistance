[CmdletBinding(SupportsShouldProcess)]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DailyEdge.psm1') -Force
$identity = Get-DlmuTaskIdentity
$existing = Get-ScheduledTask -TaskName $identity.Name -TaskPath $identity.Path -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Output '当前未注册此计划任务。'
    return
}
if (-not (Test-DlmuOwnedTask -Task $existing -Sid (Get-DlmuCurrentSid))) {
    throw '同名任务不属于本应用或当前用户，已保留该任务。'
}
if ($PSCmdlet.ShouldProcess($identity.Name, '移除本应用的每日 Edge 启动任务')) {
    Unregister-ScheduledTask -TaskName $identity.Name -TaskPath $identity.Path -Confirm:$false -ErrorAction Stop
}

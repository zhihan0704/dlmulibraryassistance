[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DailyEdge.psm1') -Force

function Assert-Equal($Actual, $Expected, [string]$Message) {
    if ($Actual -cne $Expected) {
        throw "$Message. Expected [$Expected], got [$Actual]."
    }
}

$invariant = [Globalization.CultureInfo]::InvariantCulture
function Test-Instant([string]$Iso) {
    [DateTimeOffset]::Parse($Iso, $invariant)
}
$before = Test-Instant '2026-11-05T23:54:59Z'
$open = Test-Instant '2026-11-05T23:55:00Z'
$last = Test-Instant '2026-11-06T00:00:59Z'
$cutoff = Test-Instant '2026-11-06T00:01:00Z'
Assert-Equal (Test-DlmuLaunchWindow -Now $before) $false '07:54:59 is outside launch window'
Assert-Equal (Test-DlmuLaunchWindow -Now $open) $true '07:55:00 starts launch window'
Assert-Equal (Test-DlmuLaunchWindow -Now $last) $true '08:00:59 is in launch window'
Assert-Equal (Test-DlmuLaunchWindow -Now $cutoff) $false '08:01:00 is outside launch window'
Assert-Equal (Test-DlmuLaunchWindow -Now (Test-Instant '2026-11-05T18:55:00-05:00')) $true 'Timezone-offset instant resolves to same Shanghai window'

$common = @{
    Launcher = 'C:\Applications & Tools\extension\scripts\Open-DailyEdge.ps1'
    PowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
    Sid = 'S-1-5-21-100-200-300-1000'
}
$plan = New-DlmuTaskPlan @common -Now $before
Assert-Equal $plan.StartBoundaryUtc '2026-11-05T23:55:00Z' 'UTC calendar boundary'
Assert-Equal $plan.FirstShanghai '2026-11-06 07:55:00 +08:00' 'Displayed first trigger in Shanghai'
Assert-Equal (New-DlmuTaskPlan @common -Now $open).StartBoundaryUtc '2026-11-06T23:55:00Z' 'Registration after trigger starts tomorrow'
Assert-Equal (New-DlmuTaskPlan @common -Now (Test-Instant '2026-11-05T18:54:59-05:00')).StartBoundaryUtc $plan.StartBoundaryUtc 'Host timezone offset cannot move the schedule'
[xml]$parsed = $plan.Xml
Assert-Equal $parsed.Task.Triggers.CalendarTrigger.ScheduleByDay.DaysInterval '1' 'Daily recurrence'
Assert-Equal $parsed.Task.Principals.Principal.UserId $common.Sid 'Task bound to current user'
Assert-Equal $parsed.Task.Principals.Principal.LogonType 'InteractiveToken' 'Interactive login only'
Assert-Equal $parsed.Task.Principals.Principal.RunLevel 'LeastPrivilege' 'No elevated task'
Assert-Equal $parsed.Task.Settings.WakeToRun 'true' 'Wake default'
Assert-Equal $parsed.Task.Settings.StartWhenAvailable 'false' 'Late boot does not backfill missed trigger'
Assert-Equal $parsed.Task.Settings.MultipleInstancesPolicy 'IgnoreNew' 'Concurrent action is ignored'
Assert-Equal $parsed.Task.Actions.Exec.WorkingDirectory 'C:\Applications & Tools\extension\scripts' 'XML special character escaping'
Assert-Equal $parsed.Task.Actions.Exec.Arguments ('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $common.Launcher + '" -NotBeforeUtc 2026-11-05T23:55:00Z') 'Exact action arguments'
[xml]$noWake = (New-DlmuTaskPlan @common -Now $before -Wake $false).Xml
Assert-Equal $noWake.Task.Settings.WakeToRun 'false' 'Wake preference'
$identity = Get-DlmuTaskIdentity
$owned = [pscustomobject]@{ TaskName = $identity.Name; TaskPath = $identity.Path; Description = $identity.Description; Principal = [pscustomobject]@{UserId = $common.Sid} }
Assert-Equal (Test-DlmuOwnedTask -Task $owned -Sid $common.Sid) $true 'Own task can update or remove'
$owned.Description = 'Unrelated task'
Assert-Equal (Test-DlmuOwnedTask -Task $owned -Sid $common.Sid) $false 'Unrelated same-name task is protected'

# Synthetic time, isolated temporary marker and mock process launcher. The school receives zero requests.
$testId = [guid]::NewGuid().ToString('N')
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('dlmu-task-test-' + $testId)
$launches = New-Object System.Collections.ArrayList
$mock = @{
    StateDirectory = $testRoot
    MutexName = 'Local\DLMUTest-' + $testId
    ResolveEdge = { 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' }.GetNewClosure()
    Launch = {
        param($Path, $Url)
        [void]$launches.Add(@($Path, $Url))
    }.GetNewClosure()
}
try {
    Assert-Equal (Invoke-DlmuDailyEdge @mock -Now $cutoff) 'OUTSIDE_SHANGHAI_WINDOW' 'Cutoff skips process launch'
    Assert-Equal (Invoke-DlmuDailyEdge @mock -Now $open -NotBeforeUtc '2026-11-06T23:55:00Z') 'BEFORE_FIRST_TRIGGER' 'Task cannot run a day before its first trigger'
    Assert-Equal (Invoke-DlmuDailyEdge @mock -Now $open) 'EDGE_LAUNCH_REQUESTED' 'Launch allowed at trigger'
    Assert-Equal (Invoke-DlmuDailyEdge @mock -Now $last) 'ALREADY_OPENED_TODAY' 'Duplicate on same Shanghai day suppressed'
    Assert-Equal $launches.Count 1 'Exactly one mock launch'
    Assert-Equal $launches[0][0] 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe' 'Launch uses normal Edge'
    Assert-Equal $launches[0][1] 'https://seats.dlmu.edu.cn/#/ic/home' 'Only argument is the official homepage'
    $next = $open.AddDays(1)
    $failing = $mock.Clone()
    $failing.Launch = { throw 'Mock Edge launch failure' }
    $rejected = $false
    try { Invoke-DlmuDailyEdge @failing -Now $next }
    catch { $rejected = $_.Exception.Message -eq 'Mock Edge launch failure' }
    Assert-Equal $rejected $true 'Process failure is propagated'
    Assert-Equal (Invoke-DlmuDailyEdge @mock -Now $next) 'EDGE_LAUNCH_REQUESTED' 'Failure marker rolls back and next day may run'
    Assert-Equal $launches.Count 2 'Two successful mock launches over two dates'
}
finally {
    $marker = Join-Path $testRoot 'daily-edge-opened.txt'
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker }
    if (Test-Path -LiteralPath $testRoot) { Remove-Item -LiteralPath $testRoot }
}
'PASS: Shanghai trigger, cutoff, wake configuration, ownership protection, safe arguments, launch deduplication and failure rollback. No task or browser started.'

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskName = 'DLMU Library Assistant 2.0 Daily Edge'
$script:TaskDescription = 'DLMU Library Assistant 2.0 / daily-edge / official homepage'
$script:OfficialHome = 'https://seats.dlmu.edu.cn/#/ic/home'
$script:Invariant = [Globalization.CultureInfo]::InvariantCulture
$script:UtcFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"

function Get-DlmuShanghaiTime {
    param([Parameter(Mandatory)][DateTimeOffset]$Instant)
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    [TimeZoneInfo]::ConvertTime($Instant, $zone)
}

function Get-DlmuNextBoundary {
    param([DateTimeOffset]$Now = [DateTimeOffset]::UtcNow)
    $local = Get-DlmuShanghaiTime -Instant $Now
    $candidate = $local.Date.AddHours(7).AddMinutes(55)
    if ($local.DateTime -ge $candidate) {
        $candidate = $candidate.AddDays(1)
    }
    $zone = [TimeZoneInfo]::FindSystemTimeZoneById('China Standard Time')
    [TimeZoneInfo]::ConvertTimeToUtc($candidate, $zone)
}

function Test-DlmuLaunchWindow {
    param([Parameter(Mandatory)][DateTimeOffset]$Now)
    $time = (Get-DlmuShanghaiTime -Instant $Now).TimeOfDay
    $time -ge [TimeSpan]::FromMinutes(475) -and $time -lt [TimeSpan]::FromMinutes(481)
}

function Get-DlmuCurrentSid {
    [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
}

function Get-DlmuEdgePath {
    $roots = @(${env:ProgramFiles(x86)}, $env:ProgramFiles, $env:LOCALAPPDATA)
    foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
        $candidate = Join-Path $root 'Microsoft\Edge\Application\msedge.exe'
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Get-Item -LiteralPath $candidate).FullName
        }
    }
    throw '未找到正常安装的 Microsoft Edge。请先安装 Edge，再运行计划任务。'
}

function Get-DlmuStateDirectory {
    if (-not $env:LOCALAPPDATA) {
        throw '无法定位当前 Windows 用户的本地应用数据目录。'
    }
    Join-Path $env:LOCALAPPDATA 'DLMULibraryAssistance'
}

function Get-DlmuTaskIdentity {
    [pscustomobject]@{ Name = $script:TaskName; Path = '\'; Description = $script:TaskDescription }
}

function Test-DlmuOwnedTask {
    param([Parameter(Mandatory)]$Task, [Parameter(Mandatory)][string]$Sid)
    if ($Task.TaskName -ne $script:TaskName -or $Task.TaskPath -ne '\' -or $Task.Description -ne $script:TaskDescription) {
        return $false
    }
    $principal = [string]$Task.Principal.UserId
    if ($principal -eq $Sid) {
        return $true
    }
    try {
        $account = New-Object Security.Principal.NTAccount($principal)
        return $account.Translate([Security.Principal.SecurityIdentifier]).Value -eq $Sid
    }
    catch {
        return $false
    }
}

function New-DlmuTaskPlan {
    param(
        [Parameter(Mandatory)][string]$Launcher,
        [Parameter(Mandatory)][string]$PowerShell,
        [Parameter(Mandatory)][string]$Sid,
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [bool]$Wake = $true
    )
    $identity = Get-DlmuTaskIdentity
    $start = Get-DlmuNextBoundary -Now $Now
    $boundary = $start.ToString($script:UtcFormat, $script:Invariant)
    $arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -File "{0}" -NotBeforeUtc {1}' -f $Launcher, $boundary
    $commandXml = [Security.SecurityElement]::Escape($PowerShell)
    $argumentsXml = [Security.SecurityElement]::Escape($arguments)
    $workingXml = [Security.SecurityElement]::Escape((Split-Path -Parent $Launcher))
    $sidXml = [Security.SecurityElement]::Escape($Sid)
    $wakeXml = $Wake.ToString().ToLowerInvariant()
    $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>$($identity.Description)</Description>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$boundary</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="InteractiveUser">
      <UserId>$sidXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <WakeToRun>$wakeXml</WakeToRun>
    <ExecutionTimeLimit>PT2M</ExecutionTimeLimit>
  </Settings>
  <Actions Context="InteractiveUser">
    <Exec>
      <Command>$commandXml</Command>
      <Arguments>$argumentsXml</Arguments>
      <WorkingDirectory>$workingXml</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
    [pscustomobject]@{
        Name = $identity.Name
        Path = $identity.Path
        StartBoundaryUtc = $boundary
        FirstShanghai = (Get-DlmuShanghaiTime -Instant ([DateTimeOffset]$start)).ToString('yyyy-MM-dd HH:mm:ss zzz', $script:Invariant)
        Wake = $Wake
        Url = $script:OfficialHome
        Xml = $xml
    }
}

function Invoke-DlmuDailyEdge {
    param(
        [DateTimeOffset]$Now = [DateTimeOffset]::UtcNow,
        [string]$NotBeforeUtc,
        [string]$StateDirectory = (Get-DlmuStateDirectory),
        [string]$MutexName = ('Local\DLMULibraryAssistance-DailyEdge-' + (Get-DlmuCurrentSid)),
        [scriptblock]$Launch = {
            param($Path, $Url)
            Start-Process -FilePath $Path -ArgumentList $Url -ErrorAction Stop
        },
        [scriptblock]$ResolveEdge = { Get-DlmuEdgePath }
    )
    if ($NotBeforeUtc) {
        $format = [Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal
        $boundary = [DateTimeOffset]::ParseExact($NotBeforeUtc, $script:UtcFormat, $script:Invariant, $format)
        if ($Now -lt $boundary) {
            return 'BEFORE_FIRST_TRIGGER'
        }
    }
    if (-not (Test-DlmuLaunchWindow -Now $Now)) {
        return 'OUTSIDE_SHANGHAI_WINDOW'
    }

    $mutex = New-Object Threading.Mutex($false, $MutexName)
    $held = $false
    try {
        try {
            $held = $mutex.WaitOne(500)
        }
        catch [Threading.AbandonedMutexException] {
            $held = $true
        }
        if (-not $held) {
            return 'OTHER_LAUNCH_IN_PROGRESS'
        }
        $day = (Get-DlmuShanghaiTime -Instant $Now).ToString('yyyy-MM-dd', $script:Invariant)
        $marker = Join-Path $StateDirectory 'daily-edge-opened.txt'
        $previous = $null
        if (Test-Path -LiteralPath $marker -PathType Leaf) {
            $previous = [IO.File]::ReadAllText($marker).Trim()
            if ($previous -eq $day) {
                return 'ALREADY_OPENED_TODAY'
            }
            $savedDay = [DateTime]::ParseExact($previous, 'yyyy-MM-dd', $script:Invariant)
            if ($savedDay -gt [DateTime]::ParseExact($day, 'yyyy-MM-dd', $script:Invariant)) {
                throw '启动日期标记晚于当前北京时间，请核对 Windows 时钟。'
            }
        }
        $edge = & $ResolveEdge
        [IO.Directory]::CreateDirectory($StateDirectory) | Out-Null
        [IO.File]::WriteAllText($marker, $day)
        try {
            # Without a profile or window override, Edge handles its usual profile selection and process reuse.
            & $Launch $edge $script:OfficialHome
        }
        catch {
            if ($null -eq $previous) {
                [IO.File]::Delete($marker)
            }
            else {
                [IO.File]::WriteAllText($marker, $previous)
            }
            throw
        }
        return 'EDGE_LAUNCH_REQUESTED'
    }
    finally {
        if ($held) {
            $mutex.ReleaseMutex()
        }
        $mutex.Dispose()
    }
}

Export-ModuleMember -Function Get-DlmuShanghaiTime, Get-DlmuNextBoundary, Test-DlmuLaunchWindow, Get-DlmuCurrentSid, Get-DlmuEdgePath, Get-DlmuTaskIdentity, Test-DlmuOwnedTask, New-DlmuTaskPlan, Invoke-DlmuDailyEdge

[CmdletBinding()]
param([string]$NotBeforeUtc)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'DailyEdge.psm1') -Force
Invoke-DlmuDailyEdge -NotBeforeUtc $NotBeforeUtc

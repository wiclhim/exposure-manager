param([Parameter(Mandatory)][string]$ProfileDirectory)

$ErrorActionPreference = 'Stop'
$taipei = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8))
if ($taipei.DayOfWeek -in 'Saturday','Sunday' -or
    $taipei.TimeOfDay -lt [TimeSpan]'09:03' -or $taipei.TimeOfDay -ge [TimeSpan]'13:30') { return }

$taskName = 'Exposure Manager - Shioaji Quotes'
$task = Get-ScheduledTask -TaskName $taskName
if ($task.State -eq 'Disabled') { return }
$info = Get-ScheduledTaskInfo -InputObject $task
if ($info.LastRunTime -gt (Get-Date).AddMinutes(-2)) { return }

$logPath = Join-Path $ProfileDirectory 'watchdog.log'
$logFile = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
if ($logFile -and $logFile.LastWriteTimeUtc -gt $taipei.UtcDateTime.AddMinutes(-15)) { return }

$symbols = @('0050', 'IX0001')
$snapshot = $null
try {
    $snapshot = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/quotes?symbols=0050,IX0001' -TimeoutSec 4
} catch {
    # A stuck or stopped relay may not respond on loopback.
}
$cutoff = $taipei.AddMinutes(-3).ToUnixTimeMilliseconds()
$quotes = @($snapshot.quotes | Where-Object { $_.symbol -in $symbols })
$fresh = $quotes | Where-Object { $_.quoteTime -ge $cutoff }
if ($snapshot.state -eq 'connected' -and $fresh) { return }

if ($logFile -and $logFile.Length -ge 65536) {
    Move-Item -LiteralPath $logPath -Destination (Join-Path $ProfileDirectory 'watchdog.log.1') -Force
}
$reason = if (!$snapshot) { 'relay unavailable' } elseif ($snapshot.state -eq 'login_error') { 'broker login failed' } else { 'benchmarks stale' }
Add-Content -LiteralPath $logPath -Value "$($taipei.ToString('o')) restarting relay ($reason)" -Encoding UTF8

# Keep the latest benchmark prices available while the new session connects.
$configPath = Join-Path $ProfileDirectory 'tailscale.json'
if ($quotes.Count -and (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    try {
        $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $latest = @((@($config.previous_quotes) + $quotes) |
            Where-Object { $_.symbol -in $symbols } |
            Sort-Object quoteTime -Descending | Group-Object symbol |
            ForEach-Object { $_.Group[0] })
        $config | Add-Member -Force -NotePropertyName previous_quotes -NotePropertyValue $latest
        $tempPath = Join-Path $ProfileDirectory 'tailscale.watchdog.tmp'
        [IO.File]::WriteAllText($tempPath, ($config | ConvertTo-Json -Compress -Depth 6), [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($tempPath, $configPath, [NullString]::Value)
    } catch {
        Add-Content -LiteralPath $logPath -Value "$($taipei.ToString('o')) could not save benchmark cache" -Encoding UTF8
    }
}

if ($task.State -eq 'Running') {
    Stop-ScheduledTask -InputObject $task
    Start-Sleep -Milliseconds 800
}
$listener = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
    $relayPath = Join-Path $PSScriptRoot 'shioaji-feed.py'
    if ($owner.Name -ne 'python.exe' -or !$owner.CommandLine -or
        $owner.CommandLine.IndexOf($relayPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'The quote port is held by a different process.'
    }
    Stop-Process -Id $owner.ProcessId
    Wait-Process -Id $owner.ProcessId -Timeout 4 -ErrorAction SilentlyContinue
}
Start-ScheduledTask -TaskName $taskName

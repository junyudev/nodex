param(
  [Parameter(Mandatory)][string]$OutputFile,
  [Parameter(Mandatory)][string]$StopFile,
  [Parameter(Mandatory)][string]$ReadyFile,
  [int]$MaxSamples = 720
)
$ErrorActionPreference = 'Stop'
$paths = [ordered]@{
  cpuPercent = '\Processor(_Total)\% Processor Time'
  availableMiB = '\Memory\Available MBytes'
  diskQueue = '\PhysicalDisk(_Total)\Current Disk Queue Length'
  diskSecondsPerTransfer = '\PhysicalDisk(_Total)\Avg. Disk sec/Transfer'
  diskReadBytesPerSecond = '\PhysicalDisk(_Total)\Disk Read Bytes/sec'
  diskWriteBytesPerSecond = '\PhysicalDisk(_Total)\Disk Write Bytes/sec'
}
$processQuery = "SELECT ProcessId,ParentProcessId,CreationDate,Name,KernelModeTime,UserModeTime,ReadOperationCount,WriteOperationCount,ReadTransferCount,WriteTransferCount,WorkingSetSize,ThreadCount FROM Win32_Process WHERE Name='node.exe' OR Name='nodex-core.exe' OR Name='cargo.exe' OR Name LIKE 'nodex%.exe'"
$utf8 = [Text.UTF8Encoding]::new($false)
$clock = [Diagnostics.Stopwatch]::StartNew()
$hardware = Get-CimInstance -Query 'SELECT NumberOfLogicalProcessors,TotalPhysicalMemory FROM Win32_ComputerSystem' -OperationTimeoutSec 3
for ($sampleIndex = 0; $sampleIndex -lt $MaxSamples; $sampleIndex++) {
  if (Test-Path -LiteralPath $StopFile) { break }
  if ((Test-Path -LiteralPath $OutputFile) -and (Get-Item -LiteralPath $OutputFile).Length -gt 16777216) { break }
  $sampleStarted = $clock.ElapsedMilliseconds
  $row = [ordered]@{
    version = 1
    at = [DateTime]::UtcNow.ToString('o')
    elapsedMs = $sampleStarted
    sample = $sampleIndex
    logicalProcessors = $hardware.NumberOfLogicalProcessors
    totalPhysicalBytes = [string]$hardware.TotalPhysicalMemory
  }
  $row.counters = [ordered]@{}
  try {
    $counters = (Get-Counter -Counter @($paths.Values) -MaxSamples 1).CounterSamples
    foreach ($entry in $paths.GetEnumerator()) {
      $matched = @($counters | Where-Object { $_.Path.EndsWith($entry.Value, [StringComparison]::OrdinalIgnoreCase) })
      if ($matched.Count -ne 1 -or $matched[0].Status -ne 0) { throw 'Invalid counter sample' }
      $row.counters[$entry.Key] = $matched[0].CookedValue
    }
    $row.processes = @(Get-CimInstance -Query $processQuery -OperationTimeoutSec 3 | ForEach-Object {
      [ordered]@{
        pid = $_.ProcessId
        parentPid = $_.ParentProcessId
        startedAt = $_.CreationDate.ToUniversalTime().ToString('o')
        kind = $(if ($_.Name -eq 'nodex-core.exe') { 'core' } elseif ($_.Name -eq 'node.exe') { 'node' } elseif ($_.Name -eq 'cargo.exe') { 'cargo' } else { 'rust-test' })
        kernel100ns = [string]$_.KernelModeTime
        user100ns = [string]$_.UserModeTime
        readOperations = [string]$_.ReadOperationCount
        writeOperations = [string]$_.WriteOperationCount
        readTransferBytes = [string]$_.ReadTransferCount
        writeTransferBytes = [string]$_.WriteTransferCount
        workingSetBytes = [string]$_.WorkingSetSize
        threadCount = $_.ThreadCount
      }
    })
    $row.sampleCostMs = $clock.ElapsedMilliseconds - $sampleStarted
    [IO.File]::AppendAllText($OutputFile, (($row | ConvertTo-Json -Depth 8 -Compress) + "`n"), $utf8)
    if (-not (Test-Path -LiteralPath $ReadyFile)) { [IO.File]::WriteAllText($ReadyFile, 'ready', $utf8) }
  } catch {
    # Never serialize provider objects, environment, host names, or command lines.
    $row.providerErrorType = $_.Exception.GetType().Name
    [IO.File]::AppendAllText($OutputFile, (($row | ConvertTo-Json -Depth 8 -Compress) + "`n"), $utf8)
    if ($sampleIndex -eq 0) { throw 'Required resource counters unavailable; probe must not proceed without evidence.' }
  }
  $remaining = 5000 - ($clock.ElapsedMilliseconds - $sampleStarted)
  if ($remaining -gt 0) { Start-Sleep -Milliseconds $remaining }
}

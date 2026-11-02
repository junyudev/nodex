param(
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$utf8 = [Text.UTF8Encoding]::new($false)
$directory = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($directory)
$files = @(
  'src/main/core-client/agent-eval-cases.node.test.ts'
  'src/main/core-client/block-promotion-history-scenario.node.test.ts'
  'src/main/core-client/core-launcher.node.test.ts'
  'src/main/core-client/editor-history-scenario.node.test.ts'
  'src/main/codex-application/CodexThreadTargets.core-scenario.node.test.ts'
  'src/main/codex-application/CodexVisualizationState.node.test.ts'
  'src/main/platform/node/NodexCliBootstrap.node.test.ts'
)
# Both worker configurations receive a discarded warmup before the symmetric measurement block.
$rounds = @(
  @{ Name = 'warmup-4'; Workers = 4; Measured = $false }
  @{ Name = 'warmup-1'; Workers = 1; Measured = $false }
  @{ Name = 'A1-4'; Workers = 4; Measured = $true }
  @{ Name = 'B1-1'; Workers = 1; Measured = $true }
  @{ Name = 'B2-1'; Workers = 1; Measured = $true }
  @{ Name = 'A2-4'; Workers = 4; Measured = $true }
)
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify probe source.' }
$tree = (& git rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify probe source tree.' }
$manifest = [ordered]@{
  source = $head
  tree = $tree
  files = $files
  expectedCollectedFiles = 7
  expectedCollectedCases = 79
  existingWindowsSkippedCases = 4
  measuredOrder = @(4, 1, 1, 4)
  warmupOrder = @(4, 1)
  timeLimitsChanged = $false
  assertionsRemoved = $false
}
[IO.File]::WriteAllText((Join-Path $directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 5), $utf8)
function Get-CoreIds {
  @(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE Name='nodex-core.exe'" -OperationTimeoutSec 3 | ForEach-Object { [uint32]$_.ProcessId })
}
$stopFile = Join-Path $directory 'sampler.stop'
$readyFile = Join-Path $directory 'sampler.ready'
if ((Test-Path -LiteralPath $stopFile) -or (Test-Path -LiteralPath $readyFile)) { throw 'Use a fresh probe output directory.' }
$sampler = Start-Job -FilePath (Join-Path $PSScriptRoot 'windows-core-resource-sampler.ps1') -ArgumentList (Join-Path $directory 'resources.jsonl'),$stopFile,$readyFile,720
$oldRound = $env:NODEX_CORE_IO_PROBE_ROUND
$oldTimings = $env:NODEX_TEST_TIMINGS
$oldProbe = $env:NODEX_CORE_IO_PROBE
$exitCodes = @()
try {
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(25)
  while (-not (Test-Path -LiteralPath $readyFile)) {
    if ($sampler.State -eq 'Failed' -or [DateTime]::UtcNow -gt $readyDeadline) { throw 'Resource sampler did not become ready.' }
    Start-Sleep -Milliseconds 200
  }
  foreach ($round in $rounds) {
    if ((& git rev-parse HEAD).Trim() -ne $head) { throw 'Source changed during the paired sample.' }
    $baselineCore = @(Get-CoreIds)
    if ($baselineCore.Count -ne 0) { throw 'Unexpected Core before round; preserve evidence and resolve exact ownership before continuing.' }
    $roundDirectory = Join-Path $directory $round.Name
    [void][IO.Directory]::CreateDirectory($roundDirectory)
    $env:NODEX_CORE_IO_PROBE = '1'
    $env:NODEX_CORE_IO_PROBE_ROUND = $round.Name
    $env:NODEX_TEST_TIMINGS = Join-Path $roundDirectory 'timings'
    $started = [DateTime]::UtcNow
    $clock = [Diagnostics.Stopwatch]::StartNew()
    # No standalone --, no test/hook timeout flags, no skipped assertions, no task-cache replay.
    & vp run --no-cache test:core-client @files "--maxWorkers=$($round.Workers)" 2>&1 | Tee-Object -FilePath (Join-Path $roundDirectory 'tests.log')
    $actualExit = $LASTEXITCODE
    $clock.Stop()
    $exitCodes += $actualExit
    $inventory = [ordered]@{ valid = $false }
    try {
      $reports = @(Get-ChildItem -LiteralPath $env:NODEX_TEST_TIMINGS -Filter 'core-client-*.json' -File)
      if ($reports.Count -ne 1) { throw 'Expected exactly one fresh named Core report.' }
      $report = Get-Content -LiteralPath $reports[0].FullName -Raw | ConvertFrom-Json
      $actualFiles = @($report.files | ForEach-Object { $_.path.Replace('\', '/') })
      $inventory.collectedFiles = $report.summary.collectedFiles
      $inventory.collectedCases = $report.summary.passed + $report.summary.failed + $report.summary.skipped + $report.summary.pending
      $inventory.skippedCases = $report.summary.skipped
      $inventory.runtime = $report.runtime
      $inventory.valid = $inventory.collectedFiles -eq 7 -and $inventory.collectedCases -eq 79 -and $inventory.skippedCases -eq 4 -and $report.runtime -eq 'node' -and @(Compare-Object $files $actualFiles).Count -eq 0
    } catch {
      $inventory.errorType = $_.Exception.GetType().Name
    }
    $drainDeadline = [DateTime]::UtcNow.AddSeconds(20)
    $residualCore = @(Get-CoreIds)
    while ($residualCore.Count -gt 0 -and [DateTime]::UtcNow -lt $drainDeadline) {
      Start-Sleep -Milliseconds 500
      $residualCore = @(Get-CoreIds)
    }
    $record = [ordered]@{
      version = 1
      name = $round.Name
      measured = $round.Measured
      requestedWorkers = $round.Workers
      startedAt = $started.ToString('o')
      finishedAt = [DateTime]::UtcNow.ToString('o')
      canonicalCommandMs = $clock.Elapsed.TotalMilliseconds
      actualExit = $actualExit
      baselineCoreCount = $baselineCore.Count
      residualCoreCount = $residualCore.Count
      residualCoreIds = $residualCore
      inventory = $inventory
    }
    [IO.File]::AppendAllText((Join-Path $directory 'rounds.jsonl'), (($record | ConvertTo-Json -Depth 5 -Compress) + "`n"), $utf8)
    if ($residualCore.Count -gt 0) { throw 'Core remained after the round; later rounds would be contaminated. No broad kill is performed.' }
    if (-not $inventory.valid) { throw 'Collected files/cases/skips differ from the unchanged probe contract; preserve this round instead of comparing a subset.' }
    if ($sampler.State -ne 'Running') { throw 'Resource sampler stopped; preserve evidence instead of accepting unobserved rounds.' }
  }
} finally {
  $env:NODEX_CORE_IO_PROBE_ROUND = $oldRound
  $env:NODEX_TEST_TIMINGS = $oldTimings
  $env:NODEX_CORE_IO_PROBE = $oldProbe
  [IO.File]::WriteAllText($stopFile, 'stop', $utf8)
  [void](Wait-Job -Job $sampler -Timeout 15)
  if ($sampler.State -eq 'Running') { Stop-Job -Job $sampler }
  $samplerReceipt = [ordered]@{ state = [string]$sampler.State; childErrorCount = @($sampler.ChildJobs | ForEach-Object { $_.Error.Count } | Measure-Object -Sum).Sum }
  [IO.File]::WriteAllText((Join-Path $directory 'sampler-exit.json'), ($samplerReceipt | ConvertTo-Json -Compress), $utf8)
  Remove-Job -Job $sampler -Force
}
if (@($exitCodes | Where-Object { $_ -ne 0 }).Count -gt 0) { exit 1 }
exit 0

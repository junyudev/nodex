param(
  [Parameter(Mandatory)][string]$OutputDirectory,
  [ValidateSet('core-io', 'core-full')][string]$Mode = 'core-io'
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
$fullSuite = $Mode -eq 'core-full'
$baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../fixtures/windows-core-baseline-2e51.json') -Raw | ConvertFrom-Json
$expectedFiles = $(if ($fullSuite) { $baseline.collectedFiles } else { 7 })
$expectedCases = $(if ($fullSuite) { $baseline.collectedCases } else { 79 })
$expectedSkipped = $(if ($fullSuite) { $baseline.skippedCases } else { 4 })
# Both worker configurations receive a discarded warmup before the symmetric measurement block.
$rounds = @(
  @{ Name = 'warmup-4'; Workers = 4; Measured = $false }
  @{ Name = 'warmup-1'; Workers = 1; Measured = $false }
  @{ Name = 'A1-4'; Workers = 4; Measured = $true }
  @{ Name = 'B1-1'; Workers = 1; Measured = $true }
  @{ Name = 'B2-1'; Workers = 1; Measured = $true }
  @{ Name = 'A2-4'; Workers = 4; Measured = $true }
)
if ($fullSuite) {
  # One complete cold selection, with the existing four-worker config and no CLI override.
  $rounds = @(@{ Name = 'full'; Workers = 4; Measured = $true })
}
$head = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify probe source.' }
$tree = (& git rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify probe source tree.' }
$manifest = [ordered]@{
  source = $head
  tree = $tree
  mode = $Mode
  baseline = $baseline
  focusedFiles = $(if ($fullSuite) { @() } else { $files })
  expectedCollectedFiles = $expectedFiles
  expectedCollectedCases = $expectedCases
  existingWindowsSkippedCases = $expectedSkipped
  measuredOrder = @($rounds | Where-Object { $_.Measured } | ForEach-Object { $_.Workers })
  warmupOrder = @($rounds | Where-Object { -not $_.Measured } | ForEach-Object { $_.Workers })
  diagnosticOnly = $true
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
    $selection = $(if ($fullSuite) { @() } else { @($files) + "--maxWorkers=$($round.Workers)" })
    & vp run --no-cache test:core-client @selection 2>&1 | Tee-Object -FilePath (Join-Path $roundDirectory 'tests.log')
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
      $inventory.unhandledErrors = $report.unhandledErrors
      $inventory.reactActWarnings = @($report.reactActWarnings).Count
      $inventory.originalFailedCases = @($baseline.failedCases | ForEach-Object {
        $original = $_
        $caseMatches = @($report.files | Where-Object { $_.path.Replace('\', '/') -eq $original.file } | ForEach-Object { $_.tests } | Where-Object { $_.name -eq $original.name })
        [ordered]@{ file = $original.file; name = $original.name; occurrences = $caseMatches.Count; state = $(if ($caseMatches.Count -eq 1) { $caseMatches[0].state } else { 'missing-or-duplicate' }) }
      })
      $selectionValid = $(if ($fullSuite) { @($inventory.originalFailedCases | Where-Object { $_.occurrences -ne 1 }).Count -eq 0 } else { @(Compare-Object $files $actualFiles).Count -eq 0 })
      $inventory.valid = $inventory.collectedFiles -eq $expectedFiles -and $inventory.collectedCases -eq $expectedCases -and $inventory.skippedCases -eq $expectedSkipped -and $report.runtime -eq 'node' -and $selectionValid
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

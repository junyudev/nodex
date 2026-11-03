param(
  [Parameter(Mandatory)][ValidateSet('rust', 'core-client')][string]$Suite,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$utf8 = [Text.UTF8Encoding]::new($false)
$directory = [IO.Path]::GetFullPath($OutputDirectory)
[void][IO.Directory]::CreateDirectory($directory)
$baseline = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../fixtures/windows-deadline-baseline-15105.json') -Raw | ConvertFrom-Json
$source = (& git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify diagnostic source.' }
$sourceChanges = @(& git diff --name-only $baseline.source HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Cannot compare the diagnostic source to its main baseline.' }
$manifest = [ordered]@{
  source = $source
  baseline = $baseline
  sourceChanges = $sourceChanges
  suite = $Suite
  diagnosticOnly = $true
  nativeAndPairedProbes = $false
  requestedConcurrency = $(if ($Suite -eq 'rust') { 2 } else { 4 })
  requestBudgetsChanged = $false
  testBudgetsChanged = $false
  assertionsChanged = $false
}
[IO.File]::WriteAllText((Join-Path $directory 'manifest.json'), ($manifest | ConvertTo-Json -Depth 6), $utf8)
function Get-CoreIds {
  @(Get-CimInstance -Query "SELECT ProcessId FROM Win32_Process WHERE Name='nodex-core.exe'" -OperationTimeoutSec 3 | ForEach-Object { [uint32]$_.ProcessId })
}
$baselineCore = @(Get-CoreIds)
if ($baselineCore.Count -ne 0) { throw 'Unexpected Core before the diagnostic; preserve ownership evidence without a broad kill.' }
$stopFile = Join-Path $directory 'sampler.stop'
$readyFile = Join-Path $directory 'sampler.ready'
if ((Test-Path -LiteralPath $stopFile) -or (Test-Path -LiteralPath $readyFile)) { throw 'Use a fresh diagnostic output directory.' }
$sampler = Start-Job -FilePath (Join-Path $PSScriptRoot 'windows-deadline-resource-sampler.ps1') -ArgumentList (Join-Path $directory 'resources.jsonl'),$stopFile,$readyFile,720
$oldTimings = $env:NODEX_TEST_TIMINGS
$actualExit = $null
$inventory = [ordered]@{ valid = $false }
try {
  $readyDeadline = [DateTime]::UtcNow.AddSeconds(25)
  while (-not (Test-Path -LiteralPath $readyFile)) {
    if ($sampler.State -eq 'Failed' -or [DateTime]::UtcNow -gt $readyDeadline) { throw 'Resource sampler did not become ready.' }
    Start-Sleep -Milliseconds 200
  }
  $env:NODEX_TEST_TIMINGS = Join-Path $directory 'timings'
  $started = [DateTime]::UtcNow
  $clock = [Diagnostics.Stopwatch]::StartNew()
  # Preserve the original commands and every deadline, pressure fixture, and assertion.
  if ($Suite -eq 'rust') {
    & cargo test --locked --workspace --all-features --no-fail-fast -- --test-threads=2 2>&1 | Tee-Object -FilePath (Join-Path $directory 'tests.log')
  } else {
    & vp run --no-cache test:core-client 2>&1 | Tee-Object -FilePath (Join-Path $directory 'tests.log')
  }
  $actualExit = $LASTEXITCODE
  $clock.Stop()
  try {
    if ($Suite -eq 'rust') {
      $plain = (Get-Content -LiteralPath (Join-Path $directory 'tests.log') -Raw) -replace '\x1B\[[0-9;]*m', ''
      $summaries = @([regex]::Matches($plain, 'test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out;') | ForEach-Object {
        [ordered]@{ state = $_.Groups[1].Value; passed = [int]$_.Groups[2].Value; failed = [int]$_.Groups[3].Value; ignored = [int]$_.Groups[4].Value; measured = [int]$_.Groups[5].Value; filtered = [int]$_.Groups[6].Value }
      })
      $inventory.summaryCount = $summaries.Count
      $inventory.collectedCases = @($summaries | ForEach-Object { $_.passed + $_.failed + $_.ignored } | Measure-Object -Sum).Sum
      $inventory.ignoredCases = @($summaries | ForEach-Object { $_.ignored } | Measure-Object -Sum).Sum
      $identity = [regex]::Escape($baseline.rustFailedCase)
      $caseMatches = @([regex]::Matches($plain, "(?m)^test $identity \.\.\. (ok|FAILED|ignored)\s*$"))
      $inventory.originalFailedCase = [ordered]@{ name = $baseline.rustFailedCase; occurrences = $caseMatches.Count; state = $(if ($caseMatches.Count -eq 1) { $caseMatches[0].Groups[1].Value } else { 'missing-or-duplicate' }) }
      $inventory.valid = $inventory.summaryCount -eq $baseline.rustSummaryCount -and $inventory.collectedCases -eq $baseline.rustCollectedCases -and $inventory.ignoredCases -eq $baseline.rustIgnoredCases -and $caseMatches.Count -eq 1
      [IO.File]::WriteAllText((Join-Path $directory 'rust-summaries.json'), ($summaries | ConvertTo-Json -Depth 4), $utf8)
    } else {
      $reports = @(Get-ChildItem -LiteralPath $env:NODEX_TEST_TIMINGS -Filter 'core-client-*.json' -File)
      if ($reports.Count -ne 1) { throw 'Expected exactly one complete Core report.' }
      $report = Get-Content -LiteralPath $reports[0].FullName -Raw | ConvertFrom-Json
      $inventory.collectedFiles = $report.summary.collectedFiles
      $inventory.collectedCases = $report.summary.passed + $report.summary.failed + $report.summary.skipped + $report.summary.pending
      $inventory.skippedCases = $report.summary.skipped
      $inventory.unhandledErrors = $report.unhandledErrors
      $inventory.reactActWarnings = @($report.reactActWarnings).Count
      $inventory.originalFailedCases = @($baseline.coreFailedCases | ForEach-Object {
        $original = $_
        $caseMatches = @($report.files | Where-Object { $_.path.Replace('\', '/') -eq $original.file } | ForEach-Object { $_.tests } | Where-Object { $_.name -eq $original.name })
        [ordered]@{ file = $original.file; name = $original.name; occurrences = $caseMatches.Count; state = $(if ($caseMatches.Count -eq 1) { $caseMatches[0].state } else { 'missing-or-duplicate' }) }
      })
      $inventory.valid = $inventory.collectedFiles -eq $baseline.coreCollectedFiles -and $inventory.collectedCases -eq $baseline.coreCollectedCases -and $inventory.skippedCases -eq $baseline.coreSkippedCases -and $report.runtime -eq 'node' -and @($inventory.originalFailedCases | Where-Object { $_.occurrences -ne 1 }).Count -eq 0
    }
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
    suite = $Suite
    startedAt = $started.ToString('o')
    finishedAt = [DateTime]::UtcNow.ToString('o')
    canonicalCommandMs = $clock.Elapsed.TotalMilliseconds
    actualExit = $actualExit
    baselineCoreCount = $baselineCore.Count
    residualCoreCount = $residualCore.Count
    residualCoreIds = $residualCore
    inventory = $inventory
  }
  [IO.File]::WriteAllText((Join-Path $directory 'exit-receipt.json'), ($record | ConvertTo-Json -Depth 7), $utf8)
  if ($residualCore.Count -ne 0) { throw 'Core remained after the diagnostic; preserve evidence without a broad kill.' }
  if (-not $inventory.valid) { throw 'The complete collected inventory differs from the unchanged baseline.' }
  if ($sampler.State -ne 'Running') { throw 'The sampler stopped before the complete run finished.' }
} finally {
  $env:NODEX_TEST_TIMINGS = $oldTimings
  [IO.File]::WriteAllText($stopFile, 'stop', $utf8)
  [void](Wait-Job -Job $sampler -Timeout 15)
  if ($sampler.State -eq 'Running') { Stop-Job -Job $sampler }
  $samplerReceipt = [ordered]@{ state = [string]$sampler.State; childErrorCount = @($sampler.ChildJobs | ForEach-Object { $_.Error.Count } | Measure-Object -Sum).Sum }
  [IO.File]::WriteAllText((Join-Path $directory 'sampler-exit.json'), ($samplerReceipt | ConvertTo-Json -Compress), $utf8)
  Remove-Job -Job $sampler -Force
}
exit $actualExit

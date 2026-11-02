import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import path from "node:path";

const WINDOWS_FORCE_WAIT_MS = 5_000;

/** Capture native handles before signalling: taskkill returning does not prove exit. */
function windowsTerminationCommand(pid: number, signal: NodeJS.Signals, graceMs: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid child process ID");
  const grace = Math.min(10_000, Math.max(0, Number.isFinite(graceMs) ? graceMs : 250));
  const script = `
$ErrorActionPreference = 'Stop'
$owned = New-Object 'System.Collections.Generic.List[System.Diagnostics.Process]'
$probe = New-Object 'System.Collections.Generic.List[object]'
$probeClock = [System.Diagnostics.Stopwatch]::StartNew()
$nativeReady = $false
if ($env:NODEX_PROCESS_TREE_PROBE_DIRECTORY) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NodexProcessReleaseProbe {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetExitCodeProcess(IntPtr handle, out uint exitCode);
}
'@
    $nativeReady = $true
  } catch {
    $probe.Add(@{ phase = 'probe-init-error'; message = [string]$_ })
  }
}
function Write-ProcessProbe($phase, $member, $facts) {
  if (!$env:NODEX_PROCESS_TREE_PROBE_DIRECTORY) { return }
  try {
    $record = @{ phase = $phase; root = ${pid}; signal = '${signal}'; elapsedMs = $probeClock.ElapsedMilliseconds; nativeReady = $nativeReady }
    if ($null -ne $member) {
      $record.member = $member.Id
      if ($nativeReady) {
        # Observe the retained kernel handle without populating Process.HasExited's cache.
        $record.kernelWait = [NodexProcessReleaseProbe]::WaitForSingleObject($member.Handle, 0)
        $record.kernelWaitError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $nativeExitCode = [uint32]0
        $record.exitCodeRead = [NodexProcessReleaseProbe]::GetExitCodeProcess($member.Handle, [ref]$nativeExitCode)
        $record.nativeExitCode = $nativeExitCode
        $record.exitCodeError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      }
    }
    if ($null -ne $facts) { foreach ($key in $facts.Keys) { $record[$key] = $facts[$key] } }
    $probe.Add($record)
  } catch {
    $probe.Add(@{ phase = 'probe-observation-error'; message = [string]$_ })
  }
}
try {
  $root = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
  if ($null -eq $root) { exit 0 }
  try { $null = $root.Handle } catch {
    if ($root.HasExited) { $root.Dispose(); exit 0 }
    $root.Dispose()
    throw
  }
  $startedAt = $root.StartTime
  $owned.Add($root)
  $ids = New-Object 'System.Collections.Generic.HashSet[int]'
  $null = $ids.Add(${pid})
  $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
  do {
    $added = $false
    foreach ($entry in $snapshot) {
      if (!$ids.Contains([int]$entry.ParentProcessId) -or $ids.Contains([int]$entry.ProcessId)) { continue }
      if ($entry.CreationDate -lt $startedAt) { continue }
      $null = $ids.Add([int]$entry.ProcessId)
      $added = $true
      $member = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
      if ($null -eq $member) { continue }
      try {
        $null = $member.Handle
        $owned.Add($member)
      } catch {
        $exited = $member.HasExited
        $member.Dispose()
        if (!$exited) { throw }
      }
    }
  } while ($added)
  foreach ($member in $owned) { Write-ProcessProbe 'captured' $member $null }
  $arguments = '/PID ${pid} /T${signal === "SIGKILL" ? " /F" : ""}'
  $taskkillStartedMs = $probeClock.ElapsedMilliseconds
  $killer = Start-Process -FilePath "$env:SystemRoot\\System32\\taskkill.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
  try {
    if (!$killer.WaitForExit(${WINDOWS_FORCE_WAIT_MS})) {
      $killer.Kill()
      throw 'Process tree termination command timed out'
    }
    $taskkillExitCode = $killer.ExitCode
    Write-ProcessProbe 'taskkill-exit' $null @{ taskkillExitCode = $taskkillExitCode; taskkillMs = $probeClock.ElapsedMilliseconds - $taskkillStartedMs }
  } finally { $killer.Dispose() }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($member in $owned) {
    $waited = $member.WaitForExit([int][Math]::Max(0, ${grace} - $clock.ElapsedMilliseconds))
    Write-ProcessProbe 'grace-wait' $member @{ managedSignaled = $waited; graceElapsedMs = $clock.ElapsedMilliseconds }
  }
  # A leader can exit first; retain and force each captured descendant independently.
  foreach ($member in $owned) {
    if ($member.HasExited) { Write-ProcessProbe 'force-skipped-has-exited' $member $null; continue }
    try { $member.Kill(); Write-ProcessProbe 'force-kill' $member $null } catch {
      # A sibling or taskkill can finish the same process between observation and Kill.
      if (!$member.WaitForExit(${WINDOWS_FORCE_WAIT_MS})) { throw }
    }
  }
  $clock.Restart()
  foreach ($member in $owned) {
    Write-ProcessProbe 'before-final-wait' $member @{ forceElapsedMs = $clock.ElapsedMilliseconds }
    $remainingMs = [int][Math]::Max(0, ${WINDOWS_FORCE_WAIT_MS} - $clock.ElapsedMilliseconds)
    $waitStartedMs = $probeClock.ElapsedMilliseconds
    $waited = $member.WaitForExit($remainingMs)
    Write-ProcessProbe 'final-wait' $member @{ managedSignaled = $waited; remainingMs = $remainingMs; waitMs = $probeClock.ElapsedMilliseconds - $waitStartedMs; forceElapsedMs = $clock.ElapsedMilliseconds; taskkillExitCode = $taskkillExitCode }
    if (!$waited) {
      $exited = 'unknown'
      try { $exited = [string]$member.HasExited } catch {}
      throw "Process tree did not exit after forced termination (root=${pid}; member=$($member.Id); hasExited=$exited; taskkillExit=$taskkillExitCode)"
    }
  }
} finally {
  foreach ($member in $owned) { $member.Dispose() }
  if ($env:NODEX_PROCESS_TREE_PROBE_DIRECTORY) {
    try {
      # Flush only after the release attempt; diagnostic disk I/O never extends a native wait budget.
      $destination = Join-Path $env:NODEX_PROCESS_TREE_PROBE_DIRECTORY "$PID.jsonl"
      $lines = @($probe | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 })
      [IO.File]::WriteAllLines($destination, [string[]]$lines)
    } catch {}
  }
}`;
  return {
    executable: path.win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    options: { windowsHide: true, timeout: grace + 20_000 },
  };
}

/** Resolve only after the captured Windows tree exits; reject if the bounded release fails. */
export function terminateWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals = "SIGTERM",
  graceMs = 250,
): Promise<void> {
  const command = windowsTerminationCommand(pid, signal, graceMs);
  return new Promise((resolve, reject) => {
    execFile(command.executable, command.args, command.options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Terminate only the tree rooted at a PID captured when the child was spawned. */
export function killProcessTree(pid: number, signal: NodeJS.Signals, platform: string): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    const command = windowsTerminationCommand(pid, signal, 250);
    execFileSync(command.executable, command.args, {
      ...command.options,
      stdio: "pipe",
    });
    return;
  }
  process.kill(-pid, signal);
}

export function killChildProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: string = process.platform,
): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (platform === "win32" && child.pid !== undefined) {
    killProcessTree(child.pid, signal, platform);
    return;
  }
  if (child.pid !== undefined) {
    try {
      killProcessTree(child.pid, signal, platform);
      return;
    } catch {
      // A process group may already have exited or may not have been created.
    }
  }
  child.kill(signal);
}

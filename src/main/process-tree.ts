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
  $arguments = '/PID ${pid} /T${signal === "SIGKILL" ? " /F" : ""}'
  $killer = Start-Process -FilePath "$env:SystemRoot\\System32\\taskkill.exe" -ArgumentList $arguments -WindowStyle Hidden -PassThru
  try {
    if (!$killer.WaitForExit(${WINDOWS_FORCE_WAIT_MS})) {
      $killer.Kill()
      throw 'Process tree termination command timed out'
    }
  } finally { $killer.Dispose() }
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  foreach ($member in $owned) {
    $null = $member.WaitForExit([int][Math]::Max(0, ${grace} - $clock.ElapsedMilliseconds))
  }
  # A leader can exit first; retain and force each captured descendant independently.
  foreach ($member in $owned) {
    if ($member.HasExited) { continue }
    try { $member.Kill() } catch {
      # A sibling or taskkill can finish the same process between observation and Kill.
      if (!$member.WaitForExit(${WINDOWS_FORCE_WAIT_MS})) { throw }
    }
  }
  $clock.Restart()
  foreach ($member in $owned) {
    if (!$member.WaitForExit([int][Math]::Max(0, ${WINDOWS_FORCE_WAIT_MS} - $clock.ElapsedMilliseconds))) {
      throw 'Process tree did not exit after forced termination'
    }
  }
} finally {
  foreach ($member in $owned) { $member.Dispose() }
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

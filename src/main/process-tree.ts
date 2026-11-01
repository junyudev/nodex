import { execFileSync, type ChildProcess } from "node:child_process";

/** Terminate only the tree rooted at a PID captured when the child was spawned. */
export function killProcessTree(pid: number, signal: NodeJS.Signals, platform: string): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    // /T includes grandchildren; /F is necessary for console-less providers and workers.
    execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
      timeout: 10_000,
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

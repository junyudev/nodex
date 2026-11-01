import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delayTimer } from "node:timers/promises";
import type { IsolatedRunSupervisorDependencies } from "../isolated-run-contract";

const isFileSystemError = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const delay = (durationMs: number, signal?: AbortSignal): Promise<void> =>
  delayTimer(durationMs, undefined, { signal }).then(() => undefined);

export const liveIsolatedRunSupervisorDependencies: IsolatedRunSupervisorDependencies = {
  delay,
  forceExit: (exitCode) => process.exit(exitCode),
  generateRunId: randomUUID,
  isProcessGroupAlive: (processGroupId) => {
    try {
      process.kill(process.platform === "win32" ? processGroupId : -processGroupId, 0);
      return true;
    } catch (error) {
      if (isFileSystemError(error, "ESRCH")) return false;
      if (isFileSystemError(error, "EPERM")) return true;
      throw error;
    }
  },
  now: Date.now,
  signalSource: process,
  signalProcessGroup: (processGroupId, signal) => {
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill.exe", ["/PID", String(processGroupId), "/T", "/F"], {
          stdio: "ignore",
          timeout: 5_000,
        });
        return;
      }
      process.kill(-processGroupId, signal);
    } catch (error) {
      if (!isFileSystemError(error, "ESRCH")) throw error;
    }
  },
  spawnChild: (command, args, options) =>
    spawn(command, [...args], {
      ...options,
      detached: process.platform !== "win32",
      windowsHide: true,
    }),
};

export const resolveIsolatedRunSupervisorDependencies = (
  overrides: Partial<IsolatedRunSupervisorDependencies> | undefined,
): IsolatedRunSupervisorDependencies => ({
  ...liveIsolatedRunSupervisorDependencies,
  ...overrides,
});

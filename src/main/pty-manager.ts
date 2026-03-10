import * as pty from "node-pty";
import { getLogger } from "./logging/logger";

interface PtySession {
  process: pty.IPty;
  onDataDisposable: pty.IDisposable;
  onExitDisposable: pty.IDisposable;
}

const sessions = new Map<string, PtySession>();
const logger = getLogger({ subsystem: "pty" });

function getDefaultShell(): string {
  if (process.platform === "win32") return "powershell.exe";
  return process.env.SHELL || "/bin/zsh";
}

export function spawn(
  sessionId: string,
  opts: { cols: number; rows: number; cwd?: string },
  onData: (data: string) => void,
  onExit: (exitCode: number) => void,
): { success: boolean; error?: string } {
  // Reconnect: session exists — rewire callbacks to the new IPC sender
  // and resize to match the new terminal dimensions.
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.onDataDisposable.dispose();
    existing.onExitDisposable.dispose();
    existing.onDataDisposable = existing.process.onData(onData);
    existing.onExitDisposable = existing.process.onExit(({ exitCode }) => {
      sessions.delete(sessionId);
      logger.info("PTY session exited after reconnect", { sessionId, exitCode });
      onExit(exitCode);
    });
    existing.process.resize(opts.cols, opts.rows);
    logger.info("PTY session reconnected", {
      sessionId,
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd ?? null,
    });
    return { success: true };
  }

  const shell = getDefaultShell();
  logger.info("Spawning PTY session", {
    sessionId,
    shell,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd ?? null,
  });

  try {
    const proc = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd || process.cwd(),
      env: process.env as Record<string, string>,
    });

    const onDataDisposable = proc.onData(onData);
    const onExitDisposable = proc.onExit(({ exitCode }) => {
      sessions.delete(sessionId);
      logger.info("PTY session exited", { sessionId, exitCode });
      onExit(exitCode);
    });

    sessions.set(sessionId, { process: proc, onDataDisposable, onExitDisposable });
    logger.info("PTY session spawned", { sessionId, pid: proc.pid });
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to spawn PTY";
    logger.error("Failed to spawn PTY session", { sessionId, error: err, message: msg });
    return { success: false, error: msg };
  }
}

export function write(sessionId: string, data: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.process.write(data);
}

export function resize(sessionId: string, cols: number, rows: number): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.process.resize(cols, rows);
}

export function kill(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.onDataDisposable.dispose();
  session.onExitDisposable.dispose();
  session.process.kill();
  sessions.delete(sessionId);
  logger.info("PTY session killed", { sessionId });
}

export function killAll(): void {
  for (const sessionId of [...sessions.keys()]) {
    kill(sessionId);
  }
}

export function isAlive(sessionId: string): boolean {
  return sessions.has(sessionId);
}

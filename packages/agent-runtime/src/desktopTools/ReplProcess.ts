// @effect-diagnostics nodeBuiltinImport:off -- owns the POSIX Desktop Tool process boundary
import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);
const psOptions = { encoding: "utf8", env: { LC_ALL: "C" }, timeout: 2_000 } as const;
const watchdogPrefix = "nodex-desktop-repl:";
const startPattern = /\S+\s+\S+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4}/u;
const processPattern = new RegExp(
  `^\\s*(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${startPattern.source})\\s*(.*)$`,
  "u",
);
const missing = (error: unknown) =>
  error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";

// The watchdog leads a private process group, so it can signal its own group without
// looking up a PID. Its private IPC endpoint sees EOF even on Runtime SIGKILL.
// The signed launcher inherits only the three MCP stdio streams.
const watchdogSource = `
const { spawn } = require("node:child_process");
let stopping = false;
let child;
const killGroup = () => process.kill(-process.pid, "SIGKILL");
const stop = () => {
  if (stopping) return;
  stopping = true;
  if (!child?.pid) process.exit(0);
  process.kill(-process.pid, "SIGTERM");
  setTimeout(killGroup, 1000);
};
process.on("SIGTERM", stop);
process.once("disconnect", stop);
process.once("message", ({ command, args, cwd, env }) => {
  if (!process.connected || stopping) return;
  child = spawn(command, args, { cwd, env, stdio: [0, 1, 2] });
  child.once("error", stop);
  child.once("exit", killGroup);
});
`;

interface ReplRecord {
  readonly token: string;
  readonly group: number;
  readonly started: string;
  readonly codexHome?: string;
  readonly sessionId: string;
}

interface ProcessRow {
  readonly pid: number;
  readonly group: number;
  readonly started: string;
  readonly args: string;
}

function recordDirectory(home: string) {
  return join(home, "desktop-repl");
}

function parseRecord(value: unknown, token: string): ReplRecord {
  if (typeof value !== "object" || value === null) throw new Error("Invalid Desktop Tool record");
  const record = value as Partial<ReplRecord>;
  if (
    record.token !== token ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(token) ||
    typeof record.group !== "number" ||
    !Number.isSafeInteger(record.group) ||
    record.group <= 1 ||
    typeof record.started !== "string" ||
    !startPattern.test(record.started) ||
    typeof record.sessionId !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.sessionId) ||
    (record.codexHome !== undefined &&
      (typeof record.codexHome !== "string" || !isAbsolute(record.codexHome)))
  )
    throw new Error("Invalid Desktop Tool record");
  return record as ReplRecord;
}

async function processes(): Promise<ProcessRow[]> {
  const { stdout } = await exec("/bin/ps", ["-axww", "-o", "pid=,pgid=,stat=,lstart=,args="], {
    ...psOptions,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.split("\n").flatMap((line) => {
    const match = processPattern.exec(line);
    return match && !match[3]!.startsWith("Z")
      ? [{ pid: Number(match[1]), group: Number(match[2]), started: match[4]!, args: match[5]! }]
      : [];
  });
}

async function jsonFiles(directory: string) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** The watchdog alone signals its group, whose identity it pins until the final SIGKILL.
 * Recovery waits for that kernel-initiated EOF cleanup and never signals a persisted PID. */
async function reapRecord(
  record: ReplRecord,
  path: string,
  snapshot: () => Promise<readonly ProcessRow[]>,
) {
  const deadline = Date.now() + 5_000;
  let rows = await snapshot();
  for (;;) {
    const leader = rows.find(({ pid }) => pid === record.group);
    // ps can lose argv before it reports the leader as dead. Require a different
    // birth time before treating an unrecognized leader as a reused PID.
    if (
      leader &&
      leader.started !== record.started &&
      !leader.args.endsWith(" -- " + watchdogPrefix + record.token)
    )
      break;
    if (!rows.some(({ group }) => group === record.group)) break;
    if (Date.now() >= deadline)
      throw new Error("Previous Desktop Tool process group is still active");
    await delay(25);
    rows = await snapshot();
  }
  if (record.codexHome) {
    const activeExecs = join(record.codexHome, "node_repl", "active_execs");
    const live = new Set(rows.map(({ pid }) => pid));
    for (const name of await jsonFiles(activeExecs)) {
      const file = join(activeExecs, name);
      const value = (await readJson(file)) as
        | { sessionId?: unknown; nodeReplPid?: unknown }
        | undefined;
      if (
        value?.sessionId === record.sessionId &&
        typeof value.nodeReplPid === "number" &&
        !live.has(value.nodeReplPid)
      )
        await rm(file, { force: true });
    }
  }
  await rm(path, { force: true });
}

/** Called under the Runtime home lease before opening the execution store or listener. */
export async function reapDesktopReplProcesses(
  home: string,
  snapshot: () => Promise<readonly ProcessRow[]> = processes,
) {
  if (process.platform === "win32") return;
  const directory = recordDirectory(home);
  // A writer killed during the atomic write could not have sent the launch message.
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".json.tmp"))
        await rm(join(directory, entry.name), { force: true });
    }
  } catch (error) {
    if (!missing(error)) throw error;
  }
  for (const name of await jsonFiles(directory)) {
    const path = join(directory, name);
    const record = parseRecord(await readJson(path), name.slice(0, -5));
    await reapRecord(record, path, snapshot);
  }
}

interface Launch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string | undefined;
  readonly env: NodeJS.ProcessEnv;
}

/** Own the launcher transport and its physical lifetime at the same boundary. */
export function spawnDesktopReplProcess(home: string, sessionId: string, launch: Launch) {
  const stdio = ["pipe", "pipe", "pipe"] as const;
  // Windows will use a kill-on-close Job Object at this launch boundary.
  if (process.platform === "win32") {
    const child = spawn(launch.command, launch.args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: [...stdio],
    });
    return {
      child,
      async stop() {
        if (!child.kill("SIGTERM")) return;
        const deadline = Date.now() + 1_000;
        while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
          await delay(20);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      },
    };
  }

  const token = randomUUID();
  const directory = recordDirectory(home);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, ["-e", watchdogSource, "--", watchdogPrefix + token], {
    detached: true,
    env: {},
    stdio: [...stdio, "ipc"],
  }) as ChildProcessWithoutNullStreams; // The spawn overload cannot express a fourth IPC fd.
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const path = join(directory, token + ".json");
  const codexHome = launch.env.CODEX_HOME;
  let record: ReplRecord | undefined;
  if (child.pid) {
    try {
      // The watchdog can create a launcher only after the record is committed.
      const started = execFileSync(
        "/bin/ps",
        ["-p", String(child.pid), "-o", "lstart="],
        psOptions,
      ).trim();
      if (!startPattern.test(started)) throw new Error("Could not identify Desktop Tool watchdog");
      record = {
        token,
        group: child.pid,
        started,
        sessionId,
        ...(codexHome && isAbsolute(codexHome) ? { codexHome } : {}),
      };
      writeFileSync(path + ".tmp", JSON.stringify(record), { mode: 0o600 });
      renameSync(path + ".tmp", path);
      child.send(launch, (error) => {
        if (error && child.connected) child.disconnect();
      });
    } catch (error) {
      // A failed ledger write leaves the watchdog idle. Closing its private IPC
      // endpoint lets it exit without having started the launcher.
      if (child.connected) child.disconnect();
      throw error;
    }
  }
  return {
    child,
    async stop() {
      if (child.connected) child.disconnect();
      await exited;
      if (record) {
        // Keep evidence for the next startup if the process table or filesystem is unavailable.
        await reapRecord(record, path, processes).catch(() => {});
      }
    },
  };
}

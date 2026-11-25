// @effect-diagnostics nodeBuiltinImport:off -- The Agent owns this read-only session log and its output files.
import { constants } from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { protoFields } from "./AntigravityChildWork.ts";
import { antigravityManagedPath, antigravityProfileRoot } from "./AntigravityProfilePaths.ts";

const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const TASK_NAME = /^task-(0|[1-9][0-9]{0,14})$/;
const RUN_COMMAND_STEP = 132;
const STEP_RUNNING = 2;
const STEP_COMPLETED = 3;
const STEP_CANCELLED = 6;
const MAX_LIVE_DISCOVERY_ROWS = 128;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 8 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

const field = (payload: Uint8Array, number: number) =>
  protoFields(payload).find(([key]) => key === number)?.[1];

function readStartedAt(details: Uint8Array): DateTime.Utc | undefined {
  const timestamp = field(details, 8);
  if (timestamp === undefined) return undefined;
  let seconds: number | undefined;
  let nanos = 0;
  protoFields(timestamp, (key, value) => {
    if (key === 1) seconds = value;
    if (key === 2) nanos = value;
  });
  if (seconds === undefined || !Number.isSafeInteger(seconds) || nanos >= 1_000_000_000) {
    return undefined;
  }
  return Option.getOrUndefined(DateTime.make(seconds * 1_000 + Math.floor(nanos / 1_000_000)));
}

function decodeCommandTask(row: Record<string, unknown>, sessionId: string) {
  if (!(row.metadata instanceof Uint8Array) || !(row.details instanceof Uint8Array)) {
    return undefined;
  }
  try {
    // StepMetadata.tool_call and TaskDetails are stored separately from the general step payload.
    const call = field(row.metadata, 4);
    const id = call && field(call, 1);
    const name = call && field(call, 2);
    const task = field(row.details, 1);
    if (!id || !name || decoder.decode(name) !== "run_command" || !task) return undefined;
    const taskId = decoder.decode(task);
    // The step index is the shell task's native identity and determines its literal output path.
    if (taskId !== `${sessionId}/task-${row.idx}`) return undefined;
    const status =
      row.status === STEP_RUNNING
        ? "running"
        : row.status === STEP_COMPLETED
          ? "completed"
          : row.status === STEP_CANCELLED
            ? "failed"
            : undefined;
    if (status === undefined) return undefined;
    const startedAt = readStartedAt(row.details);
    return {
      toolCallId: decoder.decode(id),
      taskId,
      status,
      ...(startedAt === undefined ? {} : { startedAt }),
    } as const;
  } catch {
    return undefined;
  }
}

function taskIndex(sessionId: string, taskId: string): number | undefined {
  const prefix = `${sessionId}/`;
  if (!taskId.startsWith(prefix)) return undefined;
  const match = TASK_NAME.exec(taskId.slice(prefix.length));
  return match === null ? undefined : Number(match[1]);
}

/** ACP announces the command but omits the handoff. The exact call's native task record proves it. */
export function readAntigravityBackgroundCommands(
  profileDirectory: string,
  sessionId: string,
  commands: ReadonlyArray<{ readonly toolCallId: string; readonly taskId?: string }>,
) {
  return Effect.promise(async () => {
    if (!SESSION_ID.test(sessionId)) return [];
    const root = await antigravityProfileRoot(profileDirectory);
    if (root === undefined) return [];
    const directory = ["antigravity-acp", "conversations"];
    const file = await antigravityManagedPath(root, [...directory, `${sessionId}.db`], "file");
    if (file === undefined) return [];
    // SQLite can follow sidecars independently of how the database path was opened.
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try {
        if (!(await NodeFSP.lstat(`${file.path}${suffix}`)).isFile()) return [];
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") return [];
      }
    }
    try {
      using database = new NodeSqlite.DatabaseSync(file.path, { readOnly: true });
      const fields = `idx, status, metadata, task_details AS details`;
      const taskRecords = `step_type = ? AND step_format = 0 AND
        length(metadata) <= ? AND length(task_details) <= ?`;
      const bindings = [RUN_COMMAND_STEP, MAX_RECORD_BYTES, MAX_RECORD_BYTES] as const;
      const wanted = new Set(commands.map(({ toolCallId }) => toolCallId));
      const rows = commands.some(({ taskId }) => taskId === undefined)
        ? database
            .prepare(`SELECT ${fields} FROM steps WHERE status = ? AND ${taskRecords}
              ORDER BY idx DESC LIMIT ?`)
            .all(STEP_RUNNING, ...bindings, MAX_LIVE_DISCOVERY_ROWS)
        : [];
      const byIndex = new Map(rows.map((row) => [row.idx, row]));
      const readKnown = database.prepare(
        `SELECT ${fields} FROM steps WHERE idx = ? AND ${taskRecords}`,
      );
      for (const { taskId } of commands) {
        if (taskId === undefined) continue;
        const index = taskIndex(sessionId, taskId);
        if (index === undefined || byIndex.has(index)) continue;
        const row = readKnown.get(index, ...bindings);
        if (row !== undefined) byIndex.set(index, row);
      }
      return [...byIndex.values()].flatMap((row) => {
        const task = decodeCommandTask(row, sessionId);
        return task !== undefined && wanted.has(task.toolCallId) ? [task] : [];
      });
    } catch {
      // Older versions and a database being replaced provide no new task evidence.
      return [];
    }
  });
}

export function readAntigravityBackgroundCommandOutput(
  profileDirectory: string,
  sessionId: string,
  taskId: string,
) {
  return Effect.promise(async () => {
    if (!SESSION_ID.test(sessionId) || taskIndex(sessionId, taskId) === undefined) return null;
    const root = await antigravityProfileRoot(profileDirectory);
    if (root === undefined) return null;
    const name = taskId.slice(sessionId.length + 1);
    const file = await antigravityManagedPath(
      root,
      ["antigravity-acp", "brain", sessionId, ".system_generated", "tasks", `${name}.log`],
      "file",
    );
    // A quiet task may not have created its output file yet. Keep following it.
    if (file === undefined) return { text: "", truncated: false, totalBytes: 0 };
    try {
      await using handle = await NodeFSP.open(
        file.path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== file.info.ino || info.dev !== file.info.dev) return null;
      const offset = Math.max(0, info.size - MAX_OUTPUT_BYTES);
      const bytes = Buffer.alloc(info.size - offset);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, offset);
      return {
        text: bytes.toString("utf8", 0, bytesRead),
        truncated: offset > 0,
        totalBytes: info.size,
      };
    } catch {
      return null;
    }
  });
}

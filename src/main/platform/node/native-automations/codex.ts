// @effect-diagnostics asyncFunction:off -- Filesystem and SQLite reads are the Node capability boundary.
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import {
  NATIVE_AUTOMATION_RUN_LIMIT,
  type NativeAutomationCandidate,
  type NativeAutomationRun,
} from "../../../../shared/native-automation-import";
import { normalizeCodexAutomationRrule } from "../../../../shared/native-automation-schedule";
import { canonicalNativeSessionHome } from "../NativeSessionCatalogPaths";
import {
  NATIVE_AUTOMATION_TASK_LIMIT,
  readSourceText,
  reportSourceIssues,
  sourceEntries,
  sourceReadReason,
  type NativeAutomationReadIssue,
  type NativeAutomationReadResult,
} from "./source-files";

export interface CodexNativeAutomationSource {
  /** Use ApplicationSettings' active Codex history home. */
  readonly codexHome: string;
  /** Select an exact Desktop owner when the caller has one. Unscoped local tasks remain visible. */
  readonly owner?: {
    readonly accountId: string;
    readonly userId: string;
    readonly installationId: string;
  };
}

const text = z.string().trim().min(1);
const optionalText = z
  .string()
  .trim()
  .nullish()
  .transform((value) => value || undefined);
const timestamp = z.number().int().nonnegative();
const folders = z.array(text);
const definitionSchema = z.object({
  id: text,
  name: text,
  prompt: z.string(),
  status: z.enum(["ACTIVE", "PAUSED"]),
  rrule: z.string(),
  kind: z.enum(["cron", "heartbeat"]).nullish(),
  model: optionalText,
  reasoning_effort: optionalText,
  target_thread_id: optionalText,
  execution_environment: z.enum(["local", "worktree"]).nullish(),
  local_environment_config_path: optionalText,
  notification_policy: optionalText,
  cwds: z.union([folders, z.string()]).nullish(),
});

const runSchema = z.object({
  thread_id: text,
  thread_title: optionalText,
  source_cwd: optionalText,
  status: text,
  created_at: timestamp,
  updated_at: timestamp,
});

type Report = ReturnType<typeof reportSourceIssues>;
type CodexCandidate = NativeAutomationCandidate & { readonly agent: "codex" };

function decodeDefinition(
  value: unknown,
  home: string,
  report: Report,
  store: "codex-database" | "codex-legacy",
): CodexCandidate | null {
  const parsed = definitionSchema.safeParse(value);
  if (!parsed.success) {
    report(store, "invalid");
    return null;
  }
  const row = parsed.data;
  let configuredFolders: string[] = [];
  try {
    configuredFolders = folders.parse(
      typeof row.cwds === "string" ? JSON.parse(row.cwds) : (row.cwds ?? []),
    );
  } catch {
    report(store, "invalid");
    return null;
  }
  const fields = {
    agent: "codex",
    sourceHome: home,
    sourceAutomationId: row.id,
    conversationSource: { backendKind: "codex", nativeHome: home },
    name: row.name,
    prompt: row.prompt,
    sourceStatus: row.status === "ACTIVE" ? "active" : "paused",
    schedule: normalizeCodexAutomationRrule(row.rrule),
    executionEnvironment: row.execution_environment ?? "local",
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    notificationPolicy: row.notification_policy,
    runs: [],
  } as const;
  if (row.kind === "heartbeat") {
    const target = row.target_thread_id;
    return {
      ...fields,
      kind: "heartbeat",
      folders: [],
      ...(target &&
        !target.startsWith("pending:") && { heartbeatTarget: { nativeSessionId: target } }),
    };
  }
  return {
    ...fields,
    kind: "cron",
    folders: configuredFolders,
    localEnvironmentConfigPath: row.local_environment_config_path,
  };
}

function readDefinitions(
  db: DatabaseSync,
  home: string,
  legacyDirectories: readonly string[],
  owner: CodexNativeAutomationSource["owner"],
  report: Report,
) {
  const columns = tableColumns(db, "automations");
  if (columns.size === 0) {
    report("codex-database", "missing");
    return { definitions: [], fallbackDirectories: legacyDirectories };
  }
  const optional = [
    "kind",
    "model",
    "reasoning_effort",
    "target_thread_id",
    "execution_environment",
    "local_environment_config_path",
    "notification_policy",
  ].map((name) => (columns.has(name) ? name : `NULL AS ${name}`));
  const scope = ["account_id", "user_id", "installation_id"];
  const scoped = owner && scope.every((column) => columns.has(column));
  const scopeFilter = scoped
    ? "AND ((account_id = ? AND user_id = ? AND installation_id = ?) OR (account_id IS NULL AND user_id IS NULL AND installation_id IS NULL))"
    : "";
  const localFilter = columns.has("remote_host") ? "AND remote_host IS NULL" : "";
  const rows = db
    .prepare(`
    SELECT id, name, prompt, status, rrule, cwds, ${optional.join(", ")}
    FROM automations WHERE status IN ('ACTIVE', 'PAUSED') ${scopeFilter} ${localFilter}
    ORDER BY updated_at DESC, id LIMIT ?
  `)
    .all(
      ...(scoped ? [owner.accountId, owner.userId, owner.installationId] : []),
      NATIVE_AUTOMATION_TASK_LIMIT + 1,
    );
  if (rows.length > NATIVE_AUTOMATION_TASK_LIMIT) report("codex-database", "limit");
  const definitions = rows
    .slice(0, NATIVE_AUTOMATION_TASK_LIMIT)
    .flatMap((row) => decodeDefinition(row, home, report, "codex-database") ?? []);

  // Tombstones and re-keyed definitions still supersede the legacy file.
  const alias = columns.has("legacy_automation_id") ? "OR legacy_automation_id = ?" : "";
  const hasDefinition = db.prepare(`SELECT 1 FROM automations WHERE id = ? ${alias} LIMIT 1`);
  const fallbackDirectories = legacyDirectories.filter((path) => {
    const id = basename(path);
    return !hasDefinition.get(...(alias ? [id, id] : [id]));
  });
  return { definitions, fallbackDirectories };
}

function tableColumns(db: DatabaseSync, table: "automations" | "automation_runs") {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

function readRuns(
  db: DatabaseSync,
  taskIds: readonly string[],
  report: Report,
): ReadonlyMap<string, readonly NativeAutomationRun[]> {
  if (taskIds.length === 0) return new Map();
  if (tableColumns(db, "automation_runs").size === 0) {
    report("codex-runs", "missing");
    return new Map();
  }
  const statement = db.prepare(`
    SELECT thread_id, status, thread_title, source_cwd, created_at, updated_at
    FROM automation_runs
    WHERE automation_id = ? AND thread_id NOT LIKE 'pending:%'
    ORDER BY created_at DESC, updated_at DESC, thread_id LIMIT ?
  `);
  const runs = new Map<string, readonly NativeAutomationRun[]>();
  for (const id of taskIds) {
    const rows = statement.all(id, NATIVE_AUTOMATION_RUN_LIMIT + 1);
    if (rows.length > NATIVE_AUTOMATION_RUN_LIMIT) report("codex-runs", "limit");
    runs.set(
      id,
      rows.slice(0, NATIVE_AUTOMATION_RUN_LIMIT).flatMap((row) => {
        const result = runSchema.safeParse(row);
        if (!result.success) {
          report("codex-runs", "invalid");
          return [];
        }
        const run = result.data;
        return [
          {
            nativeSessionId: run.thread_id,
            title: run.thread_title,
            cwd: run.source_cwd,
            createdAt: run.created_at,
            updatedAt: run.updated_at,
            archived: run.status === "ARCHIVED",
          },
        ];
      }),
    );
  }
  return runs;
}

async function readLegacyDefinition(
  directory: string,
  home: string,
  report: Report,
  signal: AbortSignal,
) {
  let value;
  try {
    value = await readSourceText(join(directory, "automation.toml"), signal);
  } catch (error) {
    if (sourceReadReason(error) !== "missing") report("codex-legacy", "unreadable");
    return null;
  }
  try {
    if (value === null) {
      report("codex-legacy", "limit");
      return null;
    }
    const document = parseToml(value);
    if (
      document.id !== basename(directory) ||
      (document.version !== undefined && document.version !== 1)
    ) {
      report("codex-legacy", "invalid");
      return null;
    }
    if (document.status === "DELETED") return null;
    return decodeDefinition(document, home, report, "codex-legacy");
  } catch {
    report("codex-legacy", "invalid");
    return null;
  }
}

async function readMemory(directory: string, report: Report, signal: AbortSignal) {
  try {
    const memory = await readSourceText(join(directory, "memory.md"), signal);
    if (memory === null) report("codex-memory", "limit");
    return memory ?? undefined;
  } catch (error) {
    if (sourceReadReason(error) !== "missing") report("codex-memory", "unreadable");
    return undefined;
  }
}

async function readCodexSource(
  input: CodexNativeAutomationSource,
  signal: AbortSignal,
): Promise<NativeAutomationReadResult> {
  const issues: NativeAutomationReadIssue[] = [];
  let home: string;
  try {
    home = await canonicalNativeSessionHome(input.codexHome);
  } catch (error) {
    return {
      candidates: [],
      issues: [
        { store: "codex-home", reason: sourceReadReason(error), sourceHome: input.codexHome },
      ],
    };
  }
  const report = reportSourceIssues(home, issues);
  const legacyRoot = join(home, "automations");
  let legacyDirectories: readonly string[] = [];
  try {
    const found = await sourceEntries({
      directory: legacyRoot,
      accept: (entry) => entry.isDirectory(),
      signal,
    });
    if (found.limited || found.entries.length > NATIVE_AUTOMATION_TASK_LIMIT)
      report("codex-legacy", "limit");
    legacyDirectories = found.entries.sort().slice(0, NATIVE_AUTOMATION_TASK_LIMIT);
  } catch (error) {
    report("codex-legacy", sourceReadReason(error));
  }

  const dbPath = join(home, "sqlite", "codex.db");
  let databaseExists = true;
  try {
    if (!(await lstat(dbPath)).isFile()) throw new Error("Expected a regular SQLite source");
  } catch (error) {
    const reason = sourceReadReason(error);
    report("codex-database", reason);
    if (reason !== "missing") return { candidates: [], issues };
    databaseExists = false;
  }

  signal.throwIfAborted();
  let definitions: readonly CodexCandidate[] = [];
  let fallbackDirectories = legacyDirectories;
  let runsById: ReadonlyMap<string, readonly NativeAutomationRun[]> = new Map();
  if (databaseExists) {
    try {
      using db = new DatabaseSync(dbPath, { readOnly: true });
      // Definitions, tombstones, and run links come from one committed SQLite snapshot.
      db.exec("BEGIN");
      ({ definitions, fallbackDirectories } = readDefinitions(
        db,
        home,
        legacyDirectories,
        input.owner,
        report,
      ));
      try {
        runsById = readRuns(
          db,
          [
            ...definitions
              .filter(({ kind }) => kind === "cron")
              .map(({ sourceAutomationId }) => sourceAutomationId),
            ...fallbackDirectories.map((path) => basename(path)),
          ],
          report,
        );
      } catch {
        report("codex-runs", "unreadable");
      }
    } catch {
      report("codex-database", "unreadable");
      return { candidates: [], issues };
    }
  }

  const all = [...definitions];
  for (const directory of fallbackDirectories) {
    signal.throwIfAborted();
    if (all.length >= NATIVE_AUTOMATION_TASK_LIMIT) {
      report("codex-legacy", "limit");
      break;
    }
    const candidate = await readLegacyDefinition(directory, home, report, signal);
    if (candidate) all.push(candidate);
  }
  const memoryDirectories = new Map(
    legacyDirectories.map((directory) => [basename(directory), directory]),
  );
  const candidates = [];
  for (const candidate of all) {
    signal.throwIfAborted();
    const directory = memoryDirectories.get(candidate.sourceAutomationId);
    const memory =
      directory === undefined ? undefined : await readMemory(directory, report, signal);
    const runs =
      candidate.kind === "cron" ? (runsById.get(candidate.sourceAutomationId) ?? []) : [];
    candidates.push({ ...candidate, memory, runs });
  }
  return { candidates, issues };
}

/** Reads the production Desktop database and legacy definitions from the configured Codex home. */
export function readCodexNativeAutomations(
  input: CodexNativeAutomationSource,
): Effect.Effect<NativeAutomationReadResult> {
  return Effect.promise((signal) => readCodexSource(input, signal));
}

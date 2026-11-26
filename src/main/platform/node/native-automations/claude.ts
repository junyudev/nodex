// @effect-diagnostics asyncFunction:off -- Filesystem reads are the Node capability boundary.
import { basename, isAbsolute, join, posix, win32 } from "node:path";
import * as Effect from "effect/Effect";
import { parseDocument } from "yaml";
import { z } from "zod";
import {
  NATIVE_AUTOMATION_RUN_LIMIT,
  type NativeAutomationCandidate,
  type NativeAutomationRun,
  type NativeAutomationSchedule,
} from "../../../../shared/native-automation-import";
import { claudeCronToRrule } from "../../../../shared/native-automation-schedule";
import { readSkillHeader } from "../../../../shared/skill-document/frontmatter";
import { canonicalAcpProfilePath } from "../AcpProfilePaths";
import { hostEnvironmentValue } from "../HostExecutableSearch";
import { canonicalNativeSessionHome } from "../NativeSessionCatalogPaths";
import {
  NATIVE_AUTOMATION_DIRECTORY_SCAN_LIMIT,
  NATIVE_AUTOMATION_TASK_LIMIT,
  readSourceText,
  reportSourceIssues,
  sourceEntries,
  sourceReadReason,
  type NativeAutomationReadIssue,
  type NativeAutomationReadResult,
} from "./source-files";

export interface ClaudeNativeAutomationSource {
  readonly userDataHome: string;
  /** The Desktop CLI transcript home and the Nodex profile that reads that same directory. */
  readonly nativeHome: string;
  readonly instanceConfigId: string;
}

/** Resolves Desktop's standard and third-party-provider user-data locations. */
export function claudeDesktopUserDataHomes(input: {
  readonly platform: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory: string;
}): readonly string[] {
  const { platform, environment, homeDirectory } = input;
  const env = (name: string) => hostEnvironmentValue(environment, name, platform);
  const path = platform === "win32" ? win32 : posix;
  const custom = env("CLAUDE_USER_DATA_DIR");
  if (custom && path.isAbsolute(custom)) return [custom];
  if (platform === "win32") {
    const roaming = env("APPDATA") || path.join(homeDirectory, "AppData", "Roaming");
    return [path.join(roaming, "Claude"), path.join(env("LOCALAPPDATA") || roaming, "Claude-3p")];
  }
  const xdgConfig = env("XDG_CONFIG_HOME");
  const directory =
    platform === "darwin"
      ? path.join(homeDirectory, "Library", "Application Support")
      : xdgConfig && path.isAbsolute(xdgConfig)
        ? xdgConfig
        : path.join(homeDirectory, ".config");
  return [path.join(directory, "Claude"), path.join(directory, "Claude-3p")];
}

const text = z.string().trim().min(1);
const timestamp = z.number().int().nonnegative();
const taskFileSchema = z.object({ scheduledTasks: z.array(z.unknown()) });
const taskSchema = z.object({
  id: text,
  displayName: z.string().optional(),
  filePath: text,
  enabled: z.boolean(),
  createdAt: timestamp,
  model: z.string().optional(),
  cwd: text.optional(),
  userSelectedFolders: z.array(text).optional(),
  useWorktree: z.boolean().optional(),
  cronExpression: z.string().optional(),
  fireAt: timestamp.optional(),
  place: z.unknown().optional(),
});

const sessionLinkSchema = z.object({ scheduledTaskId: z.string().optional() });
const runSchema = z.object({
  cliSessionId: text,
  title: z.string().optional(),
  cwd: z.string().optional(),
  createdAt: timestamp,
  lastActivityAt: timestamp.optional(),
  isArchived: z.boolean().optional(),
});

type ClaudeTask = z.infer<typeof taskSchema>;
type Report = ReturnType<typeof reportSourceIssues>;
type ClaudeCandidate = NativeAutomationCandidate & { readonly agent: "claude" };

function claudeTaskSchedule(task: ClaudeTask): NativeAutomationSchedule {
  if (task.cronExpression !== undefined) return claudeCronToRrule(task.cronExpression);
  return { kind: "unsupported", reason: task.fireAt === undefined ? "manual" : "one-shot" };
}

function skillModel(skill: string, bodyStart: number): string | undefined {
  const frontmatter = skill
    .slice(0, bodyStart)
    .trim()
    .split(/\r\n|\r|\n/u)
    .slice(1, -1);
  if (!frontmatter.length) return undefined;
  const value: unknown = parseDocument(frontmatter.join("\n")).get("model");
  if (typeof value !== "string") return undefined;
  const model = value.trim();
  return !model || /^(default|inherit)$/iu.test(model) ? undefined : model;
}

async function readClaudeJson(
  path: string,
  store: "claude-tasks" | "claude-runs",
  report: Report,
  signal: AbortSignal,
): Promise<unknown> {
  let raw;
  try {
    raw = await readSourceText(path, signal);
  } catch (error) {
    report(store, sourceReadReason(error));
    return undefined;
  }
  if (raw === null) {
    report(store, "limit");
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    report(store, "invalid");
    return undefined;
  }
}

async function readTask(
  task: ClaudeTask,
  candidateSource: ClaudeCandidate["conversationSource"],
  home: string,
  report: Report,
  signal: AbortSignal,
): Promise<ClaudeCandidate | null> {
  if (!isAbsolute(task.filePath) || basename(task.filePath) !== "SKILL.md") {
    report("claude-skill", "invalid");
    return null;
  }
  let skill;
  try {
    skill = await readSourceText(task.filePath, signal);
  } catch (error) {
    report("claude-skill", sourceReadReason(error));
    return null;
  }
  if (skill === null) {
    report("claude-skill", "limit");
    return null;
  }
  const header = readSkillHeader(skill);
  if (header.reason) {
    report("claude-skill", "invalid");
    return null;
  }
  return {
    agent: "claude",
    kind: "cron",
    sourceHome: home,
    sourceAutomationId: task.id,
    conversationSource: candidateSource,
    name: task.displayName?.trim() || header.fields.name.value?.trim() || task.id,
    prompt: skill.slice(header.bodyStart).trim(),
    sourceStatus: task.enabled ? "active" : "paused",
    model: task.model?.trim() || skillModel(skill, header.bodyStart),
    executionEnvironment: task.useWorktree ? "worktree" : "local",
    folders: task.cwd ? [task.cwd] : [],
    additionalFolders: task.userSelectedFolders?.filter((folder) => folder !== task.cwd),
    schedule: claudeTaskSchedule(task),
    runs: [],
  };
}

async function readPartitionTasks(home: string, report: Report, signal: AbortSignal) {
  const raw = await readClaudeJson(
    join(home, "scheduled-tasks.json"),
    "claude-tasks",
    report,
    signal,
  );
  if (raw === undefined) return [];
  const file = taskFileSchema.safeParse(raw);
  if (!file.success) {
    report("claude-tasks", "invalid");
    return [];
  }
  const tasks = new Map<string, ClaudeTask>();
  for (const row of file.data.scheduledTasks) {
    const task = taskSchema.safeParse(row);
    if (!task.success) {
      report("claude-tasks", "invalid");
      continue;
    }
    // SSH and other off-device places do not use the local CLI history.
    if (task.data.place != null || tasks.has(task.data.id)) continue;
    tasks.set(task.data.id, task.data);
  }
  return [...tasks.values()].sort(
    (left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id),
  );
}

function latestRuns(runs: NativeAutomationRun[], report: Report) {
  const seen = new Set<string>();
  const sorted = runs
    .sort(
      (left, right) =>
        right.createdAt - left.createdAt ||
        right.updatedAt - left.updatedAt ||
        left.nativeSessionId.localeCompare(right.nativeSessionId),
    )
    .filter(({ nativeSessionId }) => {
      if (seen.has(nativeSessionId)) return false;
      seen.add(nativeSessionId);
      return true;
    });
  if (sorted.length > NATIVE_AUTOMATION_RUN_LIMIT) report("claude-runs", "limit");
  return sorted.slice(0, NATIVE_AUTOMATION_RUN_LIMIT);
}

async function readPartitionRuns(
  home: string,
  ids: ReadonlySet<string>,
  report: Report,
  signal: AbortSignal,
  maxEntries: number,
) {
  const runsByTask = new Map<string, NativeAutomationRun[]>();
  const files = await sourceEntries({
    directory: home,
    accept: (entry) =>
      entry.isFile() && entry.name.startsWith("local_") && entry.name.endsWith(".json"),
    signal,
    maxEntries,
  });
  if (files.limited) report("claude-runs", "limit");
  for (const file of files.entries) {
    signal.throwIfAborted();
    const raw = await readClaudeJson(file, "claude-runs", report, signal);
    const link = sessionLinkSchema.safeParse(raw).data?.scheduledTaskId;
    if (!link || !ids.has(link)) continue;
    const parsed = runSchema.safeParse(raw);
    if (!parsed.success) {
      // A launch can have a Desktop record before it has a CLI conversation.
      if (typeof raw === "object" && raw !== null && "cliSessionId" in raw && raw.cliSessionId)
        report("claude-runs", "invalid");
      continue;
    }
    const row = parsed.data;
    const runs = runsByTask.get(link) ?? [];
    runs.push({
      nativeSessionId: row.cliSessionId,
      title: row.title,
      cwd: row.cwd,
      createdAt: row.createdAt,
      updatedAt: row.lastActivityAt ?? row.createdAt,
      archived: row.isArchived ?? false,
    });
    runsByTask.set(link, runs);
  }
  return { runsByTask, scanned: files.scanned };
}

async function readOrganizations(home: string, report: Report, signal: AbortSignal) {
  const directories = (directory: string, maxEntries?: number) =>
    sourceEntries({ directory, accept: (entry) => entry.isDirectory(), signal, maxEntries });
  const sessions = await canonicalNativeSessionHome(join(home, "claude-code-sessions"));
  const accounts = await directories(sessions);
  const organizations: string[] = [];
  let budget = NATIVE_AUTOMATION_DIRECTORY_SCAN_LIMIT - accounts.scanned;
  if (accounts.limited) report("claude-tasks", "limit");
  for (const account of accounts.entries.sort()) {
    signal.throwIfAborted();
    if (budget <= 0) {
      report("claude-tasks", "limit");
      break;
    }
    try {
      const found = await directories(account, budget);
      budget -= found.scanned;
      if (found.limited) report("claude-tasks", "limit");
      organizations.push(...found.entries.sort());
    } catch (error) {
      report("claude-tasks", sourceReadReason(error));
    }
  }
  if (organizations.length > NATIVE_AUTOMATION_TASK_LIMIT) report("claude-tasks", "limit");
  return organizations.slice(0, NATIVE_AUTOMATION_TASK_LIMIT);
}

async function readClaudeSource(
  input: ClaudeNativeAutomationSource,
  signal: AbortSignal,
): Promise<NativeAutomationReadResult> {
  const issues: NativeAutomationReadIssue[] = [];
  let desktopHome;
  try {
    desktopHome = await canonicalNativeSessionHome(input.userDataHome);
  } catch (error) {
    return {
      candidates: [],
      issues: [
        {
          store: "claude-desktop",
          reason: sourceReadReason(error),
          sourceHome: input.userDataHome,
        },
      ],
    };
  }
  const report = reportSourceIssues(desktopHome, issues);
  let nativeHome;
  try {
    nativeHome = await canonicalAcpProfilePath(input.nativeHome);
  } catch (error) {
    report("claude-history", sourceReadReason(error));
    return { candidates: [], issues };
  }
  let partitions;
  try {
    partitions = await readOrganizations(desktopHome, report, signal);
  } catch (error) {
    report("claude-tasks", sourceReadReason(error));
    return { candidates: [], issues };
  }
  const source = {
    backendKind: "claude",
    nativeHome,
    instanceConfigId: input.instanceConfigId,
  } as const;
  const candidates: ClaudeCandidate[] = [];
  let runScanBudget = NATIVE_AUTOMATION_DIRECTORY_SCAN_LIMIT;
  for (const partition of partitions) {
    signal.throwIfAborted();
    const remaining = NATIVE_AUTOMATION_TASK_LIMIT - candidates.length;
    const partitionReport = reportSourceIssues(partition, issues);
    const tasks = await readPartitionTasks(partition, partitionReport, signal);
    if (tasks.length > remaining) partitionReport("claude-tasks", "limit");
    const selected: ClaudeCandidate[] = [];
    for (const task of tasks.slice(0, remaining)) {
      const candidate = await readTask(task, source, partition, partitionReport, signal);
      if (candidate) selected.push(candidate);
    }
    if (!selected.length) continue;
    let runsByTask: ReadonlyMap<string, NativeAutomationRun[]> = new Map();
    if (runScanBudget === 0) partitionReport("claude-runs", "limit");
    else {
      try {
        const ids = new Set(selected.map(({ sourceAutomationId }) => sourceAutomationId));
        const result = await readPartitionRuns(
          partition,
          ids,
          partitionReport,
          signal,
          runScanBudget,
        );
        runScanBudget -= result.scanned;
        runsByTask = result.runsByTask;
      } catch (error) {
        partitionReport("claude-runs", sourceReadReason(error));
      }
    }
    for (const candidate of selected) {
      const runs = latestRuns(runsByTask.get(candidate.sourceAutomationId) ?? [], partitionReport);
      candidates.push({ ...candidate, runs });
    }
  }
  return { candidates, issues };
}

/** Reads local Claude Desktop tasks and links their Desktop run records to Claude Code IDs. */
export function readClaudeNativeAutomations(
  input: ClaudeNativeAutomationSource,
): Effect.Effect<NativeAutomationReadResult> {
  return Effect.promise((signal) => readClaudeSource(input, signal));
}

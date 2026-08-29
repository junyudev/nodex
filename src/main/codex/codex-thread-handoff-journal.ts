import path from "node:path";
import { z } from "zod";
import type { CodexExecutionHostFileDescriptor } from "./codex-execution-host-file-transfer";
import type { CodexWorktreeWorkerPreparedHandoff } from "./codex-worktree-worker-protocol";

export const CODEX_THREAD_HANDOFF_JOURNAL_SCHEMA_VERSION = 1 as const;
export const CODEX_THREAD_HANDOFF_JOURNAL_MAX_BYTES = 512 * 1024;
export const CODEX_THREAD_HANDOFF_JOURNAL_MAX_ENTRIES = 128;

export const CODEX_THREAD_HANDOFF_PHASES = [
  "queued",
  "stopping-turn",
  "preparing-destination",
  "switching-runtime",
  "committing-location",
  "transferring-owner",
  "cleaning-source",
  "completed",
  "completed-with-warning",
  "rolling-back",
  "failed",
] as const;

export type CodexThreadHandoffPhase = (typeof CODEX_THREAD_HANDOFF_PHASES)[number];

export interface CodexThreadExecutionLocation {
  readonly hostId: string;
  readonly cwd: string;
  readonly workspaceRoots: readonly string[];
  readonly managedWorktreePath: string | null;
  readonly projectId: string | null;
  readonly projectlessOutputDirectory: string | null;
  readonly projectlessWorkspaceBrowserRoot: string | null;
}

export interface CodexCrossHostPreparedHandoff {
  readonly direction: "cross-host";
  readonly sourceHostId: string;
  readonly destinationHostId: string;
  readonly transferId: string;
  readonly sourceBranch: string;
  readonly sourceWorkspaceRoot: string;
  readonly sourceManagedWorktreePath: string | null;
  readonly destinationWorkspaceRoot: string;
  readonly destinationGitRoot: string;
  readonly managedWorktreePath: string;
  readonly createdWorktree: true;
  readonly sourceRepositoryPath: string;
  readonly destinationRepositoryPath: string;
  readonly sourceTemporaryRef: string;
  readonly destinationTemporaryRef: string;
  readonly sourceStagingRoot: string;
  readonly destinationStagingRoot: string;
  readonly destinationManagedRoot: string;
  readonly destinationCodexHome: string;
  readonly relayRoot: string;
  readonly sourceBundle: CodexExecutionHostFileDescriptor;
  readonly destinationBundle: CodexExecutionHostFileDescriptor;
  readonly sourceRollout: CodexExecutionHostFileDescriptor;
  readonly destinationRollout: CodexExecutionHostFileDescriptor;
  readonly destinationRolloutCreated: boolean;
  readonly warnings: readonly string[];
}

export type CodexThreadHandoffPreparedArtifact =
  | CodexWorktreeWorkerPreparedHandoff
  | CodexCrossHostPreparedHandoff;

export interface CodexThreadHandoffJournalEntry {
  readonly schemaVersion: typeof CODEX_THREAD_HANDOFF_JOURNAL_SCHEMA_VERSION;
  readonly operationId: string;
  readonly threadId: string;
  readonly phase: CodexThreadHandoffPhase;
  readonly source: CodexThreadExecutionLocation;
  readonly requestedDestinationHostId: string | null;
  readonly destination: CodexThreadExecutionLocation | null;
  readonly prepared: CodexThreadHandoffPreparedArtifact | null;
  readonly runtimeSwitched: boolean;
  readonly coreCommitted: boolean;
  readonly followUpPrompt: string | null;
  readonly followUpDispatchStarted: boolean;
  readonly warnings: readonly string[];
  readonly lastError: string | null;
  readonly failedPhase: CodexThreadHandoffPhase | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt: number | null;
}

const absolutePath = z.string().min(1).max(8_192).refine(path.isAbsolute);
const locationSchema = z
  .object({
    hostId: z.string().min(1).max(512),
    cwd: absolutePath,
    workspaceRoots: z.array(absolutePath).max(128),
    managedWorktreePath: absolutePath.nullable(),
    projectId: z.string().min(1).max(1_024).nullable(),
    projectlessOutputDirectory: absolutePath.nullable(),
    projectlessWorkspaceBrowserRoot: absolutePath.nullable(),
  })
  .strict();
const preparedCommon = {
  sourceBranch: z.string().min(1).max(1_024),
  sourceWorkspaceRoot: absolutePath,
  destinationWorkspaceRoot: absolutePath,
  destinationGitRoot: absolutePath,
  managedWorktreePath: absolutePath,
  warnings: z.array(z.string().max(64_000)).max(128),
};
const fileDescriptorSchema = z
  .object({
    path: absolutePath,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    size: z
      .number()
      .int()
      .nonnegative()
      .max(2 * 1024 * 1024 * 1024),
  })
  .strict();
const preparedSchema = z.discriminatedUnion("direction", [
  z
    .object({
      direction: z.literal("to-worktree"),
      ...preparedCommon,
      localCheckoutBranch: z.string().min(1).max(1_024),
      destinationBranch: z.string().min(1).max(1_024),
      createdWorktree: z.literal(true),
    })
    .strict(),
  z
    .object({
      direction: z.literal("to-checkout"),
      ...preparedCommon,
      localCheckoutPreviousBranch: z.string().min(1).max(1_024).nullable(),
      createdWorktree: z.literal(false),
    })
    .strict(),
  z
    .object({
      direction: z.literal("cross-host"),
      ...preparedCommon,
      sourceHostId: z.string().min(1).max(512),
      destinationHostId: z.string().min(1).max(512),
      transferId: z.string().regex(/^[a-f0-9]{32}$/u),
      sourceManagedWorktreePath: absolutePath.nullable(),
      createdWorktree: z.literal(true),
      sourceRepositoryPath: absolutePath,
      destinationRepositoryPath: absolutePath,
      sourceTemporaryRef: z.string().min(1).max(1_024),
      destinationTemporaryRef: z.string().min(1).max(1_024),
      sourceStagingRoot: absolutePath,
      destinationStagingRoot: absolutePath,
      destinationManagedRoot: absolutePath,
      destinationCodexHome: absolutePath,
      relayRoot: absolutePath,
      sourceBundle: fileDescriptorSchema,
      destinationBundle: fileDescriptorSchema,
      sourceRollout: fileDescriptorSchema,
      destinationRollout: fileDescriptorSchema,
      destinationRolloutCreated: z.boolean(),
    })
    .strict(),
]);
const entrySchema = z
  .object({
    schemaVersion: z.literal(CODEX_THREAD_HANDOFF_JOURNAL_SCHEMA_VERSION),
    operationId: z.string().min(1).max(1_024),
    threadId: z.string().min(1).max(1_024),
    phase: z.enum(CODEX_THREAD_HANDOFF_PHASES),
    source: locationSchema,
    requestedDestinationHostId: z.string().min(1).max(512).nullable().default(null),
    destination: locationSchema.nullable(),
    prepared: preparedSchema.nullable(),
    runtimeSwitched: z.boolean(),
    coreCommitted: z.boolean(),
    followUpPrompt: z.string().max(64_000).nullable(),
    followUpDispatchStarted: z.boolean(),
    warnings: z.array(z.string().max(64_000)).max(128),
    lastError: z.string().max(64_000).nullable(),
    failedPhase: z.enum(CODEX_THREAD_HANDOFF_PHASES).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative().nullable(),
  })
  .strict();
const journalSchema = z
  .object({
    schemaVersion: z.literal(CODEX_THREAD_HANDOFF_JOURNAL_SCHEMA_VERSION),
    entries: z.array(entrySchema).max(CODEX_THREAD_HANDOFF_JOURNAL_MAX_ENTRIES),
  })
  .strict();

export function isTerminalCodexThreadHandoff(entry: CodexThreadHandoffJournalEntry): boolean {
  return (
    entry.phase === "completed" ||
    entry.phase === "completed-with-warning" ||
    entry.phase === "failed"
  );
}

export function parseCodexThreadHandoffJournalEntry(
  input: unknown,
): CodexThreadHandoffJournalEntry {
  return entrySchema.parse(input) as CodexThreadHandoffJournalEntry;
}

export function parseCodexThreadHandoffJournal(
  raw: string,
): readonly CodexThreadHandoffJournalEntry[] | null {
  try {
    const parsed = journalSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success
      ? parsed.data.entries.map((entry) => entry as CodexThreadHandoffJournalEntry)
      : null;
  } catch {
    return null;
  }
}

export function retainCodexThreadHandoffJournalEntries(
  entries: Iterable<CodexThreadHandoffJournalEntry>,
): readonly CodexThreadHandoffJournalEntry[] {
  const newestFirst = [...entries].sort((left, right) => right.updatedAt - left.updatedAt);
  const active = newestFirst.filter((entry) => !isTerminalCodexThreadHandoff(entry));
  const terminal = newestFirst
    .filter(isTerminalCodexThreadHandoff)
    .slice(0, Math.max(0, CODEX_THREAD_HANDOFF_JOURNAL_MAX_ENTRIES - active.length));
  return [...active, ...terminal].sort((left, right) => left.createdAt - right.createdAt);
}

export function resolveCodexThreadHandoffJournalPath(runtimeStateHome: string): string {
  return path.join(runtimeStateHome, "recovery", "thread-handoffs-v1.json");
}

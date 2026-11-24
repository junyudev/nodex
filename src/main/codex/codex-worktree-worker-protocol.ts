import path from "node:path";
import { z } from "zod";
import { isCodexWorktreeEnvironmentConfigPath } from "../../shared/codex-worktree-environment-path";
import { WorktreeStartingStateSchema } from "../../shared/schemas/worktree-starting-state";

export const CODEX_WORKTREE_HANDOFF_STEPS = [
  "create-new-worktree",
  "stash-source-changes",
  "detach-worktree-branch",
  "checkout-local-branch",
  "checkout-worktree-branch",
  "apply-changes-to-worktree",
  "apply-changes-to-local",
  "snapshot-source",
  "bundle-source",
  "import-bundle",
] as const;

const HandoffStepSchema = z.enum(CODEX_WORKTREE_HANDOFF_STEPS);
const HandoffStepStatusSchema = z.enum(["started", "completed", "skipped", "failed"]);
const RemovalReasonSchema = z.enum([
  "page-completed",
  "archive",
  "automatic-retention",
  "automation-archive",
  "handoff",
  "settings-delete",
  "failed-create",
  "retry",
  "cancel",
]);
const SnapshotPolicySchema = z.enum(["required", "best-effort", "ephemeral"]);

export type CodexWorktreeHandoffStep = z.output<typeof HandoffStepSchema>;
export type CodexWorktreeHandoffStepStatus = z.output<typeof HandoffStepStatusSchema>;
export type CodexManagedWorktreeRemovalReason = z.output<typeof RemovalReasonSchema>;
export type CodexManagedWorktreeSnapshotPolicy = z.output<typeof SnapshotPolicySchema>;

function nonEmptyString(maxLength: number) {
  return z
    .string()
    .min(1)
    .max(maxLength)
    .refine((value) => value === value.trim(), {
      message: "Must not have leading or trailing whitespace",
    });
}

const AbsolutePathSchema = nonEmptyString(8_192).refine(path.isAbsolute, {
  message: "Must be an absolute path",
});

/** Git roots belong to the execution host, whose path syntax can differ from Main. */
const ExecutionHostAbsolutePathSchema = nonEmptyString(8_192).refine(
  (value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value),
  { message: "Must be an absolute POSIX or Windows path" },
);

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export const WorktreeWorkerIdSchema = nonEmptyString(1_024);
export const WorktreeWorkerHostIdSchema = nonEmptyString(512);

const identity = { requestId: WorktreeWorkerIdSchema, hostId: WorktreeWorkerHostIdSchema };
const ThreadTitleSchema = z.string().max(4_096);
const BranchNameSchema = nonEmptyString(1_024);
const SnapshotRefSchema = nonEmptyString(1_024);
const CandidateRepositoryPathsSchema = z.array(AbsolutePathSchema).max(128);
const WarningsSchema = z.array(z.string().max(64_000)).max(128).readonly();
const OutcomeSchema = z.enum(["committed", "rolled-back"]);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const TransferIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,200}$/u)
  .refine((value) => value !== "." && value !== "..", { message: "Must not be a dot segment" });

const GitRootInputSchema = z.strictObject({ ...identity, cwd: ExecutionHostAbsolutePathSchema });
const GitRootResultSchema = z.object({ root: ExecutionHostAbsolutePathSchema.nullable() });

const CreateInputSchema = z.strictObject({
  ...identity,
  repositoryPath: AbsolutePathSchema,
  nodexHome: AbsolutePathSchema,
  managedRoot: AbsolutePathSchema,
  projectId: WorktreeWorkerIdSchema,
  targetId: WorktreeWorkerIdSchema,
  threadTitle: ThreadTitleSchema,
  branchPrefix: z.string().nullable().optional(),
  pageWorkspace: z
    .strictObject({
      workspaceId: nonEmptyString(512),
      operationId: nonEmptyString(512),
      branchName: nonEmptyString(256),
      baseCommitOid: z.string().regex(/^[a-f0-9]{40,64}$/),
      worktreePath: AbsolutePathSchema,
    })
    .readonly()
    .optional(),
  mode: z.enum(["autoBranch", "detachedHead"]).optional(),
  startingState: WorktreeStartingStateSchema.readonly().nullable(),
  /** Portable path relative to `repositoryPath`, under `.codex/environments`. */
  localEnvironmentConfigPath: z
    .string()
    .refine(isCodexWorktreeEnvironmentConfigPath, {
      message: "Must be a workspace-relative .toml path inside .codex/environments",
    })
    .nullable(),
  setUpSyncedBranch: z.boolean(),
  propagateLocalWorkspaceFiles: z.boolean(),
});

const worktreeRoots = {
  worktreeGitRoot: AbsolutePathSchema,
  worktreeWorkspaceRoot: AbsolutePathSchema,
};
const CreateResultSchema = z.strictObject({
  ...worktreeRoots,
  branchName: z.string().max(256).nullable().optional(),
  setupError: z.string().max(64_000).nullable(),
  shellEnvironment: z
    .object({
      version: z.literal(1),
      set: z.record(z.string(), z.string()).readonly(),
      exclude: z.array(z.string()).readonly(),
    })
    .readonly()
    .nullable(),
});

const PathInputSchema = z.strictObject({ ...identity, worktreeGitRoot: AbsolutePathSchema });
const ListInputSchema = z.strictObject({ ...identity, managedRoot: AbsolutePathSchema });
const ListEntrySchema = z.object({
  worktreeGitRoot: AbsolutePathSchema,
  /** Null means a named managed residue exists but its Git identity cannot be resolved. */
  repositoryPath: AbsolutePathSchema.nullable(),
  createdAtMs: z.number().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  ownerThreadId: WorktreeWorkerIdSchema.nullable(),
  ownerReadFailed: z.boolean(),
});
const ListResultSchema = z.object({
  entries: z.array(ListEntrySchema.readonly()).max(100_000).readonly(),
});

const InspectShapeSchema = PathInputSchema.extend({
  cwd: AbsolutePathSchema,
  candidateRepositoryPaths: CandidateRepositoryPathsSchema.readonly(),
});
const cwdWithinWorktree = ({ worktreeGitRoot, cwd }: z.output<typeof InspectShapeSchema>) =>
  isPathWithin(worktreeGitRoot, cwd);
const cwdWithinWorktreeIssue = { path: ["cwd"], message: "Must be inside worktreeGitRoot" };
const InspectInputSchema = InspectShapeSchema.refine(cwdWithinWorktree, cwdWithinWorktreeIssue);

const AvailabilitySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available") }),
  z.object({
    state: z.literal("restorable"),
    repositoryPath: AbsolutePathSchema,
    snapshotRef: SnapshotRefSchema,
  }),
  z.object({ state: z.literal("gone") }),
  z.object({
    state: z.literal("unavailable"),
    reason: z.enum(["inspection-failed", "no-candidate-roots"]),
    message: nonEmptyString(64_000),
  }),
]);
const InspectResultSchema = z.object({ availability: AvailabilitySchema.readonly() });

const SnapshotInputSchema = PathInputSchema.extend({ reason: RemovalReasonSchema });
const SnapshotResultSchema = z.object({
  worktreeId: nonEmptyString(128),
  repositoryPath: AbsolutePathSchema,
  snapshotRef: SnapshotRefSchema,
  commitId: nonEmptyString(256),
  changed: z.boolean(),
});
const RemoveInputSchema = SnapshotInputSchema.extend({ snapshotPolicy: SnapshotPolicySchema });
const RemoveResultSchema = z.object({
  removed: z.boolean(),
  alreadyMissing: z.boolean(),
  snapshot: SnapshotResultSchema.readonly().nullable(),
  warnings: z.array(z.string()).max(128).readonly(),
});
const RestoreInputSchema = InspectShapeSchema.extend({
  ownerThreadId: WorktreeWorkerIdSchema.nullable(),
}).refine(cwdWithinWorktree, cwdWithinWorktreeIssue);
const RestoreResultSchema = z.object({
  worktreeGitRoot: AbsolutePathSchema,
  cwd: AbsolutePathSchema,
  repositoryPath: AbsolutePathSchema,
  snapshotRef: SnapshotRefSchema,
  ownerWarning: z.string().max(64_000).nullable(),
});
const SetOwnerInputSchema = PathInputSchema.extend({ ownerThreadId: WorktreeWorkerIdSchema });
const SetOwnerResultSchema = z.object({ ownerThreadId: WorktreeWorkerIdSchema });

const sourceWorkspace = {
  sourceCwd: AbsolutePathSchema,
  sourceWorkspaceRoot: AbsolutePathSchema,
};
const sourceCwdWithinWorkspace = ({
  sourceCwd,
  sourceWorkspaceRoot,
}: {
  readonly sourceCwd: string;
  readonly sourceWorkspaceRoot: string;
}) => isPathWithin(sourceWorkspaceRoot, sourceCwd);
const sourceCwdWithinWorkspaceIssue = {
  path: ["sourceCwd"],
  message: "Must be inside sourceWorkspaceRoot",
};
const allocationWithinManagedRoot = ({
  managedRoot,
  allocatedWorktreePath,
}: {
  readonly managedRoot: string;
  readonly allocatedWorktreePath: string | null;
}) =>
  allocatedWorktreePath === null ||
  (allocatedWorktreePath !== managedRoot && isPathWithin(managedRoot, allocatedWorktreePath));
const allocationWithinManagedRootIssue = {
  path: ["allocatedWorktreePath"],
  message: "Must be inside managedRoot and differ from it",
};
const PrepareHandoffInputSchema = z
  .strictObject({
    ...identity,
    managedRoot: AbsolutePathSchema,
    allocatedWorktreePath: AbsolutePathSchema.nullable(),
    nodexHome: AbsolutePathSchema,
    projectId: WorktreeWorkerIdSchema,
    threadId: WorktreeWorkerIdSchema,
    threadTitle: ThreadTitleSchema,
    ...sourceWorkspace,
    sourceManagedWorktreePath: AbsolutePathSchema.nullable(),
    destinationCheckoutRoot: AbsolutePathSchema.nullable(),
  })
  .refine(allocationWithinManagedRoot, allocationWithinManagedRootIssue)
  .refine(sourceCwdWithinWorkspace, sourceCwdWithinWorkspaceIssue)
  .refine(
    (input) =>
      (input.sourceManagedWorktreePath === null) !== (input.allocatedWorktreePath === null),
    {
      path: ["allocatedWorktreePath"],
      message: "Exactly one of sourceManagedWorktreePath and allocatedWorktreePath must be set",
    },
  );

const preparedHandoff = {
  sourceBranch: BranchNameSchema,
  sourceWorkspaceRoot: AbsolutePathSchema,
  destinationWorkspaceRoot: AbsolutePathSchema,
  destinationGitRoot: AbsolutePathSchema,
  managedWorktreePath: AbsolutePathSchema,
  warnings: WarningsSchema,
};
const PreparedHandoffSchema = z.discriminatedUnion("direction", [
  z.object({
    direction: z.literal("to-worktree"),
    ...preparedHandoff,
    localCheckoutBranch: BranchNameSchema,
    destinationBranch: BranchNameSchema,
    createdWorktree: z.literal(true),
  }),
  z.object({
    direction: z.literal("to-checkout"),
    ...preparedHandoff,
    localCheckoutPreviousBranch: BranchNameSchema.nullable(),
    createdWorktree: z.literal(false),
  }),
]);
const RollbackHandoffInputSchema = z.strictObject({
  ...identity,
  prepared: PreparedHandoffSchema.readonly(),
});
const RollbackHandoffResultSchema = z.object({ rolledBack: z.boolean(), warnings: WarningsSchema });
const CleanupHandoffInputSchema = RollbackHandoffInputSchema.extend({ outcome: OutcomeSchema });
const CleanupHandoffResultSchema = z.object({ cleaned: z.boolean(), warnings: WarningsSchema });

const RepositoryIdentitySchema = z.strictObject({
  displayName: nonEmptyString(512),
  keys: z.array(Sha256Schema).min(1).max(128).readonly(),
});
const repositoryCandidates = {
  repositoryIdentity: RepositoryIdentitySchema.readonly(),
  candidateRepositoryPaths: CandidateRepositoryPathsSchema.min(1).readonly(),
};
const ExportHandoffInputSchema = z
  .strictObject({
    ...identity,
    transferId: TransferIdSchema,
    ...sourceWorkspace,
    stagingRoot: AbsolutePathSchema,
  })
  .refine(sourceCwdWithinWorkspace, sourceCwdWithinWorkspaceIssue);
const ExportHandoffResultSchema = z.object({
  sourceRepositoryPath: AbsolutePathSchema,
  sourceBranch: BranchNameSchema,
  sourceCommit: nonEmptyString(256),
  temporaryRef: nonEmptyString(1_024),
  repositoryIdentity: RepositoryIdentitySchema.readonly(),
  bundle: z
    .object({
      path: AbsolutePathSchema,
      sha256: Sha256Schema,
      size: z.int().nonnegative(),
    })
    .readonly(),
});
const ResolveHandoffRepositoryInputSchema = z.strictObject({
  ...identity,
  ...repositoryCandidates,
});
const ResolveHandoffRepositoryResultSchema = z.object({
  repositoryPath: ExecutionHostAbsolutePathSchema,
});
const ImportHandoffInputSchema = z
  .strictObject({
    ...identity,
    transferId: TransferIdSchema,
    bundlePath: AbsolutePathSchema,
    rolloutPath: AbsolutePathSchema,
    rolloutRelativePath: nonEmptyString(8_192).refine(
      (value) => !path.isAbsolute(value) && !value.split(/[\\/]/u).includes(".."),
      { message: "Must be a relative path without parent segments" },
    ),
    destinationCodexHome: AbsolutePathSchema,
    sourceCommit: nonEmptyString(256),
    ...repositoryCandidates,
    managedRoot: AbsolutePathSchema,
    allocatedWorktreePath: AbsolutePathSchema,
    nodexHome: AbsolutePathSchema,
    projectId: WorktreeWorkerIdSchema,
    threadId: WorktreeWorkerIdSchema,
    threadTitle: ThreadTitleSchema,
  })
  .refine(allocationWithinManagedRoot, allocationWithinManagedRootIssue);
const ImportHandoffResultSchema = z.object({
  destinationRepositoryPath: AbsolutePathSchema,
  destinationWorkspaceRoot: AbsolutePathSchema,
  destinationGitRoot: AbsolutePathSchema,
  managedWorktreePath: AbsolutePathSchema,
  temporaryRef: nonEmptyString(1_024),
  destinationRolloutPath: AbsolutePathSchema,
  destinationRolloutCreated: z.boolean(),
});
const CleanupTransferHandoffInputSchema = z
  .strictObject({
    ...identity,
    transferId: TransferIdSchema,
    stagingRoot: AbsolutePathSchema,
    repositoryPath: AbsolutePathSchema,
    temporaryRef: nonEmptyString(1_024),
    managedRoot: AbsolutePathSchema.nullable(),
    createdWorktreePath: AbsolutePathSchema.nullable(),
    createdRolloutPath: AbsolutePathSchema.nullable(),
    destinationCodexHome: AbsolutePathSchema.nullable(),
    outcome: OutcomeSchema,
  })
  .refine(
    ({ createdWorktreePath, managedRoot }) =>
      createdWorktreePath === null ||
      (managedRoot !== null && isPathWithin(managedRoot, createdWorktreePath)),
    { path: ["createdWorktreePath"], message: "Requires managedRoot and must be inside it" },
  )
  .refine(
    ({ createdRolloutPath, destinationCodexHome }) =>
      createdRolloutPath === null ||
      (destinationCodexHome !== null && isPathWithin(destinationCodexHome, createdRolloutPath)),
    {
      path: ["createdRolloutPath"],
      message: "Requires destinationCodexHome and must be inside it",
    },
  );

function operation<Name extends string, Input extends z.ZodType, Result extends z.ZodType>(
  name: Name,
  input: Input,
  result: Result,
) {
  const discriminator = z.literal(name);
  return {
    name,
    request: z.strictObject({ operation: discriminator, input: input.readonly() }),
    success: z.object({ operation: discriminator, value: result.readonly() }),
  };
}

// Zod discriminated unions require a non-empty tuple. Keep the first entry
// separate when projecting the operation table into request and success schemas.
const [gitRootOperation, ...otherOperations] = [
  operation("git-root", GitRootInputSchema, GitRootResultSchema),
  operation("create", CreateInputSchema, CreateResultSchema),
  operation("list", ListInputSchema, ListResultSchema),
  operation("inspect", InspectInputSchema, InspectResultSchema),
  operation("snapshot", SnapshotInputSchema, SnapshotResultSchema),
  operation("remove", RemoveInputSchema, RemoveResultSchema),
  operation("restore", RestoreInputSchema, RestoreResultSchema),
  operation("set-owner", SetOwnerInputSchema, SetOwnerResultSchema),
  operation("prepare-handoff", PrepareHandoffInputSchema, PreparedHandoffSchema),
  operation("rollback-handoff", RollbackHandoffInputSchema, RollbackHandoffResultSchema),
  operation("cleanup-handoff", CleanupHandoffInputSchema, CleanupHandoffResultSchema),
  operation("export-handoff", ExportHandoffInputSchema, ExportHandoffResultSchema),
  operation(
    "resolve-handoff-repository",
    ResolveHandoffRepositoryInputSchema,
    ResolveHandoffRepositoryResultSchema,
  ),
  operation("import-handoff", ImportHandoffInputSchema, ImportHandoffResultSchema),
  operation(
    "cleanup-transfer-handoff",
    CleanupTransferHandoffInputSchema,
    CleanupHandoffResultSchema,
  ),
] as const;

export const CODEX_WORKTREE_WORKER_OPERATIONS = [
  gitRootOperation.name,
  ...otherOperations.map((entry) => entry.name),
] as const;
export const WorktreeWorkerOperationSchema = z.enum(CODEX_WORKTREE_WORKER_OPERATIONS);
export type CodexWorktreeWorkerOperation = z.output<typeof WorktreeWorkerOperationSchema>;

export const WorktreeWorkerRequestSchema = z.discriminatedUnion("operation", [
  gitRootOperation.request,
  ...otherOperations.map((entry) => entry.request),
]);
export const WorktreeWorkerSuccessSchema = z.discriminatedUnion("operation", [
  gitRootOperation.success,
  ...otherOperations.map((entry) => entry.success),
]);

const HandoffBranchContextSchema = z.strictObject({
  sourceBranch: z.string().max(1_024).nullable(),
  localBranch: z.string().max(1_024).nullable(),
  worktreeBranch: z.string().max(1_024).nullable(),
});
export const WorktreeWorkerEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("output"),
    operation: WorktreeWorkerOperationSchema,
    phase: z.enum(["worktree", "setup", "snapshot", "cleanup", "restore"]),
    stream: z.enum(["stdout", "stderr", "info"]),
    data: z.string(),
  }),
  z.object({
    type: z.literal("path-allocated"),
    operation: WorktreeWorkerOperationSchema.extract([
      "create",
      "prepare-handoff",
      "import-handoff",
    ]),
    ...worktreeRoots,
  }),
  z.object({ type: z.literal("setup-started"), operation: z.literal("create") }),
  z.object({
    type: z.literal("snapshot-started"),
    operation: WorktreeWorkerOperationSchema.extract(["snapshot", "remove"]),
  }),
  z.object({ type: z.literal("cleanup-started"), operation: z.literal("remove") }),
  z.object({ type: z.literal("restore-started"), operation: z.literal("restore") }),
  z.object({
    type: z.literal("handoff-progress"),
    operation: WorktreeWorkerOperationSchema.extract([
      "prepare-handoff",
      "rollback-handoff",
      "export-handoff",
      "import-handoff",
    ]),
    branchContext: HandoffBranchContextSchema.readonly().optional(),
    step: HandoffStepSchema,
    status: HandoffStepStatusSchema,
  }),
]);

type Wire<Schema extends z.ZodType> = Readonly<z.output<Schema>>;

export type CodexWorktreeWorkerRequest = Wire<typeof WorktreeWorkerRequestSchema>;
export type CodexWorktreeWorkerSuccess = Wire<typeof WorktreeWorkerSuccessSchema>;
export type CodexWorktreeWorkerEvent = Wire<typeof WorktreeWorkerEventSchema>;

export type CodexWorktreeWorkerGitRootInput = Wire<typeof GitRootInputSchema>;
export type CodexWorktreeWorkerGitRootResult = Wire<typeof GitRootResultSchema>;
export type CodexWorktreeWorkerCreateInput = Wire<typeof CreateInputSchema>;
export type CodexWorktreeWorkerCreateResult = Wire<typeof CreateResultSchema>;
export type CodexWorktreeWorkerTargetInput = Wire<typeof PathInputSchema>;
export type CodexWorktreeWorkerPathInput = CodexWorktreeWorkerTargetInput;
export type CodexWorktreeWorkerListInput = Wire<typeof ListInputSchema>;
export type CodexWorktreeWorkerListEntry = Wire<typeof ListEntrySchema>;
export type CodexWorktreeWorkerListResult = Wire<typeof ListResultSchema>;
export type CodexWorktreeWorkerInspectInput = Wire<typeof InspectInputSchema>;
export type CodexWorktreeWorkerAvailability = Wire<typeof AvailabilitySchema>;
export type CodexWorktreeWorkerInspectResult = Wire<typeof InspectResultSchema>;
export type CodexWorktreeWorkerSnapshotInput = Wire<typeof SnapshotInputSchema>;
export type CodexWorktreeWorkerSnapshotResult = Wire<typeof SnapshotResultSchema>;
export type CodexWorktreeWorkerRemoveInput = Wire<typeof RemoveInputSchema>;
export type CodexWorktreeWorkerRemoveResult = Wire<typeof RemoveResultSchema>;
export type CodexWorktreeWorkerRestoreInput = Wire<typeof RestoreInputSchema>;
export type CodexWorktreeWorkerRestoreResult = Wire<typeof RestoreResultSchema>;
export type CodexWorktreeWorkerSetOwnerInput = Wire<typeof SetOwnerInputSchema>;
export type CodexWorktreeWorkerSetOwnerResult = Wire<typeof SetOwnerResultSchema>;
export type CodexWorktreeWorkerPrepareHandoffInput = Wire<typeof PrepareHandoffInputSchema>;
export type CodexWorktreeWorkerPreparedHandoff = Wire<typeof PreparedHandoffSchema>;
export type CodexWorktreeWorkerRollbackHandoffInput = Wire<typeof RollbackHandoffInputSchema>;
export type CodexWorktreeWorkerRollbackHandoffResult = Wire<typeof RollbackHandoffResultSchema>;
export type CodexWorktreeWorkerCleanupHandoffInput = Wire<typeof CleanupHandoffInputSchema>;
export type CodexWorktreeWorkerCleanupHandoffResult = Wire<typeof CleanupHandoffResultSchema>;
export type CodexRepositoryIdentity = Wire<typeof RepositoryIdentitySchema>;
export type CodexWorktreeWorkerExportHandoffInput = Wire<typeof ExportHandoffInputSchema>;
export type CodexWorktreeWorkerExportHandoffResult = Wire<typeof ExportHandoffResultSchema>;
export type CodexWorktreeWorkerResolveHandoffRepositoryInput = Wire<
  typeof ResolveHandoffRepositoryInputSchema
>;
export type CodexWorktreeWorkerImportHandoffInput = Wire<typeof ImportHandoffInputSchema>;
export type CodexWorktreeWorkerImportHandoffResult = Wire<typeof ImportHandoffResultSchema>;
export type CodexWorktreeWorkerCleanupTransferHandoffInput = Wire<
  typeof CleanupTransferHandoffInputSchema
>;
export type CodexWorktreeWorkerCleanupTransferHandoffResult = Wire<
  typeof CleanupHandoffResultSchema
>;

export interface CodexWorktreeWorkerOperationOptions {
  readonly signal?: AbortSignal;
  readonly onEvent: (event: CodexWorktreeWorkerEvent) => void;
}

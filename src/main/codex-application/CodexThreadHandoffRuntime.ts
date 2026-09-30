import { resolveCodexThreadHandoffStepLabel } from "../../shared/codex-thread-handoff";
import type {
  CodexAppHandoffOperation,
  CodexAppHandoffStep,
  CodexAppHandoffStatusType,
  CodexThreadHandoffSnapshot,
} from "../../shared/codex-thread-handoff";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  isTerminalCodexThreadHandoff,
  parseCodexThreadHandoffJournalEntry,
  retainCodexThreadHandoffJournalEntries,
  type CodexThreadExecutionLocation,
  type CodexThreadHandoffJournalEntry,
  type CodexThreadHandoffPhase,
} from "../codex/codex-thread-handoff-journal";
import type { CodexThreadHandoffJournalStorage } from "../platform/CodexThreadHandoffJournalStorage";
import { ThreadExecution } from "../host-runtime/ThreadExecution";
import { ManagedWorktreeHandoff, ManagedWorktreeHandoffError } from "./ManagedWorktreeHandoff";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";

export interface CodexThreadHandoffProgress {
  readonly entry: CodexThreadHandoffJournalEntry;
  readonly detail: string | null;
}

export interface CodexStartThreadHandoffInput {
  readonly operationId: string;
  readonly threadId: string;
  readonly destinationHostId: string | null;
  /** Reject a stale attached selector rather than toggling the opposite way. */
  readonly expectedDestination?: "local" | "worktree";
  readonly followUpPrompt: string | null;
  readonly requestThreadId?: string;
  readonly threadTitle?: string;
  readonly onProgress?: (progress: CodexThreadHandoffProgress) => void;
}

export type CodexLaunchThreadHandoffInput = CodexStartThreadHandoffInput;

export class CodexThreadHandoffRuntimeError extends Schema.TaggedError<CodexThreadHandoffRuntimeError>()(
  "CodexThreadHandoffRuntimeError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
    operationId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
  },
) {}

export class CodexThreadHandoffRuntime extends Context.Service<
  CodexThreadHandoffRuntime,
  {
    readonly snapshot: Effect.Effect<CodexThreadHandoffSnapshot>;
    readonly changes: Stream.Stream<CodexThreadHandoffSnapshot>;
    readonly start: (
      input: CodexStartThreadHandoffInput,
    ) => Effect.Effect<CodexThreadHandoffJournalEntry, CodexThreadHandoffRuntimeError>;
    readonly prepareRecovery: Effect.Effect<void, CodexThreadHandoffRuntimeError>;
    readonly recover: (
      onProgress?: (progress: CodexThreadHandoffProgress) => void,
    ) => Effect.Effect<readonly CodexThreadHandoffJournalEntry[], CodexThreadHandoffRuntimeError>;
    readonly launch: (
      input: CodexLaunchThreadHandoffInput,
    ) => Effect.Effect<CodexAppHandoffOperation, CodexThreadHandoffRuntimeError>;
    readonly get: (
      operationId: string,
    ) => Effect.Effect<CodexAppHandoffOperation | null, CodexThreadHandoffRuntimeError>;
    readonly waitForRevision: (
      operationId: string,
      afterRevision: number | null,
      waitMs: number,
    ) => Effect.Effect<CodexAppHandoffOperation | null, CodexThreadHandoffRuntimeError>;
  }
>()("nodex/main/codex-application/CodexThreadHandoffRuntime") {}

const terminalPhases = new Set<CodexThreadHandoffPhase>([
  "completed",
  "completed-with-warning",
  "failed",
]);
const MAX_STATUS_OPERATIONS = 128;

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "object" && cause !== null && "cause" in cause && cause.cause !== cause) {
    return failureMessage(cause.cause);
  }
  return String(cause);
};

const locationsEqual = (
  left: CodexThreadExecutionLocation,
  right: CodexThreadExecutionLocation,
): boolean =>
  left.hostId === right.hostId &&
  left.cwd === right.cwd &&
  left.managedWorktreePath === right.managedWorktreePath &&
  left.projectId === right.projectId &&
  left.projectlessOutputDirectory === right.projectlessOutputDirectory &&
  left.projectlessWorkspaceBrowserRoot === right.projectlessWorkspaceBrowserRoot &&
  left.workspaceRoots.length === right.workspaceRoots.length &&
  left.workspaceRoots.every((root, index) => root === right.workspaceRoots[index]);

const preparationRestored = (cause: unknown): boolean => {
  if (cause instanceof ManagedWorktreeHandoffError) return cause.preparationRestored === true;
  if (typeof cause === "object" && cause !== null && "cause" in cause && cause.cause !== cause)
    return preparationRestored(cause.cause);
  return false;
};

const isTerminalStatus = (status: CodexAppHandoffStatusType): boolean => status !== "running";

const retainStatusOperations = (
  operations: Iterable<CodexAppHandoffOperation>,
): ReadonlyMap<string, CodexAppHandoffOperation> => {
  const all = [...operations];
  if (all.length <= MAX_STATUS_OPERATIONS) {
    return new Map(all.map((operation) => [operation.operationId, operation]));
  }
  const active = all.filter(
    (operation) => operation.recoveryRequired || !isTerminalStatus(operation.status),
  );
  const terminal = all
    .filter((operation) => !operation.recoveryRequired && isTerminalStatus(operation.status))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(0, MAX_STATUS_OPERATIONS - active.length));
  return new Map([...active, ...terminal].map((operation) => [operation.operationId, operation]));
};

const buildStep = (
  id: string,
  label: string,
  status: CodexAppHandoffStatusType,
  message: string | null,
  updatedAt: number,
): CodexAppHandoffStep => ({ id, label, status, message, updatedAt });

const buildInitialOperation = (
  input: CodexLaunchThreadHandoffInput,
  now: number,
  source: CodexThreadExecutionLocation | null,
  destinationHostId: string,
  destinationHostDisplayName: string,
): CodexAppHandoffOperation => ({
  operationId: input.operationId,
  revision: 0,
  status: "running",
  recoveryRequired: false,
  threadId: input.threadId,
  sourceThreadId: input.threadId,
  requestThreadId: input.requestThreadId ?? null,
  threadTitle: input.threadTitle?.trim() || input.threadId,
  projectId: source?.projectId ?? null,
  sourceHostId: source?.hostId ?? null,
  direction:
    source === null
      ? null
      : destinationHostId !== source.hostId
        ? "cross-host"
        : source.managedWorktreePath
          ? "worktree-to-local"
          : "local-to-worktree",
  localBranch: null,
  sourceBranch: null,
  worktreeBranch: null,
  destinationHostId,
  destinationHostDisplayName,
  message: "Preparing thread handoff.",
  steps: [],
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});

const buildOperationFromJournal = (input: {
  readonly entry: CodexThreadHandoffJournalEntry;
  readonly detail: string | null;
  readonly existing: CodexAppHandoffOperation | undefined;
  readonly destinationHostDisplayName: string;
}): CodexAppHandoffOperation => {
  const { entry, existing } = input;
  const destinationHostId =
    entry.destination?.hostId ?? entry.requestedDestinationHostId ?? entry.source.hostId;
  const context: Pick<
    CodexAppHandoffOperation,
    "direction" | "sourceBranch" | "localBranch" | "worktreeBranch"
  > = {
    direction:
      destinationHostId !== entry.source.hostId
        ? "cross-host"
        : entry.source.managedWorktreePath
          ? "worktree-to-local"
          : "local-to-worktree",
    sourceBranch: entry.prepared?.sourceBranch ?? entry.branchContext?.sourceBranch ?? null,
    localBranch:
      entry.prepared?.direction === "to-worktree"
        ? entry.prepared.localCheckoutBranch
        : entry.prepared?.direction === "to-checkout"
          ? entry.prepared.sourceBranch
          : (entry.branchContext?.localBranch ?? null),
    worktreeBranch:
      entry.prepared?.direction === "to-worktree"
        ? entry.prepared.destinationBranch
        : (entry.prepared?.sourceBranch ?? entry.branchContext?.worktreeBranch ?? null),
  };
  const terminal = terminalPhases.has(entry.phase) || entry.phase === "recovery-required";
  const failedPhase =
    entry.phase === "failed" ||
    entry.phase === "rolling-back" ||
    entry.phase === "recovery-required"
      ? entry.failedPhase
      : null;
  const steps = (entry.preparationSteps ?? []).map((step) =>
    buildStep(
      step.id,
      resolveCodexThreadHandoffStepLabel(step.id, context) ?? step.id,
      step.status === "running" && failedPhase === "preparing-destination" ? "error" : step.status,
      null,
      step.updatedAt,
    ),
  );
  const switchedPhases = new Set<CodexThreadHandoffPhase>([
    "switching-runtime",
    "committing-location",
    "transferring-owner",
    "cleaning-source",
    "completed",
    "completed-with-warning",
  ]);
  if (switchedPhases.has(failedPhase ?? entry.phase)) {
    steps.push(
      buildStep(
        "switching-thread",
        resolveCodexThreadHandoffStepLabel("switching-thread", context)!,
        terminal
          ? entry.phase === "failed" || entry.phase === "recovery-required"
            ? "error"
            : "success"
          : "running",
        entry.lastError,
        entry.updatedAt,
      ),
    );
  }
  if (
    entry.phase === "rolling-back" ||
    entry.phase === "cleaning-rolled-back" ||
    entry.phase === "failed" ||
    entry.phase === "recovery-required"
  ) {
    steps.push(
      buildStep(
        "rolling-back-changes",
        "Rolling back changes",
        entry.phase === "rolling-back"
          ? "running"
          : entry.phase === "recovery-required" || entry.warnings.length > 0
            ? "warning"
            : "success",
        entry.warnings.at(-1) ?? null,
        entry.updatedAt,
      ),
    );
  }
  const status: CodexAppHandoffStatusType =
    entry.phase === "completed"
      ? "success"
      : entry.phase === "completed-with-warning"
        ? "warning"
        : entry.phase === "failed" || entry.phase === "recovery-required"
          ? "error"
          : "running";
  return {
    operationId: entry.operationId,
    revision: (existing?.revision ?? -1) + 1,
    status,
    recoveryRequired: entry.phase === "recovery-required",
    threadId: entry.threadId,
    sourceThreadId: entry.threadId,
    requestThreadId: entry.requestThreadId ?? existing?.requestThreadId ?? null,
    threadTitle: entry.threadTitle ?? existing?.threadTitle ?? null,
    projectId: entry.source.projectId,
    sourceHostId: entry.source.hostId,
    ...context,
    destinationHostId,
    destinationHostDisplayName: input.destinationHostDisplayName,
    message:
      entry.phase === "recovery-required"
        ? (entry.warnings.at(-1) ?? "Recovery required. Prepared files are retained.")
        : status === "success"
          ? "Task handoff completed."
          : status === "warning"
            ? (entry.warnings.at(-1) ?? "Task handoff completed with a warning.")
            : status === "error"
              ? (entry.lastError ?? "Task handoff failed.")
              : (input.detail ?? "Moving task to its destination."),
    steps,
    createdAt: existing?.createdAt ?? entry.createdAt,
    updatedAt: entry.updatedAt,
    completedAt: entry.completedAt,
  };
};

interface ActiveHandoff {
  readonly operationId: string;
  readonly requestThreadId: string | null;
  readonly result: Deferred.Deferred<
    CodexThreadHandoffJournalEntry,
    CodexThreadHandoffRuntimeError
  >;
}

interface HandoffStatusState {
  readonly revision: number;
  readonly operations: ReadonlyMap<string, CodexAppHandoffOperation>;
}

type StatusAdmission =
  | { readonly isNew: false; readonly operation: CodexAppHandoffOperation }
  | { readonly isNew: true; readonly operation: CodexAppHandoffOperation };

export const make = (options: {
  readonly storage: CodexThreadHandoffJournalStorage;
}): Effect.Effect<
  CodexThreadHandoffRuntime["Service"],
  never,
  Scope.Scope | ExecutionHostRuntime | ManagedWorktreeHandoff | ThreadExecution
> =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.Scope;
    const executionHosts = yield* ExecutionHostRuntime;
    const managedWorktrees = yield* ManagedWorktreeHandoff;
    const threadExecution = yield* ThreadExecution;
    const journalLock = yield* Semaphore.make(1);
    const journalLoaded = yield* Ref.make(false);
    const journalEntries = yield* Ref.make<ReadonlyMap<string, CodexThreadHandoffJournalEntry>>(
      new Map(),
    );
    const activeLock = yield* Semaphore.make(1);
    const activeByThreadId = yield* Ref.make<ReadonlyMap<string, ActiveHandoff>>(new Map());
    const statuses = yield* SubscriptionRef.make<HandoffStatusState>({
      revision: 0,
      operations: new Map<string, CodexAppHandoffOperation>(),
    });
    const projectSnapshot = (state: {
      readonly revision: number;
      readonly operations: ReadonlyMap<string, CodexAppHandoffOperation>;
    }): CodexThreadHandoffSnapshot => ({
      revision: state.revision,
      operations: [...state.operations.values()],
    });

    const runtimeError = (
      operation: string,
      cause: unknown,
      identity?: { readonly operationId?: string; readonly threadId?: string },
    ) =>
      new CodexThreadHandoffRuntimeError({
        operation,
        message: failureMessage(cause),
        cause,
        ...identity,
      });
    const invoke = <A, E>(
      operation: string,
      effect: Effect.Effect<A, E>,
      identity?: { readonly operationId?: string; readonly threadId?: string },
    ): Effect.Effect<A, CodexThreadHandoffRuntimeError> =>
      effect.pipe(Effect.mapError((cause) => runtimeError(operation, cause, identity)));

    const requireOwnership = (
      input: CodexStartThreadHandoffInput,
      recorded: {
        readonly threadId: string;
        readonly requestThreadId: string | null | undefined;
        readonly destinationHostId?: string;
        readonly destination?: "local" | "worktree" | null;
      },
    ): Effect.Effect<void, CodexThreadHandoffRuntimeError> => {
      if (
        input.threadId === recorded.threadId &&
        (input.requestThreadId ?? null) === (recorded.requestThreadId ?? null) &&
        (input.destinationHostId === null ||
          recorded.destinationHostId === undefined ||
          input.destinationHostId === recorded.destinationHostId) &&
        (!input.expectedDestination ||
          recorded.destination === undefined ||
          input.expectedDestination === recorded.destination)
      )
        return Effect.void;
      return Effect.fail(
        runtimeError(
          "admit",
          new Error("This handoff operation belongs to another chat or destination intent."),
          {
            operationId: input.operationId,
            threadId: input.threadId,
          },
        ),
      );
    };
    const requireJournalOwnership = (
      input: CodexStartThreadHandoffInput,
      entry: CodexThreadHandoffJournalEntry,
    ) =>
      requireOwnership(input, {
        threadId: entry.threadId,
        requestThreadId: entry.requestThreadId,
        destinationHostId: entry.requestedDestinationHostId ?? entry.source.hostId,
        destination: entry.source.managedWorktreePath ? "local" : "worktree",
      });
    const requireStatusOwnership = (
      input: CodexStartThreadHandoffInput,
      operation: CodexAppHandoffOperation,
    ) =>
      requireOwnership(input, {
        threadId: operation.threadId,
        requestThreadId: operation.requestThreadId,
        destinationHostId: operation.destinationHostId,
        destination:
          operation.direction === "local-to-worktree"
            ? "worktree"
            : operation.direction === "worktree-to-local"
              ? "local"
              : null,
      });
    const requireActiveOwnership = (
      input: Pick<CodexStartThreadHandoffInput, "threadId" | "operationId" | "requestThreadId">,
    ) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(activeByThreadId);
        const owner = [...current].find(
          ([_threadId, active]) => active.operationId === input.operationId,
        );
        if (
          !owner ||
          (owner[0] === input.threadId &&
            owner[1].requestThreadId === (input.requestThreadId ?? null))
        )
          return;
        return yield* runtimeError(
          "admit",
          new Error("This handoff operation belongs to another chat."),
          { operationId: input.operationId, threadId: input.threadId },
        );
      });

    const loadJournalUnlocked = Effect.gen(function* () {
      if (yield* Ref.get(journalLoaded)) return;
      const loaded = yield* options.storage.load.pipe(
        Effect.mapError((cause) => runtimeError("journal-load", cause)),
      );
      yield* Ref.set(
        journalEntries,
        new Map(loaded.map((entry) => [entry.operationId, entry] as const)),
      );
      yield* Ref.set(journalLoaded, true);
    });
    const listJournal = journalLock.withPermits(1)(
      Effect.gen(function* () {
        yield* loadJournalUnlocked;
        return [...(yield* Ref.get(journalEntries)).values()].sort(
          (left, right) => left.createdAt - right.createdAt,
        );
      }),
    );
    const getJournal = (operationId: string) =>
      journalLock.withPermits(1)(
        Effect.gen(function* () {
          yield* loadJournalUnlocked;
          return (yield* Ref.get(journalEntries)).get(operationId) ?? null;
        }),
      );
    const putJournal = (entry: CodexThreadHandoffJournalEntry) =>
      journalLock.withPermits(1)(
        Effect.gen(function* () {
          yield* loadJournalUnlocked;
          const parsed = yield* Effect.try({
            try: () => parseCodexThreadHandoffJournalEntry(entry),
            catch: (cause) =>
              runtimeError("journal-validate", cause, {
                operationId: entry.operationId,
                threadId: entry.threadId,
              }),
          });
          const current = yield* Ref.get(journalEntries);
          const next = new Map(current).set(parsed.operationId, parsed);
          const retained = retainCodexThreadHandoffJournalEntries(next.values());
          yield* options.storage.persist(retained).pipe(
            Effect.mapError((cause) =>
              runtimeError("journal-persist", cause, {
                operationId: entry.operationId,
                threadId: entry.threadId,
              }),
            ),
          );
          yield* Ref.set(
            journalEntries,
            new Map(retained.map((retainedEntry) => [retainedEntry.operationId, retainedEntry])),
          );
        }),
      );

    const recordProgress = (progress: CodexThreadHandoffProgress) =>
      Effect.gen(function* () {
        const destinationHostId =
          progress.entry.destination?.hostId ??
          progress.entry.requestedDestinationHostId ??
          progress.entry.source.hostId;
        const host = yield* executionHosts.get(destinationHostId);
        return yield* SubscriptionRef.modify(statuses, (current) => {
          const operation = buildOperationFromJournal({
            entry: progress.entry,
            detail: progress.detail,
            existing: current.operations.get(progress.entry.operationId),
            destinationHostDisplayName: host?.descriptor.displayName ?? destinationHostId,
          });
          const next = new Map(current.operations).set(operation.operationId, operation);
          return [
            operation,
            { revision: current.revision + 1, operations: retainStatusOperations(next.values()) },
          ];
        });
      });
    const emitProgress = (
      progress: CodexThreadHandoffProgress,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) =>
      recordProgress(progress).pipe(
        Effect.andThen(
          observer === undefined ? Effect.void : Effect.sync(() => observer(progress)),
        ),
        Effect.asVoid,
      );

    const save = (
      entry: CodexThreadHandoffJournalEntry,
      observer: ((progress: CodexThreadHandoffProgress) => void) | undefined,
      detail: string | null,
    ) =>
      putJournal(entry).pipe(
        Effect.andThen(emitProgress({ entry, detail }, observer)),
        Effect.asVoid,
      );
    const patchEntry = (
      entry: CodexThreadHandoffJournalEntry,
      patch: Partial<CodexThreadHandoffJournalEntry>,
      observer: ((progress: CodexThreadHandoffProgress) => void) | undefined,
      detail: string | null,
    ) =>
      Effect.gen(function* () {
        const next: CodexThreadHandoffJournalEntry = {
          ...entry,
          ...patch,
          schemaVersion: 1,
          operationId: entry.operationId,
          threadId: entry.threadId,
          createdAt: entry.createdAt,
          updatedAt: yield* Clock.currentTimeMillis,
        };
        yield* save(next, observer, detail);
        return next;
      });
    const phase = (
      entry: CodexThreadHandoffJournalEntry,
      nextPhase: CodexThreadHandoffPhase,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) => patchEntry(entry, { phase: nextPhase }, observer, null);
    const addWarning = (
      entry: CodexThreadHandoffJournalEntry,
      cause: unknown,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) => {
      const warning = failureMessage(cause);
      return patchEntry(entry, { warnings: [...entry.warnings, warning] }, observer, warning);
    };

    const readCanonical = (entry: CodexThreadHandoffJournalEntry) =>
      invoke(
        "read-canonical-location",
        threadExecution
          .read(entry.threadId)
          .pipe(Effect.interruptible, Effect.timeout("5 seconds")),
        { operationId: entry.operationId, threadId: entry.threadId },
      ).pipe(
        Effect.map((location) => {
          if (locationsEqual(location, entry.source)) return { kind: "source" as const };
          if (entry.destination && locationsEqual(location, entry.destination))
            return { kind: "destination" as const };
          return { kind: "ambiguous" as const };
        }),
        Effect.catch((cause) => Effect.succeed({ kind: "unavailable" as const, cause })),
      );

    const requireRecovery = (
      entry: CodexThreadHandoffJournalEntry,
      cause: unknown,
      detail: string,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) =>
      invoke("seal-recovery", threadExecution.setRecoveryRequired(entry.threadId, true), {
        operationId: entry.operationId,
        threadId: entry.threadId,
      }).pipe(
        Effect.andThen(
          patchEntry(
            entry,
            {
              phase: "recovery-required",
              failedPhase: entry.phase === "recovery-required" ? entry.failedPhase : entry.phase,
              lastError: entry.lastError ?? failureMessage(cause),
              warnings: [...new Set([...entry.warnings, detail])].slice(-128),
              completedAt: null,
            },
            observer,
            detail,
          ),
        ),
      );

    const releaseVerifiedRecovery = (
      entry: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) => {
      if (entry.phase !== "cleaning-source" && entry.phase !== "failed")
        return Effect.succeed(entry);
      return invoke(
        "release-recovery",
        threadExecution.setRecoveryRequired(entry.threadId, false),
        {
          operationId: entry.operationId,
          threadId: entry.threadId,
        },
      ).pipe(
        Effect.as(entry),
        Effect.catch((cause) =>
          requireRecovery(
            entry,
            cause,
            "Recovery required: execution admission could not be restored.",
            observer,
          ),
        ),
      );
    };

    const rollback = Effect.fn("CodexThreadHandoffRuntime.rollback")(function* (
      initial: CodexThreadHandoffJournalEntry,
      cause: unknown,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      const cleanupOnly =
        initial.phase === "cleaning-rolled-back" ||
        (initial.phase === "recovery-required" && initial.failedPhase === "cleaning-rolled-back");
      if (
        !initial.prepared &&
        (initial.phase === "preparing-destination" ||
          initial.failedPhase === "preparing-destination") &&
        !preparationRestored(cause)
      )
        return yield* requireRecovery(
          initial,
          cause,
          "Recovery required: workspace preparation did not return a verified result. Prepared files are retained.",
          observer,
        );
      const canonical = yield* readCanonical(initial);
      if (canonical.kind === "unavailable" || canonical.kind === "ambiguous")
        return yield* requireRecovery(
          initial,
          cause,
          `Recovery required: ${canonical.kind === "ambiguous" ? "chat execution location changed" : failureMessage(canonical.cause)}. Prepared files are retained.`,
          observer,
        );
      if (cleanupOnly && canonical.kind !== "source")
        return yield* requireRecovery(
          initial,
          cause,
          "Recovery required: chat execution moved after Git rollback. Prepared files are retained.",
          observer,
        );
      let entry = yield* patchEntry(
        initial,
        {
          phase: "rolling-back",
          coreCommitted: canonical.kind === "destination",
          lastError: initial.lastError ?? failureMessage(cause),
          failedPhase: initial.failedPhase ?? initial.phase,
        },
        observer,
        "Rolling back task handoff.",
      );
      const preparation =
        entry.destination && entry.prepared
          ? { destination: entry.destination, prepared: entry.prepared }
          : null;
      const restoreSource = entry.coreCommitted
        ? invoke("commit-source-location", threadExecution.commit(entry.threadId, entry.source), {
            operationId: entry.operationId,
            threadId: entry.threadId,
          })
        : Effect.void;
      const runtimeRollback = yield* invoke(
        "switch-runtime-source",
        preparation
          ? threadExecution.withRuntimeLocation(
              entry.threadId,
              entry.source,
              preparation,
              restoreSource,
            )
          : restoreSource,
        { operationId: entry.operationId, threadId: entry.threadId },
      ).pipe(
        Effect.as({ kind: "restored" as const }),
        Effect.catch((rollbackCause) =>
          Effect.succeed({ kind: "failed" as const, cause: rollbackCause }),
        ),
      );
      if (runtimeRollback.kind === "failed")
        return yield* requireRecovery(
          entry,
          runtimeRollback.cause,
          `Recovery required: runtime rollback failed: ${failureMessage(runtimeRollback.cause)}. Prepared files are retained.`,
          observer,
        );
      const restored = yield* readCanonical(entry);
      if (restored.kind !== "source")
        return yield* requireRecovery(
          entry,
          cause,
          "Recovery required: the original chat execution location could not be verified. Prepared files are retained.",
          observer,
        );
      entry = yield* patchEntry(
        entry,
        { runtimeSwitched: false, coreCommitted: false },
        observer,
        null,
      );
      if (preparation && !cleanupOnly) {
        const gitRollback = yield* invoke(
          "rollback-preparation",
          managedWorktrees.rollback(entry.threadId, preparation),
          {
            operationId: entry.operationId,
            threadId: entry.threadId,
          },
        ).pipe(
          Effect.map((warnings) => ({ kind: "restored" as const, warnings })),
          Effect.catch((rollbackCause) =>
            Effect.succeed({ kind: "failed" as const, cause: rollbackCause }),
          ),
        );
        if (gitRollback.kind === "failed" || gitRollback.warnings.length > 0) {
          const detail =
            gitRollback.kind === "failed"
              ? failureMessage(gitRollback.cause)
              : gitRollback.warnings.join("; ");
          return yield* requireRecovery(
            entry,
            cause,
            `Recovery required: Git rollback failed: ${detail}. Prepared files are retained.`,
            observer,
          );
        }
      }
      if (preparation) {
        entry = yield* phase(entry, "cleaning-rolled-back", observer);
        const cleanup = yield* invoke(
          "cleanup-rolled-back",
          managedWorktrees.cleanup(entry.threadId, preparation, "rolled-back"),
          {
            operationId: entry.operationId,
            threadId: entry.threadId,
          },
        ).pipe(
          Effect.map((warnings) => ({ kind: "cleaned" as const, warnings })),
          Effect.catch((cleanupCause) =>
            Effect.succeed({ kind: "failed" as const, cause: cleanupCause }),
          ),
        );
        if (cleanup.kind === "failed" || cleanup.warnings.length > 0) {
          const detail =
            cleanup.kind === "failed" ? failureMessage(cleanup.cause) : cleanup.warnings.join("; ");
          return yield* requireRecovery(
            entry,
            cause,
            `Recovery required: artifact cleanup failed: ${detail}. Remaining files are retained.`,
            observer,
          );
        }
      }
      return yield* patchEntry(
        entry,
        {
          phase: "failed",
          runtimeSwitched: false,
          coreCommitted: false,
          completedAt: yield* Clock.currentTimeMillis,
        },
        observer,
        entry.lastError,
      );
    });

    const finishCommitted = Effect.fn("CodexThreadHandoffRuntime.finishCommitted")(function* (
      initial: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      if (!initial.destination || !initial.prepared) {
        return yield* rollback(
          initial,
          new Error("Committed handoff is missing its destination artifact."),
          observer,
        );
      }
      const preparation = { destination: initial.destination, prepared: initial.prepared };
      let entry = yield* phase(initial, "cleaning-source", observer);
      entry = yield* invoke(
        "cleanup-committed",
        managedWorktrees.cleanup(entry.threadId, preparation, "committed"),
        {
          operationId: entry.operationId,
          threadId: entry.threadId,
        },
      ).pipe(
        Effect.flatMap((warnings) =>
          warnings.length === 0
            ? Effect.succeed(entry)
            : patchEntry(
                entry,
                { warnings: [...entry.warnings, ...warnings] },
                observer,
                warnings.join("; "),
              ),
        ),
        Effect.catch((cleanupCause) => addWarning(entry, cleanupCause, observer)),
      );
      return entry;
    });

    // Follow-up admission happens after the native execution handoff lease is released.
    const completeHandoff = Effect.fn("CodexThreadHandoffRuntime.completeHandoff")(function* (
      initial: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      if (initial.phase !== "cleaning-source") return initial;
      let entry = initial;
      const followUpPrompt = entry.followUpPrompt;
      if (followUpPrompt && !entry.followUpDispatchStarted) {
        entry = yield* patchEntry(
          entry,
          { followUpDispatchStarted: true },
          observer,
          "Dispatching follow-up.",
        );
        entry = yield* invoke(
          "send-follow-up",
          threadExecution.followUp(entry.threadId, followUpPrompt),
          { operationId: entry.operationId, threadId: entry.threadId },
        ).pipe(
          Effect.as(entry),
          Effect.catch((followUpCause) => addWarning(entry, followUpCause, observer)),
        );
      }
      return yield* patchEntry(
        entry,
        {
          phase: entry.warnings.length > 0 ? "completed-with-warning" : "completed",
          completedAt: yield* Clock.currentTimeMillis,
          lastError: null,
        },
        observer,
        entry.warnings.at(-1) ?? null,
      );
    });

    const runTransaction = Effect.fn("CodexThreadHandoffRuntime.runTransaction")(function* (
      initial: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      let entry = initial;
      return yield* Effect.gen(function* () {
        entry = yield* phase(entry, "stopping-turn", observer);
        yield* invoke("stop-active-turn", threadExecution.stop(entry.threadId), {
          operationId: entry.operationId,
          threadId: entry.threadId,
        });
        entry = yield* phase(entry, "preparing-destination", observer);
        const preparation = yield* invoke(
          "prepare-destination",
          managedWorktrees.prepare(entry, (progress) =>
            Effect.gen(function* () {
              const id =
                progress.phase === "snapshot-source" || progress.phase === "bundle-source"
                  ? "prepare-host-transfer"
                  : progress.phase === "transfer-state"
                    ? "transfer-host-artifacts"
                    : progress.phase === "import-bundle"
                      ? "create-new-worktree"
                      : progress.phase;
              const updatedAt = yield* Clock.currentTimeMillis;
              const nextStep = { id, status: progress.status, updatedAt };
              const steps = entry.preparationSteps ?? [];
              entry = {
                ...entry,
                branchContext: progress.branchContext ?? entry.branchContext,
                allocatedDestination: progress.allocatedDestination ?? entry.allocatedDestination,
                preparationSteps: steps.some((step) => step.id === id)
                  ? steps.map((step) => (step.id === id ? nextStep : step))
                  : [...steps, nextStep],
                updatedAt,
              };
              yield* progress.allocatedDestination
                ? save(entry, observer, null)
                : emitProgress({ entry, detail: null }, observer);
            }),
          ),
          { operationId: entry.operationId, threadId: entry.threadId },
        );
        entry = yield* patchEntry(
          entry,
          {
            destination: preparation.destination,
            prepared: preparation.prepared,
            warnings: [...entry.warnings, ...preparation.prepared.warnings],
          },
          observer,
          null,
        );
        entry = yield* phase(entry, "switching-runtime", observer);
        yield* invoke(
          "switch-runtime-destination",
          threadExecution.withRuntimeLocation(
            entry.threadId,
            preparation.destination,
            preparation,
            Effect.gen(function* () {
              entry = yield* patchEntry(entry, { runtimeSwitched: true }, observer, null);
              entry = yield* phase(entry, "committing-location", observer);
              yield* invoke(
                "commit-destination-location",
                threadExecution.commit(entry.threadId, preparation.destination),
                { operationId: entry.operationId, threadId: entry.threadId },
              );
              entry = yield* patchEntry(entry, { coreCommitted: true }, observer, null);
            }),
          ),
          { operationId: entry.operationId, threadId: entry.threadId },
        );
        entry = yield* phase(entry, "transferring-owner", observer);
        entry = yield* invoke(
          "transfer-owner",
          managedWorktrees.transferOwner(entry.threadId, preparation),
          { operationId: entry.operationId, threadId: entry.threadId },
        ).pipe(
          Effect.as(entry),
          Effect.catch((ownerCause) => addWarning(entry, ownerCause, observer)),
        );
        return yield* finishCommitted(entry, observer);
      }).pipe(Effect.catch((transactionCause) => rollback(entry, transactionCause, observer)));
    });

    const resumeCommitted = Effect.fn("CodexThreadHandoffRuntime.resumeCommitted")(function* (
      initial: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      if (!initial.destination || !initial.prepared) {
        return yield* rollback(
          initial,
          new Error("Committed handoff is missing its destination artifact."),
          observer,
        );
      }
      const preparation = { destination: initial.destination, prepared: initial.prepared };
      let entry = initial;
      return yield* Effect.gen(function* () {
        yield* invoke(
          "recover-runtime-destination",
          threadExecution.withRuntimeLocation(
            entry.threadId,
            preparation.destination,
            preparation,
            Effect.void,
          ),
          { operationId: entry.operationId, threadId: entry.threadId },
        );
        entry = yield* phase(entry, "transferring-owner", observer);
        entry = yield* invoke(
          "recover-transfer-owner",
          managedWorktrees.transferOwner(entry.threadId, preparation),
          { operationId: entry.operationId, threadId: entry.threadId },
        ).pipe(
          Effect.as(entry),
          Effect.catch((ownerCause) => addWarning(entry, ownerCause, observer)),
        );
        return yield* finishCommitted(entry, observer);
      }).pipe(Effect.catch((recoveryCause) => rollback(entry, recoveryCause, observer)));
    });

    const recoverEntry = Effect.fn("CodexThreadHandoffRuntime.recoverEntry")(function* (
      entry: CodexThreadHandoffJournalEntry,
      observer?: (progress: CodexThreadHandoffProgress) => void,
    ) {
      const canonical = yield* readCanonical(entry);
      if (canonical.kind === "unavailable" || canonical.kind === "ambiguous")
        return yield* requireRecovery(
          entry,
          canonical.kind === "unavailable"
            ? canonical.cause
            : new Error("Chat execution location is ambiguous"),
          `Recovery required: ${canonical.kind === "unavailable" ? failureMessage(canonical.cause) : "chat execution location is ambiguous"}. Prepared files are retained.`,
          observer,
        );
      const coreCommitted = canonical.kind === "destination";
      const reconciled =
        entry.coreCommitted === coreCommitted
          ? entry
          : yield* patchEntry(
              entry,
              { coreCommitted },
              observer,
              coreCommitted ? "Recovered durable location." : "Recovered source location.",
            );
      if (
        entry.phase === "cleaning-rolled-back" ||
        (entry.phase === "recovery-required" && entry.failedPhase === "cleaning-rolled-back")
      )
        return yield* rollback(
          reconciled,
          new Error(entry.lastError ?? "Recovering rollback cleanup"),
          observer,
        );
      if (reconciled.coreCommitted && reconciled.destination && reconciled.prepared)
        return yield* resumeCommitted(reconciled, observer);
      return yield* rollback(
        reconciled,
        new Error(entry.lastError ?? "Recovered an interrupted task handoff."),
        observer,
      );
    });

    const runOwned = (
      threadId: string,
      operationId: string,
      requestThreadId: string | null,
      operation: Effect.Effect<CodexThreadHandoffJournalEntry, CodexThreadHandoffRuntimeError>,
    ) =>
      Effect.gen(function* () {
        const allocation = yield* activeLock.withPermits(1)(
          Effect.gen(function* () {
            yield* requireActiveOwnership({
              threadId,
              operationId,
              requestThreadId: requestThreadId ?? undefined,
            });
            const current = yield* Ref.get(activeByThreadId);
            const existing = current.get(threadId);
            if (existing?.operationId === operationId) {
              return { owned: false as const, active: existing };
            }
            if (existing) {
              return yield* Effect.fail(
                runtimeError("admit", new Error("This task already has a handoff in progress."), {
                  operationId,
                  threadId,
                }),
              );
            }
            const active: ActiveHandoff = {
              operationId,
              requestThreadId,
              result: yield* Deferred.make<
                CodexThreadHandoffJournalEntry,
                CodexThreadHandoffRuntimeError
              >(),
            };
            yield* Ref.set(activeByThreadId, new Map(current).set(threadId, active));
            return { owned: true as const, active };
          }),
        );
        if (allocation.owned) {
          const owned = operation.pipe(
            Effect.onExit((exit) =>
              activeLock.withPermits(1)(
                Ref.update(activeByThreadId, (current) => {
                  if (current.get(threadId) !== allocation.active) return current;
                  const next = new Map(current);
                  next.delete(threadId);
                  return next;
                }).pipe(Effect.andThen(Deferred.done(allocation.active.result, exit))),
              ),
            ),
          );
          yield* Effect.forkIn(owned, ownerScope, { startImmediately: true });
        }
        return yield* Deferred.await(allocation.active.result);
      });

    const start = (input: CodexStartThreadHandoffInput) =>
      runOwned(
        input.threadId,
        input.operationId,
        input.requestThreadId ?? null,
        Effect.gen(function* () {
          const status = (yield* SubscriptionRef.get(statuses)).operations.get(input.operationId);
          if (status) yield* requireStatusOwnership(input, status);
          const existing = yield* getJournal(input.operationId);
          if (existing) {
            yield* requireJournalOwnership(input, existing);
            yield* emitProgress({ entry: existing, detail: null }, input.onProgress);
            return existing;
          }
          const persisted = (yield* listJournal).find(
            (entry) => entry.threadId === input.threadId && !isTerminalCodexThreadHandoff(entry),
          );
          if (persisted) {
            return yield* Effect.fail(
              runtimeError(
                "admit",
                new Error("This task has an unfinished handoff that must be recovered first."),
                { operationId: input.operationId, threadId: input.threadId },
              ),
            );
          }
          return yield* invoke(
            "handoff-admission",
            threadExecution.withHandoff(
              input.threadId,
              Effect.gen(function* () {
                const source = yield* invoke(
                  "resolve-source",
                  threadExecution.read(input.threadId, input.destinationHostId),
                  {
                    operationId: input.operationId,
                    threadId: input.threadId,
                  },
                );
                if (
                  input.expectedDestination &&
                  (source.managedWorktreePath ? "local" : "worktree") !== input.expectedDestination
                ) {
                  return yield* runtimeError(
                    "admit",
                    new Error("Chat execution location changed. Reopen the location menu."),
                    {
                      operationId: input.operationId,
                      threadId: input.threadId,
                    },
                  );
                }
                const now = yield* Clock.currentTimeMillis;
                const entry: CodexThreadHandoffJournalEntry = {
                  schemaVersion: 1,
                  operationId: input.operationId,
                  threadId: input.threadId,
                  requestThreadId: input.requestThreadId ?? null,
                  threadTitle: input.threadTitle?.trim() || input.threadId,
                  phase: "queued",
                  source,
                  requestedDestinationHostId: input.destinationHostId,
                  destination: null,
                  prepared: null,
                  runtimeSwitched: false,
                  coreCommitted: false,
                  followUpPrompt: input.followUpPrompt,
                  followUpDispatchStarted: false,
                  warnings: [],
                  lastError: null,
                  failedPhase: null,
                  createdAt: now,
                  updatedAt: now,
                  completedAt: null,
                };
                yield* save(entry, input.onProgress, null);
                yield* invoke(
                  "seal-recovery",
                  threadExecution.setRecoveryRequired(entry.threadId, true),
                  { operationId: entry.operationId, threadId: entry.threadId },
                );
                return yield* runTransaction(entry, input.onProgress).pipe(
                  Effect.flatMap((entry) => releaseVerifiedRecovery(entry, input.onProgress)),
                );
              }),
            ),
            { operationId: input.operationId, threadId: input.threadId },
          ).pipe(Effect.flatMap((entry) => completeHandoff(entry, input.onProgress)));
        }),
      ).pipe(Effect.tap((entry) => requireJournalOwnership(input, entry)));

    const prepareRecovery = Effect.gen(function* () {
      const entries = yield* listJournal;
      for (const entry of entries) {
        if (isTerminalCodexThreadHandoff(entry)) continue;
        yield* invoke("seal-recovery", threadExecution.setRecoveryRequired(entry.threadId, true), {
          operationId: entry.operationId,
          threadId: entry.threadId,
        });
      }
    });

    const recover = (observer?: (progress: CodexThreadHandoffProgress) => void) =>
      Effect.gen(function* () {
        yield* prepareRecovery;
        const entries = yield* listJournal;
        const recovered: CodexThreadHandoffJournalEntry[] = [];
        for (const entry of entries) {
          if (isTerminalCodexThreadHandoff(entry)) {
            yield* emitProgress({ entry, detail: null }, observer);
            continue;
          }
          recovered.push(
            yield* runOwned(
              entry.threadId,
              entry.operationId,
              entry.requestThreadId ?? null,
              invoke(
                "recover-admission",
                threadExecution.withHandoff(
                  entry.threadId,
                  recoverEntry(entry, observer).pipe(
                    Effect.flatMap((recovered) => releaseVerifiedRecovery(recovered, observer)),
                  ),
                ),
                {
                  operationId: entry.operationId,
                  threadId: entry.threadId,
                },
              ).pipe(Effect.flatMap((recovered) => completeHandoff(recovered, observer))),
            ),
          );
        }
        return recovered;
      });

    const get = Effect.fn("CodexThreadHandoffRuntime.get")(function* (operationId: string) {
      const existing = (yield* SubscriptionRef.get(statuses)).operations.get(operationId);
      if (existing) return existing;
      const entry = yield* getJournal(operationId);
      if (!entry) return null;
      const destinationHostId =
        entry.destination?.hostId ?? entry.requestedDestinationHostId ?? entry.source.hostId;
      const host = yield* executionHosts.get(destinationHostId);
      return yield* SubscriptionRef.modify(statuses, (current) => {
        // Live progress may have arrived while storage or host lookup was pending.
        const latest = current.operations.get(operationId);
        if (latest) return [latest, current];
        const operation = buildOperationFromJournal({
          entry,
          detail: null,
          existing: undefined,
          destinationHostDisplayName: host?.descriptor.displayName ?? destinationHostId,
        });
        return [
          operation,
          {
            revision: current.revision + 1,
            operations: retainStatusOperations(
              new Map(current.operations).set(operationId, operation).values(),
            ),
          },
        ];
      });
    });
    const waitForRevision = (operationId: string, afterRevision: number | null, waitMs: number) =>
      Effect.gen(function* () {
        const existing = yield* get(operationId);
        if (
          !existing ||
          waitMs <= 0 ||
          afterRevision === null ||
          existing.revision > afterRevision ||
          isTerminalStatus(existing.status)
        ) {
          return existing;
        }
        yield* SubscriptionRef.changes(statuses).pipe(
          Stream.filter((current) => {
            const operation = current.operations.get(operationId);
            return (
              operation !== undefined &&
              (operation.revision > afterRevision || isTerminalStatus(operation.status))
            );
          }),
          Stream.runHead,
          Effect.asVoid,
          Effect.raceFirst(Effect.sleep(waitMs)),
        );
        return yield* get(operationId);
      });
    const launch = (input: CodexLaunchThreadHandoffInput) =>
      Effect.gen(function* () {
        const existing = yield* get(input.operationId);
        if (existing) {
          yield* requireStatusOwnership(input, existing);
          return existing;
        }
        const source = yield* invoke(
          "resolve-source",
          threadExecution.read(input.threadId, input.destinationHostId),
          {
            operationId: input.operationId,
            threadId: input.threadId,
          },
        );
        const destinationHostId = input.destinationHostId ?? source?.hostId ?? "local";
        const host = yield* executionHosts.get(destinationHostId);
        const now = yield* Clock.currentTimeMillis;
        const admitted = yield* activeLock.withPermits(1)(
          requireActiveOwnership(input).pipe(
            Effect.andThen(
              SubscriptionRef.modify(
                statuses,
                (current): readonly [StatusAdmission, HandoffStatusState] => {
                  const existing = current.operations.get(input.operationId);
                  if (existing) return [{ isNew: false as const, operation: existing }, current];
                  const operation = buildInitialOperation(
                    input,
                    now,
                    source,
                    destinationHostId,
                    host?.descriptor.displayName ?? destinationHostId,
                  );
                  const next = new Map(current.operations).set(operation.operationId, operation);
                  return [
                    { isNew: true as const, operation },
                    {
                      revision: current.revision + 1,
                      operations: retainStatusOperations(next.values()),
                    },
                  ];
                },
              ),
            ),
          ),
        );
        if (!admitted.isNew) {
          yield* requireStatusOwnership(input, admitted.operation);
          return admitted.operation;
        }
        const background = start(input).pipe(
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const failedAt = yield* Clock.currentTimeMillis;
              yield* SubscriptionRef.update(statuses, (current) => {
                const existing = current.operations.get(input.operationId);
                if (!existing || isTerminalStatus(existing.status)) return current;
                const failed: CodexAppHandoffOperation = {
                  ...existing,
                  revision: existing.revision + 1,
                  status: "error",
                  message: cause.message,
                  steps: existing.steps.map((step) =>
                    step.status === "running"
                      ? { ...step, status: "error", updatedAt: failedAt }
                      : step,
                  ),
                  updatedAt: failedAt,
                  completedAt: failedAt,
                };
                return {
                  revision: current.revision + 1,
                  operations: retainStatusOperations(
                    new Map(current.operations).set(input.operationId, failed).values(),
                  ),
                };
              });
            }),
          ),
        );
        yield* Effect.forkIn(background, ownerScope, { startImmediately: true });
        return admitted.operation;
      });

    return CodexThreadHandoffRuntime.of({
      start,
      prepareRecovery,
      recover,
      launch,
      get,
      waitForRevision,
      snapshot: SubscriptionRef.get(statuses).pipe(Effect.map(projectSnapshot)),
      changes: SubscriptionRef.changes(statuses).pipe(Stream.map(projectSnapshot)),
    });
  });

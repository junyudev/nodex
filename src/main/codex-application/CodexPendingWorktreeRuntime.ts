import { randomUUID } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as FiberSet from "effect/FiberSet";
import * as PubSub from "effect/PubSub";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { Config } from "@nodex/codex-app-server-protocol/v2/Config";
import type {
  CodexPendingStartConversationParamsInput,
  CodexPendingWorktreeCreateResult,
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeRequest,
  CodexPendingWorktreeThreadResolution,
} from "../../shared/codex-pending-worktree";
import {
  buildCodexPendingWorktreeSetupRepairPrompt,
  canCreateCodexPendingWorktreeSetupRepair,
  CODEX_PENDING_WORKTREE_SETUP_REPAIR_LABEL,
} from "../../shared/codex-pending-worktree";
import type { CodexAgentMode } from "../../shared/types";
import { expandCodexDynamicCreateConfigProfile } from "../codex/codex-dynamic-create-config";
import { allocateCodexPendingWorktreeRequest } from "../codex/codex-pending-worktree-request";
import { persistCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import {
  createCodexPendingWorktreeState,
  getCodexPendingWorktreeSnapshot,
  reduceCodexPendingWorktreeState,
  resolveCodexPendingWorktreeThread,
  type CodexPendingWorktreeAction,
  type CodexPendingWorktreeEffect,
  type CodexPendingWorktreeMetadataUpdate,
  type CodexPendingWorktreeState,
} from "../codex/codex-pending-worktree-state";
import type { CodexWorktreeWorkerEvent } from "../codex/codex-worktree-worker-protocol";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { createOperationId } from "../core-runtime/operation-identity";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAttachments } from "./CodexAttachments";
import { CodexConversationCreation } from "./CodexConversationCreation";
import { CodexGitProbe } from "./CodexGitProbe";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "./ManagedWorktreeRuntime";

export interface CodexPendingWorktreeCreationResult {
  readonly worktreeGitRoot: string;
  readonly worktreeWorkspaceRoot: string;
  readonly setupError?: string | null;
}

export class CodexPendingWorktreeRuntimeError extends Schema.TaggedError<CodexPendingWorktreeRuntimeError>()(
  "CodexPendingWorktreeRuntimeError",
  {
    operation: Schema.String,
    pendingWorktreeId: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class CodexPendingWorktreeRuntime extends Context.Service<
  CodexPendingWorktreeRuntime,
  {
    /** Synchronous immutable projection for title policy and retention planning. */
    readonly list: () => readonly CodexPendingWorktreeEntry[];
    readonly resolveThread: (clientThreadId: string) => CodexPendingWorktreeThreadResolution | null;
    readonly changes: Stream.Stream<readonly CodexPendingWorktreeEntry[]>;
    readonly create: (
      request: CodexPendingWorktreeRequest,
      createdAt?: number,
    ) => Effect.Effect<void>;
    readonly createSetupRepair: (
      hostId: string,
      pendingWorktreeId: string,
      agentMode: CodexAgentMode,
    ) => Effect.Effect<CodexPendingWorktreeCreateResult, CodexPendingWorktreeRuntimeError>;
    readonly retry: (pendingWorktreeId: string) => Effect.Effect<void>;
    readonly workLocally: (
      pendingWorktreeId: string,
    ) => Effect.Effect<{ readonly threadId: string }, CodexPendingWorktreeRuntimeError>;
    readonly continueWithoutSetup: (pendingWorktreeId: string) => Effect.Effect<void>;
    readonly cancel: (pendingWorktreeId: string) => Effect.Effect<void>;
    readonly dismiss: (pendingWorktreeId: string) => Effect.Effect<void>;
    readonly rename: (pendingWorktreeId: string, label: string) => Effect.Effect<void>;
    readonly setPinned: (pendingWorktreeId: string, isPinned: boolean) => Effect.Effect<void>;
    readonly setPinnedBeforeThreadId: (
      pendingWorktreeId: string,
      beforeThreadId: string | null,
    ) => Effect.Effect<void>;
    readonly clearAttention: (pendingWorktreeId: string) => Effect.Effect<void>;
  }
>()("nodex/main/codex-application/CodexPendingWorktreeRuntime") {}

type CodexPendingWorktreeProgressAction = Extract<
  CodexPendingWorktreeAction,
  { readonly type: "appendOutput" | "setupStarted" }
>;

const failureMessage = (cause: unknown): string => {
  if (cause instanceof Error && cause.message.trim()) return cause.message;
  if (typeof cause === "object" && cause !== null && "cause" in cause && cause.cause !== cause) {
    return failureMessage(cause.cause);
  }
  return String(cause);
};

const runtimeError = (
  operation: string,
  pendingWorktreeId: string,
  cause: unknown,
): CodexPendingWorktreeRuntimeError =>
  new CodexPendingWorktreeRuntimeError({
    operation,
    pendingWorktreeId,
    message: failureMessage(cause),
    cause,
  });

function assertNeverCodexPendingWorktreeRuntimeVariant(value: never, owner: string): never {
  throw new Error(`Unhandled ${owner}: ${JSON.stringify(value)}`);
}

/** Projects transport progress into the pure pending-worktree reducer vocabulary. */
export function projectCodexWorktreeWorkerEventToPendingAction(
  identity: {
    readonly pendingWorktreeId: string;
    readonly attempt: number;
  },
  event: CodexWorktreeWorkerEvent,
): CodexPendingWorktreeProgressAction | null {
  if (event.operation !== "create") return null;
  switch (event.type) {
    case "output":
      if (!event.data || (event.phase !== "worktree" && event.phase !== "setup")) return null;
      return {
        type: "appendOutput",
        pendingWorktreeId: identity.pendingWorktreeId,
        attempt: identity.attempt,
        phase: event.phase,
        output: event.data,
      };
    case "path-allocated":
      return null;
    case "setup-started":
      return {
        type: "setupStarted",
        pendingWorktreeId: identity.pendingWorktreeId,
        attempt: identity.attempt,
      };
  }
}

export const make: Effect.Effect<
  CodexPendingWorktreeRuntime["Service"],
  never,
  | CodexApplicationEventHub
  | CodexAttachments
  | CodexConversationCreation
  | CodexGateway
  | CodexGitProbe
  | ExecutionHostRuntime
  | ManagedWorktreeRuntime
  | ProjectWorkspace
  | Scope.Scope
> = Effect.gen(function* () {
  const applicationEvents = yield* CodexApplicationEventHub;
  const attachments = yield* CodexAttachments;
  const conversationCreation = yield* CodexConversationCreation;
  const gateway = yield* CodexGateway;
  const git = yield* CodexGitProbe;
  const executionHosts = yield* ExecutionHostRuntime;
  const managedWorktrees = yield* ManagedWorktreeRuntime;
  const projectWorkspace = yield* ProjectWorkspace;
  let accepting = true;
  let state: CodexPendingWorktreeState = createCodexPendingWorktreeState();
  let snapshot: readonly CodexPendingWorktreeEntry[] = [];
  const changes = yield* PubSub.sliding<readonly CodexPendingWorktreeEntry[]>(
    MAIN_OBSERVATION_EVENT_CAPACITY,
  );
  const attemptFibers = yield* FiberMap.make<string, void>();
  const launchFibers = yield* FiberMap.make<string, void>();
  const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
  const localLaunchAdmission = yield* Semaphore.make(1);
  const localLaunches = new Map<
    string,
    Deferred.Deferred<{ readonly threadId: string }, CodexPendingWorktreeRuntimeError>
  >();

  const reportFailure = (
    phase: "create" | "launch" | "remove" | "cleanup-goal-sources" | "register-stable-project",
    error: unknown,
    pendingWorktreeId: string,
  ) =>
    Effect.logError("Pending worktree lifecycle failed").pipe(
      Effect.annotateLogs({
        cause: failureMessage(error),
        pendingWorktreeId,
        phase,
      }),
    );

  const dispatch = (action: CodexPendingWorktreeAction): readonly CodexPendingWorktreeEffect[] => {
    if (!accepting) return [];
    const transition = reduceCodexPendingWorktreeState(state, action);
    if (transition.state !== state) {
      state = transition.state;
      snapshot = getCodexPendingWorktreeSnapshot(state);
      PubSub.publishUnsafe(changes, snapshot);
      applicationEvents.publish({ kind: "pendingWorktreesChanged", value: snapshot });
    }
    for (const effect of transition.effects) executeEffect(effect);
    return transition.effects;
  };

  const isCurrentAttempt = (pendingWorktreeId: string, attempt: number): boolean => {
    const entry = state.entriesById.get(pendingWorktreeId);
    return (
      accepting &&
      entry?.attempt === attempt &&
      (entry.phase === "queued" || entry.phase === "creating" || entry.phase === "setting-up")
    );
  };

  const removeBestEffort = (pendingWorktreeId: string, hostId: string, worktreeGitRoot: string) =>
    managedWorktrees
      .remove({ hostId, worktreeGitRoot, reason: "cancel" })
      .pipe(Effect.asVoid)
      .pipe(Effect.catch((error) => reportFailure("remove", error, pendingWorktreeId)));

  const createWorktree = Effect.fn("CodexPendingWorktreeRuntime.createWorktree")(function* (
    entry: CodexPendingWorktreeEntry,
    onEvent: (event: CodexWorktreeWorkerEvent) => void,
  ): Effect.fn.Return<CodexPendingWorktreeCreationResult, unknown> {
    const host = yield* executionHosts.resolve(entry.hostId, "create");
    let allocatedRoot: string | null = null;
    const worker = yield* host
      .request(
        {
          operation: "create",
          input: {
            requestId: `${entry.id}:${String(entry.attempt)}`,
            hostId: entry.hostId,
            repositoryPath: entry.sourceWorkspaceRoot,
            nodexHome: host.descriptor.nodexHome,
            managedRoot: host.descriptor.managedRoot,
            projectId:
              entry.launchMode === "start-conversation"
                ? (entry.startConversationParamsInput.projectAssignment?.projectId ?? entry.id)
                : entry.id,
            targetId: entry.id,
            threadTitle: entry.label,
            startingState: entry.startingState ?? null,
            localEnvironmentConfigPath: entry.localEnvironmentConfigPath?.trim() || null,
            setUpSyncedBranch: entry.launchMode !== "create-stable-worktree",
            propagateLocalWorkspaceFiles: entry.hostId === "local",
          },
        },
        {
          onEvent: (event) =>
            Effect.sync(() => {
              if (event.type === "path-allocated") allocatedRoot = event.worktreeGitRoot;
              onEvent(event);
            }).pipe(
              Effect.andThen(
                event.type === "path-allocated"
                  ? managedWorktrees.registerNewborn({
                      hostId: entry.hostId,
                      worktreeGitRoot: event.worktreeGitRoot,
                    })
                  : Effect.void,
              ),
            ),
        },
      )
      .pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && allocatedRoot
            ? managedWorktrees
                .remove({
                  hostId: entry.hostId,
                  worktreeGitRoot: allocatedRoot,
                  reason: "cancel",
                })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
    const gitPath = yield* git.readPath(worker.worktreeWorkspaceRoot, [
      "rev-parse",
      "--git-path",
      "codex-shell-environment.json",
    ]);
    if (gitPath) {
      yield* Effect.tryPromise(() =>
        persistCodexWorktreeShellEnvironmentAtGitPath({
          cwd: worker.worktreeWorkspaceRoot,
          gitPath,
          shellEnvironment: worker.shellEnvironment,
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.sync(() =>
            onEvent({
              operation: "create",
              type: "output",
              phase: "setup",
              stream: "stderr",
              data: `[stderr] Failed to store worktree shell environment: ${failureMessage(cause)}\n`,
            }),
          ),
        ),
      );
    }
    return {
      worktreeGitRoot: worker.worktreeGitRoot,
      worktreeWorkspaceRoot: worker.worktreeWorkspaceRoot,
      setupError: worker.setupError,
    };
  });

  const startWorktree = Effect.fn("CodexPendingWorktreeRuntime.startWorktree")(function* (
    pendingWorktreeId: string,
    attempt: number,
  ) {
    const entry = state.entriesById.get(pendingWorktreeId);
    if (!entry || entry.attempt !== attempt) return;
    dispatch({ type: "start", pendingWorktreeId, attempt });
    const onEvent = (event: CodexWorktreeWorkerEvent): void => {
      if (!isCurrentAttempt(pendingWorktreeId, attempt)) return;
      const action = projectCodexWorktreeWorkerEventToPendingAction(
        { pendingWorktreeId, attempt },
        event,
      );
      if (action) dispatch(action);
    };
    yield* createWorktree(entry, onEvent).pipe(
      Effect.flatMap((result) => {
        if (!isCurrentAttempt(pendingWorktreeId, attempt)) {
          return removeBestEffort(pendingWorktreeId, entry.hostId, result.worktreeGitRoot);
        }
        if (result.setupError) {
          dispatch({
            type: "setupFailed",
            pendingWorktreeId,
            attempt,
            errorMessage: result.setupError,
            worktreeGitRoot: result.worktreeGitRoot,
            worktreeWorkspaceRoot: result.worktreeWorkspaceRoot,
          });
          return Effect.void;
        }
        dispatch({
          type: "worktreeReady",
          pendingWorktreeId,
          attempt,
          worktreeGitRoot: result.worktreeGitRoot,
          worktreeWorkspaceRoot: result.worktreeWorkspaceRoot,
        });
        return Effect.void;
      }),
      Effect.catch((error) => {
        if (!isCurrentAttempt(pendingWorktreeId, attempt)) return Effect.void;
        dispatch({
          type: "worktreeFailed",
          pendingWorktreeId,
          attempt,
          errorMessage: failureMessage(error),
        });
        return reportFailure("create", error, pendingWorktreeId);
      }),
    );
  });

  const completeLocalLaunch = (
    pendingWorktreeId: string,
    completion:
      | { readonly _tag: "Success"; readonly threadId: string }
      | { readonly _tag: "Failure"; readonly error: CodexPendingWorktreeRuntimeError },
  ) =>
    Effect.gen(function* () {
      const pending = localLaunches.get(pendingWorktreeId);
      if (!pending) return;
      localLaunches.delete(pendingWorktreeId);
      if (completion._tag === "Success") {
        yield* Deferred.succeed(pending, { threadId: completion.threadId });
        return;
      }
      yield* Deferred.fail(pending, completion.error);
    });

  const launchConversation = Effect.fn("CodexPendingWorktreeRuntime.launchConversation")(function* (
    effect: Extract<CodexPendingWorktreeEffect, { readonly type: "launchConversation" }>,
  ) {
    const { attempt, entry, includeWorktreeInit, pendingWorktreeId, workspaceRoot } = effect;
    const currentEntry = state.entriesById.get(pendingWorktreeId);
    if (includeWorktreeInit) {
      if (
        !currentEntry ||
        currentEntry.attempt !== attempt ||
        currentEntry.phase !== "worktree-ready"
      ) {
        return;
      }
    } else if (!localLaunches.has(pendingWorktreeId)) {
      return;
    }

    const result = yield* conversationCreation
      .launchPending(entry, workspaceRoot, includeWorktreeInit)
      .pipe(Effect.result);
    if (Result.isSuccess(result)) {
      if (includeWorktreeInit) {
        dispatch({ type: "conversationStartSucceeded", pendingWorktreeId, attempt });
      } else {
        yield* completeLocalLaunch(pendingWorktreeId, {
          _tag: "Success",
          threadId: result.success.threadId,
        });
      }
      return;
    }
    const error = runtimeError("launch-conversation", pendingWorktreeId, result.failure);
    yield* reportFailure("launch", result.failure, pendingWorktreeId);
    if (includeWorktreeInit) {
      dispatch({
        type: "conversationStartFailed",
        pendingWorktreeId,
        attempt,
        errorMessage: error.message,
      });
    } else {
      yield* completeLocalLaunch(pendingWorktreeId, { _tag: "Failure", error });
    }
  });

  function executeEffect(effect: CodexPendingWorktreeEffect): void {
    if (!accepting) return;
    switch (effect.type) {
      case "startWorktree":
        runBackground(
          FiberMap.run(
            attemptFibers,
            effect.pendingWorktreeId,
            startWorktree(effect.pendingWorktreeId, effect.attempt),
            { startImmediately: true },
          ).pipe(Effect.asVoid),
        );
        return;
      case "launchConversation":
        runBackground(
          FiberMap.run(launchFibers, effect.pendingWorktreeId, launchConversation(effect), {
            startImmediately: true,
          }).pipe(Effect.asVoid),
        );
        return;
      case "abort":
        runBackground(
          FiberMap.run(attemptFibers, effect.pendingWorktreeId, Effect.void, {
            startImmediately: true,
          }).pipe(Effect.asVoid),
        );
        return;
      case "delete":
        runBackground(
          removeBestEffort(effect.pendingWorktreeId, effect.hostId, effect.worktreeGitRoot),
        );
        return;
      case "remove":
        runBackground(
          FiberMap.run(attemptFibers, effect.pendingWorktreeId, Effect.void, {
            startImmediately: true,
          }).pipe(Effect.asVoid),
        );
        return;
      case "cleanupGoalSources":
        runBackground(
          attachments
            .cleanupGoalSources(
              effect.entry.launchMode === "start-conversation"
                ? effect.entry.threadGoalDraft
                : null,
              effect.entry.hostId,
            )
            .pipe(
              Effect.catch((error) =>
                reportFailure("cleanup-goal-sources", error, effect.pendingWorktreeId),
              ),
            ),
        );
        return;
      case "registerStableProject":
        runBackground(
          projectWorkspace
            .createProject({
              operationId: createOperationId("pending-worktree.project.create"),
              payload: {
                projectId: randomUUID(),
                input: { name: effect.label, sources: [...effect.workspaceRoots] },
              },
            })
            .pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  Effect.sync(() => {
                    dispatch({
                      type: "workspaceRootAddFailed",
                      pendingWorktreeId: effect.pendingWorktreeId,
                      attempt: effect.attempt,
                      errorMessage: failureMessage(error),
                    });
                  }).pipe(
                    Effect.andThen(
                      reportFailure("register-stable-project", error, effect.pendingWorktreeId),
                    ),
                  ),
                onSuccess: () =>
                  Effect.sync(() => {
                    dispatch({
                      type: "stableProjectRegistered",
                      pendingWorktreeId: effect.pendingWorktreeId,
                      attempt: effect.attempt,
                    });
                  }),
              }),
            ),
        );
        return;
      default:
        return assertNeverCodexPendingWorktreeRuntimeVariant(
          effect,
          "Codex pending worktree effect",
        );
    }
  }

  const updateMetadata = (
    pendingWorktreeId: string,
    update: CodexPendingWorktreeMetadataUpdate,
  ): void => {
    dispatch({ type: "updateMetadata", pendingWorktreeId, update });
  };

  const interruptLaunch = (pendingWorktreeId: string): void => {
    runBackground(
      FiberMap.run(launchFibers, pendingWorktreeId, Effect.void, {
        startImmediately: true,
      }).pipe(Effect.asVoid),
    );
  };

  const rejectLocalLaunch = (pendingWorktreeId: string, message: string): void => {
    const pending = localLaunches.get(pendingWorktreeId);
    if (!pending) return;
    localLaunches.delete(pendingWorktreeId);
    runBackground(
      Deferred.fail(
        pending,
        runtimeError("work-locally", pendingWorktreeId, new Error(message)),
      ).pipe(Effect.asVoid),
    );
  };

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      accepting = false;
      const closing = runtimeError(
        "close",
        "*",
        new Error("Pending worktree runtime is shut down"),
      );
      const pending = [...localLaunches.values()];
      localLaunches.clear();
      yield* Effect.forEach(pending, (deferred) => Deferred.fail(deferred, closing), {
        discard: true,
      });
    }),
  );

  const createSetupRepair = Effect.fn("CodexPendingWorktreeRuntime.createSetupRepair")(function* (
    hostId: string,
    pendingWorktreeId: string,
    agentMode: CodexAgentMode,
  ) {
    const entry = state.entriesById.get(pendingWorktreeId);
    if (!entry || entry.hostId !== hostId || !canCreateCodexPendingWorktreeSetupRepair(entry)) {
      return yield* runtimeError(
        "create-setup-repair",
        pendingWorktreeId,
        new Error(`Pending worktree cannot start setup repair: ${pendingWorktreeId}`),
      );
    }

    const prompt = buildCodexPendingWorktreeSetupRepairPrompt(entry);
    let startConversationParamsInput: CodexPendingStartConversationParamsInput;
    if (entry.launchMode === "start-conversation") {
      startConversationParamsInput = {
        ...entry.startConversationParamsInput,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        commentAttachments: [],
        workspaceRoots: [...entry.startConversationParamsInput.workspaceRoots],
        cwd: entry.sourceWorkspaceRoot,
        fileAttachments: [],
        addedFiles: [],
        threadSource: "system",
      };
    } else {
      const config = yield* gateway
        .requestLocal("config/read", {
          includeLayers: false,
          cwd: entry.sourceWorkspaceRoot,
        })
        .pipe(
          Effect.mapError((cause) =>
            runtimeError("read-setup-repair-config", pendingWorktreeId, cause),
          ),
        );
      startConversationParamsInput = {
        input: [{ type: "text", text: prompt, text_elements: [] }],
        commentAttachments: [],
        workspaceRoots: [...entry.sourceWorkspaceRoots],
        cwd: entry.sourceWorkspaceRoot,
        fileAttachments: [],
        addedFiles: [],
        agentMode,
        shouldSendPermissionOverrides: true,
        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode:
          entry.launchMode === "fork-conversation" ? entry.sourceCollaborationMode : null,
        config: expandCodexDynamicCreateConfigProfile(
          config.config as unknown as Readonly<Partial<Config>>,
        ),
        threadSource: "system",
        workspaceKind: "project",
      };
    }
    const allocated = allocateCodexPendingWorktreeRequest({
      hostId: entry.hostId,
      label: CODEX_PENDING_WORKTREE_SETUP_REPAIR_LABEL,
      initialThreadTitle: CODEX_PENDING_WORKTREE_SETUP_REPAIR_LABEL,
      sourceWorkspaceRoot: entry.sourceWorkspaceRoot,
      startingState: entry.startingState,
      localEnvironmentConfigPath: null,
      launchMode: "start-conversation",
      prompt,
      startConversationParamsInput,
      sourceConversationId: null,
      sourceCollaborationMode: null,
    });
    const createdAt = yield* Clock.currentTimeMillis;
    dispatch({ type: "create", request: allocated.request, createdAt });
    return allocated.result;
  });

  return CodexPendingWorktreeRuntime.of({
    list: () => snapshot,
    resolveThread: (clientThreadId) => resolveCodexPendingWorktreeThread(state, clientThreadId),
    changes: Stream.fromPubSub(changes),
    create: (request, createdAt) =>
      Effect.gen(function* () {
        const admittedAt = createdAt ?? (yield* Clock.currentTimeMillis);
        dispatch({ type: "create", request, createdAt: admittedAt });
      }),
    createSetupRepair,
    retry: (pendingWorktreeId) =>
      Effect.sync(() => {
        const entry = state.entriesById.get(pendingWorktreeId);
        const conversationStart =
          state.conversationStartsByPendingWorktreeId.get(pendingWorktreeId);
        if (entry?.phase === "worktree-ready" && conversationStart?.value.state === "failed") {
          dispatch({ type: "retryConversationStart", pendingWorktreeId });
          return;
        }
        dispatch({ type: "retry", pendingWorktreeId });
      }),
    workLocally: (pendingWorktreeId) =>
      localLaunchAdmission
        .withPermits(1)(
          Effect.gen(function* () {
            if (!accepting) {
              return yield* runtimeError(
                "work-locally",
                pendingWorktreeId,
                new Error("Pending worktree runtime is shut down"),
              );
            }
            const existing = localLaunches.get(pendingWorktreeId);
            if (existing) return existing;
            const deferred = yield* Deferred.make<
              { readonly threadId: string },
              CodexPendingWorktreeRuntimeError
            >();
            localLaunches.set(pendingWorktreeId, deferred);
            const effects = dispatch({ type: "workLocally", pendingWorktreeId });
            const started = effects.some(
              (effect) =>
                effect.type === "launchConversation" && effect.includeWorktreeInit === false,
            );
            if (started) return deferred;
            localLaunches.delete(pendingWorktreeId);
            yield* Deferred.fail(
              deferred,
              runtimeError(
                "work-locally",
                pendingWorktreeId,
                new Error(`Pending worktree cannot start locally: ${pendingWorktreeId}`),
              ),
            );
            return deferred;
          }),
        )
        .pipe(Effect.flatMap(Deferred.await)),
    continueWithoutSetup: (pendingWorktreeId) =>
      Effect.sync(() => dispatch({ type: "continueWithoutSetup", pendingWorktreeId })).pipe(
        Effect.asVoid,
      ),
    cancel: (pendingWorktreeId) =>
      Effect.sync(() => {
        rejectLocalLaunch(pendingWorktreeId, "Pending worktree launch canceled");
        interruptLaunch(pendingWorktreeId);
        dispatch({ type: "cancel", pendingWorktreeId });
      }),
    dismiss: (pendingWorktreeId) =>
      Effect.sync(() => {
        rejectLocalLaunch(pendingWorktreeId, "Pending worktree launch dismissed");
        interruptLaunch(pendingWorktreeId);
        dispatch({ type: "dismiss", pendingWorktreeId });
      }),
    rename: (pendingWorktreeId, label) =>
      Effect.sync(() => {
        const nextLabel = label.trim();
        if (!nextLabel) return;
        updateMetadata(pendingWorktreeId, { type: "label", label: nextLabel });
        updateMetadata(pendingWorktreeId, { type: "labelEdited", labelEdited: true });
      }),
    setPinned: (pendingWorktreeId, isPinned) =>
      Effect.sync(() => {
        updateMetadata(pendingWorktreeId, { type: "isPinned", isPinned });
        if (isPinned) return;
        updateMetadata(pendingWorktreeId, {
          type: "pinnedBeforeThreadId",
          beforeThreadId: null,
        });
      }),
    setPinnedBeforeThreadId: (pendingWorktreeId, beforeThreadId) =>
      Effect.sync(() => {
        updateMetadata(pendingWorktreeId, { type: "pinnedBeforeThreadId", beforeThreadId });
      }),
    clearAttention: (pendingWorktreeId) =>
      Effect.sync(() => {
        updateMetadata(pendingWorktreeId, { type: "needsAttention", needsAttention: false });
      }),
  });
});

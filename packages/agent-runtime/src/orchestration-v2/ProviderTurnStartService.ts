import { RuntimeModelPolicy } from "../nodex/ModelPolicy.ts";
import {
  readRunRecoveryContext,
  settleFailedRunAttempt,
  withoutRunRecovery,
} from "./RunRecovery.ts";
import { modelSelectionsEqual } from "@nodex/runtime-shared/model";
import { projectMessageForProvider } from "@nodex/runtime-shared/messageContextProjection";
import { readExecutionHandoff } from "./ExecutionHandoff.ts";
import { isNativeCompactCommand } from "./nativeMaintenanceCommand.ts";
import {
  CommandId,
  ORCHESTRATION_V2_NATIVE_SESSION_UNRECOVERABLE_FAILURE_CODE,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  contextHandoffDeliveredTo,
  handoffBudget,
  handoffBudgetEvidence,
  contextUsageForHandoff,
  latestNativeContextUsage,
} from "@nodex/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { makeProviderFailure } from "@nodex/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import { ThreadCommandExecutor } from "./ThreadCommandExecutor.ts";
import { restartCancelledBackgroundWorkNote } from "./RestartBackgroundNote.ts";
import { detachNativeConversation } from "./NativeConversation.ts";
import { nativeThreadHistoryEvents } from "./NativeThreadHistory.ts";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

/** Claude refuses to replace a process running background work before it reads the prompt. */
const refusedBeforePrompt = (error: unknown): boolean =>
  Predicate.isTagged(error, "ClaudeBackgroundWorkBlocksQueryReplacementError") ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

const permanentNativeRecoveryFailure = (error: unknown): boolean =>
  Predicate.isTagged(error, "ModelPolicyError") ||
  ((Predicate.isTagged(error, "ProviderAdapterOpenSessionError") ||
    Predicate.isTagged(error, "ProviderAdapterResumeThreadError")) &&
    Predicate.hasProperty(error, "retryable") &&
    error.retryable === false) ||
  (Predicate.hasProperty(error, "cause") && permanentNativeRecoveryFailure(error.cause));

/** Native fork failure is recoverable before the side chat has dispatched any user Turn. */
export const withSideChatForkFallback = Effect.fnUntraced(function* <A, E, R, B, E2, R2>(
  nativeFork: Effect.Effect<A, E, R>,
  portable: () => Effect.Effect<B, E2, R2>,
  sideChat: boolean,
): Effect.fn.Return<A | B, E | E2, R | R2> {
  const attempt = yield* Effect.result(nativeFork);
  if (attempt._tag === "Success") return attempt.success;
  if (!sideChat) return yield* Effect.fail(attempt.failure);
  return yield* portable();
});

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. Retryable startup failures return to the
   * worker while `willRetry` is true. Known permanent recovery failures and
   * exhausted retries consult the Run recovery policy before finalizing.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("nodex/runtime/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | ThreadCommandExecutor
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const git = Option.getOrUndefined(yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver));
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const threadCommands = yield* ThreadCommandExecutor;

    const makeRelatedNativeResolver =
      (input: {
        readonly threadId: ThreadId;
        readonly providerThreadId: OrchestrationV2ProviderThread["id"];
        readonly providerSessionId: NonNullable<OrchestrationV2ProviderThread["providerSessionId"]>;
        readonly nativeThreadId: string | undefined;
      }) =>
      (
        address: Parameters<
          ProjectionStore.ProjectionStoreV2Shape["getRelatedNativeThread"]
        >[0]["address"],
      ) =>
        input.nativeThreadId === undefined
          ? Effect.succeed(null)
          : projectionStore.getRelatedNativeThread({
              ...input,
              nativeThreadId: input.nativeThreadId,
              address,
            });

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly userMessageId: import("@nodex/runtime-contracts").MessageId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      // Guards and background routing need live execution state, not a fresh
      // allocation of every completed message and tool output in the thread.
      // `false` means the run moved on or is gone. A failed read is an error,
      // so the caller fails the start or the run instead of skipping it.
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        readExecutionHandoff(projectionStore, input.threadId).pipe(
          Effect.flatMap((hold) =>
            hold
              ? Effect.succeed(false)
              : projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
                  Effect.map((current) => {
                    const run = current.runs.find((candidate) => candidate.id === input.runId);
                    return (
                      run?.activeAttemptId === input.attemptId && run.status === expectedStatus
                    );
                  }),
                ),
          ),
        );
      return {
        isRunTerminal: (ownerRunId: RunId) =>
          projectionStore
            .getRunOutcome({ threadId: input.threadId, runId: ownerRunId })
            .pipe(
              Effect.map(
                (owner) =>
                  owner !== null &&
                  ["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(
                    owner.status,
                  ),
              ),
            ),
        recoveryControls: {
          read: () => readRunRecoveryContext(projectionStore, input),
          withLock: threadCommands.withLock,
        },
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.gen(function* () {
          const policy = yield* RuntimeModelPolicy;
          yield* policy.assert(input.modelSelection, input.modelPolicyOrigin ?? "automatic").pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause,
                }),
            ),
          );
          return yield* Effect.suspend(() => {
            if (deliver !== undefined) return deliver(input, compact);
            return compact && session.compactThread !== undefined
              ? session.compactThread(input)
              : session.startTurn(input);
          });
        }).pipe(
          // Only startup needs the handoff history. The event worker keeps this
          // session alive afterward, including when background work remains.
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      if (yield* readExecutionHandoff(projectionStore, input.threadId)) return;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        // The effect is idempotent once the run has advanced or terminalized.
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const originalMessage = projection.messages.find(
        (candidate) => candidate.id === run.userMessageId,
      );
      if (
        run.contextRecovery !== undefined &&
        (providerThread?.id !== run.contextRecovery.providerThreadId ||
          providerThread.nativeThreadRef?.nativeId !== run.contextRecovery.nativeThreadId)
      )
        return yield* new ProviderTurnStartError({
          runId,
          cause: "The recovery native conversation changed.",
        });
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.status === "ready" &&
          (providerThread === undefined || !contextHandoffDeliveredTo(handoff, providerThread)) &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId && isNativeCompactCommand(message),
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        originalMessage === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const message = originalMessage;
      // Settles a run that never reached the provider: one signal turn item plus
      // terminal run, attempt and root node, written only while the run is still
      // the current starting attempt.
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          /** Omitted when the run never started, so `startedAt` stays as projected. */
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          /** Emitted after the run events when the provider thread should go idle. */
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: projection.nextTurnItemOrdinal,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            {
              type: "run.updated",
              payload: { ...withoutRunRecovery(run), status, ...started, completedAt: now },
            },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events: Array<OrchestrationV2DomainEvent> = yield* Effect.forEach(
            eventPayloads,
            (event) =>
              Effect.gen(function* () {
                return {
                  ...event,
                  id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                  threadId: projection.thread.id,
                  runId,
                  nodeId: rootNode.id,
                  providerInstanceId: input.providerInstanceId,
                  occurredAt: now,
                } satisfies OrchestrationV2DomainEvent;
              }),
          );
          if (run.recovery !== undefined) {
            const retries = yield* projectionStore.getThreadRecords(
              projection.thread.id,
              ["turnItems"],
              {
                turnItemRunId: run.id,
                turnItemTypes: ["error"],
                turnItemStatuses: ["running"],
              },
            );
            for (const retry of retries.turnItems) {
              if (retry.type !== "error" || retry.retry === undefined) continue;
              events.push({
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated",
                threadId: projection.thread.id,
                runId,
                ...(retry.nodeId === null ? {} : { nodeId: retry.nodeId }),
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...retry,
                  status: status === "failed" ? "failed" : "completed",
                  completedAt: now,
                  updatedAt: now,
                },
              });
            }
          }
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction = isNativeCompactCommand(message) && !projection.hasConversation;
        // Preparing a run may already point the thread at a newly selected
        // provider. Account commands still belong to its last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectMessageForProvider(message),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                  cause: authResult.failure,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath, branch } = projection.thread;
      if (worktreePath !== null && branch !== null && git !== undefined) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        if (!exists) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            yield* git.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
              Effect.andThen(
                git.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("provider turn start failed to recreate worktree", {
                      threadId: projection.thread.id,
                      worktreePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        userMessageId: run.userMessageId,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
        thread: projection.thread,
        modelSelection: run.modelSelection,
      });
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          ...(projection.thread.sideChat ? { ephemeral: true } : {}),
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          modelPolicyOrigin: run.modelPolicyOrigin ?? "automatic",
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      // Exhausted transport retries settle through the same Run policy as a failed native turn.
      const settleStartFailure = Effect.fn("orchestrationV2.providerTurnStart.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
        }) {
          yield* threadCommands.withLock(
            projection.thread.id,
            Effect.gen(function* () {
              const context = yield* runControls.recoveryControls.read();
              const current = context.runs.find((candidate) => candidate.id === run.id);
              if (current?.activeAttemptId !== attempt.id || current.status !== "starting") return;
              const now = yield* DateTime.now;
              const signal = `${failed.signal}:${attempt.id}`;
              const nonRetryable = permanentNativeRecoveryFailure(failed.error);
              const unrecoverableNativeSession =
                providerThread.nativeThreadRef !== null && nonRetryable;
              const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
              const failure = makeProviderFailure({
                cause: failed.error,
                message: unrecoverableNativeSession
                  ? "The Agent couldn't reopen this conversation"
                  : nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message,
                ...(nonRetryable ? { retryable: false } : {}),
                ...(unrecoverableNativeSession
                  ? { code: ORCHESTRATION_V2_NATIVE_SESSION_UNRECOVERABLE_FAILURE_CODE }
                  : {}),
                class: "provider_error",
              });
              yield* settleFailedRunAttempt({
                ids: idAllocator,
                sink: eventSink,
                context,
                run: current,
                attempt,
                rootNode,
                now,
                failureItem: {
                  id: idAllocator.derive.runSignalTurnItem({ runId, signal }),
                  threadId: current.threadId,
                  runId,
                  nodeId: rootNode.id,
                  providerThreadId: providerThread.id,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: projection.nextTurnItemOrdinal,
                  type: "error",
                  title: failed.title,
                  failure,
                  status: "failed",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                },
                finalize: settleRunBeforeStart({
                  signal,
                  status: "failed",
                  now,
                  providerInstanceId: current.providerInstanceId,
                  itemProviderThreadId: providerThread.id,
                  item: { type: "error", title: failed.title, failure },
                }),
              });
            }),
          );
        },
      );
      if (sessionResult._tag === "Failure") {
        if (input.willRetry === true && !permanentNativeRecoveryFailure(sessionResult.failure))
          return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title:
            providerThread.nativeThreadRef === null
              ? "Provider session failed to open"
              : "The Agent couldn't reopen this conversation",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      // Only the provider's own thread load fails the run on the last attempt;
      // store, id and handoff failures around it keep their typed errors.
      const loadFromProvider = <A>(
        load: Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error>,
      ) =>
        Effect.gen(function* () {
          const loaded = yield* Effect.result(load);
          if (loaded._tag === "Success") return loaded.success;
          if (input.willRetry === true && !permanentNativeRecoveryFailure(loaded.failure))
            return yield* loaded.failure;
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: loaded.failure,
          });
          return undefined;
        });
      let effectiveHandoffs = handoffs;
      let forkedNatively = nativeForkTransfer !== undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const portableFork = Effect.fnUntraced(function* (sourceRunOrdinal: number | null) {
            forkedNatively = false;
            const preparedHistory =
              (projection.thread.capturedContext
                ? yield* projectionStore.getSideChatContext(input.threadId)
                : null) ??
              (yield* projectionStore.getHandoffHistory({
                scope: "conversation",
                threadId: nativeForkTransfer.sourceThreadId,
                ...(sourceRunOrdinal === null ? {} : { runOrdinalTo: sourceRunOrdinal }),
                asOfRunOrdinalTo: true,
                historyRevision:
                  projection.thread.forkedFrom?.type === "run"
                    ? projection.thread.forkedFrom.sourceHistoryRevision
                    : undefined,
                includeImported: true,
                budget: handoffBudget({
                  tokenCap: contextHandoffService.historyBudget,
                  userText: message.text,
                  attachments: message.attachments,
                  providerThread: { ...providerThread, contextUsage: null },
                  nativeContextEstimate: 0,
                  modelContextWindow: session.getModelContextWindow?.(
                    run.modelSelection,
                    resolvedRuntimePolicy.cwd,
                  ),
                }),
              }));
            const createdAt = yield* DateTime.now;
            const handoff = yield* contextHandoffService.prepareProviderHandoff({
              threadId: input.threadId,
              targetRunId: run.id,
              transferId: nativeForkTransfer.id,
              fromProviderThreadIds: preparedHistory.fromProviderThreadIds,
              toProviderThreadId: providerThread.id,
              fromProviderInstanceId:
                nativeForkTransfer.sourceProviderInstanceId ?? run.providerInstanceId,
              toProviderInstanceId: run.providerInstanceId,
              coveredRunOrdinals: preparedHistory.coveredRunOrdinals,
              strategy: "full_thread_summary",
              items: [],
              preparedHistory,
              createdAt,
            });
            const portableWrite = yield* eventSink.writeIfRunCurrent({
              threadId: input.threadId,
              runId: run.id,
              activeAttemptId: attempt.id,
              expectedStatus: "starting",
              events: [
                {
                  id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                  type: "context-handoff.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: createdAt,
                  payload: handoff,
                },
                {
                  id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                  type: "context-transfer.updated",
                  threadId: input.threadId,
                  runId: run.id,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: createdAt,
                  payload: {
                    ...nativeForkTransfer,
                    status: "resolved_portable",
                    resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                    error: null,
                    updatedAt: createdAt,
                  },
                },
              ],
            });
            if (!portableWrite.committed) return undefined;
            effectiveHandoffs = [handoff, ...effectiveHandoffs];
            return yield* loadFromProvider(
              session.ensureThread({
                ...(projection.thread.sideChat ? { ephemeral: true } : {}),
                threadId: input.threadId,
                title: projection.thread.title,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                providerSessionId,
                existingProviderThread: {
                  ...providerThread,
                  nativeThreadRef: null,
                  forkedFrom: null,
                },
              }),
            );
          });
          // The source boundary and its native copy must observe one history revision.
          return yield* threadCommands.withLock(
            nativeForkTransfer.sourceThreadId,
            Effect.gen(function* () {
              if (nativeForkTransfer.sourcePoint.runId === undefined) {
                return yield* new ProviderTurnStartError({
                  runId,
                  cause: `Native fork transfer ${nativeForkTransfer.id} has no source run.`,
                });
              }
              const boundary = yield* projectionStore.getNativeForkBoundary(
                nativeForkTransfer.sourceThreadId,
                nativeForkTransfer.sourcePoint.runId,
              );
              // A source row may have rebound while this fork was queued. Its old
              // accepted turn cannot be combined with the replacement native thread.
              if (!boundary.nativeIncarnationMatches && boundary.sourceRunOrdinal !== null)
                return yield* portableFork(boundary.sourceRunOrdinal);
              const sourceProviderThread = boundary.providerThread;
              const sourceProviderTurn = boundary.providerTurn;
              if (sourceProviderThread === null) {
                return yield* new ProviderTurnStartError({
                  runId,
                  cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
                });
              }
              const nativeFork = session.forkThread({
                ...(projection.thread.sideChat ? { ephemeral: true } : {}),
                sourceProviderThread,
                sourceProviderTurns: sourceProviderTurn === null ? [] : [sourceProviderTurn],
                sourceRollbackTurnCount: boundary.rollbackTurnCount,
                loadSourceFollowingTurns: (following) =>
                  projectionStore
                    .getNativeForkBoundary(
                      nativeForkTransfer.sourceThreadId,
                      nativeForkTransfer.sourcePoint.runId!,
                      following,
                    )
                    .pipe(
                      Effect.flatMap((current) =>
                        current.nativeIncarnationMatches
                          ? Effect.succeed(current.followingProviderTurns)
                          : Effect.fail(
                              new ProviderAdapter.ProviderAdapterProtocolError({
                                driver: session.driver,
                                detail:
                                  "Native fork source incarnation changed before its boundary was read.",
                              }),
                            ),
                      ),
                      Effect.mapError((cause) =>
                        Schema.is(ProviderAdapter.ProviderAdapterV2Error)(cause)
                          ? cause
                          : new ProviderAdapter.ProviderAdapterProtocolError({
                              driver: session.driver,
                              detail: "Native fork source boundary could not be read.",
                              cause,
                            }),
                      ),
                    ),
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === null ? {} : { providerTurnId: sourceProviderTurn.id }),
              });
              if (projection.thread.sideChat)
                return yield* withSideChatForkFallback(
                  nativeFork,
                  () => portableFork(boundary.sourceRunOrdinal),
                  true,
                );
              return yield* loadFromProvider(nativeFork);
            }),
          );
        }
        // A fresh native session continues this conversation from bounded portable history
        // of every earlier Run, so it never receives a continuation without its context.
        const carryPortableHistory = Effect.fnUntraced(function* (
          replacement: OrchestrationV2ProviderThread,
        ) {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const preparedHistory = yield* projectionStore.getHandoffHistory({
            scope: "conversation",
            threadId: input.threadId,
            runOrdinalTo: run.ordinal - 1,
            runStatuses: ["completed", "failed", "interrupted"],
            includeImported: true,
            budget: handoffBudget({
              tokenCap: contextHandoffService.historyBudget,
              userText: message.text,
              attachments: message.attachments,
              providerThread: { ...replacement, contextUsage: null },
              nativeContextEstimate: 0,
              modelContextWindow: session.getModelContextWindow?.(
                run.modelSelection,
                resolvedRuntimePolicy.cwd,
              ),
            }),
          });
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: preparedHistory.coveredRunOrdinals,
            strategy: "full_thread_summary",
            items: [],
            preparedHistory,
            createdAt,
          });
          effectiveHandoffs = [handoff, ...effectiveHandoffs];
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  id: transferId,
                  type: "provider_handoff",
                  sourceThreadId: projection.thread.id,
                  targetThreadId: projection.thread.id,
                  sourcePoint: { threadId: projection.thread.id },
                  basePoint: null,
                  sourceProviderInstanceId: providerThread.providerInstanceId,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  createdBy: "system",
                  error: null,
                  createdAt,
                  updatedAt: createdAt,
                  consumedAt: null,
                },
              },
            ],
          });
        });
        if (providerThread.nativeThreadRef === null) {
          // Hand the run's provider thread to the adapter so it adopts this
          // row's identity when attaching native state. An adapter that mints
          // its own row instead leaves two live rows per app thread, and
          // `activeProviderThreadId` then flaps between them on every update.
          const fresh = yield* loadFromProvider(
            session.ensureThread({
              ...(projection.thread.sideChat ? { ephemeral: true } : {}),
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
          // A fresh incarnation must also recover a fork's captured base, even when
          // rewinding removed every local Run. Native forks return above.
          const hasPreparedHistory = effectiveHandoffs.some(
            (handoff) =>
              handoff.targetRunId === run.id && handoff.strategy === "full_thread_summary",
          );
          if (
            fresh !== undefined &&
            ((providerThread.contextHandoffRequired === true && !hasPreparedHistory) ||
              run.restartContinuationOfRunId !== undefined ||
              (projection.thread.forkedFrom?.type === "run" && !hasPreparedHistory))
          )
            yield* carryPortableHistory(fresh);
          return fresh;
        }
        const uncertainDelivery = projection.uncertainDelivery;
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }
        if (
          session.nativeResumeFailurePolicy === "fail" ||
          run.contextRecovery !== undefined ||
          attempt.reason === "provider_recovery"
        ) {
          if (input.willRetry === true && !permanentNativeRecoveryFailure(resumed.failure))
            return yield* resumed.failure;
          yield* settleStartFailure({
            signal: "provider-native-session-recovery-failure",
            title: "The Agent couldn't reopen this conversation",
            error: resumed.failure,
          });
          return undefined;
        }

        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery ? "uncertain_history_delivery" : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            ...(projection.thread.sideChat ? { ephemeral: true } : {}),
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // The native ref is dropped so the adapter binds a fresh native
            // session instead of retrying the resume that just failed, while
            // still adopting this row's identity.
            existingProviderThread: detachNativeConversation(providerThread, yield* DateTime.now),
          }),
        );
        if (replacement === undefined) return undefined;
        yield* carryPortableHistory(replacement);
        return replacement;
      });
      // The last attempt already failed the run.
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      // Resume may reconcile a receipt; continuation uses that receipt, not the startup copy.
      const inputMessage =
        attempt.reason === "provider_recovery"
          ? ((yield* projectionStore.getRunMessage(input.threadId, run.id)) ?? message)
          : message;
      if (
        attempt.reason === "provider_recovery" &&
        inputMessage.delivery !== "accepted" &&
        inputMessage.delivery !== "pending"
      ) {
        yield* settleRunBeforeStart({
          signal: "recovery-delivery-unknown",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message delivery unconfirmed",
            failure: makeProviderFailure({
              message:
                "Nodex could not confirm delivery of the original message. Continue manually to avoid sending it twice.",
              code: "recovery_delivery_unknown",
              retryable: false,
              class: "provider_error",
            }),
          },
        });
        return;
      }
      // The first native restoration already collected replay in the adapter.
      // Commit it with the existing start transition so cancellation/retries cannot
      // expose a loaded marker without its history, or attach old messages to this Run.
      let importedHistory: ReadonlyArray<OrchestrationV2DomainEvent> = [];
      if (
        providerThread.status === "not_loaded" &&
        providerThread.nativeMetadata?.nativeImport?.canLoad === true &&
        session.providerSession.capabilities.threads.canReadThreadSnapshot
      ) {
        const nativeSnapshot = yield* loadFromProvider(
          session.readThreadSnapshot({ providerThread: loadedProviderThread }),
        );
        if (nativeSnapshot === undefined) return;
        importedHistory = nativeThreadHistoryEvents({
          providerThread: loadedProviderThread,
          messages: nativeSnapshot.messages,
          idAllocator,
        });
      }
      const now = yield* DateTime.now;
      // Only started runs reached the provider-thread update below. Queued runs and
      // failures during session setup cannot establish a new telemetry selection.
      const measuredContext = latestNativeContextUsage(projection, providerThread);
      const previousSelection =
        measuredContext?.modelSelection ??
        projection.runs.findLast(
          (source) =>
            source.ordinal < run.ordinal &&
            source.startedAt !== null &&
            source.providerThreadId === providerThread.id,
        )?.modelSelection;
      const sameSelection =
        previousSelection === undefined ||
        modelSelectionsEqual(previousSelection, run.modelSelection);
      const sameNativeThread =
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const knownModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      // Persist before delivery. Keep this native transcript's measured
      // occupancy. A different model drops compaction telemetry and uses the
      // new window when that window is known.
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage,
        knownModelWindow,
      });
      const { contextHandoffRequired: _handoffRequired, ...attachedProviderThread } =
        loadedProviderThread;
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...attachedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        ...importedHistory,
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined ||
        !forkedNatively ||
        runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const continuation =
        attempt.reason === "provider_recovery"
          ? inputMessage.delivery === "accepted"
            ? session.providerSession.capabilities.turns.supportsEmptyContinuation === true
              ? "empty"
              : "prompt"
            : "resend"
          : attempt.continuation;
      const syntheticContinuation = continuation === "empty" || continuation === "prompt";
      const userText = syntheticContinuation
        ? continuation === "empty"
          ? ""
          : "Continue where you left off."
        : projectMessageForProvider({
            text: inputMessage.providerText ?? inputMessage.text,
            context: inputMessage.context,
          });
      // Delivered once: this run's provider turn marks the work as told. A
      // restart continuation is prompted by its own text or resumes natively.
      const noteContinuation = projection.restartNoteState.continuation;
      const restartCancelledWork = projection.restartNoteState.work;
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : [
              restartCancelledBackgroundWorkNote(restartCancelledWork),
              ...(projection.restartNoteState.totalWork > restartCancelledWork.length
                ? [
                    `- and ${projection.restartNoteState.totalWork - restartCancelledWork.length} more`,
                  ]
                : []),
            ].join("\n");
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const nativeId = runningProviderThread.nativeThreadRef?.nativeId ?? undefined;
      const nativeContextEstimate =
        sameNativeThread && nativeId !== undefined
          ? projectionStore.getNativeContextEstimate({
              threadId: input.threadId,
              runId: run.id,
              providerThreadId: providerThread.id,
              nativeThreadId: nativeId,
            })
          : Effect.succeed(0);
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      // Replacing a native thread clears its usage, not the selected model's capacity.
      const budgetProviderThread = {
        ...runningProviderThread,
        contextUsage: handoffUsage,
      };
      const retainedRequestItems =
        run.contextRecovery?.phase !== "retry"
          ? []
          : (yield* projectionStore.getThreadRecords(input.threadId, ["turnItems"], {
              turnItemRunIds: [run.contextRecovery.failedRunId],
              turnItemTypes: ["user_message", "error"],
            })).turnItems.map((item) => item.id);
      const retryHistoryInput = {
        excludeItemIds: retainedRequestItems,
        scope: "local" as const,
        threadId: input.threadId,
        runOrdinalTo: run.ordinal - 1,
        runStatuses: ["failed", "interrupted"] as const,
        missingFromProviderThreadId: providerThread.id,
        ...(nativeId === undefined
          ? {}
          : {
              excludeDelivered: { providerThreadId: providerThread.id, nativeThreadId: nativeId },
            }),
      };
      const missedHead = yield* projectionStore.getHandoffHistory({
        ...retryHistoryInput,
        budget: 0,
      });
      // Coverage includes checkpoint/control items; only historical text warrants replay.
      const missedHistoricalCount =
        missedHead.history.messages.length + missedHead.history.omittedItems;
      const missedHistory =
        missedHistoricalCount === 0
          ? missedHead
          : yield* projectionStore.getHandoffHistory({
              ...retryHistoryInput,
              budget: handoffBudget({
                tokenCap,
                modelContextWindow,
                userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                attachments: inputMessage.attachments,
                providerThread: budgetProviderThread,
                nativeContextEstimate:
                  budgetProviderThread.contextUsage?.usedTokens === undefined
                    ? yield* nativeContextEstimate
                    : 0,
              }),
            });
      const deliveryItemIds = [
        ...new Set([
          ...effectiveHandoffs.flatMap((h) => h.history?.messages.map((m) => m.itemId) ?? []),
          ...missedHistory.history.messages.map((m) => m.itemId),
        ]),
      ];
      const deliveredItemIds = new Set(
        nativeId === undefined || deliveryItemIds.length === 0
          ? []
          : yield* projectionStore.getDeliveredHandoffItemIds({
              threadId: input.threadId,
              providerThreadId: providerThread.id,
              nativeThreadId: nativeId,
              itemIds: deliveryItemIds,
            }),
      );
      const startWithHandoffs = (
        turnInput: Parameters<typeof session.startTurn>[0],
        compact = false,
      ) =>
        Effect.gen(function* () {
          // A failed turn/start can leave the requested turn absent from
          // native history even when its preceding handoff was injected.
          const retryHandoff =
            missedHistoricalCount === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: missedHistory.coveredRunOrdinals,
                    strategy: "delta_since_target_last_seen",
                    items: [],
                    preparedHistory: missedHistory,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact,
            providerThread: runningProviderThread,
            budget: Effect.gen(function* () {
              return handoffBudgetEvidence({
                tokenCap,
                modelContextWindow,
                // The note is sent with the user text, so it spends the same allowance.
                userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                attachments: inputMessage.attachments,
                providerThread: budgetProviderThread,
                nativeContextEstimate:
                  budgetProviderThread.contextUsage?.usedTokens === undefined
                    ? yield* nativeContextEstimate
                    : 0,
              });
            }),
            alreadyDeliveredItemIds: deliveredItemIds,
            omittedHandoffCount: projection.omittedHandoffCount,
            ...(session.injectHistory === undefined ||
            (compact && run.contextRecovery?.phase === "compact")
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: (handoff) =>
              Effect.gen(function* () {
                const updatedAt = yield* DateTime.now;
                yield* eventSink.write({
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({
                        threadId: projection.thread.id,
                      }),
                      type: "context-handoff.updated",
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: updatedAt,
                      payload: { ...handoff, updatedAt },
                    },
                  ],
                });
              }),
          });
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [delivery.context, restartNote]
            .filter((part) => part !== "")
            .join("\n\n");
          // A note continuation has no turn to resume; its text is the prompt.
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: context === "" ? userText : `${context}\n\nUser message:\n${userText}`,
            },
          }).pipe(
            // A pending marker would make the next turn abandon this native
            // session, though the refused prompt never reached it.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // The provider already accepted the turn. A stale pending marker
          // can force a fresh thread later, but must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        }).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ProviderAdapterTurnStartError"
              ? cause
              : new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId: run.id,
                  cause,
                }),
          ),
        );
      const deliverySession =
        continuation === "empty"
          ? session
          : effectiveHandoffs.length === 0 &&
              projection.omittedHandoffCount === 0 &&
              missedHistoricalCount === 0 &&
              restartNote === "" &&
              !noteContinuation
            ? session
            : makeDeliverySession(session, startWithHandoffs);
      yield* runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        isRunTerminal: runControls.isRunTerminal,
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        ...(continuation === undefined ? {} : { continuation }),
        recoveryControls: runControls.recoveryControls,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        resolveRelatedNativeThread: makeRelatedNativeResolver({
          threadId: input.threadId,
          providerThreadId: providerThread.id,
          providerSessionId,
          nativeThreadId: nativeId,
        }),
        providerTurnOrdinal: projection.providerTurnOrdinal,
        nativeThreadHasTurns:
          nativeId !== undefined &&
          (yield* projectionStore.hasNativeTurns({
            threadId: input.threadId,
            providerThreadId: providerThread.id,
            nativeThreadId: nativeId,
            sameNativeThread,
          })),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        message: {
          messageId: inputMessage.id,
          ...(inputMessage.delivery === undefined ? {} : { delivery: inputMessage.delivery }),
          text: userText,
          attachments: syntheticContinuation ? [] : inputMessage.attachments,
          createdBy: inputMessage.createdBy,
          creationSource: inputMessage.creationSource,
          ...(inputMessage.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: inputMessage.scheduledTaskId }),
          ...(inputMessage.senderThreadId === undefined
            ? {}
            : { senderThreadId: inputMessage.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        start(input).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);

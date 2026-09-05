import {
  expandCodexAsyncQuestions,
  readCodexAsyncQuestionReplies,
} from "../../shared/codex-async-user-input";
import { randomUUID } from "node:crypto";
import type { RequestId } from "@nodex/codex-app-server-protocol";
import type { Thread } from "@nodex/codex-app-server-protocol/v2";
import { CodexAppServerNoResponse } from "@nodex/effect-codex-app-server/protocol";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  projectCodexCanonicalProtocolThread,
  type CodexCanonicalConversationState,
} from "../../shared/codex-conversation-state/codex-conversation-state";
import type { CodexConversationReducerEffect } from "../../shared/codex-conversation-state/codex-conversation-reducer";
import { extractCodexThreadSpawnMetadata } from "../../shared/codex-subagent-metadata";
import type { CodexNotificationConversationFacts } from "../../shared/codex-thread-notification";
import {
  hasCodexPendingContinuation,
  parseCodexHeartbeatAssistantMessage,
} from "../../shared/codex-turn-notification";
import {
  reduceCodexConversationServerRequestResolved,
  reduceCodexServerRequestResolvedRawState,
} from "../../shared/codex-conversation-state/codex-server-request-lifecycle";
import {
  isCodexCommandOutputNotification,
  toCodexCommandOutputUpdate,
} from "../../shared/codex-conversation-state/codex-command-execution-stream";
import {
  isCodexFrameTextDeltaNotification,
  toCodexFrameTextDelta,
} from "../../shared/codex-conversation-state/codex-frame-text-delta";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { sanitizeCodexLiveLifecycleNotification } from "../../shared/codex-conversation-state/codex-live-turn-residency";
import { CodexTerminalInteractionAccumulator } from "../../shared/codex-terminal-interaction";
import { toCodexThreadStartedMetadataNotification } from "../../shared/codex-thread-start-metadata";
import {
  getCodexThreadOwnerNotificationThreadId,
  isCodexThreadOwnerNotification,
} from "../../shared/types";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexActiveGoalContinuation } from "./CodexActiveGoalContinuation";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAutomationTurnCompletion } from "./CodexAutomationTurnCompletion";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexConversationDeltaBufferRuntime } from "./CodexConversationDeltaBufferRuntime";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationProjection } from "./CodexProtocolNotificationProjection";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";
import {
  CodexThreadDurableProjection,
  isCodexThreadDurableProjectionNotification,
} from "./CodexThreadDurableProjection";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexProtocolNotificationInput {
  readonly hostId: string;
  readonly generation: number;
  readonly notification: CodexServerNotification;
  readonly occurrenceId: string;
  readonly occurrenceToken: number;
}

export type CodexConversationDisposition = "retain" | "retire";

export class CodexProtocolNotificationEffects extends Context.Service<
  CodexProtocolNotificationEffects,
  {
    readonly apply: (
      input: CodexProtocolNotificationInput,
    ) => Effect.Effect<CodexConversationDisposition, CodexNotificationConsequenceError>;
  }
>()("nodex/main/codex-application/CodexProtocolNotificationEffects") {}

export class CodexNotificationConsequenceError extends Data.TaggedError(
  "CodexNotificationConsequenceError",
)<{
  readonly method: string;
  readonly threadId: string;
  readonly cause: Cause.Cause<unknown>;
}> {}

const isInterruptedOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

const paramsRecord = (
  notification: CodexServerNotification,
): Readonly<Record<string, unknown>> | null =>
  typeof notification.params === "object" && notification.params !== null
    ? (notification.params as Readonly<Record<string, unknown>>)
    : null;

/** Every Thread-addressed notification uses the same causal lane, including lifecycle events. */
export const codexProtocolNotificationThreadId = (
  notification: CodexServerNotification,
): string | null => {
  if (isCodexThreadOwnerNotification(notification)) {
    return getCodexThreadOwnerNotificationThreadId(notification);
  }
  const params = paramsRecord(notification);
  if (typeof params?.threadId === "string") return params.threadId;
  const thread =
    typeof params?.thread === "object" && params.thread !== null
      ? (params.thread as Readonly<Record<string, unknown>>)
      : null;
  return typeof thread?.id === "string" ? thread.id : null;
};

/**
 * Interprets one transport-ordered notification into durable and process-local consequences.
 * `CodexApplicationProtocol` supplies the causal Thread lane; no other stream consumer projects
 * these notifications.
 */
export const make: Effect.Effect<
  CodexProtocolNotificationEffects["Service"],
  never,
  | CodexActiveGoalContinuation
  | CodexApplicationEventHub
  | CodexAutomationTurnCompletion
  | CodexConversationDeltaBufferRuntime
  | CodexConversationLifecycle
  | CodexConversationProjection
  | CodexManualCompactionRuntime
  | CodexPendingServerRequestRuntime
  | CodexProtocolNotificationProjection
  | CodexQueuedFollowUps
  | CodexRendererConversationCoordinator
  | CodexThreadDurableProjection
  | CodexSubagentDirectory
  | CodexThreadGoalRuntime
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | BrowserUseRuntime
  | RemoteHostedPipRuntime
> = Effect.gen(function* () {
  const activeGoalContinuation = yield* CodexActiveGoalContinuation;
  const events = yield* CodexApplicationEventHub;
  const automation = yield* CodexAutomationTurnCompletion;
  const deltas = yield* CodexConversationDeltaBufferRuntime;
  const lifecycle = yield* CodexConversationLifecycle;
  const conversationProjection = yield* CodexConversationProjection;
  const manualCompaction = yield* CodexManualCompactionRuntime;
  const pending = yield* CodexPendingServerRequestRuntime;
  const globalProjection = yield* CodexProtocolNotificationProjection;
  const queued = yield* CodexQueuedFollowUps;
  const renderer = yield* CodexRendererConversationCoordinator;
  const durableThreads = yield* CodexThreadDurableProjection;
  const subagents = yield* CodexSubagentDirectory;
  const threadGoals = yield* CodexThreadGoalRuntime;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const conversations = yield* ConversationEntityMap;
  const browserUse = yield* BrowserUseRuntime;
  const remoteHostedPip = yield* RemoteHostedPipRuntime;
  const terminalInputBuffers = new CodexTerminalInteractionAccumulator();

  const logFailure = (method: string, threadId: string, cause: unknown): Effect.Effect<void> =>
    Effect.logWarning("Codex notification consequence failed").pipe(
      Effect.annotateLogs({ method, threadId, cause }),
    );

  const loadedProtocolThread = (state: CodexCanonicalConversationState | null): Thread | null => {
    if (!state) return null;
    return projectCodexCanonicalProtocolThread(state);
  };

  const conversationFacts = (threadId: string): CodexNotificationConversationFacts => {
    const snapshot = conversations.current(threadId)?.readSnapshot();
    const parentThreadId = extractCodexThreadSpawnMetadata(snapshot?.source).parentThreadId ?? null;
    return {
      conversationId: threadId,
      title: snapshot?.threadName ?? null,
      threadSource: snapshot?.threadSource ?? null,
      parentThreadId,
      source: snapshot?.source ?? null,
      sideConversationParentNavigationPath:
        snapshot?.source &&
        typeof snapshot.source === "object" &&
        "sideConversationParentNavigationPath" in snapshot.source &&
        typeof snapshot.source.sideConversationParentNavigationPath === "string"
          ? snapshot.source.sideConversationParentNavigationPath
          : null,
    };
  };

  const lastAgentMessage = (threadId: string, turn: Thread["turns"][number]): string | null => {
    const canonical = conversations.current(threadId)?.readCanonicalState();
    const canonicalTurn = canonical?.turns.find((candidate) => candidate.protocol.id === turn.id);
    const canonicalMessage = [...(canonicalTurn?.items ?? [])]
      .reverse()
      .find((item) => item.type === "agentMessage")
      ?.text.trim();
    if (canonicalMessage) return canonicalMessage;
    return (
      [...turn.items]
        .reverse()
        .find((item) => item.type === "agentMessage")
        ?.text.trim() || null
    );
  };

  const publishTurnCompleted = Effect.fn("CodexProtocolNotificationEffects.publishTurnCompleted")(
    function* (
      threadId: string,
      turn: Extract<CodexServerNotification, { method: "turn/completed" }>["params"]["turn"],
    ) {
      if (turn.status === "inProgress") return;
      const aggregate = conversations.current(threadId);
      const canonical = aggregate?.readCanonicalState();
      const snapshot = aggregate?.readSnapshot();
      const descendantOverview = yield* subagents
        .readKnownOverview({ rootThreadId: threadId })
        .pipe(
          Effect.catchCause((cause) =>
            logFailure("resolve-notification-descendants", threadId, cause).pipe(Effect.as(null)),
          ),
        );
      const message = lastAgentMessage(threadId, turn);
      const queuedHead = queued.list(threadId)[0];
      events.publish({
        kind: "threadNotification",
        value: {
          type: "turn-completed",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversation: conversationFacts(threadId),
          turnId: turn.id,
          status: turn.status,
          lastAgentMessage: message,
          heartbeatAssistantMessage: parseCodexHeartbeatAssistantMessage(message),
          automationNotificationDecision: null,
          hasPendingContinuation: hasCodexPendingContinuation({
            terminalStatus: turn.status,
            queuedResourceLoading: false,
            queuedHeadPausedReason: queuedHead ? (queuedHead.pause?.reason ?? null) : undefined,
            threadGoalStatus: snapshot?.threadGoal?.status ?? null,
            latestMergedTurnStatus: canonical?.turns.at(-1)?.protocol.status ?? null,
            hasRunningCollabAgent:
              canonical?.turns.some((candidate) =>
                candidate.items.some(
                  (item) => item.type === "collabAgentToolCall" && item.status === "inProgress",
                ),
              ) ?? false,
            hasActiveDescendant:
              descendantOverview === null ||
              descendantOverview.completeness === "incomplete" ||
              descendantOverview.active.knownCount > 0,
          }),
        },
      });
    },
  );

  const applyTerminalInteraction = Effect.fn(
    "CodexProtocolNotificationEffects.applyTerminalInteraction",
  )(function* (
    notification: Extract<
      CodexServerNotification,
      { method: "item/commandExecution/terminalInteraction" }
    >,
    observedAtMs: number,
    projectReplica: boolean,
  ) {
    const { threadId, turnId, itemId, stdin } = notification.params;
    const parsed = terminalInputBuffers.accept(
      { conversationId: threadId, turnId, itemId },
      stdin,
      observedAtMs,
    );
    if (parsed.disposition === "overflow") {
      yield* Effect.logWarning("Discarding overflowing terminal interaction input").pipe(
        Effect.annotateLogs({ threadId, turnId, itemId, reason: parsed.reason }),
      );
      return;
    }
    if (parsed.commands.length === 0) return;
    conversations.current(threadId)?.commitTerminalCommands({
      update: {
        conversationId: threadId,
        turnId,
        itemId,
        commands: parsed.commands,
      },
      observedAtMs,
      projectReplica,
    });
  });

  const settleResolvedRequest = Effect.fn("CodexProtocolNotificationEffects.settleResolvedRequest")(
    function* (threadId: string, requestId: RequestId) {
      renderer.clearRequestDelivery(threadId, requestId);
      yield* autoResolution.observeServerResolution(threadId, requestId);
      events.publish({
        kind: "threadNotification",
        value: {
          type: "request-resolved",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId: threadId,
          requestId,
        },
      });
      const complete = <Kind extends Parameters<typeof pending.takeAll>[0]>(kind: Kind) => {
        const entries = pending.takeAll(kind, requestId, (entry) => entry.threadId === threadId);
        for (const entry of entries) {
          pending.complete(entry as never, CodexAppServerNoResponse as never);
        }
      };
      complete("approval");
      complete("dynamic-tool");
      complete("mcp-elicitation");
      complete("permission");
      complete("private");
      complete("user-input");
    },
  );

  const consumeReducerEffects = Effect.fn("CodexProtocolNotificationEffects.consumeReducerEffects")(
    function* (
      threadId: string,
      ownerRouted: boolean,
      effects: readonly CodexConversationReducerEffect[],
    ) {
      for (const effect of effects) {
        if (effect.type === "markConversationStreaming") {
          conversations.current(threadId)?.setStreaming(true);
          continue;
        }
        if (effect.type === "restoreUnacceptedSteers") {
          yield* queued.acceptTerminalOutcomeInCurrentLane({
            threadId,
            rows: effect.rows,
            interrupted: effect.terminalStatus === "interrupted",
          });
          continue;
        }
        if (effect.type === "hydrateCollabThreads") {
          // Relationship projection owns bounded, keyed metadata repair. Publishing the durable
          // invalidation keeps the notification lane free of app-server reads. This consequence
          // is application-wide even when the renderer owner receives the protocol notification;
          // otherwise owner attachment timing makes the child catalog nondeterministic.
          events.publish({
            kind: "conversationRelationshipsInvalidated",
            value: { parentThreadIds: [threadId] },
          });
          continue;
        }
        if (ownerRouted) continue;
        if (effect.type === "continueGoalIfIdle") {
          yield* activeGoalContinuation.request(threadId);
          continue;
        }
        if (effect.type === "clearCompletedGoal") {
          yield* threadGoals
            .clear(threadId)
            .pipe(Effect.catchCause((cause) => logFailure("thread/goal/clear", threadId, cause)));
        }
      }
    },
  );

  const apply = Effect.fn("CodexProtocolNotificationEffects.apply")(function* (
    input: CodexProtocolNotificationInput,
    deferRootLifecycleNotification: boolean,
  ) {
    // Direct callers must retain the same no-history invariant as the ingress lane.
    const notification = sanitizeCodexLiveLifecycleNotification(
      toCodexThreadStartedMetadataNotification(input.notification),
    );
    if (yield* globalProjection.observe(notification)) return;
    const threadId = codexProtocolNotificationThreadId(notification);
    if (!threadId) return;
    const ownerRouted = isCodexThreadOwnerNotification(notification)
      ? renderer.forwardNotificationForConversation(threadId, notification)
      : false;

    if (isCodexFrameTextDeltaNotification(notification)) {
      deltas.enqueueFrameText(toCodexFrameTextDelta(notification));
      return;
    }
    if (isCodexCommandOutputNotification(notification)) {
      const update = toCodexCommandOutputUpdate(notification);
      deltas.enqueueCommandOutput(update);
      if (!ownerRouted && update.turnId !== null) {
        events.publish({
          kind: "hostMessage",
          value: { type: "mcpNotification", hostId: DEFAULT_CODEX_HOST_ID, notification },
        });
      }
      return;
    }
    if (notification.method === "item/commandExecution/terminalInteraction") {
      const observedAtMs = yield* Clock.currentTimeMillis;
      yield* applyTerminalInteraction(notification, observedAtMs, !ownerRouted);
      return;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      terminalInputBuffers.clearItem({
        conversationId: threadId,
        turnId: notification.params.turnId,
        itemId: notification.params.item.id,
      });
    }
    if (notification.method === "turn/completed") {
      terminalInputBuffers.clearTurn(threadId, notification.params.turn.id);
    }
    if (notification.method === "item/completed" || notification.method === "turn/completed") {
      const observedAtMs = yield* Clock.currentTimeMillis;
      deltas.drainFrameText(threadId, observedAtMs);
    }

    const observedAtMs = yield* Clock.currentTimeMillis;
    const aggregate = conversations.current(threadId);
    if (notification.method === "serverRequest/resolved") {
      if (aggregate) {
        const state = aggregate.readServerRequestState();
        if (state.canonicalState) {
          const lifecycle = reduceCodexConversationServerRequestResolved(
            state.canonicalState,
            notification,
            { now: () => observedAtMs },
          );
          aggregate.commitServerRequestLifecycle({
            kind: "canonical",
            before: state.canonicalState,
            lifecycle,
            observedAtMs,
            projectReplica: !ownerRouted,
          });
        } else {
          aggregate.commitServerRequestLifecycle({
            kind: "raw",
            lifecycle: reduceCodexServerRequestResolvedRawState(state.rawState, notification, {
              now: () => observedAtMs,
            }),
            observedAtMs,
            projectReplica: !ownerRouted,
          });
        }
      }
      yield* settleResolvedRequest(threadId, notification.params.requestId);
      return;
    }

    const before = aggregate?.readCanonicalState() ?? null;
    const committed = aggregate?.commitProtocolNotification({
      notification,
      observedAtMs,
      projectReplica: !ownerRouted,
      createId: () => randomUUID(),
      reducerContext: {
        consumeContextCompactionSource: () => manualCompaction.consumeSource(threadId),
        resolveCollabReceiverThread: (receiverThreadId) =>
          loadedProtocolThread(
            conversations.current(receiverThreadId)?.readCanonicalState() ?? null,
          ),
      },
    });
    const hasTerminalQueueRecoveryEffect =
      committed?.effects.some((effect) => effect.type === "restoreUnacceptedSteers") ?? false;
    if (committed) yield* consumeReducerEffects(threadId, ownerRouted, committed.effects);
    if (notification.method === "item/started" || notification.method === "item/completed") {
      yield* remoteHostedPip.observeCodexOccurrence({ ...input, notification });
    }
    if (notification.method === "item/started") {
      const firstQuestion = expandCodexAsyncQuestions(notification.params.item)[0];
      const alreadyKnown = before?.turns.some((turn) =>
        turn.items.some((item) => item.id === notification.params.item.id),
      );
      if (firstQuestion && !alreadyKnown)
        events.publish({
          kind: "threadNotification",
          value: {
            type: "async-question-requested",
            hostId: input.hostId,
            conversation: conversationFacts(threadId),
            turnId: notification.params.turnId,
            questionId: firstQuestion.id,
          },
        });
    }
    if (notification.method === "item/completed") {
      for (const reply of readCodexAsyncQuestionReplies(notification.params.item) ?? []) {
        events.publish({
          kind: "threadNotification",
          value: {
            type: "async-question-resolved",
            hostId: input.hostId,
            conversationId: threadId,
            turnId: notification.params.turnId,
            questionId: reply.questionItemId,
          },
        });
      }
    }
    if (notification.method === "turn/completed") {
      const turn = before?.turns.find(
        (candidate) => candidate.protocol.id === notification.params.turn.id,
      );
      for (const question of turn?.items.flatMap(expandCodexAsyncQuestions) ?? []) {
        events.publish({
          kind: "threadNotification",
          value: {
            type: "async-question-resolved",
            hostId: input.hostId,
            conversationId: threadId,
            turnId: notification.params.turn.id,
            questionId: question.id,
          },
        });
      }
    }
    if (committed?.stateChanged && !ownerRouted) {
      const after = aggregate?.readCanonicalState();
      for (const [turnIndex, turn] of after?.turns.entries() ?? []) {
        if (turn === before?.turns[turnIndex]) continue;
        events.publish({
          kind: "codex",
          value: {
            type: "turn",
            turn: buildCodexCanonicalTurnSummary(
              threadId,
              turn,
              turn.items.map((item) => item.id),
            ),
          },
        });
      }
    }
    if (notification.method === "thread/status/changed") {
      const status = parseThreadStatus(notification.params.status);
      events.publish({
        kind: "codex",
        value: {
          type: "threadStatus",
          threadId,
          statusType: status.statusType,
          statusActiveFlags: status.statusActiveFlags,
        },
      });
    }
    if (notification.method === "thread/closed") {
      yield* remoteHostedPip.observeCodexOccurrence({ ...input, notification });
    }
    const durableNotification = isCodexThreadDurableProjectionNotification(notification);
    if (!durableNotification) {
      yield* subagents.observeNotification({
        hostId: input.hostId,
        generation: input.generation,
        notification,
        occurrenceToken: input.occurrenceToken,
        observedAtMs,
      });
    }
    if (notification.method === "turn/started") {
      yield* browserUse.turnStarted({ sessionId: threadId, turnId: notification.params.turn.id });
      yield* conversationProjection.reconcileThreadStatus(threadId);
    }
    if (notification.method === "turn/completed") {
      yield* browserUse.turnEnded({ sessionId: threadId, turnId: notification.params.turn.id });
      yield* remoteHostedPip.observeCodexOccurrence({ ...input, notification });
      yield* automation.complete(threadId, notification.params.turn);
      yield* publishTurnCompleted(threadId, notification.params.turn);
      if (notification.params.turn.status === "interrupted") {
        if (!hasTerminalQueueRecoveryEffect) {
          yield* queued.acceptTerminalOutcomeInCurrentLane({
            threadId,
            rows: [],
            interrupted: true,
          });
        }
      } else if (notification.params.turn.status !== "inProgress") {
        yield* queued.requestDispatch(threadId);
      }
      yield* conversationProjection.reconcileThreadStatus(threadId);
    }
    if (durableNotification) {
      const durable = durableThreads.observe({
        hostId: input.hostId,
        generation: input.generation,
        notification,
        occurrenceId: input.occurrenceId,
        occurrenceToken: input.occurrenceToken,
      });
      if (notification.method !== "thread/archived" && notification.method !== "thread/deleted") {
        yield* durable;
        yield* subagents.observeNotification({
          hostId: input.hostId,
          generation: input.generation,
          notification,
          occurrenceToken: input.occurrenceToken,
          observedAtMs,
        });
        return;
      }
      if (deferRootLifecycleNotification) {
        yield* subagents.observeNotification({
          hostId: input.hostId,
          generation: input.generation,
          notification,
          occurrenceToken: input.occurrenceToken,
          observedAtMs,
        });
        return;
      }
      const reason = new Error(
        `Codex Thread '${threadId}' was ${notification.method.slice("thread/".length)}`,
      );
      terminalInputBuffers.clearConversation(threadId);
      yield* durable.pipe(Effect.ensuring(lifecycle.close(threadId, reason)));
      yield* remoteHostedPip.observeCodexOccurrence({ ...input, notification });
      yield* subagents.observeNotification({
        hostId: input.hostId,
        generation: input.generation,
        notification,
        occurrenceToken: input.occurrenceToken,
        observedAtMs,
      });
    }
  });

  return CodexProtocolNotificationEffects.of({
    apply: (input) =>
      Effect.gen(function* () {
        const method = input.notification.method;
        const threadId = codexProtocolNotificationThreadId(input.notification);
        const deferRootLifecycleNotification =
          threadId !== null && (method === "thread/archived" || method === "thread/deleted")
            ? yield* subagents.shouldDeferLifecycleNotification(threadId, method).pipe(
                Effect.mapError(
                  (cause) =>
                    new CodexNotificationConsequenceError({
                      method,
                      threadId,
                      cause: Cause.fail(cause),
                    }),
                ),
              )
            : false;
        const disposition: CodexConversationDisposition =
          !deferRootLifecycleNotification &&
          (input.notification.method === "thread/archived" ||
            input.notification.method === "thread/deleted")
            ? "retire"
            : "retain";
        return yield* apply(input, deferRootLifecycleNotification).pipe(
          Effect.catchCause((cause) =>
            isInterruptedOnly(cause)
              ? Effect.interrupt
              : Effect.fail(
                  new CodexNotificationConsequenceError({
                    method: input.notification.method,
                    threadId: codexProtocolNotificationThreadId(input.notification) ?? "unknown",
                    cause,
                  }),
                ),
          ),
          Effect.as(disposition),
        );
      }),
  });
});

export const live = Layer.effect(CodexProtocolNotificationEffects, make);

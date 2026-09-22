import { residentConversationTurns } from "../../shared/codex-conversation-state/codex-turn-mutation";
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
import type { CodexConversationReducerEffect } from "../../shared/codex-conversation-state/codex-conversation-reducer";
import { extractCodexThreadSpawnMetadata } from "../../shared/codex-subagent-metadata";
import type { CodexNotificationConversationFacts } from "../../shared/codex-thread-notification";
import {
  type CodexHeartbeatDecision,
  hasCodexPendingContinuation,
  parseCodexHeartbeatAssistantMessage,
} from "../../shared/codex-turn-notification";
import { resolveCodexForkSourceConversationTitle } from "../../shared/codex-thread-title";
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
import { CodexTerminalInteractionAccumulator } from "../../shared/codex-terminal-interaction";
import { toCodexThreadStartedMetadataNotification } from "../../shared/codex-thread-start-metadata";
import {
  getCodexThreadOwnerNotificationThreadId,
  isCodexThreadOwnerNotification,
} from "../../shared/types";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexAutomationTurnCompletion } from "./CodexAutomationTurnCompletion";
import { CodexConversationLifecycle } from "./CodexConversationLifecycle";
import { CodexConversationDeltaBufferRuntime } from "./CodexConversationDeltaBufferRuntime";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexManualCompactionRuntime } from "./CodexManualCompactionRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationProjection } from "./CodexProtocolNotificationProjection";
import { CodexQueuedFollowUps } from "./CodexQueuedFollowUps";
import { CodexMainConversationManagers } from "./CodexMainConversationManagers";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";
import { parseThreadStatus } from "./CodexThreadCatalogProjection";
import {
  CodexThreadDurableProjection,
  isCodexThreadDurableProjectionNotification,
} from "./CodexThreadDurableProjection";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexThreadGoalRuntime } from "./CodexThreadGoalRuntime";
import { CodexThreadTitleReconsideration } from "./CodexThreadTitleReconsideration";
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
  | CodexApplicationEventHub
  | CodexAutomationTurnCompletion
  | CodexConversationDeltaBufferRuntime
  | CodexConversationLifecycle
  | CodexConversationProjection
  | CodexManualCompactionRuntime
  | CodexPendingServerRequestRuntime
  | CodexProtocolNotificationProjection
  | CodexQueuedFollowUps
  | CodexMainConversationManagers
  | CodexThreadDurableProjection
  | CodexSubagentDirectory
  | CodexThreadGoalRuntime
  | CodexThreadTitleReconsideration
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | BrowserUseRuntime
  | RemoteHostedPipRuntime
> = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const automation = yield* CodexAutomationTurnCompletion;
  const deltas = yield* CodexConversationDeltaBufferRuntime;
  const lifecycle = yield* CodexConversationLifecycle;
  const conversationProjection = yield* CodexConversationProjection;
  const manualCompaction = yield* CodexManualCompactionRuntime;
  const pending = yield* CodexPendingServerRequestRuntime;
  const globalProjection = yield* CodexProtocolNotificationProjection;
  const queued = yield* CodexQueuedFollowUps;
  const managers = yield* CodexMainConversationManagers;
  const durableThreads = yield* CodexThreadDurableProjection;
  const subagents = yield* CodexSubagentDirectory;
  const threadGoals = yield* CodexThreadGoalRuntime;
  const titleReconsideration = yield* CodexThreadTitleReconsideration;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const conversations = yield* ConversationEntityMap;
  const browserUse = yield* BrowserUseRuntime;
  const remoteHostedPip = yield* RemoteHostedPipRuntime;
  const terminalInputBuffers = new CodexTerminalInteractionAccumulator();

  const logFailure = (method: string, threadId: string, cause: unknown): Effect.Effect<void> =>
    Effect.logWarning("Codex notification consequence failed").pipe(
      Effect.annotateLogs({ method, threadId, cause }),
    );

  const conversationFacts = (threadId: string): CodexNotificationConversationFacts => {
    const aggregate = conversations.current(threadId);
    const snapshot = aggregate?.readSnapshot();
    const canonical = aggregate?.readCanonicalState();
    const firstTurn = residentConversationTurns(canonical).at(0);
    const parentThreadId = extractCodexThreadSpawnMetadata(snapshot?.source).parentThreadId ?? null;
    return {
      conversationId: threadId,
      title: resolveCodexForkSourceConversationTitle({
        explicitTitle: canonical?.title ?? snapshot?.threadName,
        firstTurnInput: firstTurn?.params.input,
        firstTurnCommentAttachments: firstTurn?.params.commentAttachments,
      }),
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
    const canonicalTurn = residentConversationTurns(canonical).find(
      (candidate) => candidate.turnId === turn.id,
    );
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
      hostId: string,
      threadId: string,
      turn: Extract<CodexServerNotification, { method: "turn/completed" }>["params"]["turn"],
      automationNotificationDecision: CodexHeartbeatDecision | null,
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
      const queuedHead = queued.readHead(threadId);
      const hasPendingContinuation = hasCodexPendingContinuation({
        terminalStatus: turn.status,
        queuedResourceLoading: false,
        queuedHeadPausedReason: queuedHead ? (queuedHead.pausedReason ?? null) : undefined,
        threadGoalStatus: snapshot?.threadGoal?.status ?? null,
        latestMergedTurnStatus: residentConversationTurns(canonical).at(-1)?.status ?? null,
        hasRunningCollabAgent:
          residentConversationTurns(canonical).some((candidate) =>
            candidate.items.some(
              (item) => item.type === "collabAgentToolCall" && item.status === "inProgress",
            ),
          ) ?? false,
        hasActiveDescendant:
          descendantOverview === null ||
          descendantOverview.completeness === "incomplete" ||
          descendantOverview.active.knownCount > 0,
      });
      events.publish({
        kind: "threadNotification",
        value: {
          type: "turn-completed",
          hostId,
          conversation: conversationFacts(threadId),
          turnId: turn.id,
          status: turn.status,
          lastAgentMessage: message,
          heartbeatAssistantMessage: parseCodexHeartbeatAssistantMessage(message),
          automationNotificationDecision,
          hasPendingContinuation,
        },
      });
      if (turn.status === "completed") {
        yield* titleReconsideration.observe({
          hostId,
          threadId,
          lastAgentMessage: message,
          hasPendingContinuation,
        });
      }
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
  ) {
    const { threadId, turnId, itemId, stdin } = notification.params;
    const parsed = terminalInputBuffers.accept({ conversationId: threadId, itemId }, stdin);
    if (parsed.commands.length === 0) return;
    yield* Effect.sync(() =>
      conversations.current(threadId)?.commitTerminalCommands({
        update: {
          conversationId: threadId,
          turnId,
          itemId,
          commands: parsed.commands,
        },
        observedAtMs,
      }),
    );
  });

  const settleResolvedRequest = Effect.fn("CodexProtocolNotificationEffects.settleResolvedRequest")(
    function* (threadId: string, requestId: RequestId, hostId: string, generation: number) {
      yield* autoResolution.observeServerResolution(threadId, requestId, { hostId, generation });
      events.publish({
        kind: "threadNotification",
        value: {
          type: "request-resolved",
          hostId,
          conversationId: threadId,
          requestId,
        },
      });
      const complete = <Kind extends Parameters<typeof pending.takeAll>[0]>(kind: Kind) => {
        const entries = pending.takeAll(
          kind,
          requestId,
          (entry) =>
            entry.threadId === threadId &&
            entry.hostId === hostId &&
            entry.generation === generation,
        );
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
  ) {
    // Direct callers must retain the same no-history invariant as the ingress lane.
    const notification = toCodexThreadStartedMetadataNotification(input.notification);
    if (yield* globalProjection.observe(notification)) return;
    const threadId = codexProtocolNotificationThreadId(notification);
    if (!threadId) return;
    const manager = managers.current(input.hostId);
    const ownerRouted = manager?.stream.getRole(threadId)?.role === "follower";
    const projectLocal =
      manager !== null && manager.generation === input.generation && !ownerRouted;

    if (isCodexFrameTextDeltaNotification(notification)) {
      if (projectLocal) deltas.enqueueFrameText(toCodexFrameTextDelta(notification));
      return;
    }
    if (isCodexCommandOutputNotification(notification)) {
      const update = toCodexCommandOutputUpdate(notification);
      if (projectLocal) deltas.enqueueCommandOutput(update);
      return;
    }
    if (notification.method === "item/commandExecution/terminalInteraction") {
      const observedAtMs = yield* Clock.currentTimeMillis;
      if (projectLocal) yield* applyTerminalInteraction(notification, observedAtMs);
      return;
    }
    if (
      notification.method === "item/completed" &&
      notification.params.item.type === "commandExecution"
    ) {
      terminalInputBuffers.clearItem({
        conversationId: threadId,
        itemId: notification.params.item.id,
      });
    }
    if (notification.method === "turn/completed") {
      const turn = conversations
        .current(threadId)
        ?.readCanonicalState()
        ?.turns.findLast((candidate) => candidate.turnId === notification.params.turn.id);
      terminalInputBuffers.clearItems(
        threadId,
        turn?.items.filter((item) => item.type === "commandExecution").map((item) => item.id) ?? [],
      );
    }
    if (notification.method === "item/completed" || notification.method === "turn/completed") {
      const observedAtMs = yield* Clock.currentTimeMillis;
      if (projectLocal) deltas.drainBeforeCompletion(threadId, observedAtMs);
    }

    const observedAtMs = yield* Clock.currentTimeMillis;
    const aggregate = projectLocal ? conversations.current(threadId) : null;
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
          });
        } else {
          aggregate.commitServerRequestLifecycle({
            kind: "raw",
            lifecycle: reduceCodexServerRequestResolvedRawState(state.rawState, notification, {
              now: () => observedAtMs,
            }),
            observedAtMs,
          });
        }
      }
      yield* settleResolvedRequest(
        threadId,
        notification.params.requestId,
        input.hostId,
        input.generation,
      );
      return;
    }

    const before = aggregate?.readCanonicalState() ?? null;
    const committed = aggregate?.commitProtocolNotification({
      notification,
      observedAtMs,
      createId: () => randomUUID(),
      reducerContext: {
        consumeContextCompactionSource: () => manualCompaction.consumeSource(threadId),
        resolveCollabReceiverThread: (receiverThreadId) =>
          conversations.readThreadMetadata(receiverThreadId),
      },
    });
    if (committed) yield* consumeReducerEffects(threadId, ownerRouted, committed.effects);
    if (notification.method === "item/started" || notification.method === "item/completed") {
      yield* remoteHostedPip.observeCodexOccurrence({ ...input, notification });
    }
    if (notification.method === "item/started") {
      const firstQuestion = expandCodexAsyncQuestions(notification.params.item)[0];
      const alreadyKnown = residentConversationTurns(before).some((turn) =>
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
      const turn = residentConversationTurns(before).find(
        (candidate) => candidate.turnId === notification.params.turn.id,
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
      for (const [turnIndex, turn] of residentConversationTurns(after).entries() ?? []) {
        if (turn === residentConversationTurns(before)[turnIndex]) continue;
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
      const decision = yield* automation.complete(threadId, notification.params.turn);
      yield* publishTurnCompleted(input.hostId, threadId, notification.params.turn, decision);
      if (notification.params.turn.status === "interrupted")
        yield* queued.acceptTerminalOutcomeInCurrentLane({ threadId, interrupted: true });
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
        if (input.notification.method === "thread/started") {
          conversations.registerThreadMetadata(input.notification.params.thread);
        }
        const disposition: CodexConversationDisposition =
          input.notification.method === "thread/archived" ||
          input.notification.method === "thread/deleted"
            ? "retire"
            : "retain";
        return yield* apply(input).pipe(
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

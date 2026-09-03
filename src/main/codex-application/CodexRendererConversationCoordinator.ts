import type { RequestId } from "@nodex/codex-app-server-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Scope from "effect/Scope";
import type {
  CodexHostMessage,
  CodexConversationSnapshot,
  CodexConversationResumeState,
  CodexThreadFollowerActionInput,
  CodexThreadFollowerSnapshotAppliedInput,
  CodexThreadOwnerNotificationAckInput,
  CodexThreadOwnerServerRequest,
  CodexThreadOwnerStreamStatePublishInput,
  CodexThreadOwnerStreamStatePublishResult,
  CodexThreadStreamCheckpoint,
  CodexThreadStreamResyncRequestInput,
} from "../../shared/types";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import {
  applyCodexThreadOwnerPublication,
  areCodexThreadStreamCheckpointsEqual,
} from "../../shared/codex-owner-follower-replication";
import {
  getCodexThreadOwnerNotificationThreadId,
  isCodexThreadOwnerNotification,
} from "../../shared/types";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import {
  runThreadFollowerActionThroughOwner,
  type CodexOwnerFollowerRendererClientRuntime,
} from "../codex/owner-follower-ipc-bridge";
import { CODEX_THREAD_STREAM_FOLLOWER_RECONNECT_GRACE_MS } from "../codex/codex-thread-stream-subscription-state";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import {
  CodexOwnerNotificationDrainRuntime,
  type CodexOwnerNotificationDrainError,
} from "./CodexOwnerNotificationDrainRuntime";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexRendererConversationRegistry } from "./CodexRendererConversationRegistry";
import { CodexRendererOwnerRetention } from "./CodexRendererOwnerRetention";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export interface CodexRendererConversationCoordinatorService {
  readonly readRendererState: (conversationId: string) => {
    readonly acceptedConversation: CodexConversationSnapshot | null;
    readonly checkpoint: CodexThreadStreamCheckpoint | null;
    readonly ownerClientId: string | null;
    readonly resumeState: CodexConversationResumeState | null;
    readonly revision: number;
    readonly threadGeneration: number | null;
  };
  readonly adoptRendererOwner: (input: {
    readonly conversationId: string;
    readonly ownerClientId: string;
  }) => Effect.Effect<{
    readonly checkpoint: CodexThreadStreamCheckpoint | null;
    readonly ownerClientId: string | null;
    readonly revision: number;
    readonly threadGeneration: number | null;
  }>;
  readonly setOwner: (conversationId: string, clientId: string) => Effect.Effect<boolean>;
  readonly setFollowing: (
    conversationId: string,
    clientId: string,
    following: boolean,
    options?: { readonly forceSnapshot?: boolean },
  ) => Effect.Effect<boolean>;
  readonly setViewActive: (
    conversationId: string,
    clientId: string,
    active: boolean,
  ) => Effect.Effect<boolean>;
  readonly setPresented: (
    conversationId: string,
    clientId: string,
    surfaceId: string,
    presented: boolean,
  ) => Effect.Effect<boolean>;
  readonly setClientForegrounded: (
    clientId: string | null | undefined,
    foregrounded: boolean,
  ) => Effect.Effect<void>;
  readonly handleClientConnected: (clientId: string) => Effect.Effect<void>;
  readonly handleClientDisposed: (clientId: string) => Effect.Effect<void>;
  readonly handleClientDeliveryFailure: (clientIds: readonly string[]) => Effect.Effect<void>;
  readonly acknowledgeFollowerSnapshotApplied: (
    sourceClientId: string,
    input: CodexThreadFollowerSnapshotAppliedInput,
  ) => Effect.Effect<boolean>;
  readonly requestStreamResync: (
    sourceClientId: string,
    input: CodexThreadStreamResyncRequestInput,
  ) => Effect.Effect<boolean>;
  readonly publishOwnerStateChange: (
    sourceClientId: string,
    input: CodexThreadOwnerStreamStatePublishInput,
  ) => CodexThreadOwnerStreamStatePublishResult;
  readonly acknowledgeOwnerNotification: (
    sourceClientId: string,
    input: CodexThreadOwnerNotificationAckInput,
  ) => Effect.Effect<boolean>;
  readonly replayPendingOwnerRequests: (
    conversationId: string,
    rendererClientId: string | null,
  ) => number;
  readonly runFollowerAction: (
    rendererClients: CodexOwnerFollowerRendererClientRuntime,
    sourceClientId: string,
    input: CodexThreadFollowerActionInput,
  ) => ReturnType<typeof runThreadFollowerActionThroughOwner>;
  readonly forwardNotification: (notification: CodexServerNotification) => boolean;
  readonly forwardNotificationForConversation: (
    conversationId: string,
    notification: CodexServerNotification,
  ) => boolean;
  readonly forwardServerRequest: (request: CodexThreadOwnerServerRequest) => boolean;
  readonly clearRequestDelivery: (conversationId: string, requestId: RequestId) => void;
  readonly reconcileOwnership: (conversationId: string) => void;
  /** Invalidates renderer stream roles after the physical app-server generation is lost. */
  readonly resetTransport: (conversationIds: readonly string[]) => void;
  readonly awaitOwnerNotificationDrain: (
    conversationId: string,
  ) => Effect.Effect<void, CodexOwnerNotificationDrainError>;
  readonly clearConversation: (conversationId: string) => Effect.Effect<void>;
}

export class CodexRendererConversationCoordinator extends Context.Service<
  CodexRendererConversationCoordinator,
  CodexRendererConversationCoordinatorService
>()("nodex/main/codex-application/CodexRendererConversationCoordinator") {}

const asOwnerRequest = (request: unknown): CodexThreadOwnerServerRequest | null => {
  if (!request || typeof request !== "object" || !("method" in request)) return null;
  switch (request.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "item/permissions/requestApproval":
    case "item/tool/requestUserInput":
    case "item/tool/call":
    case "mcpServer/elicitation/request":
    case "item/tool/requestOptionPicker":
    case "item/tool/requestSetupCodexContextPicker":
      return request as CodexThreadOwnerServerRequest;
    default:
      return null;
  }
};

export const make: Effect.Effect<
  CodexRendererConversationCoordinatorService,
  never,
  | CodexApplicationEventHub
  | CodexOwnerNotificationDrainRuntime
  | CodexPendingServerRequestRuntime
  | CodexRendererConversationRegistry
  | CodexRendererOwnerRetention
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const conversations = yield* ConversationEntityMap;
  const events = yield* CodexApplicationEventHub;
  const ownerNotificationDrain = yield* CodexOwnerNotificationDrainRuntime;
  const pendingRequests = yield* CodexPendingServerRequestRuntime;
  const registry = yield* CodexRendererConversationRegistry;
  const retention = yield* CodexRendererOwnerRetention;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const reconciliations = yield* FiberMap.make<string, void>();
  const runReconciliation = yield* FiberMap.runtime(reconciliations)();

  const aggregate = (conversationId: string) => conversations.current(conversationId);
  const acceptedReplica = (conversationId: string) =>
    aggregate(conversationId)?.read().acceptedReplica ?? null;
  const emitOwnerMessage = (
    conversationId: string,
    makeMessage: (sequence: number) => CodexHostMessage,
  ): boolean => {
    const targetClientId = registry.getOwnerClientId(conversationId);
    if (!targetClientId) return false;
    const message = makeMessage(ownerNotificationDrain.next(conversationId));
    events.publish({ kind: "rendererOwnerHostMessage", value: { targetClientId, message } });
    return true;
  };
  const emitSnapshot = (conversationId: string, targetClientId: string): boolean => {
    const ownerClientId = registry.getOwnerClientId(conversationId);
    const replica = acceptedReplica(conversationId);
    if (!ownerClientId || !replica) return false;
    if (!registry.markSnapshotSent(conversationId, targetClientId, replica.checkpoint))
      return false;
    events.publish({
      kind: "rendererThreadStreamRelay",
      value: {
        targetClientIds: [targetClientId],
        sourceClientId: ownerClientId,
        message: {
          type: "threadStreamStateChanged",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId,
          change: {
            type: "snapshot",
            revision: replica.checkpoint.revision,
            conversationState: replica.conversation,
          },
          version: aggregate(conversationId)?.read().version ?? 0,
          sourceClientId: ownerClientId,
          checkpoint: replica.checkpoint,
          baseCheckpoint: null,
        },
      },
    });
    return true;
  };
  const emitActions = (
    actions: readonly import("../codex/codex-thread-stream-subscription-state").CodexThreadStreamSubscriptionAction[],
  ): void => {
    for (const action of actions) {
      if (action.type === "request-following-status") {
        events.publish({
          kind: "hostMessage",
          value: {
            type: "threadStreamFollowingStatusRequested",
            hostId: DEFAULT_CODEX_HOST_ID,
            conversationId: action.conversationId,
            ownerClientId: action.ownerClientId,
          },
        });
        continue;
      }
      if (action.type === "followers-changed") {
        events.publish({
          kind: "rendererThreadStreamControlRelay",
          value: {
            targetClientIds: action.targetClientIds,
            message: {
              type: "threadStreamFollowersChanged",
              hostId: DEFAULT_CODEX_HOST_ID,
              conversationId: action.conversationId,
              ownerClientId: action.ownerClientId,
              followerClientIds: [...action.followerClientIds],
              membershipEpoch: action.membershipEpoch,
            },
          },
        });
        continue;
      }
      events.publish({
        kind: "rendererThreadStreamControlRelay",
        value: {
          targetClientIds: action.targetClientIds,
          message: {
            type: "threadStreamTransportReset",
            hostId: DEFAULT_CODEX_HOST_ID,
            conversationIds: [...action.conversationIds],
          },
        },
      });
    }
  };
  const flushSnapshots = (conversationId: string): void => {
    for (const clientId of registry.getSnapshotClientIds(conversationId)) {
      emitSnapshot(conversationId, clientId);
    }
  };
  const setOwnerState = (conversationId: string, clientId: string): boolean => {
    const result = registry.setOwner(conversationId, clientId);
    if (!result) return false;
    const current = acceptedReplica(conversationId);
    if (current) {
      aggregate(conversationId)?.acceptReplica({
        conversation: current.conversation,
        revision: current.checkpoint.revision,
        ownerEpoch: result.ownerEpoch,
      });
    }
    emitActions(result.actions);
    for (const targetClientId of result.snapshotClientIds)
      emitSnapshot(conversationId, targetClientId);
    if (result.previousOwnerClientId !== clientId)
      ownerNotificationDrain.resetOwner(conversationId);
    return true;
  };
  const setOwner = (conversationId: string, clientId: string) =>
    Effect.sync(() => setOwnerState(conversationId, clientId)).pipe(
      Effect.tap(() => retention.reconcile(conversationId)),
    );
  const reconcilePresentation = (conversationId: string) =>
    autoResolution
      .reevaluatePresentation(conversationId)
      .pipe(Effect.andThen(retention.reconcile(conversationId)));
  const forwardServerRequest = (request: CodexThreadOwnerServerRequest): boolean => {
    const conversationId = request.params.threadId;
    const targetClientId = registry.getOwnerClientId(conversationId);
    if (!targetClientId) return false;
    if (registry.hasRequestDelivery(conversationId, request, targetClientId)) return true;
    const delivered = emitOwnerMessage(conversationId, (sequence) => ({
      type: "threadOwnerRequest",
      hostId: DEFAULT_CODEX_HOST_ID,
      request,
      sequence,
    }));
    if (delivered) registry.recordRequestDelivery(conversationId, request, targetClientId);
    return delivered;
  };
  const forwardNotificationForConversation = (
    conversationId: string,
    notification: CodexServerNotification,
  ): boolean => {
    if (!isCodexThreadOwnerNotification(notification)) return false;
    return emitOwnerMessage(conversationId, (sequence) => ({
      type: "threadOwnerNotification",
      hostId: DEFAULT_CODEX_HOST_ID,
      sequence,
      notification,
    }));
  };

  const service: CodexRendererConversationCoordinatorService = {
    readRendererState: (conversationId) => {
      const state = aggregate(conversationId)?.read();
      return {
        acceptedConversation: state?.acceptedReplica?.conversation ?? null,
        checkpoint: state?.acceptedReplica?.checkpoint ?? null,
        ownerClientId: registry.getOwnerClientId(conversationId),
        resumeState: state?.resumeState ?? null,
        revision: state?.revision ?? 0,
        threadGeneration: aggregate(conversationId)?.generation ?? null,
      };
    },
    adoptRendererOwner: (input) =>
      Effect.sync(() => {
        if (registry.isClientDisposed(input.ownerClientId)) {
          return {
            checkpoint: null,
            ownerClientId: null,
            revision: aggregate(input.conversationId)?.read().revision ?? 0,
            threadGeneration: aggregate(input.conversationId)?.generation ?? null,
          };
        }
        const currentOwner = registry.getOwnerClientId(input.conversationId);
        if (currentOwner && currentOwner !== input.ownerClientId) {
          const current = aggregate(input.conversationId)?.read();
          return {
            checkpoint: current?.acceptedReplica?.checkpoint ?? null,
            ownerClientId: currentOwner,
            revision: current?.revision ?? 0,
            threadGeneration: aggregate(input.conversationId)?.generation ?? null,
          };
        }
        const conversation = aggregate(input.conversationId);
        const before = conversation?.read() ?? null;
        const initialReplica =
          before?.acceptedReplica?.conversation ?? conversation?.readSnapshot();
        if (!conversation || !before || !initialReplica) {
          return {
            checkpoint: null,
            ownerClientId: null,
            revision: conversation?.read().revision ?? 0,
            threadGeneration: conversation?.generation ?? null,
          };
        }
        if (!setOwnerState(input.conversationId, input.ownerClientId)) {
          return {
            checkpoint: null,
            ownerClientId: null,
            revision: conversation.read().revision,
            threadGeneration: conversation.generation,
          };
        }
        conversation.setStreamRole("owner");
        if (!before.acceptedReplica) {
          conversation.acceptReplica({
            conversation: initialReplica,
            revision: before.revision,
            ownerEpoch: registry.getOwnerEpoch(input.conversationId) ?? 0,
          });
          flushSnapshots(input.conversationId);
        }
        const after = conversation.read();
        return {
          checkpoint: after.acceptedReplica?.checkpoint ?? null,
          ownerClientId: registry.getOwnerClientId(input.conversationId),
          revision: after.revision,
          threadGeneration: conversation.generation,
        };
      }).pipe(Effect.tap(() => retention.reconcile(input.conversationId))),
    setOwner,
    setFollowing: (conversationId, clientId, following, options) =>
      Effect.sync(() => registry.setFollowing(conversationId, clientId, following, options)).pipe(
        Effect.tap((result) => {
          if (!result) return Effect.void;
          emitActions(result.actions);
          if (result.shouldSendSnapshot) emitSnapshot(conversationId, clientId);
          return retention.reconcile(conversationId);
        }),
        Effect.map((result) => result !== null),
      ),
    setViewActive: (conversationId, clientId, active) =>
      Effect.sync(() => registry.setViewActive(conversationId, clientId, active)).pipe(
        Effect.tap((result) => {
          if (!result.accepted) return Effect.void;
          if (result.following) {
            emitActions(result.following.actions);
            if (result.following.shouldSendSnapshot) emitSnapshot(conversationId, clientId);
          }
          return reconcilePresentation(conversationId);
        }),
        Effect.map((result) => result.accepted),
      ),
    setPresented: (conversationId, clientId, surfaceId, presented) =>
      Effect.sync(() => registry.setPresented(conversationId, clientId, surfaceId, presented)).pipe(
        Effect.tap((result) => {
          if (!result.accepted) return Effect.void;
          if (result.presentedInForeground) {
            events.publish({
              kind: "rendererConversationPresentedInForeground",
              value: conversationId,
            });
          }
          return autoResolution.reevaluatePresentation(conversationId);
        }),
        Effect.map((result) => result.accepted),
      ),
    setClientForegrounded: (clientId, foregrounded) => {
      if (!clientId) return Effect.void;
      return Effect.sync(() => registry.setClientForegrounded(clientId, foregrounded)).pipe(
        Effect.flatMap((conversationIds) =>
          Effect.forEach(
            conversationIds,
            (conversationId) => {
              if (foregrounded) {
                events.publish({
                  kind: "rendererConversationPresentedInForeground",
                  value: conversationId,
                });
              }
              return autoResolution.reevaluatePresentation(conversationId);
            },
            { discard: true },
          ),
        ),
      );
    },
    handleClientConnected: (clientId) =>
      Effect.sync(() => emitActions(registry.handleClientConnected(clientId))),
    handleClientDeliveryFailure: (clientIds) =>
      Effect.sync(() => {
        const actions = registry.handleClientDeliveryFailure(clientIds);
        for (const action of actions) {
          if (action.type !== "transport-reset") continue;
          // A reconnect may reuse the client identity; retain its sequence fence.
          for (const conversationId of action.conversationIds)
            ownerNotificationDrain.resetOwner(conversationId);
        }
        emitActions(actions);
      }),
    handleClientDisposed: (clientId) =>
      Effect.gen(function* () {
        const result = registry.handleClientDisposed(clientId);
        emitActions(result.actions);
        yield* Effect.forEach(result.viewConversationIds, autoResolution.reevaluatePresentation, {
          discard: true,
        });
        for (const conversationId of result.viewConversationIds) {
          aggregate(conversationId)?.clearHistoryResidencyPins(clientId);
        }
        for (const conversationId of result.ownerConversationIds) {
          ownerNotificationDrain.release(conversationId);
          pendingRequests.rejectDispatchedDynamicForThread(
            conversationId,
            new Error("Dynamic tool call owner disconnected"),
          );
          const current = acceptedReplica(conversationId);
          const conversation = aggregate(conversationId);
          conversation?.setStreamRole(null);
          if (current) {
            conversation?.advanceReplica({
              conversation: { ...current.conversation, resumeState: "needs_resume" },
              ownerEpoch: current.checkpoint.ownerEpoch,
            });
          }
          yield* retention.clear(conversationId);
          yield* retention.reconcile(conversationId);
          yield* retention.recheckAfter(
            conversationId,
            CODEX_THREAD_STREAM_FOLLOWER_RECONNECT_GRACE_MS + 1,
          );
        }
        for (const conversationId of result.viewConversationIds) {
          if (!result.ownerConversationIds.includes(conversationId)) {
            yield* retention.reconcile(conversationId);
          }
        }
        if (result.ownerConversationIds.length === 0) return;
        events.publish({
          kind: "hostMessage",
          value: {
            type: "threadOwnerUnavailable",
            hostId: DEFAULT_CODEX_HOST_ID,
            ownerClientId: clientId,
            conversationIds: [...result.ownerConversationIds],
          },
        });
      }),
    acknowledgeFollowerSnapshotApplied: (sourceClientId, input) =>
      Effect.sync(() => {
        const replica = acceptedReplica(input.conversationId);
        if (!replica) return false;
        const result = registry.acknowledgeSnapshotApplied({
          conversationId: input.conversationId,
          clientId: sourceClientId,
          ownerClientId: input.ownerClientId,
          checkpoint: input.checkpoint,
          currentCheckpoint: replica.checkpoint,
        });
        if (!result) return false;
        emitActions(result.actions);
        if (result.shouldSendSnapshot) emitSnapshot(input.conversationId, sourceClientId);
        return result.accepted;
      }).pipe(Effect.tap(() => retention.reconcile(input.conversationId))),
    requestStreamResync: (sourceClientId, input) =>
      Effect.sync(() => {
        const accepted = registry.requireSnapshot({
          conversationId: input.conversationId,
          clientId: sourceClientId,
          ownerClientId: input.ownerClientId,
          observedOwnerEpoch: input.observedCheckpoint?.ownerEpoch,
        });
        return accepted && emitSnapshot(input.conversationId, sourceClientId);
      }),
    publishOwnerStateChange: (sourceClientId, input) => {
      const reject = (
        reason: Exclude<CodexThreadOwnerStreamStatePublishResult, { accepted: true }>["reason"],
      ): CodexThreadOwnerStreamStatePublishResult => {
        const current = acceptedReplica(input.conversationId);
        return {
          accepted: false,
          reason,
          recovery: current
            ? { checkpoint: current.checkpoint, conversationState: current.conversation }
            : null,
        };
      };
      if (registry.isClientDisposed(sourceClientId)) return reject("not-owner");
      const current = acceptedReplica(input.conversationId);
      if (current?.conversation.archived) return reject("archived");
      const ownerClientId = registry.getOwnerClientId(input.conversationId);
      if (!ownerClientId || ownerClientId !== sourceClientId) return reject("not-owner");
      const ownerEpoch = registry.getOwnerEpoch(input.conversationId);
      if (ownerEpoch === null) return reject("owner-epoch-mismatch");
      if (
        input.ownerNotificationSequence !== undefined &&
        !ownerNotificationDrain.canAck(input.conversationId, input.ownerNotificationSequence)
      ) {
        return reject("owner-notification-sequence-mismatch");
      }
      const result = applyCodexThreadOwnerPublication({
        current,
        expectedOwnerEpoch: ownerEpoch,
        publication: input,
      });
      if (!result.accepted) return result;
      const canonicalUnread = aggregate(input.conversationId)?.readCanonicalState()?.sidecar
        .hasUnreadTurn;
      const authoritativeUnread = canonicalUnread ?? current?.conversation.hasUnreadTurn ?? null;
      const nextConversation =
        authoritativeUnread !== null &&
        result.replica.conversation.hasUnreadTurn !== authoritativeUnread
          ? {
              ...result.replica.conversation,
              hasUnreadTurn: authoritativeUnread,
              ...(!authoritativeUnread ? { unreadMessageCount: 0 } : {}),
            }
          : result.replica.conversation;
      const checkpoint = aggregate(input.conversationId)?.acceptReplica({
        conversation: nextConversation,
        revision: input.checkpoint.revision,
        ownerEpoch,
      }).checkpoint;
      if (!checkpoint || !areCodexThreadStreamCheckpointsEqual(checkpoint, input.checkpoint)) {
        return reject("checkpoint-mismatch");
      }
      if (
        input.ownerNotificationSequence !== undefined &&
        !ownerNotificationDrain.ack(input.conversationId, input.ownerNotificationSequence)
      ) {
        return reject("owner-notification-sequence-mismatch");
      }
      registry.invalidateSnapshotBarriers(input.conversationId);
      events.publish({
        kind: "hostMessage",
        value: {
          type: "threadStreamStateChanged",
          hostId: DEFAULT_CODEX_HOST_ID,
          conversationId: input.conversationId,
          change: input.change,
          version: aggregate(input.conversationId)?.incrementVersion() ?? 0,
          sourceClientId,
          baseCheckpoint: input.baseCheckpoint,
          checkpoint,
        },
      });
      if (nextConversation !== result.replica.conversation && authoritativeUnread !== null) {
        events.publish({
          kind: "hostMessage",
          value: {
            type: "threadReadStateChanged",
            hostId: DEFAULT_CODEX_HOST_ID,
            conversationId: input.conversationId,
            hasUnreadTurn: authoritativeUnread,
          },
        });
      }
      flushSnapshots(input.conversationId);
      return { accepted: true, checkpoint };
    },
    acknowledgeOwnerNotification: (sourceClientId, input) =>
      Effect.gen(function* () {
        if (registry.isClientDisposed(sourceClientId)) return false;
        const current = acceptedReplica(input.conversationId);
        if (current?.conversation.archived) return false;
        const ownerClientId = registry.getOwnerClientId(input.conversationId);
        if (ownerClientId && ownerClientId !== sourceClientId) return false;
        if (!ownerNotificationDrain.canAck(input.conversationId, input.sequence)) return false;
        if (!ownerClientId && !(yield* setOwner(input.conversationId, sourceClientId)))
          return false;
        return ownerNotificationDrain.ack(input.conversationId, input.sequence);
      }),
    replayPendingOwnerRequests: (conversationId, rendererClientId) => {
      if (!rendererClientId || registry.getOwnerClientId(conversationId) !== rendererClientId)
        return 0;
      let replayed = 0;
      for (const request of aggregate(conversationId)?.readServerRequests() ?? []) {
        const ownerRequest = asOwnerRequest(request);
        if (ownerRequest && forwardServerRequest(ownerRequest)) replayed += 1;
      }
      return replayed;
    },
    runFollowerAction: (rendererClients, sourceClientId, input) =>
      runThreadFollowerActionThroughOwner(registry, rendererClients, sourceClientId, input),
    forwardNotification: (notification) =>
      isCodexThreadOwnerNotification(notification)
        ? forwardNotificationForConversation(
            getCodexThreadOwnerNotificationThreadId(notification),
            notification,
          )
        : false,
    forwardNotificationForConversation,
    forwardServerRequest,
    clearRequestDelivery: (conversationId, requestId) =>
      registry.clearRequestDelivery(conversationId, requestId),
    reconcileOwnership: (conversationId) =>
      runReconciliation(conversationId, retention.reconcile(conversationId)),
    resetTransport: (conversationIds) => {
      const normalizedConversationIds = [...new Set(conversationIds.filter(Boolean))];
      if (normalizedConversationIds.length === 0) return;
      const targetClientIds = new Set<string>();
      for (const conversationId of normalizedConversationIds) {
        const ownerClientId = registry.getOwnerClientId(conversationId);
        if (ownerClientId) targetClientIds.add(ownerClientId);
        for (const followerClientId of registry.getFollowerClientIds(conversationId) ?? []) {
          targetClientIds.add(followerClientId);
        }
      }
      if (targetClientIds.size === 0) return;
      events.publish({
        kind: "rendererThreadStreamControlRelay",
        value: {
          targetClientIds: [...targetClientIds],
          message: {
            type: "threadStreamTransportReset",
            hostId: DEFAULT_CODEX_HOST_ID,
            conversationIds: normalizedConversationIds,
          },
        },
      });
    },
    awaitOwnerNotificationDrain: (conversationId) =>
      registry.hasOwner(conversationId)
        ? ownerNotificationDrain.awaitCurrent(conversationId)
        : Effect.void,
    clearConversation: (conversationId) =>
      Effect.sync(() => {
        registry.clearConversation(conversationId);
        ownerNotificationDrain.clear(conversationId);
      }).pipe(
        Effect.andThen(retention.clear(conversationId)),
        Effect.andThen(autoResolution.clearConversation(conversationId)),
      ),
  };
  return CodexRendererConversationCoordinator.of(service);
});

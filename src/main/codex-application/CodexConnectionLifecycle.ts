import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { CodexConnectionState } from "../../shared/types";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import { createOperationId } from "../core-runtime/operation-identity";
import { CodexConnection } from "./CodexConnection";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationEffects } from "./CodexProtocolNotificationEffects";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

export class CodexConnectionLifecycle extends Context.Service<
  CodexConnectionLifecycle,
  { readonly observe: (connection: CodexConnectionState) => Effect.Effect<void> }
>()("nodex/main/codex-application/CodexConnectionLifecycle") {}

/**
 * Owns the application consequences of local app-server connection generations. Transport state
 * stays in `CodexConnection`; this capability atomically retires ephemeral request state and marks
 * loaded conversations for resume before the reconnected catalog is refreshed.
 */
export const make: Effect.Effect<
  CodexConnectionLifecycle["Service"],
  never,
  | CodexApplicationEventHub
  | CodexConnection
  | CodexPendingServerRequestRuntime
  | CodexProtocolNotificationEffects
  | CodexRendererConversationCoordinator
  | CodexSidebarSyncRuntime
  | CodexSubagentDirectory
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | Scope.Scope
> = Effect.gen(function* () {
  const ownerScope = yield* Scope.Scope;
  const connectionState = yield* CodexConnection;
  const events = yield* CodexApplicationEventHub;
  const pending = yield* CodexPendingServerRequestRuntime;
  const protocol = yield* CodexProtocolNotificationEffects;
  const renderer = yield* CodexRendererConversationCoordinator;
  const sidebar = yield* CodexSidebarSyncRuntime;
  const subagents = yield* CodexSubagentDirectory;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const conversations = yield* ConversationEntityMap;
  // The endpoint may already be ready before this dependent Layer subscribes. Seed the transition
  // fence from the current stable-host state so its first observed disconnect cannot be mistaken
  // for startup and leave loaded renderer roles attached to a dead generation.
  let previousStatus: CodexConnectionState["status"] = (yield* connectionState.read).status;
  let disconnectedThreadIds: readonly string[] = [];

  const settleDisconnectedRequests = Effect.fn(
    "CodexConnectionLifecycle.settleDisconnectedRequests",
  )(function* () {
    yield* Effect.forEach(
      pending.disconnectIdentities(),
      ({ threadId, requestId }) =>
        conversations.runCommand(
          threadId,
          protocol
            .apply({
              hostId: DEFAULT_CODEX_HOST_ID,
              generation: 0,
              notification: {
                method: "serverRequest/resolved",
                params: { threadId, requestId },
              },
              occurrenceId: createOperationId("connection.resolve-request"),
              occurrenceToken: 0,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Failed to reconcile a disconnected Codex request").pipe(
                  Effect.annotateLogs({ threadId, requestId: String(requestId), error }),
                ),
              ),
            ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const observe = Effect.fn("CodexConnectionLifecycle.observe")(function* (
    connection: CodexConnectionState,
  ) {
    const wasConnected = previousStatus === "connected";
    previousStatus = connection.status;

    if (wasConnected && connection.status !== "connected") {
      yield* autoResolution.handleDisconnect;
      yield* settleDisconnectedRequests();
    }

    events.publish({ kind: "codex", value: { type: "connection", connection } });
    events.publish({
      kind: "hostMessage",
      value: {
        type: "sharedObjectUpdated",
        hostId: DEFAULT_CODEX_HOST_ID,
        object: {
          objectType: "connection",
          objectId: "connection",
          value: connection,
        },
      },
    });

    if (wasConnected && connection.status !== "connected") {
      const affectedThreadIds = conversations.markAllNeedsResume();
      disconnectedThreadIds = affectedThreadIds;
      renderer.resetTransport(affectedThreadIds);
      return;
    }

    if (
      connection.status !== "connected" ||
      wasConnected ||
      (connection.retries <= 0 && disconnectedThreadIds.length === 0)
    )
      return;
    const reconnectThreadIds = disconnectedThreadIds;
    disconnectedThreadIds = [];
    yield* sidebar
      .sync({ policy: "stale", reason: "app-server-reconnect" })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to refresh the task catalog after Codex reconnected").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );
    yield* subagents
      .reconcileAfterReconnect({ loadedThreadIds: reconnectThreadIds })
      .pipe(Effect.forkIn(ownerScope, { startImmediately: true }));
  });

  const service = CodexConnectionLifecycle.of({ observe });
  yield* connectionState.changes.pipe(
    Stream.runForEach(service.observe),
    Effect.forkScoped({ startImmediately: true }),
  );
  return service;
});

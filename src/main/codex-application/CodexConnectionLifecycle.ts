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
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";

export class CodexConnectionLifecycle extends Context.Service<
  CodexConnectionLifecycle,
  { readonly observe: (connection: CodexConnectionState, hostId?: string) => Effect.Effect<void> }
>()("nodex/main/codex-application/CodexConnectionLifecycle") {}

/**
 * Retires only the disconnected host's request generation. Local catalog and OS consequences
 * remain local; remote transport changes cannot clear another host's requests or timers.
 */
export const make: Effect.Effect<
  CodexConnectionLifecycle["Service"],
  never,
  | CodexApplicationEventHub
  | CodexConnection
  | CodexPendingServerRequestRuntime
  | CodexProtocolNotificationEffects
  | CodexSidebarSyncRuntime
  | CodexSubagentDirectory
  | CodexUserInputAutoResolution
  | ConversationEntityMap
  | RemoteHostedPipRuntime
  | Scope.Scope
> = Effect.gen(function* () {
  const ownerScope = yield* Scope.Scope;
  const connectionState = yield* CodexConnection;
  const events = yield* CodexApplicationEventHub;
  const pending = yield* CodexPendingServerRequestRuntime;
  const protocol = yield* CodexProtocolNotificationEffects;
  const sidebar = yield* CodexSidebarSyncRuntime;
  const subagents = yield* CodexSubagentDirectory;
  const autoResolution = yield* CodexUserInputAutoResolution;
  const conversations = yield* ConversationEntityMap;
  const remoteHostedPip = yield* RemoteHostedPipRuntime;
  // The endpoint may already be ready before this dependent Layer subscribes. Seed the transition
  // fence from the current stable-host state so its first observed disconnect cannot be mistaken
  // for startup and leave loaded renderer roles attached to a dead generation.
  const previousByHost = new Map(yield* connectionState.readAll);
  let disconnectedThreadIds: readonly string[] = [];

  const settleDisconnectedRequests = Effect.fn(
    "CodexConnectionLifecycle.settleDisconnectedRequests",
  )(function* (hostId: string, generation?: number) {
    yield* Effect.forEach(
      pending.disconnectIdentities(hostId, generation),
      ({ threadId, requestId, generation: requestGeneration }) =>
        conversations.runCommand(
          threadId,
          protocol
            .apply({
              hostId,
              generation: requestGeneration,
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
    hostId = DEFAULT_CODEX_HOST_ID,
  ) {
    const previous = previousByHost.get(hostId);
    const wasConnected = previous?.status === "connected";
    previousByHost.set(hostId, connection);
    const isLocal = hostId === DEFAULT_CODEX_HOST_ID;

    if (wasConnected && connection.status !== "connected") {
      if (isLocal) yield* remoteHostedPip.retireLocalCodexHost("connection-lost");
      yield* autoResolution.handleDisconnect(hostId, previous.native?.generation);
      yield* settleDisconnectedRequests(hostId, previous.native?.generation);
    }

    if (!isLocal) return;
    events.publish({ kind: "codex", value: { type: "connection", connection } });

    if (wasConnected && connection.status !== "connected") {
      // Each Main manager resets its own native stream. Catalog recovery concerns this host only.
      disconnectedThreadIds = conversations
        .forHost(DEFAULT_CODEX_HOST_ID)
        .map((entity) => entity.threadId);
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
      .sync({ policy: "force", reason: "app-server-reconnect" })
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
  yield* connectionState.allChanges.pipe(
    Stream.runForEach((snapshot) =>
      Effect.forEach(
        snapshot,
        ([hostId, connection]) =>
          previousByHost.get(hostId) === connection
            ? Effect.void
            : service.observe(connection, hostId),
        { discard: true },
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );
  return service;
});

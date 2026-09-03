import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { CodexConnectionState } from "../../shared/types";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexConnection } from "./CodexConnection";
import { make } from "./CodexConnectionLifecycle";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationEffects } from "./CodexProtocolNotificationEffects";
import { CodexRendererConversationCoordinator } from "./CodexRendererConversationCoordinator";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

it.effect("settles a lost generation and marks loaded conversations before reconnect sync", () =>
  Effect.gen(function* () {
    const trace: string[] = [];
    const published: CodexApplicationEvent[] = [];
    const runtime = yield* make.pipe(
      Effect.provideService(
        CodexConnection,
        CodexConnection.of({
          read: Effect.succeed({ status: "connected", retries: 0, lastConnectedAt: 1 }),
          changes: Stream.empty,
        }),
      ),
      Effect.provideService(
        CodexApplicationEventHub,
        CodexApplicationEventHub.of({
          events: Stream.empty,
          publish: (event) => published.push(event),
        }),
      ),
      Effect.provideService(
        CodexPendingServerRequestRuntime,
        CodexPendingServerRequestRuntime.of({
          disconnectIdentities: () => [{ threadId: "thread-1", requestId: 7 }],
        } as unknown as CodexPendingServerRequestRuntime["Service"]),
      ),
      Effect.provideService(
        CodexProtocolNotificationEffects,
        CodexProtocolNotificationEffects.of({
          apply: ({ notification }) =>
            Effect.sync(() => {
              assert.strictEqual(notification.method, "serverRequest/resolved");
              if (notification.method !== "serverRequest/resolved") return;
              trace.push(`${notification.method}:${notification.params.requestId}`);
            }).pipe(Effect.as("retain" as const)),
        }),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          sync: () => Effect.sync(() => trace.push("sidebar")).pipe(Effect.as({} as never)),
        } as unknown as CodexSidebarSyncRuntime["Service"]),
      ),
      Effect.provideService(
        CodexSubagentDirectory,
        CodexSubagentDirectory.of({
          reconcileAfterReconnect: ({ loadedThreadIds }: { loadedThreadIds: readonly string[] }) =>
            Effect.sync(() => trace.push(`subagents:${loadedThreadIds.join(",")}`)),
        } as unknown as CodexSubagentDirectory["Service"]),
      ),
      Effect.provideService(
        CodexRendererConversationCoordinator,
        CodexRendererConversationCoordinator.of({
          resetTransport: (threadIds: readonly string[]) =>
            trace.push(`renderer-reset:${threadIds.join(",")}`),
        } as unknown as CodexRendererConversationCoordinator["Service"]),
      ),
      Effect.provideService(
        CodexUserInputAutoResolution,
        CodexUserInputAutoResolution.of({
          handleDisconnect: Effect.sync(() => trace.push("auto-resolution")),
        } as unknown as CodexUserInputAutoResolution["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          runCommand: (<A, E, R>(
            _threadId: string,
            operation: Effect.Effect<A, E, R>,
          ): Effect.Effect<A, E, R> => operation) as ConversationEntityMap["Service"]["runCommand"],
          markAllNeedsResume: () => {
            trace.push("mark-needs-resume");
            return ["thread-1"];
          },
        } as unknown as ConversationEntityMap["Service"]),
      ),
      Effect.provideService(
        RemoteHostedPipRuntime,
        RemoteHostedPipRuntime.of({
          retireLocalCodexHost: () => Effect.sync(() => trace.push("pip-retire")),
        } as unknown as RemoteHostedPipRuntime["Service"]),
      ),
    );

    const connected = (retries: number): CodexConnectionState => ({
      status: "connected",
      retries,
      lastConnectedAt: 1,
    });
    yield* runtime.observe({ status: "error", retries: 1, message: "lost" });
    yield* runtime.observe(connected(1));
    yield* Effect.yieldNow;

    assert.deepEqual(trace, [
      "pip-retire",
      "auto-resolution",
      "serverRequest/resolved:7",
      "mark-needs-resume",
      "renderer-reset:thread-1",
      "sidebar",
      "subagents:thread-1",
    ]);
    assert.strictEqual(
      published.filter((event) => event.kind === "codex" && event.value.type === "connection")
        .length,
      2,
    );
    assert.strictEqual(
      published.filter(
        (event) =>
          event.kind === "hostMessage" &&
          event.value.type === "sharedObjectUpdated" &&
          event.value.object.objectType === "connection",
      ).length,
      2,
    );
  }),
);

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import type { CodexConnectionState } from "../../shared/types";
import { RemoteHostedPipRuntime } from "../host-runtime/RemoteHostedPipRuntime";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import { CodexConnection } from "./CodexConnection";
import { make } from "./CodexConnectionLifecycle";
import { CodexPendingServerRequestRuntime } from "./CodexPendingServerRequestRuntime";
import { CodexProtocolNotificationEffects } from "./CodexProtocolNotificationEffects";
import { CodexSidebarSyncRuntime } from "./CodexSidebarSyncRuntime";
import { CodexSubagentDirectory } from "./CodexSubagentDirectory";
import { CodexUserInputAutoResolution } from "./CodexUserInputAutoResolution";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";

it.effect("settles a lost generation and marks loaded conversations before reconnect sync", () =>
  Effect.gen(function* () {
    const trace: string[] = [];
    const published: CodexApplicationEvent[] = [];
    const transitions = yield* PubSub.unbounded<ReadonlyMap<string, CodexConnectionState>>();
    const native = { sourceEpoch: "endpoint", transportKind: "websocket" as const, generation: 1 };
    const disconnected: Array<{ hostId: string; generation: number | undefined }> = [];
    const resolved: Array<{ hostId: string; generation: number }> = [];
    const runtime = yield* make.pipe(
      Effect.provideService(
        CodexConnection,
        CodexConnection.of({
          readAll: Effect.succeed(
            new Map([["local", { status: "connected" as const, retries: 0, native }]]),
          ),
          allChanges: Stream.fromPubSub(transitions),
          read: Effect.succeed({ status: "connected", retries: 0, lastConnectedAt: 1 }),
          readForHost: () => Effect.succeed({ status: "connected", retries: 0 }),
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
          disconnectIdentities: (hostId: string, generation?: number) => {
            disconnected.push({ hostId, generation });
            return [{ threadId: "thread-1", requestId: 7, generation: generation ?? 1 }];
          },
        } as unknown as CodexPendingServerRequestRuntime["Service"]),
      ),
      Effect.provideService(
        CodexProtocolNotificationEffects,
        CodexProtocolNotificationEffects.of({
          apply: ({ notification, hostId, generation }) =>
            Effect.sync(() => {
              resolved.push({ hostId, generation });
              assert.strictEqual(notification.method, "serverRequest/resolved");
              if (notification.method !== "serverRequest/resolved") return;
              trace.push(`${notification.method}:${notification.params.requestId}`);
            }).pipe(Effect.as("retain" as const)),
        }),
      ),
      Effect.provideService(
        CodexSidebarSyncRuntime,
        CodexSidebarSyncRuntime.of({
          sync: (input: Parameters<CodexSidebarSyncRuntime["Service"]["sync"]>[0]) =>
            Effect.sync(() => {
              assert.deepEqual(input, {
                policy: "force",
                reason: "app-server-reconnect",
              });
              trace.push("sidebar");
            }).pipe(Effect.as({} as never)),
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
        CodexUserInputAutoResolution,
        CodexUserInputAutoResolution.of({
          handleDisconnect: (hostId: string, generation?: number) =>
            Effect.sync(() => {
              assert.strictEqual(generation, hostId === "local" ? 1 : 7);
              trace.push("auto-resolution");
            }),
        } as unknown as CodexUserInputAutoResolution["Service"]),
      ),
      Effect.provideService(
        ConversationEntityMap,
        ConversationEntityMap.of({
          registerThreadMetadata: () => {},
          readThreadMetadata: () => null,
          runCommand: (<A, E, R>(
            _threadId: string,
            operation: Effect.Effect<A, E, R>,
          ): Effect.Effect<A, E, R> => operation) as ConversationEntityMap["Service"]["runCommand"],
          forHost: (hostId: string) => {
            assert.strictEqual(hostId, "local");
            trace.push("read-local-threads");
            return [{ threadId: "thread-1" }];
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
      "read-local-threads",
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
      0,
    );
    assert.deepEqual(disconnected, [{ hostId: "local", generation: 1 }]);
    assert.deepEqual(resolved, [{ hostId: "local", generation: 1 }]);
    trace.length = 0;
    published.length = 0;
    // Exercise the subscribed production host stream, including a new connection generation
    // appearing in the starting event before the old generation's requests are retired.
    yield* PubSub.publish(
      transitions,
      new Map([
        [
          "remote",
          {
            status: "connected",
            retries: 0,
            native: { ...native, generation: 7 },
          },
        ],
      ]),
    );
    yield* Effect.yieldNow;
    yield* PubSub.publish(
      transitions,
      new Map([
        [
          "remote",
          {
            status: "starting",
            retries: 1,
            native: { ...native, generation: 8 },
          },
        ],
      ]),
    );
    for (let i = 0; i < 20 && resolved.length < 2; i++) yield* Effect.yieldNow;
    assert.deepEqual(disconnected.at(-1), { hostId: "remote", generation: 7 });
    assert.deepEqual(resolved.at(-1), { hostId: "remote", generation: 7 });
    assert.deepEqual(trace, ["auto-resolution", "serverRequest/resolved:7"]);
    assert.isEmpty(published);
  }),
);

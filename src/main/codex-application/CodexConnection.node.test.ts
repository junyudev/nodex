import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import { assert, it } from "@effect/vitest";
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { CodexConnection, live, projectCodexConnection } from "./CodexConnection";
import { CodexApplicationEventHub, type CodexApplicationEvent } from "./CodexApplicationEventHub";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";

it.effect("projects the authoritative endpoint state without losing retry history", () =>
  Effect.gen(function* () {
    const retrying = projectCodexConnection(
      { status: "connected", retries: 1, lastConnectedAt: 10 },
      {
        kind: "backing-off",
        hostId: "local",
        generation: 2,
        attempt: 3,
        error: codexRuntimeError({
          operation: "session.spawn",
          reason: "spawn",
          retryable: true,
        }),
      },
      20,
    );
    assert.deepEqual(retrying, {
      status: "missingBinary",
      retries: 3,
      message: "Codex session.spawn failed",
    });

    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    const requestOnHost = ((_hostId: string, method: string) =>
      method === "getAuthStatus"
        ? Effect.succeed({ authMethod: "chatgpt", authToken: null, requiresOpenaiAuth: true })
        : unsupported()) as CodexGateway["Service"]["requestOnHost"];
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal: unsupported,
      requestOnHost,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
      connectionChanges: () => Stream.succeed({ kind: "ready", hostId: "local", generation: 1 }),
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
    const scope = yield* Scope.make();
    const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
    const authState = Context.get(authContext, CodexExecutionHostAuthState);
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(CodexApplicationEventHub, { events: Stream.empty, publish: () => {} }),
            Layer.succeed(CodexExecutionHostAuthState, authState),
          ),
        ),
      ),
      scope,
    );
    const connection = Context.get(context, CodexConnection);
    const snapshot = yield* connection.read;
    assert.strictEqual(snapshot.status, "connected");
    assert.strictEqual(snapshot.retries, 0);
    assert.isNumber(snapshot.lastConnectedAt);

    yield* authState.markLoginRequired("local");
    const loginRequired = yield* connection.readForHost("local");
    assert.strictEqual(loginRequired.status, "error");
    assert.deepEqual(loginRequired.error, { code: "login-required" });

    yield* authState.clearLoginRequired("local");
    const recovered = yield* connection.readForHost("local");
    assert.strictEqual(recovered.status, "connected");
    assert.isUndefined(recovered.error);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "publishes remote connection provenance independently of the local connection snapshot",
  () =>
    Effect.gen(function* () {
      const endpointEvents = yield* PubSub.unbounded<CodexEndpointEvent>();
      const published: CodexApplicationEvent[] = [];
      const remote = {
        kind: "ready" as const,
        hostId: "remote",
        generation: 7,
        source: { sourceEpoch: "remote-endpoint", transportKind: "websocket" as const },
      };
      const scope = yield* Scope.Scope;
      const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
      const authState = Context.get(authContext, CodexExecutionHostAuthState);
      const context = yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(CodexGateway, {
                localHostId: "local",
                events: Stream.fromPubSub(endpointEvents),
                connectionChanges: () =>
                  Stream.succeed({ kind: "ready", hostId: "local", generation: 1 }),
                connection: () => Effect.succeed(remote),
                requestOnHost: ((_hostId: string, method: string) =>
                  method === "getAuthStatus"
                    ? Effect.succeed({
                        authMethod: "chatgpt",
                        authToken: null,
                        requiresOpenaiAuth: true,
                      })
                    : Effect.die(
                        new Error("Unsupported test operation"),
                      )) as CodexGateway["Service"]["requestOnHost"],
              } as unknown as CodexGateway["Service"]),
              Layer.succeed(CodexApplicationEventHub, {
                events: Stream.empty,
                publish: (event) => {
                  published.push(event);
                },
              }),
              Layer.succeed(CodexExecutionHostAuthState, authState),
            ),
          ),
        ),
        scope,
      );
      const connection = Context.get(context, CodexConnection);
      yield* PubSub.publish(endpointEvents, { kind: "connection", value: remote });
      yield* Effect.yieldNow;
      const read = yield* connection.readForHost("remote");
      assert.deepEqual(read.native, {
        sourceEpoch: "remote-endpoint",
        transportKind: "websocket",
        generation: 7,
      });
      assert.strictEqual((yield* connection.read).native, undefined);
      assert.isTrue(
        published.some(
          (event) =>
            event.kind === "hostMessage" &&
            event.value.type === "sharedObjectUpdated" &&
            event.value.hostId === "remote" &&
            event.value.object.objectType === "connection" &&
            event.value.object.value.native?.generation === 7,
        ),
      );
    }),
);

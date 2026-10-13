import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { HostBridge } from "./HostBridge.ts";
import { make } from "./Ingress.ts";

const actor = {
  runtimeId: "runtime:test",
  runtimeGeneration: "process:test",
  projectId: ProjectId.make("project:test"),
  threadId: ThreadId.make("thread:test"),
  runId: RunId.make("run:old"),
  attemptId: RunAttemptId.make("attempt:old"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: ProviderSessionId.make("native-session:test"),
  providerThreadId: ProviderThreadId.make("provider-thread:test"),
  nativeGeneration: 1,
  nativeThreadRef: null,
  cwd: "/workspace",
};
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("runtime:test"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId: actor.threadId,
    providerInstanceId: actor.providerInstanceId,
    providerSessionId: "credential:test",
  },
  client: undefined,
};
const request = (body: unknown, profileId?: string) =>
  HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(profileId === undefined ? {} : { "mcp-session-id": profileId }),
      },
      body: JSON.stringify(body),
    }),
  );
const unused = Layer.mergeAll(
  Layer.mock(Projections.ProjectionStoreV2)({
    getHostToolAuthorityContext: () =>
      Effect.die("An old client must be rejected before looking up the new Run."),
  }),
  Layer.mock(Sessions.ProviderSessionManagerV2)({
    get: () => Effect.die("An old client must be rejected before loading the new native runtime."),
  }),
);

it.effect(
  "rejects an initialized client from an older native generation instead of borrowing the newest Run",
  () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(actor);
      yield* Effect.gen(function* () {
        const admit = yield* make;
        yield* admit(
          Effect.succeed(
            HttpServerResponse.empty({ headers: { "mcp-session-id": "profile:old" } }),
          ),
          scope,
          request({ method: "initialize", id: 1 }),
        );
        yield* Ref.update(current, (old) => ({
          ...old,
          nativeGeneration: 2,
          runId: RunId.make("run:new"),
        }));
        const response = yield* admit(
          Effect.succeed(HttpServerResponse.empty()),
          scope,
          request({ method: "tools/call", id: 2, params: { name: "read_page" } }, "profile:old"),
        );
        expect(response.body._tag).toBe("Uint8Array");
        if (response.body._tag !== "Uint8Array") return;
        expect(JSON.parse(new TextDecoder().decode(response.body.body)).result.isError).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mock(HostBridge)({
            runtimeId: EnvironmentId.make(actor.runtimeId),
            runtimeGeneration: actor.runtimeGeneration,
            preparedTurn: () => Ref.get(current),
            nativeSessions: () =>
              Ref.get(current).pipe(
                Effect.map((turn) => [
                  {
                    providerSessionId: turn.providerSessionId,
                    nativeGeneration: turn.nativeGeneration,
                  },
                ]),
              ),
          }),
        ),
        Effect.provide(unused),
      );
    }),
);

it.effect("keeps the ingress Run immutable while a request body is delayed", () =>
  Effect.gen(function* () {
    const current = yield* Ref.make(actor);
    const body = yield* Deferred.make<Schema.Json>();
    const entered = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const admit = yield* make;
      const slow = Object.create(request({}), {
        json: {
          value: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(body))),
        },
      }) as HttpServerRequest.HttpServerRequest;
      const pending = yield* admit(
        Effect.gen(function* () {
          const captured = yield* ExecutionHost.McpTurnAdmission;
          expect(captured?.actor?.runId).toBe(actor.runId);
          expect(captured?.requestId).toBe(7);
          return HttpServerResponse.empty();
        }),
        scope,
        slow,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Ref.update(current, (old) => ({ ...old, runId: RunId.make("run:new") }));
      yield* Deferred.succeed(body, {
        method: "tools/call",
        id: 7,
        params: { name: "t3_thread_read" },
      });
      yield* Fiber.join(pending);
    }).pipe(
      Effect.provide(
        Layer.mock(HostBridge)({
          runtimeId: EnvironmentId.make(actor.runtimeId),
          runtimeGeneration: actor.runtimeGeneration,
          preparedTurn: () => Ref.get(current),
          nativeSessions: () =>
            Ref.get(current).pipe(
              Effect.map((turn) => [
                {
                  providerSessionId: turn.providerSessionId,
                  nativeGeneration: turn.nativeGeneration,
                },
              ]),
            ),
        }),
      ),
      Effect.provide(unused),
    );
  }),
);

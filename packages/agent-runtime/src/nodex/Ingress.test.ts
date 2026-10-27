import * as Cause from "effect/Cause";
import * as PubSub from "effect/PubSub";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { HostBridge, make as makeBridge } from "./HostBridge.ts";
import { make as makeIngress } from "./Ingress.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as Stream from "effect/Stream";
const make = makeIngress.pipe(
  Effect.provide(
    Layer.mock(OrchestratorV2)({
      getThreadEventSequence: () => Effect.succeed(0),
      streamStoredEventsFrom: () => Stream.never,
    }),
  ),
);
import { TaskToolkit } from "../mcp/toolkits/task/tools.ts";

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
const send = (
  effect: Effect.Effect<HttpServerResponse.HttpServerResponse, unknown>,
  request: HttpServerRequest.HttpServerRequest,
) =>
  Effect.gen(function* () {
    let emitted: HttpServerResponse.HttpServerResponse | undefined;
    yield* HttpEffect.toHandled(effect, (_request, response) =>
      Effect.sync(() => {
        emitted = response;
      }),
    ).pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, request));
    if (emitted === undefined) return yield* Effect.die("HTTP response was not emitted");
    return emitted;
  });

it.effect("binds the emitted initialize session before checking canonical execution identity", () =>
  Effect.gen(function* () {
    let authorityReads = 0;
    const expectedFailure = new Projections.ProjectionStoreReadError({
      threadId: actor.threadId,
    });
    yield* Effect.gen(function* () {
      const admit = yield* make;
      const initialize = request({ method: "initialize", id: 1 });
      const opened = yield* send(
        admit(
          Effect.gen(function* () {
            HttpEffect.appendPreResponseHandlerUnsafe(
              yield* Effect.context(),
              (_request, response) =>
                Effect.succeed(
                  HttpServerResponse.setHeader(response, "mcp-session-id", "profile:test"),
                ),
            );
            return HttpServerResponse.empty();
          }),
          scope,
          initialize,
        ),
        initialize,
      );
      expect(opened.headers["mcp-session-id"]).toBe("profile:test");
      const response = yield* admit(
        Effect.die("A failed canonical authority lookup must not execute the tool"),
        scope,
        request({ method: "tools/call", id: 2, params: { name: "delegate_task" } }, "profile:test"),
      );
      expect(authorityReads).toBe(1);
      expect(response.body._tag).toBe("Uint8Array");
      if (response.body._tag !== "Uint8Array") return;
      expect(JSON.parse(new TextDecoder().decode(response.body.body)).result.content[0].text).toBe(
        expectedFailure.message,
      );
    }).pipe(
      Effect.provide(
        Layer.mock(HostBridge)({
          runtimeId: EnvironmentId.make(actor.runtimeId),
          runtimeGeneration: actor.runtimeGeneration,
          nativeSessionLive: () => Effect.succeed(true),
          preparedTurn: () => Effect.succeed(actor),
          nativeSessions: () =>
            Effect.succeed([
              {
                providerSessionId: actor.providerSessionId,
                nativeGeneration: actor.nativeGeneration,
              },
            ]),
          onNativeSessionClose: () => Effect.void,
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Projections.ProjectionStoreV2)({
            getHostToolAuthorityContext: () =>
              Effect.sync(() => {
                authorityReads++;
              }).pipe(Effect.andThen(Effect.fail(expectedFailure))),
          }),
          Layer.mock(Sessions.ProviderSessionManagerV2)({
            get: () => Effect.die("Failed canonical authority must not load a native session"),
          }),
        ),
      ),
    );
  }),
);

it.effect(
  "rejects an initialized client from an older native generation instead of borrowing the newest Run",
  () =>
    Effect.gen(function* () {
      const current = yield* Ref.make(actor);
      yield* Effect.gen(function* () {
        const admit = yield* make;
        const initialize = request({ method: "initialize", id: 1 });
        yield* send(
          admit(
            Effect.succeed(
              HttpServerResponse.empty({ headers: { "mcp-session-id": "profile:old" } }),
            ),
            scope,
            initialize,
          ),
          initialize,
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
            nativeSessionLive: () => Effect.succeed(true),
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
            onNativeSessionClose: () => Effect.void,
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
    let observed = false;
    yield* Effect.gen(function* () {
      const admit = yield* make;
      const slow = Object.create(request({}), {
        json: {
          value: Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(body))),
        },
      }) as HttpServerRequest.HttpServerRequest;
      const pending = yield* admit(
        Effect.gen(function* () {
          observed = true;
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
        params: { name: "list_agent_models" },
      });
      yield* Fiber.join(pending);
      expect(observed).toBe(true);
    }).pipe(
      Effect.provide(
        Layer.mock(HostBridge)({
          runtimeId: EnvironmentId.make(actor.runtimeId),
          runtimeGeneration: actor.runtimeGeneration,
          nativeSessionLive: () => Effect.succeed(true),
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

it.live("releases every ended native client's HTTP profile while retaining a live sibling", () =>
  Effect.gen(function* () {
    const bridge = yield* makeBridge(
      { home: "/runtime", cwd: "/workspace", providers: {} },
      () => Effect.void,
    );
    const parent = yield* Scope.Scope;
    const ended = yield* Scope.fork(parent);
    const live = yield* Scope.fork(parent);
    const identity = {
      credentialId: scope.thread!.providerSessionId,
      providerSessionId: actor.providerSessionId,
      nativeGeneration: actor.nativeGeneration,
    };
    const siblingActor = {
      ...actor,
      threadId: ThreadId.make("thread:live"),
      providerSessionId: ProviderSessionId.make("native:live"),
    };
    const sibling = {
      ...scope,
      thread: {
        ...scope.thread!,
        threadId: siblingActor.threadId,
        providerSessionId: "credential:live",
      },
    };
    yield* bridge.registerNativeSession(identity).pipe(Effect.provideService(Scope.Scope, ended));
    yield* bridge
      .registerNativeSession({
        ...identity,
        credentialId: sibling.thread.providerSessionId,
        providerSessionId: siblingActor.providerSessionId,
      })
      .pipe(Effect.provideService(Scope.Scope, live));
    let authorityReads = 0;
    const expectedFailure = new Projections.ProjectionStoreReadError({ threadId: actor.threadId });
    yield* Effect.gen(function* () {
      const admit = yield* make;
      const initialize = Effect.fn(function* (
        profileId: string,
        caller: Invocation.McpInvocationScope,
        beforeResponse: Effect.Effect<void> = Effect.void,
      ) {
        const incoming = request({ method: "initialize", id: profileId });
        yield* send(
          admit(
            beforeResponse.pipe(
              Effect.andThen(
                Effect.gen(function* () {
                  HttpEffect.appendPreResponseHandlerUnsafe(
                    yield* Effect.context(),
                    (_request, response) =>
                      Effect.succeed(
                        HttpServerResponse.setHeader(response, "mcp-session-id", profileId),
                      ),
                  );
                  return HttpServerResponse.empty();
                }),
              ),
            ),
            caller,
            incoming,
          ),
          incoming,
        );
      });
      yield* initialize("profile:ended:one", scope);
      yield* initialize("profile:ended:two", scope);
      yield* initialize("profile:live", sibling);
      // A native process can close while the HTTP initialize response is still being emitted.
      yield* initialize("profile:ended:late", scope, Scope.close(ended, Exit.void));
      expect(yield* bridge.nativeSessions(identity.credentialId)).toEqual([]);
      const replacement = yield* Scope.fork(parent);
      yield* bridge
        .registerNativeSession(identity)
        .pipe(Effect.provideService(Scope.Scope, replacement));
      const call = Effect.fn(function* (profileId: string, caller: Invocation.McpInvocationScope) {
        const incoming = request(
          { method: "tools/call", id: 2, params: { name: "delegate_task" } },
          profileId,
        );
        const response = yield* send(
          admit(Effect.die("The test authority lookup must stop tool execution"), caller, incoming),
          incoming,
        );
        expect(response.body._tag).toBe("Uint8Array");
        if (response.body._tag !== "Uint8Array") return "";
        return JSON.parse(new TextDecoder().decode(response.body.body)).result.content[0]
          .text as string;
      });
      for (const profileId of ["profile:ended:one", "profile:ended:two", "profile:ended:late"])
        expect(yield* call(profileId, scope)).toBe(
          "This MCP client has no captured execution identity.",
        );
      expect(authorityReads).toBe(0);
      expect(yield* call("profile:live", sibling)).toBe(expectedFailure.message);
      expect(authorityReads).toBe(1);
    }).pipe(
      Effect.provideService(HostBridge, {
        ...bridge,
        preparedTurn: (threadId) =>
          Effect.succeed(threadId === actor.threadId ? actor : siblingActor),
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(Projections.ProjectionStoreV2)({
            getHostToolAuthorityContext: () =>
              Effect.sync(() => {
                authorityReads++;
              }).pipe(Effect.andThen(Effect.fail(expectedFailure))),
          }),
          Layer.mock(Sessions.ProviderSessionManagerV2)({
            get: () => Effect.die("Failed canonical authority must not load a native session"),
          }),
        ),
      ),
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(actor.runtimeId)),
      }),
    ),
  ),
);

it.effect(
  "routes private native metadata through strict tool decoding to the original Run and refuses cancellation",
  () =>
    Effect.gen(function* () {
      const next = {
        ...actor,
        runId: RunId.make("run:new"),
        attemptId: RunAttemptId.make("attempt:new"),
      };
      let cancelled = false;
      const seen: string[] = [];
      const toolkit = Toolkit.make(
        Tool.make("content_write", {
          parameters: TaskToolkit.tools.list_agent_models.parametersSchema,
          success: Schema.Struct({ runId: Schema.String }),
        }),
      );
      const tools = McpServer.toolkit(toolkit).pipe(
        Layer.provide(
          toolkit.toLayer({
            content_write: () =>
              Effect.gen(function* () {
                const frame = yield* ExecutionHost.McpTurnAdmission;
                seen.push(frame!.actor!.runId!);
                yield* frame!.assertCurrent().pipe(Effect.orDie);
                return { runId: frame!.actor!.runId! };
              }),
          }),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
      );
      yield* Effect.gen(function* () {
        const admit = yield* make;
        const server = yield* McpServer.McpServer;
        const initialize = request({ method: "initialize", id: "init" });
        yield* send(
          admit(
            Effect.gen(function* () {
              HttpEffect.appendPreResponseHandlerUnsafe(
                yield* Effect.context(),
                (_request, response) =>
                  Effect.succeed(
                    HttpServerResponse.setHeader(response, "mcp-session-id", "profile:shared"),
                  ),
              );
              return HttpServerResponse.empty();
            }),
            scope,
            initialize,
          ),
          initialize,
        );
        const invoke = (extra: Record<string, unknown> = {}) =>
          admit(
            Effect.gen(function* () {
              const incoming = yield* HttpServerRequest.HttpServerRequest;
              const body = yield* incoming.text.pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.fromJsonString(
                      Schema.Struct({
                        params: Schema.Struct({
                          name: Schema.String,
                          arguments: Schema.Record(Schema.String, Schema.Unknown),
                        }),
                      }),
                    ),
                  ),
                ),
              );
              const result = yield* server.callTool(body.params).pipe(
                Effect.provideService(
                  McpSchema.McpServerClient,
                  McpSchema.McpServerClient.of({
                    clientId: 1,
                    protocolVersion: "2025-06-18",
                    clientCapabilities: {},
                    clientInfo: { name: "native-source-test", version: "1" },
                    initializePayload: {
                      protocolVersion: "2025-06-18",
                      capabilities: {},
                      clientInfo: { name: "native-source-test", version: "1" },
                    },
                    getClient: Effect.die("unused"),
                  }),
                ),
              );
              return HttpServerResponse.jsonUnsafe(result);
            }).pipe(Effect.orDie),
            scope,
            request(
              {
                method: "tools/call",
                id: "native:original",
                params: {
                  name: "content_write",
                  arguments: {
                    ...extra,
                    __nodexExecutionCall: "call:original",
                    __nodexNativeExecution: { nativeThreadId: "transport-only" },
                  },
                },
              },
              "profile:shared",
            ),
          );
        const accepted = yield* invoke();
        expect(accepted.status).toBe(200);
        expect(accepted.body._tag).toBe("Uint8Array");
        if (accepted.body._tag !== "Uint8Array") return;
        expect(JSON.parse(new TextDecoder().decode(accepted.body.body)).structuredContent).toEqual({
          runId: actor.runId,
        });
        expect(seen).toEqual([actor.runId]);
        expect(Exit.isFailure(yield* invoke({ unsupported: true }).pipe(Effect.exit))).toBe(true);
        expect(seen).toEqual([actor.runId]);
        cancelled = true;
        const refused = yield* invoke();
        expect(seen).toEqual([actor.runId]);
        expect(refused.body._tag).toBe("Uint8Array");
        if (refused.body._tag !== "Uint8Array") return;
        expect(JSON.parse(new TextDecoder().decode(refused.body.body)).result.isError).toBe(true);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            tools,
            Layer.mock(HostBridge)({
              runtimeId: EnvironmentId.make(actor.runtimeId),
              runtimeGeneration: actor.runtimeGeneration,
              nativeSessionLive: () => Effect.succeed(true),
              preparedTurn: () => Effect.succeed(next),
              resolveNativeToolCall: (token) =>
                Effect.succeed(
                  token === "call:original"
                    ? { ...actor, nativeCallId: "tool:original", nativeCallKey: "call:original" }
                    : undefined,
                ),
              nativeSessions: () =>
                Effect.succeed([
                  {
                    providerSessionId: actor.providerSessionId,
                    nativeGeneration: actor.nativeGeneration,
                  },
                ]),
              onNativeSessionClose: () => Effect.void,
            }),
            Layer.mock(Projections.ProjectionStoreV2)({
              getHostToolAuthorityContext: (_threadId, runId) => {
                expect(runId).toBe(actor.runId);
                return Effect.succeed({
                  thread: { id: actor.threadId, projectId: actor.projectId, deletedAt: null },
                  runs: [
                    {
                      id: actor.runId,
                      status: cancelled ? "cancelled" : "completed",
                      activeAttemptId: actor.attemptId,
                      providerThreadId: actor.providerThreadId,
                      providerInstanceId: actor.providerInstanceId,
                    },
                  ],
                  providerThreads: [
                    {
                      id: actor.providerThreadId,
                      providerSessionId: actor.providerSessionId,
                      providerInstanceId: actor.providerInstanceId,
                      nativeThreadRef: null,
                    },
                  ],
                  subagents: [],
                } as never);
              },
            }),
          ),
        ),
      );
    }),
);

it.live(
  "binds Codex MCP before preparation and admits exact sources while rejecting retired sessions and cancellation",
  () =>
    Effect.gen(function* () {
      let bridge!: Effect.Success<ReturnType<typeof makeBridge>>;
      bridge = yield* makeBridge(
        { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
        (notification) =>
          notification.type === "host.request"
            ? Effect.suspend(() =>
                bridge.accept({
                  type: "host.result",
                  id: notification.id,
                  success: true,
                  output: {},
                }),
              ).pipe(Effect.asVoid, Effect.orDie)
            : Effect.void,
      );
      const original = { ...actor, nativeDriver: ProviderDriverKind.make("codex") };
      yield* bridge.registerNativeSession({
        credentialId: scope.thread!.providerSessionId,
        providerSessionId: original.providerSessionId,
        nativeGeneration: original.nativeGeneration,
      });
      const siblingScope = yield* Scope.make();
      yield* bridge
        .registerNativeSession({
          credentialId: scope.thread!.providerSessionId,
          providerSessionId: "native-session:ambiguous",
          nativeGeneration: 2,
        })
        .pipe(Effect.provideService(Scope.Scope, siblingScope));
      let cancelled = false;
      let mutations = 0;
      let authorityReads = 0;
      yield* Effect.gen(function* () {
        const admit = yield* make;
        const initialize = Effect.fnUntraced(function* (profileId: string) {
          const incoming = request({ method: "initialize", id: 1 });
          return yield* send(
            admit(
              Effect.succeed(
                HttpServerResponse.empty({ headers: { "mcp-session-id": profileId } }),
              ),
              scope,
              incoming,
            ),
            incoming,
          );
        });
        yield* initialize("profile:ambiguous");
        yield* Scope.close(siblingScope, Exit.void);
        yield* initialize("profile:codex");
        yield* bridge.prepareTurn(original);
        yield* bridge.captureNativeToolCall({
          identity: original,
          nativeCallId: "exec:original",
          nativeThreadId: "native:thread",
          nativeTurnId: "native:turn",
        });
        yield* bridge.prepareTurn({
          ...original,
          runId: RunId.make("run:later"),
          attemptId: RunAttemptId.make("attempt:later"),
        });
        const nativeRequest = (profileId?: string) =>
          request(
            {
              method: "tools/call",
              id: "native:original",
              params: {
                name: "content_write",
                _meta: {
                  callId: "exec:original",
                  threadId: "native:thread",
                  "x-codex-turn-metadata": { turn_id: "native:turn" },
                },
              },
            },
            profileId,
          );
        const mutate = Effect.gen(function* () {
          const captured = yield* ExecutionHost.McpTurnAdmission;
          expect(captured?.actor?.runId).toBe(original.runId);
          expect(captured?.actor?.attemptId).toBe(original.attemptId);
          yield* captured!.assertCurrent().pipe(Effect.orDie);
          mutations++;
          return HttpServerResponse.empty();
        });
        expect((yield* admit(mutate, scope, nativeRequest())).status).toBe(204);
        expect((yield* admit(mutate, scope, nativeRequest("profile:codex"))).status).toBe(204);
        const assertRejected = (response: HttpServerResponse.HttpServerResponse) => {
          expect(response.body._tag).toBe("Uint8Array");
          if (response.body._tag !== "Uint8Array") return;
          expect(JSON.parse(new TextDecoder().decode(response.body.body)).result.isError).toBe(
            true,
          );
        };
        const readsBeforeUnknown = authorityReads;
        for (const profileId of ["profile:unknown", "profile:ambiguous"])
          assertRejected(yield* admit(mutate, scope, nativeRequest(profileId)));
        expect(authorityReads).toBe(readsBeforeUnknown);
        yield* admit(
          Effect.succeed(HttpServerResponse.empty()),
          scope,
          HttpServerRequest.fromWeb(
            new Request("http://127.0.0.1/mcp", {
              method: "DELETE",
              headers: { "mcp-session-id": "profile:codex" },
            }),
          ),
        );
        assertRejected(yield* admit(mutate, scope, nativeRequest("profile:codex")));
        expect(authorityReads).toBe(readsBeforeUnknown);
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const pending = yield* admit(
          Effect.gen(function* () {
            const captured = yield* ExecutionHost.McpTurnAdmission;
            expect(captured?.actor?.runId).toBe(original.runId);
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(resume);
            expect((yield* captured!.assertCurrent().pipe(Effect.result))._tag).toBe("Failure");
            return HttpServerResponse.empty();
          }),
          scope,
          nativeRequest(),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        cancelled = true;
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(pending);
        assertRejected(yield* admit(mutate, scope, nativeRequest()));
        expect(mutations).toBe(2);
      }).pipe(
        Effect.provideService(HostBridge, bridge),
        Effect.provide(
          Layer.mock(Projections.ProjectionStoreV2)({
            getHostToolAuthorityContext: (threadId, runId) => {
              expect(threadId).toBe(original.threadId);
              expect(runId).toBe(original.runId);
              authorityReads++;
              return Effect.succeed({
                thread: { id: original.threadId, deletedAt: null },
                runs: [
                  {
                    id: original.runId,
                    status: cancelled ? "cancelled" : "completed",
                    activeAttemptId: original.attemptId,
                    providerThreadId: original.providerThreadId,
                    providerInstanceId: original.providerInstanceId,
                  },
                ],
                providerThreads: [
                  {
                    id: original.providerThreadId,
                    providerSessionId: original.providerSessionId,
                    providerInstanceId: original.providerInstanceId,
                    nativeThreadRef: original.nativeThreadRef,
                  },
                ],
                subagents: [],
              } as never);
            },
          }),
        ),
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(actor.runtimeId)),
        }),
      ),
    ),
);

it.live(
  "routes shared OpenCode namespaces by native source and invalidates a released call during suspension",
  () =>
    Effect.gen(function* () {
      let bridge!: Effect.Success<ReturnType<typeof makeBridge>>;
      bridge = yield* makeBridge(
        { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
        (notification) =>
          notification.type === "host.request"
            ? Effect.suspend(() =>
                bridge.accept({
                  type: "host.result",
                  id: notification.id,
                  success: true,
                  output: {},
                }),
              ).pipe(Effect.asVoid, Effect.orDie)
            : Effect.void,
      );
      const original = { ...actor, nativeDriver: ProviderDriverKind.make("opencode2") };
      const other = {
        ...original,
        threadId: ThreadId.make("thread:other"),
        runId: RunId.make("run:other"),
        providerSessionId: ProviderSessionId.make("native:other"),
        providerThreadId: ProviderThreadId.make("provider:other"),
      };
      const otherScope = {
        ...scope,
        thread: {
          ...scope.thread!,
          threadId: other.threadId,
          providerSessionId: "credential:other",
        },
      };
      for (const [turn, credentialId] of [
        [original, scope.thread!.providerSessionId],
        [other, otherScope.thread.providerSessionId],
      ] as const) {
        yield* bridge.registerNativeSession({
          credentialId,
          providerSessionId: turn.providerSessionId,
          nativeGeneration: turn.nativeGeneration,
        });
        yield* bridge.prepareTurn(turn);
      }
      const native = {
        nativeThreadId: "native:source",
        nativeTurnId: "message:source",
        nativeCallId: "call:source",
      };
      const token = yield* bridge.captureNativeToolCall({ identity: original, ...native });
      yield* Effect.gen(function* () {
        const admit = yield* make;
        const initialize = request({ method: "initialize", id: 1 });
        yield* send(
          admit(
            Effect.gen(function* () {
              HttpEffect.appendPreResponseHandlerUnsafe(
                yield* Effect.context(),
                (_request, response) =>
                  Effect.succeed(
                    HttpServerResponse.setHeader(response, "mcp-session-id", "profile:other"),
                  ),
              );
              return HttpServerResponse.empty();
            }),
            otherScope,
            initialize,
          ),
          initialize,
        );
        const response = yield* admit(
          Effect.gen(function* () {
            const captured = yield* ExecutionHost.McpTurnAdmission;
            const invocation = yield* Invocation.McpInvocationContext;
            expect(captured?.actor?.threadId).toBe(original.threadId);
            expect(captured?.actor?.runId).toBe(original.runId);
            expect(invocation.thread?.threadId).toBe(original.threadId);
            expect(invocation.requestNamespace).toBe(`native-thread:${original.threadId}`);
            yield* captured!.assertCurrent().pipe(Effect.orDie);
            yield* bridge.releaseNativeToolCall(token);
            expect((yield* captured!.assertCurrent().pipe(Effect.result))._tag).toBe("Failure");
            return HttpServerResponse.empty();
          }),
          otherScope,
          request(
            {
              method: "tools/call",
              id: 2,
              params: { name: "content_write", arguments: { __nodexNativeExecution: native } },
            },
            "profile:other",
          ),
        );
        expect(response.status).toBe(204);
      }).pipe(
        Effect.provideService(HostBridge, bridge),
        Effect.provide(
          Layer.mock(Projections.ProjectionStoreV2)({
            getHostToolAuthorityContext: (threadId, runId) => {
              expect(threadId).toBe(original.threadId);
              expect(runId).toBe(original.runId);
              return Effect.succeed({
                thread: { id: original.threadId, deletedAt: null },
                runs: [
                  {
                    id: original.runId,
                    status: "completed",
                    activeAttemptId: original.attemptId,
                    providerThreadId: original.providerThreadId,
                    providerInstanceId: original.providerInstanceId,
                  },
                ],
                providerThreads: [
                  {
                    id: original.providerThreadId,
                    providerSessionId: original.providerSessionId,
                    providerInstanceId: original.providerInstanceId,
                    nativeThreadRef: null,
                  },
                ],
                subagents: [],
              } as never);
            },
          }),
        ),
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(actor.runtimeId)),
        }),
      ),
    ),
);

it.live(
  "keeps standard ACP calls on their real Session with unknown Run and expires the native incarnation",
  () =>
    Effect.gen(function* () {
      let bridge!: Effect.Success<ReturnType<typeof makeBridge>>;
      bridge = yield* makeBridge(
        { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
        (notification) =>
          notification.type === "host.request"
            ? Effect.suspend(() =>
                bridge.accept({
                  type: "host.result",
                  id: notification.id,
                  success: true,
                  output: {},
                }),
              ).pipe(Effect.asVoid, Effect.orDie)
            : Effect.void,
      );
      const nativeScope = yield* Scope.make();
      yield* bridge
        .registerNativeSession({
          credentialId: scope.thread!.providerSessionId,
          providerSessionId: actor.providerSessionId,
          nativeGeneration: actor.nativeGeneration,
        })
        .pipe(Effect.provideService(Scope.Scope, nativeScope));
      const first = { ...actor, nativeDriver: ProviderDriverKind.make("grok") };
      yield* bridge.prepareTurn(first);
      const original = yield* bridge.nativeSessionActor(first.threadId, first);
      expect(original?.runId).toBeNull();
      yield* bridge.prepareTurn({
        ...first,
        runId: RunId.make("run:later"),
        attemptId: RunAttemptId.make("attempt:later"),
      });
      expect(yield* bridge.nativeSessionActor(first.threadId, first)).toEqual(original);
      yield* Effect.gen(function* () {
        const admit = yield* make;
        const initialize = request({ method: "initialize", id: 1 });
        yield* send(
          admit(
            Effect.gen(function* () {
              HttpEffect.appendPreResponseHandlerUnsafe(
                yield* Effect.context(),
                (_request, response) =>
                  Effect.succeed(
                    HttpServerResponse.setHeader(response, "mcp-session-id", "profile:acp"),
                  ),
              );
              return HttpServerResponse.empty();
            }),
            scope,
            initialize,
          ),
          initialize,
        );
        const response = yield* admit(
          Effect.gen(function* () {
            const captured = yield* ExecutionHost.McpTurnAdmission;
            expect(captured?.actor?.runId).toBeNull();
            expect(captured?.actor?.attemptId).toBeNull();
            yield* captured!.assertCurrent().pipe(Effect.orDie);
            yield* Scope.close(nativeScope, Exit.void);
            expect((yield* captured!.assertCurrent().pipe(Effect.result))._tag).toBe("Failure");
            return HttpServerResponse.empty();
          }),
          scope,
          request(
            { method: "tools/call", id: 2, params: { name: "content_write" } },
            "profile:acp",
          ),
        );
        expect(response.status).toBe(204);
      }).pipe(
        Effect.provideService(HostBridge, bridge),
        Effect.provide(
          Layer.mock(Projections.ProjectionStoreV2)({
            getHostToolAuthorityContext: (_threadId, runId, providerThreadId) => {
              expect(runId).toBeNull();
              expect(providerThreadId).toBe(actor.providerThreadId);
              return Effect.succeed({
                thread: { id: actor.threadId, deletedAt: null },
                runs: [],
                providerThreads: [
                  {
                    id: actor.providerThreadId,
                    providerSessionId: actor.providerSessionId,
                    providerInstanceId: actor.providerInstanceId,
                    nativeThreadRef: null,
                  },
                ],
                subagents: [],
              } as never);
            },
          }),
        ),
      );
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provide(
        Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make(actor.runtimeId)),
        }),
      ),
    ),
);

it.live("cancels a yielded background host call when its exact captured Run is stopped", () =>
  Effect.gen(function* () {
    const events =
      yield* PubSub.unbounded<import("@t3tools/contracts").OrchestrationV2StoredEvent>();
    const subscribed = yield* Deferred.make<void>();
    const hostStarted = yield* Deferred.make<string>();
    const hostCancelled = yield* Deferred.make<string>();
    const completedChecked = yield* Deferred.make<void>();
    let status = "running";
    let bridge!: Effect.Success<ReturnType<typeof makeBridge>>;
    bridge = yield* makeBridge(
      { home: "/runtime", cwd: "/workspace", providers: {}, host: { tools: [] } },
      (notification) => {
        if (notification.type === "host.cancel")
          return Deferred.succeed(hostCancelled, notification.id).pipe(Effect.asVoid);
        if (notification.type !== "host.request") return Effect.void;
        if (notification.operation === "tool.call")
          return Deferred.succeed(hostStarted, notification.id).pipe(Effect.asVoid);
        return Effect.suspend(() =>
          bridge.accept({ type: "host.result", id: notification.id, success: true, output: {} }),
        ).pipe(Effect.asVoid, Effect.orDie);
      },
    );
    const captured = { ...actor, nativeDriver: ProviderDriverKind.make("codex") };
    yield* bridge.registerNativeSession({
      credentialId: scope.thread!.providerSessionId,
      providerSessionId: captured.providerSessionId,
      nativeGeneration: captured.nativeGeneration,
    });
    yield* bridge.prepareTurn(captured);
    yield* bridge.captureNativeToolCall({
      identity: captured,
      nativeCallId: "background:call",
      nativeThreadId: "native:thread",
      nativeTurnId: "native:turn",
    });
    const authority = Layer.mock(Projections.ProjectionStoreV2)({
      getHostToolAuthorityContext: () =>
        Effect.gen(function* () {
          if (status === "completed") yield* Deferred.succeed(completedChecked, undefined);
          return {
            thread: { id: captured.threadId, deletedAt: null },
            runs: [
              {
                id: captured.runId,
                status,
                activeAttemptId: captured.attemptId,
                providerThreadId: captured.providerThreadId,
                providerInstanceId: captured.providerInstanceId,
              },
            ],
            providerThreads: [
              {
                id: captured.providerThreadId,
                providerSessionId: captured.providerSessionId,
                providerInstanceId: captured.providerInstanceId,
                nativeThreadRef: null,
              },
            ],
            subagents: [],
          } as never;
        }),
    });
    const journal = Layer.mock(OrchestratorV2)({
      getThreadEventSequence: () => Effect.succeed(7),
      streamStoredEventsFrom: (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            expect(input).toEqual({ threadId: captured.threadId, afterSequence: 7 });
            const queue = yield* PubSub.subscribe(events);
            yield* Deferred.succeed(subscribed, undefined);
            return Stream.fromEffectRepeat(PubSub.take(queue));
          }),
        ),
    });
    const invoked = Effect.gen(function* () {
      const admit = yield* makeIngress;
      const pending = yield* admit(
        bridge
          .callTool({ ...captured, nativeDriver: captured.nativeDriver }, "wait_sessions", {})
          .pipe(
            ExecutionHost.withMcpTurnLifetime,
            Effect.orDie,
            Effect.as(HttpServerResponse.empty()),
          ),
        scope,
        request({
          method: "tools/call",
          id: "http:background",
          params: {
            name: "wait_sessions",
            arguments: {},
            _meta: {
              callId: "background:call",
              threadId: "native:thread",
              "x-codex-turn-metadata": { turn_id: "native:turn" },
            },
          },
        }),
      ).pipe(Effect.forkChild);
      const hostId = yield* Deferred.await(hostStarted);
      yield* Deferred.await(subscribed);
      status = "completed";
      yield* PubSub.publish(events, {
        sequence: 8,
        event: { type: "run.updated", payload: { id: captured.runId } },
      } as never);
      yield* Deferred.await(completedChecked);
      yield* Effect.yieldNow;
      expect(pending.pollUnsafe()).toBeUndefined();
      status = "interrupted";
      yield* PubSub.publish(events, {
        sequence: 9,
        event: { type: "run.updated", payload: { id: captured.runId } },
      } as never);
      expect(yield* Deferred.await(hostCancelled)).toBe(hostId);
      const exit = yield* Fiber.await(pending);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    });
    yield* invoked.pipe(
      Effect.provideService(HostBridge, bridge),
      Effect.provide(authority),
      Effect.provide(journal),
    );
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(
      Layer.succeed(Environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make(actor.runtimeId)),
      }),
    ),
    Effect.timeout("3 seconds"),
  ),
);

import { describe, expect, test } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import {
  CodexSessionTransport,
  type CodexSessionTransportHandle,
} from "../platform/node/CodexSessionTransport";
import { CodexGateway } from "./CodexGateway";
import type { CodexEndpointEvent } from "./CodexEventHub";
import { make, type CodexWorkspaceRoutingInput } from "./CodexWorkspaceRouting";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { CodexExecutionHostAuthState, live } from "./CodexExecutionHostAuthState";
import { sanitizeCodexEndpointNotification } from "./CodexEndpoint";
import { fullAccessExecutionParams } from "./CodexNativeExecutionPolicy";
import {
  CodexEphemeralThreadRouting,
  live as liveCodexEphemeralThreadRouting,
} from "./CodexEphemeralThreadRouting";

describe("CodexWorkspaceRouting", () => {
  const input: CodexWorkspaceRoutingInput = {
    token: "memory-only",
    identity: { accountId: "a", userId: "u", isFedramp: false },
    primaryHost: { hostId: "local", generation: 1 },
    requirements: { requirements: null },
  };
  const runtime = {
    status: "available",
    bundle: {
      paths: { codexCli: "/verified/browser-runtime/bin/codex" },
      manifest: { runtimeVersions: { codexCli: "0.155.0-alpha.9.2" } },
    },
  } as BrowserRuntimeAvailability;
  const setup = Effect.fn("WorkspaceRoutingTest.setup")(function* (
    options: {
      readonly requirements?: unknown;
      readonly route?: unknown;
      readonly wait?: Effect.Effect<void>;
      readonly runtime?: BrowserRuntimeAvailability;
    } = {},
  ) {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const calls: string[] = [];
    const started = yield* Deferred.make<void>();
    const fs = FileSystem.makeNoop({
      makeTempDirectoryScoped: () =>
        Effect.acquireRelease(
          Effect.sync(() => {
            calls.push("create");
            return "/private/disposable";
          }),
          () =>
            Effect.sync(() => {
              calls.push("remove");
            }),
        ),
      chmod: (_path, mode) =>
        Effect.sync(() => {
          assert.strictEqual(mode, 0o700);
        }),
    });
    const transport = CodexSessionTransport.of({
      canonicalPath: (path) => Effect.succeed(path),
      open: (config) =>
        Effect.gen(function* () {
          calls.push("open");
          assert.strictEqual(config.command, "/verified/browser-runtime/bin/codex");
          assert.strictEqual(config.env.CODEX_HOME, "/private/disposable");
          assert.strictEqual(config.env.HTTPS_PROXY, "http://proxy.example:8080");
          assert.strictEqual(config.env.SSL_CERT_FILE, "/user/ca.pem");
          assert.isUndefined(config.env.OPENAI_API_KEY);
          assert.isUndefined(config.env.CODEX_APP_SERVER_CHATGPT_BASE_URL);
          assert.isFalse(config.args.some((arg) => arg.includes(input.token)));
          assert.include(config.args, 'cli_auth_credentials_store="ephemeral"');
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              calls.push("stop");
            }),
          );
          return {
            pid: 100,
            transportKind: "stdio",
            termination: Effect.never,
            client: {
              request: (method: string, params: { accessToken?: string }) =>
                Effect.sync(() => {
                  calls.push(method);
                  if (method === "initialize")
                    return { userAgent: "Codex Desktop/0.155.0-alpha.9.2" };
                  assert.strictEqual(params.accessToken, input.token);
                  return { type: "chatgptAuthTokens" };
                }),
              notify: () => Effect.void,
              raw: {
                request: (method: string) =>
                  Effect.gen(function* () {
                    calls.push(method);
                    if (method === "configRequirements/read")
                      return options.requirements ?? { requirements: null };
                    yield* Deferred.succeed(started, undefined);
                    if (options.wait) yield* options.wait;
                    return {
                      account: { type: "chatgpt" },
                      workspaceRouting: options.route ?? {
                        chatgptAccountId: "a",
                        backendOrigin: "https://chatgpt.com",
                        accountRoutingOverride: "NO_CONSTRAINT",
                      },
                    };
                  }),
              },
            },
          } as unknown as CodexSessionTransportHandle;
        }),
    });
    const service = yield* make({
      browserRuntime: options.runtime ?? runtime,
      environment: Effect.succeed({
        HOME: "/user",
        PATH: "/bin",
        HTTPS_PROXY: "http://proxy.example:8080",
        SSL_CERT_FILE: "/user/ca.pem",
        OPENAI_API_KEY: "must-not-be-inherited",
        CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://unapproved.example",
      }),
    }).pipe(
      Effect.provideService(CodexGateway, {
        localHostId: "local",
        events: Stream.fromPubSub(events),
      } as CodexGateway["Service"]),
      Effect.provideService(CodexSessionTransport, transport),
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    return { service, events, calls, started };
  });

  it.effect(
    "uses the verified companion, keeps credentials off disk and caches only the exact host/principal/requirements",
    () =>
      Effect.gen(function* () {
        const { service, calls } = yield* setup();
        assert.strictEqual((yield* service.discover(input)).kind, "workspace");
        assert.deepEqual(calls.slice(-2), ["stop", "remove"]);
        yield* service.discover({ ...input, token: "refreshed-same-principal" });
        assert.strictEqual(calls.filter((call) => call === "open").length, 1);
        yield* service.discover({ ...input, primaryHost: { ...input.primaryHost, generation: 2 } });
        yield* service.discover({ ...input, identity: { ...input.identity, userId: "u2" } });
        yield* service.discover({
          ...input,
          requirements: {
            requirements: { application: null, featureRequirements: { in_app_dictation: true } },
          },
        });
        assert.strictEqual(calls.filter((call) => call === "open").length, 4);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects residency/network mismatch before giving the companion credentials", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup();
      const result = yield* Effect.exit(
        service.discover({ ...input, requirements: { requirements: { enforceResidency: "us" } } }),
      );
      assert.isTrue(Exit.isFailure(result));
      assert.notInclude(calls, "account/login/start");
      assert.deepEqual(calls.slice(-2), ["stop", "remove"]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not cache a mismatched account response", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup({
        route: {
          chatgptAccountId: "other",
          backendOrigin: "https://chatgpt.com",
          accountRoutingOverride: "NO_CONSTRAINT",
        },
      });
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.discover(input))));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(service.discover(input))));
      assert.strictEqual(calls.filter((call) => call === "open").length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "account invalidation cancels outstanding discovery and releases the child before its home",
    () =>
      Effect.gen(function* () {
        const { service, calls, events, started } = yield* setup({ wait: Effect.never });
        const fiber = yield* Effect.forkChild(service.discover(input));
        yield* Deferred.await(started);
        yield* PubSub.publish(events, {
          kind: "notification",
          hostId: "local",
          generation: 1,
          value: {
            protocol: "generated",
            method: "account/updated",
            params: { authMode: "chatgpt", planType: "pro" },
          },
        });
        assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
        assert.deepEqual(calls.slice(-2), ["stop", "remove"]);
      }).pipe(Effect.scoped),
  );

  it.effect("bounds a stalled companion and cleans it up on timeout", () =>
    Effect.gen(function* () {
      const { service, calls, started } = yield* setup({ wait: Effect.never });
      const fiber = yield* Effect.forkChild(service.discover(input));
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(fiber)));
      assert.deepEqual(calls.slice(-2), ["stop", "remove"]);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects an unsupported platform without launching or inventing a route", () =>
    Effect.gen(function* () {
      const { service, calls } = yield* setup({
        runtime: {
          status: "unavailable",
          reason: "artifact-missing",
          message: "No verified Windows artifact",
        },
      });
      const result = yield* service.discover(input).pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.strictEqual(
          result.failure.message,
          "The verified workspace routing runtime is unavailable",
        );
      assert.deepEqual(calls, []);
    }).pipe(Effect.scoped),
  );

  it.effect("a pre-notification mutation cancels active and queued discovery", () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const { service, calls, started } = yield* setup({ wait: Effect.never });
      const request = { ...input, signal: controller.signal };
      const active = yield* service.discover(request).pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      const queued = yield* service.discover(request).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      controller.abort();
      assert.isTrue(Exit.isFailure(yield* Fiber.await(active)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(queued)));
      assert.strictEqual(calls.filter((call) => call === "open").length, 1);
      assert.deepEqual(calls.slice(-2), ["stop", "remove"]);
    }).pipe(Effect.scoped);
  });
});

describe("CodexExecutionHostAuthState", () => {
  it.effect("reuses host leases until mutation and revokes all leases with the owner Scope", () =>
    Effect.gen(function* () {
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const context = yield* Layer.build(live).pipe(Scope.provide(scope));
      const state = Context.get(context, CodexExecutionHostAuthState);
      const first = yield* state.backendLease("local");
      const remote = yield* state.backendLease("remote");
      assert.strictEqual(yield* state.backendLease("local"), first);
      yield* state.withAccountMutation("local", "account/logout", Effect.void);
      assert.isTrue(first.aborted);
      assert.isFalse(remote.aborted);
      const next = yield* state.backendLease("local");
      assert.notStrictEqual(next, first);
      assert.isFalse(next.aborted);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(next.aborted);
      assert.isTrue(remote.aborted);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "waits for every overlapping mutation and releases admission after failure or interruption",
    () =>
      Effect.gen(function* () {
        const context = yield* Layer.build(live);
        const state = Context.get(context, CodexExecutionHostAuthState);
        const previous = yield* state.backendLease("local");
        const firstStarted = yield* Deferred.make<void>();
        const secondStarted = yield* Deferred.make<void>();
        const finishFirst = yield* Deferred.make<void>();
        const first = yield* state
          .withAccountMutation(
            "local",
            "account/sessions/switch",
            Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(finishFirst)),
              Effect.andThen(Effect.fail("refused")),
            ),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(firstStarted);
        assert.isTrue(previous.aborted);
        const second = yield* state
          .withAccountMutation(
            "local",
            "account/sessions/add",
            Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Effect.never)),
          )
          .pipe(Effect.forkScoped);
        yield* Deferred.await(secondStarted);
        const pendingLease = yield* state.captureBackendLease("local");
        assert.isFalse(pendingLease.aborted);
        assert.notStrictEqual(pendingLease, previous);
        let admitted = false;
        const waiting = yield* state.backendLease("local").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              admitted = true;
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.succeed(finishFirst, undefined);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
        yield* Effect.yieldNow;
        assert.isFalse(admitted);
        yield* Fiber.interrupt(second);
        const next = yield* Fiber.join(waiting);
        assert.isTrue(admitted);
        assert.isFalse(next.aborted);
        assert.isTrue(pendingLease.aborted);
        assert.notStrictEqual(next, pendingLease);
      }).pipe(Effect.scoped),
  );
});

describe("CodexEndpoint", () => {
  it("keeps the observational endpoint projection free of embedded transcript payloads", () => {
    const input = {
      protocol: "generated",
      method: "thread/started",
      params: {
        thread: {
          id: "thread-large",
          turns: [{ id: "turn-large", items: new Array<unknown>(100_000_000) }],
        },
      },
    } as const;

    const sanitized = sanitizeCodexEndpointNotification(input);

    assert.notStrictEqual(sanitized, input);
    assert.deepStrictEqual((sanitized.params.thread as unknown as { turns: unknown[] }).turns, []);
  });

  it("preserves large completed tool output through endpoint ingress", () => {
    const generated = {
      protocol: "generated",
      method: "item/completed",
      params: {
        threadId: "thread-large",
        turnId: "turn-large",
        completedAtMs: 1,
        item: {
          type: "commandExecution",
          id: "command-large",
          status: "failed",
          aggregatedOutput: "x".repeat(2 * 1024 * 1024 + 1),
        },
      },
    } as const;
    const raw = {
      protocol: "raw",
      method: "custom/event",
      params: { value: "unchanged" },
    } as const;
    const extensionStart = {
      protocol: "extension",
      method: "thread/started",
      params: { thread: { id: "thread-extension", turns: ["must-not-fan-out"] } },
    } as const;

    const sanitized = sanitizeCodexEndpointNotification(generated);

    assert.strictEqual(sanitized.params.item.id, "command-large");
    assert.strictEqual(sanitized.params.item.type, "commandExecution");
    assert.strictEqual(
      sanitized.params.item.aggregatedOutput,
      generated.params.item.aggregatedOutput,
    );
    assert.strictEqual(sanitized.params.item.status, "failed");
    assert.strictEqual(sanitizeCodexEndpointNotification(raw), raw);
    assert.deepStrictEqual(
      sanitizeCodexEndpointNotification(extensionStart).params.thread.turns as readonly unknown[],
      [],
    );
  });
});

describe("CodexNativeExecutionPolicy", () => {
  test("execution entrypoints replace sandbox and approval overrides while preserving Plan intent", () => {
    const request = {
      threadId: "thread",
      cwd: "/workspace",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly" },
      permissions: "restricted",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
      collaborationMode: { mode: "plan", settings: { model: "model" } },
      input: [{ type: "text", text: "Plan it" }],
    };
    for (const method of ["thread/start", "thread/resume", "thread/fork", "turn/start"]) {
      const canonical = fullAccessExecutionParams(method, request);
      expect(canonical).toEqual({
        threadId: "thread",
        cwd: "/workspace",
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        collaborationMode: request.collaborationMode,
        input: request.input,
      });
    }
    expect(request.sandbox).toBe("read-only");
    expect(fullAccessExecutionParams("thread/read", request)).toBe(request);
  });
});

describe("CodexEphemeralThreadRouting", () => {
  const live = liveCodexEphemeralThreadRouting;
  it.effect("owns ephemeral Thread host affinity for exactly the Main Scope", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(live, scope);
      const routing = Context.get(context, CodexEphemeralThreadRouting);

      yield* routing.register("side-a", "remote-a");
      assert.strictEqual(yield* routing.resolve("side-a"), "remote-a");
      yield* routing.remove("side-a");
      assert.isNull(yield* routing.resolve("side-a"));

      yield* routing.register("side-b", "remote-b");
      yield* Scope.close(scope, Exit.void);
      assert.isNull(yield* routing.resolve("side-b"));
    }),
  );
});

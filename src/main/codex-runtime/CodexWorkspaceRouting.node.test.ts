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
        assert.isUndefined(config.env.OPENAI_API_KEY);
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
    environment: { HOME: "/user", PATH: "/bin", OPENAI_API_KEY: "must-not-be-inherited" },
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
        requirements: { requirements: { featureRequirements: { in_app_dictation: true } } },
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

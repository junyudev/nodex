import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import {
  CodexExecutionHostAuthState,
  live as authStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { ChatGptDesktop } from "../codex-application/ChatGptDesktop";
import { makeDictationPolicy } from "./DictationPolicy";
import { EMPTY_DICTATION_POLICY } from "./DictationPolicyState";

vi.mock("../platform/electron/ElectronNet", async (original) => {
  const actual = await original<typeof import("../platform/electron/ElectronNet")>();
  const Effect = await import("effect/Effect");
  return {
    ...actual,
    readDesktopBootstrapMetadata: Effect.succeed({
      app_session_id: "session",
      app_version: "1.0",
      brand_name: "chatgpt",
      build_flavor: "dev",
      locale: "en-US",
      system_name: "macOS",
      system_version: "27.0",
      window_type: "electron",
    }),
  };
});

const token = `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: "account-a", user_id: "user-a" } })).toString("base64url")}.x`;
const auth = { authMethod: "chatgpt", authToken: token, requiresOpenaiAuth: true };
const response = () =>
  new Response(
    JSON.stringify({
      statsigPayload: JSON.stringify({
        has_updates: true,
        user: { userID: "user-a", customIDs: { account_id: "account-a" } },
        feature_gates: {
          "4100906017": { value: true },
          "1244621283": { value: true },
          "codex-app-dictation-streaming": { value: true },
          "codex-app-dictation-sounds": { value: true },
        },
      }),
    }),
  );
const make = Effect.fn("DictationPolicyTest.make")(function* (
  request: ChatGptDesktop["Service"]["request"],
  feature = true,
  fetch: ElectronNet["Service"]["fetch"] = () =>
    Effect.succeed(new Response(null, { status: 403 })),
  authOverride?: {
    authMethod: string | null;
    authToken: string | null;
    requiresOpenaiAuth: boolean;
  },
) {
  const currentAuth = authOverride ?? auth;
  const events = yield* PubSub.unbounded<CodexEndpointEvent>();
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation: 1,
    userAgent: "codex-cli 0.155.0",
  });
  const authState = Context.get(yield* Layer.build(authStateLive), CodexExecutionHostAuthState);
  const policy = yield* makeDictationPolicy.pipe(
    Effect.provideService(ElectronNet, {
      appVersion: "1",
      fetch,
      readBase64: () => Effect.die("unused"),
    }),
    Effect.provideService(CodexExecutionHostAuthState, authState),
    Effect.provideService(CodexWorkspaceRouting, {
      discover: () => Effect.die("unexpected companion"),
    }),
    Effect.provideService(CodexGateway, {
      localHostId: "local",
      events: Stream.fromPubSub(events),
      requestLocal: (method: string) =>
        Effect.succeed(
          method === "experimentalFeature/list"
            ? { data: [{ name: "in_app_dictation", enabled: feature }], nextCursor: null }
            : currentAuth,
        ),
      requestRawOnHost: (_host: string, method: string) =>
        Effect.succeed(
          method === "account/read"
            ? {
                account: { type: "chatgpt", planType: "pro" },
                workspaceRouting: {
                  chatgptAccountId: "account-a",
                  backendOrigin: "https://chatgpt.com",
                  accountRoutingOverride: "NO_CONSTRAINT",
                },
              }
            : { requirements: null },
        ),
    } as unknown as CodexGateway["Service"]),
    Effect.provideService(CodexAppServerCapabilities, {
      forHost: () => Effect.succeed(capability),
      forThread: () => Effect.succeed(capability),
      isCurrent: () => Effect.succeed(true),
    }),
    Effect.provideService(ChatGptDesktop, {
      request,
      authStatus: () => Effect.succeed(currentAuth),
      authMethod: Effect.succeed("chatgpt"),
    }),
  );
  return { policy, events, authState };
});

it.effect(
  "acquires authenticated gates only on refresh and closes them after a remote refusal",
  () =>
    Effect.gen(function* () {
      let count = 0;
      const { policy } = yield* make((input) =>
        Effect.sync(() => {
          if (input.path === "/wham/accounts/check") return new Response(null, { status: 403 });
          count += 1;
          assert.strictEqual(input.path, "/wham/statsig/bootstrap");
          assert.strictEqual(input.method, "POST");
          assert.strictEqual(JSON.parse(String(input.body)).window_type, "electron");
          return count === 1 ? response() : new Response(null, { status: 403 });
        }),
      );
      assert.deepEqual(yield* policy.read, EMPTY_DICTATION_POLICY);
      assert.strictEqual(count, 0);
      assert.isTrue((yield* policy.refresh).streaming);
      assert.isTrue((yield* policy.read).sounds);
      assert.strictEqual(count, 1);
      assert.isFalse((yield* policy.refresh).streaming);
      assert.strictEqual(count, 2);
    }).pipe(Effect.scoped),
);

it.effect("does not enable dictation when the default-host feature is disabled", () =>
  Effect.gen(function* () {
    const { policy } = yield* make(() => Effect.succeed(response()), false);
    const result = yield* policy.refresh;
    assert.isFalse(result.composer);
    assert.isFalse(result.global);
    assert.isFalse(result.streaming);
  }).pipe(Effect.scoped),
);

it.effect("coalesces refreshes and discards completion after account invalidation", () =>
  Effect.gen(function* () {
    let count = 0;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const { policy, events } = yield* make(() =>
      Effect.gen(function* () {
        count += 1;
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(release);
        return response();
      }),
    );
    const first = yield* Effect.forkChild(policy.refresh);
    yield* Deferred.await(started);
    const second = yield* Effect.forkChild(policy.refresh, { startImmediately: true });
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
    yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    assert.deepEqual(yield* Fiber.join(first), EMPTY_DICTATION_POLICY);
    assert.deepEqual(yield* Fiber.join(second), EMPTY_DICTATION_POLICY);
    assert.strictEqual(count, 1);
  }).pipe(Effect.scoped),
);

it.effect("admits streaming through SDK fallback without a remote streaming value", () =>
  Effect.gen(function* () {
    let bootstrapCalls = 0;
    let sdkCalls = 0;
    const { policy } = yield* make(
      (input) =>
        Effect.sync(() => {
          if (input.path === "/wham/statsig/bootstrap") bootstrapCalls += 1;
          return new Response(null, { status: 403 });
        }),
      true,
      () =>
        Effect.sync(() => {
          sdkCalls += 1;
          return new Response(
            '{"has_updates":true,"time":1,"feature_gates":{"4100906017":{"value":true},"codex-app-dictation-sounds":{"value":true}},"dynamic_configs":{},"layer_configs":{}}',
          );
        }),
    );
    const flags = yield* policy.refresh;
    assert.isTrue(flags.composer);
    assert.isTrue(flags.sounds);
    assert.isTrue(flags.streaming);
    assert.strictEqual(bootstrapCalls, 1);
    assert.strictEqual(sdkCalls, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps streaming admitted while publishing other live changes without a new bootstrap",
  () =>
    Effect.gen(function* () {
      let bootstrapCalls = 0;
      const { policy } = yield* make(
        () =>
          Effect.gen(function* () {
            bootstrapCalls += 1;
            const raw = yield* Effect.promise(() => response().json());
            const data = JSON.parse(raw.statsigPayload);
            data.time = 1;
            data.sdk_configs = { live_values_auto_refresh_interval_seconds: 1 };
            return new Response(JSON.stringify({ statsigPayload: JSON.stringify(data) }));
          }),
        true,
        () =>
          Effect.succeed(
            new Response(
              '{"response_mode":"live_overlay","time":2,"live_entity_names":{"feature_gates":["codex-app-dictation-streaming","codex-app-dictation-sounds"]},"feature_gates":{"codex-app-dictation-streaming":{"value":false},"codex-app-dictation-sounds":{"value":false}}}',
            ),
          ),
      );
      assert.isTrue((yield* policy.refresh).streaming);
      yield* TestClock.adjust("1 second");
      yield* policy.changes.pipe(
        Stream.filter((value) => value.composer && !value.sounds),
        Stream.runHead,
      );
      assert.isTrue((yield* policy.read).streaming);
      assert.strictEqual(bootstrapCalls, 1);
    }).pipe(Effect.scoped),
);

it.effect("renews policy after a mutation that emits no account notification", () =>
  Effect.gen(function* () {
    let calls = 0;
    const { policy, authState } = yield* make(() =>
      Effect.sync(() => {
        calls += 1;
        return response();
      }),
    );
    yield* policy.refresh;
    yield* authState.withAccountMutation("local", "account/logout", Effect.void);
    yield* policy.changes.pipe(
      Stream.filter((value) => value.composer && calls === 2),
      Stream.runHead,
    );
    assert.strictEqual(calls, 2);
  }).pipe(Effect.scoped),
);

it.effect("retries bootstrap authentication failures but not explicit IP refusals", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let attempts = 0;
    const { policy } = yield* make(() =>
      Effect.gen(function* () {
        attempts += 1;
        yield* Deferred.succeed(started, undefined);
        return attempts === 1
          ? new Response('{"error":{"code":"unauthorized"}}', { status: 401 })
          : response();
      }),
    );
    const pending = yield* policy.refresh.pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust("500 millis");
    assert.isTrue((yield* Fiber.join(pending)).composer);
    assert.strictEqual(attempts, 2);
    let refusals = 0;
    const denied = yield* make((input) =>
      Effect.sync(() => {
        if (input.path === "/wham/statsig/bootstrap") refusals += 1;
        return new Response('{"error":{"code":"ip_not_authorized"}}', { status: 401 });
      }),
    );
    yield* denied.policy.refresh;
    assert.strictEqual(refusals, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "admits global API-key and auth-free sessions without enabling Composer or sending bearer requests",
  () =>
    Effect.gen(function* () {
      for (const authMethod of ["apikey", null]) {
        let sdkCalls = 0;
        const { policy } = yield* make(
          () => Effect.die("non-ChatGPT policy must not call authenticated HTTP"),
          true,
          (_url, init) =>
            Effect.sync(() => {
              sdkCalls += 1;
              const payload = JSON.parse(String(init.body));
              assert.strictEqual(payload.user.custom.auth_method ?? null, authMethod);
              if (authMethod === "apikey")
                assert.strictEqual(payload.user.userID, `ua-${payload.user.customIDs.stableID}`);
              assert.isFalse(new Headers(init.headers).has("Authorization"));
              return new Response(
                '{"has_updates":true,"time":1,"feature_gates":{"4100906017":{"value":true},"1244621283":{"value":true},"770071981":{"value":true}},"dynamic_configs":{},"layer_configs":{}}',
              );
            }),
          { authMethod, authToken: null, requiresOpenaiAuth: authMethod !== null },
        );
        const flags = yield* policy.refresh;
        assert.isTrue(flags.global);
        assert.isFalse(flags.composer);
        assert.isFalse(flags.streaming);
        assert.strictEqual(flags.accountId, null);
        assert.strictEqual(sdkCalls, 1);
      }
    }).pipe(Effect.scoped),
);

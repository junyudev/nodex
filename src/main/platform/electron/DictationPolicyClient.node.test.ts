import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import { ElectronNet, ElectronNetError } from "./ElectronNet";
import {
  makeDictationPolicyClient,
  makePolicyFallbackUser,
  PolicyUser,
  decodePolicyBootstrap,
} from "./DictationPolicyClient";

import { statsigNameHash, type DictationGateValues } from "../../dictation/DictationPolicyState";

const encodeJson = (value: unknown) => JSON.stringify(value);
const decodeRequest = (body: unknown) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({ responseMode: Schema.optionalKey(Schema.String), user: PolicyUser }),
    ),
  )(String(body));

const metadata = {
  app_session_id: "00000000-0000-0000-0000-000000000000" as const,
  app_version: "1.0",
  brand_name: "chatgpt",
  build_flavor: "dev",
  locale: "en-US",
  system_name: "macOS",
  system_version: "27",
  window_type: "electron",
};
const user = {
  userID: "user",
  customIDs: { account_id: "account" },
  privateAttributes: null,
  custom: { enabled: true, categories: ["desktop"] },
  serverContext: { cohort: "canonical" },
};
const bootstrap = encodeJson({
  has_updates: true,
  user,
  time: 1,
  hash_used: "none",
  sdk_configs: { live_values_auto_refresh_interval_seconds: 1 },
  feature_gates: {
    "4100906017": { value: true },
    "770071981": { value: false },
  },
  dynamic_configs: {},
  layer_configs: {},
});
const provide = (fetch: ElectronNet["Service"]["fetch"]) =>
  Effect.provideService(ElectronNet, {
    appVersion: "1",
    fetch,
    readBase64: () => Effect.die("unused"),
  });

it.effect("policy bootstrap retains JSON context and validates known identity fields", () =>
  Effect.sync(() => {
    const decode = (nextUser: unknown) =>
      decodePolicyBootstrap(
        { statsigPayload: encodeJson({ user: nextUser }) },
        { accountId: "account", userId: "user" },
      );
    assert.deepStrictEqual(decode(user).user, user);
    assert.throws(() => decode({ ...user, userID: 42 }));
    assert.throws(() => decode({ ...user, customIDs: { account_id: 42 } }));
    assert.throws(() => decode({ ...user, userID: "another-user" }));
  }),
);
const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Policy client did not settle: ${label}`));
  });

const steadyJitter = Effect.provideService(Random.Random, {
  nextDoubleUnsafe: () => 0.5,
  nextIntUnsafe: () => 0,
});

const liveResponse = (workspacePermissions = true) =>
  new Response(
    encodeJson({
      response_mode: "live_overlay",
      time: 2,
      live_entity_names: { feature_gates: ["770071981"], dynamic_configs: [] },
      feature_gates: { "770071981": { value: workspacePermissions } },
    }),
  );

// Models an external SDK response that ignores cancellation.
const pendingNativeResponse = () => {
  let resolve!: (response: Response) => void;
  // @effect-diagnostics-next-line newPromise:off
  const promise = new Promise<Response>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

it.effect("publishes live overlays without replacing non-live session values", () =>
  Effect.gen(function* () {
    const received = yield* Deferred.make<void>();
    let count = 0;
    const canonical = decodePolicyBootstrap(
      { statsigPayload: bootstrap },
      { accountId: "account", userId: "user" },
    );
    assert.deepEqual(canonical.user, user);
    const client = yield* makeDictationPolicyClient({
      user: canonical.user,
      bootstrap: canonical.statsigPayload,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((url, init) =>
        Effect.gen(function* () {
          assert.strictEqual(new URL(url).origin, "https://ab.chatgpt.com");
          assert.isFalse(new Headers(init.headers).has("Authorization"));
          const request = decodeRequest(init.body);
          if (request.responseMode !== "live_overlay") {
            return new Response(encodeJson({ has_updates: false }));
          }
          count += 1;
          assert.deepEqual(request.user, user);
          yield* Deferred.succeed(received, undefined);
          return new Response(
            encodeJson({
              response_mode: "live_overlay",
              time: 2,
              live_entity_names: {
                feature_gates: ["770071981"],
                dynamic_configs: [],
              },
              feature_gates: {
                "770071981": { value: true },
                "4100906017": { value: false },
              },
            }),
          );
        }),
      ),
    );
    assert.isFalse((yield* client.read).workspacePermissions);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(received);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    assert.strictEqual(count, 1);
    // Await the SDK promise continuation before reading the published overlay.
    const next = yield* client.changes.pipe(
      Stream.filter((value) => value.workspacePermissions),
      Stream.runHead,
    );
    assert.strictEqual(next._tag, "Some");
    assert.isTrue((yield* client.read).composer);
  }).pipe(Effect.scoped),
);

it.effect("uses the same account SDK for Voice policy and publishes live Voice changes", () =>
  Effect.gen(function* () {
    const payload = encodeJson({
      has_updates: true,
      user,
      time: 1,
      hash_used: "none",
      sdk_configs: { live_values_auto_refresh_interval_seconds: 1 },
      feature_gates: {
        "4100906017": { value: true },
        "2380644311": { value: true },
        "1697652030": { value: false },
        "206132468": { value: false },
      },
      dynamic_configs: {
        "1193530394": { value: { existing_thread_voice_enabled: true } },
        "3566525122": { value: { model: "configured-model", version: "v3" } },
      },
      layer_configs: {},
    });
    let refreshes = 0;
    const client = yield* makeDictationPolicyClient({
      user,
      bootstrap: payload,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((_url, init) =>
        Effect.sync(() => {
          const request = decodeRequest(init.body);
          assert.deepEqual(request.user, user);
          assert.isFalse(new Headers(init.headers).has("Authorization"));
          if (request.responseMode !== "live_overlay")
            return new Response(encodeJson({ has_updates: false }));
          refreshes++;
          return new Response(
            encodeJson({
              response_mode: "live_overlay",
              time: 2,
              live_entity_names: { feature_gates: ["2380644311"], dynamic_configs: [] },
              feature_gates: { "2380644311": { value: false } },
            }),
          );
        }),
      ),
    );
    assert.deepEqual(yield* client.readRealtime, {
      entryPoint: true,
      blocked: false,
      clientOwnedCall: false,
      config: { existing_thread_voice_enabled: true },
      sessionConfig: { model: "configured-model", version: "v3" },
    });
    assert.isTrue((yield* client.read).composer);
    yield* TestClock.adjust("1 second");
    const revised = yield* client.realtimeChanges.pipe(
      Stream.filter((value) => !value.entryPoint),
      Stream.runHead,
    );
    assert.strictEqual(revised._tag, "Some");
    assert.strictEqual(refreshes, 1);
    assert.isTrue((yield* client.read).composer);
    assert.deepEqual((yield* client.readRealtime).sessionConfig, {
      model: "configured-model",
      version: "v3",
    });
  }).pipe(Effect.scoped),
);

it.effect(
  "initializes the SDK fallback with authenticated identity independently of analytics",
  () =>
    Effect.gen(function* () {
      const token = `x.${Buffer.from(encodeJson({ "https://api.openai.com/auth": { chatgpt_compute_residency: "us" }, "https://api.openai.com/profile": { email: "u@example.test" } })).toString("base64url")}.x`;
      const fallback = makePolicyFallbackUser({
        token,
        identity: { accountId: "account", userId: "user" },
        plan: "pro",
        metadata,
      });
      const client = yield* makeDictationPolicyClient({
        user: fallback,
        metadata,
        signal: yield* Effect.abortSignal,
      }).pipe(
        provide((_url, init) =>
          Effect.sync(() => {
            const request = decodeRequest(init.body);
            assert.strictEqual(request.user.userID, "user");
            assert.strictEqual(request.user.customIDs?.account_id, "account");
            assert.strictEqual(request.user.custom?.compute_residency, "us");
            assert.strictEqual(request.user.custom?.auth_method, "chatgpt");
            assert.isFalse(new Headers(init.headers).has("Authorization"));
            return new Response(
              encodeJson({
                has_updates: true,
                time: 1,
                feature_gates: { "770071981": { value: true } },
                dynamic_configs: {},
                layer_configs: {},
              }),
            );
          }),
        ),
      );
      assert.isTrue((yield* client.read).workspacePermissions);
      assert.isFalse((yield* client.read).composer);
    }).pipe(Effect.scoped),
);

it.effect("closing the policy Scope aborts active requests and stops future refreshes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const started = yield* Deferred.make<AbortSignal>();
    let count = 0;
    yield* makeDictationPolicyClient({
      user,
      bootstrap,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((_url, init) =>
        Effect.gen(function* () {
          count += 1;
          yield* Deferred.succeed(started, init.signal!);
          return yield* Effect.never;
        }),
      ),
      Scope.provide(scope),
    );
    yield* TestClock.adjust("1 second");
    const signal = yield* Deferred.await(started);
    yield* Scope.close(scope, Exit.void);
    assert.isTrue(signal.aborted);
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(count, 1);
  }).pipe(Effect.scoped),
);

it.effect(
  "account revocation aborts requests and fences a late response without closing the owner",
  () =>
    Effect.gen(function* () {
      const accountScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(accountScope, Exit.void));
      const accountSignal = yield* Effect.abortSignal.pipe(Scope.provide(accountScope));
      const started = yield* Deferred.make<AbortSignal>();
      const observed: DictationGateValues[] = [];
      let attempts = 0;
      const { promise: lateResponse, resolve: settleResponse } = pendingNativeResponse();
      const client = yield* makeDictationPolicyClient({
        user,
        bootstrap,
        metadata,
        signal: accountSignal,
      }).pipe(
        provide((_url, init) =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(started, init.signal!);
            // Simulate a vendor Promise that completes despite cancellation.
            return yield* Effect.promise(() => lateResponse);
          }),
        ),
      );
      const verified = yield* client.read;
      yield* client.changes.pipe(
        Stream.runForEach((value) => Effect.sync(() => observed.push(value))),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* waitUntil("initial policy publication", () => observed.length === 1);
      yield* TestClock.adjust("1 second");
      const requestSignal = yield* Deferred.await(started);
      yield* Scope.close(accountScope, Exit.void);
      assert.isTrue(requestSignal.aborted);
      settleResponse(liveResponse());
      yield* Effect.promise(() => lateResponse);
      yield* TestClock.adjust("1 hour");
      assert.strictEqual(attempts, 1);
      assert.deepEqual(observed, [verified]);
      assert.deepEqual(yield* client.read, verified);
    }).pipe(Effect.scoped),
);

it.effect("aborts a hung request at its deadline before another attempt can start", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    let attempts = 0;
    let active = 0;
    let maximumActive = 0;
    yield* makeDictationPolicyClient({
      user,
      bootstrap,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((_url, init) =>
        Effect.gen(function* () {
          attempts += 1;
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          yield* Deferred.succeed(started, init.signal!);
          return yield* Effect.never;
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              active -= 1;
            }),
          ),
        ),
      ),
    );
    yield* TestClock.adjust("1 second");
    const signal = yield* Deferred.await(started);
    yield* TestClock.adjust("4999 millis");
    assert.isFalse(signal.aborted);
    assert.strictEqual(attempts, 1);
    yield* TestClock.adjust("1 millis");
    yield* waitUntil("request deadline", () => signal.aborted && active === 0);
    yield* TestClock.adjust("29999 millis");
    assert.strictEqual(attempts, 1);
    yield* TestClock.adjust("1 millis");
    yield* waitUntil("retry after deadline", () => attempts === 2);
    assert.strictEqual(maximumActive, 1);
  }).pipe(steadyJitter, Effect.scoped),
);

it.effect("the request deadline also aborts stalled response-body consumption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    let attempts = 0;
    yield* makeDictationPolicyClient({
      user,
      bootstrap,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((_url, init) =>
        Effect.gen(function* () {
          attempts += 1;
          const signal = init.signal!;
          yield* Deferred.succeed(started, signal);
          return new Response(
            new ReadableStream({
              start: (controller) => {
                signal.addEventListener("abort", () => controller.error(new Error("aborted")), {
                  once: true,
                });
              },
            }),
          );
        }),
      ),
    );
    yield* TestClock.adjust("1 second");
    const signal = yield* Deferred.await(started);
    yield* TestClock.adjust("5 seconds");
    yield* waitUntil("body deadline", () => signal.aborted);
    assert.strictEqual(attempts, 1);
  }).pipe(steadyJitter, Effect.scoped),
);

it.effect("backs off single live attempts to a cap and resumes normal polling after recovery", () =>
  Effect.gen(function* () {
    const attemptedAt: number[] = [];
    let failing = true;
    const client = yield* makeDictationPolicyClient({
      user,
      bootstrap,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide(() =>
        Effect.gen(function* () {
          attemptedAt.push(yield* Clock.currentTimeMillis);
          if (failing) {
            return yield* new ElectronNetError({
              operation: "fetch",
              cause: new Error("net::ERR_CONNECTION_CLOSED"),
            });
          }
          return liveResponse();
        }),
      ),
    );
    yield* TestClock.adjust("1 second");
    yield* waitUntil("first failed live attempt", () => attemptedAt.length === 1);
    assert.isTrue((yield* client.read).composer);
    assert.isFalse((yield* client.read).workspacePermissions);

    for (const delay of [30_000, 60_000, 120_000, 240_000, 300_000, 300_000]) {
      const before = attemptedAt.length;
      yield* TestClock.adjust(delay - 1);
      assert.strictEqual(attemptedAt.length, before);
      yield* TestClock.adjust(1);
      yield* waitUntil("backoff attempt", () => attemptedAt.length === before + 1);
    }
    assert.deepEqual(
      attemptedAt.slice(1).map((time, index) => time - attemptedAt[index]!),
      [30_000, 60_000, 120_000, 240_000, 300_000, 300_000],
    );
    assert.isTrue((yield* client.read).composer);
    assert.isFalse((yield* client.read).workspacePermissions);

    failing = false;
    yield* TestClock.adjust("5 minutes");
    yield* client.changes.pipe(
      Stream.filter((value) => value.workspacePermissions),
      Stream.runHead,
    );
    const recoveredAttempts = attemptedAt.length;
    yield* TestClock.adjust("999 millis");
    assert.strictEqual(attemptedAt.length, recoveredAttempts);
    yield* TestClock.adjust("1 millis");
    yield* waitUntil(
      "normal polling after recovery",
      () => attemptedAt.length === recoveredAttempts + 1,
    );
  }).pipe(steadyJitter, Effect.scoped),
);

it.effect("keeps failed initialization unavailable until a full initialization succeeds", () =>
  Effect.gen(function* () {
    const requests: ReturnType<typeof decodeRequest>[] = [];
    const client = yield* makeDictationPolicyClient({
      user,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide((_url, init) =>
        Effect.sync(() => {
          requests.push(decodeRequest(init.body));
          if (requests.length === 1) return new Response(null, { status: 503 });
          return new Response(bootstrap);
        }),
      ),
    );
    assert.deepEqual(yield* client.read, {
      composer: false,
      workspacePermissions: false,
      voiceDictionary: false,
    });
    assert.strictEqual(requests.length, 1);
    yield* TestClock.adjust("29999 millis");
    assert.strictEqual(requests.length, 1);
    assert.isFalse((yield* client.read).composer);
    yield* TestClock.adjust("1 millis");
    yield* client.changes.pipe(
      Stream.filter((value) => value.composer),
      Stream.runHead,
    );
    assert.strictEqual(requests.length, 2);
    assert.deepEqual(
      requests.map((request) => request.responseMode),
      [undefined, undefined],
    );
  }).pipe(steadyJitter, Effect.scoped),
);

it.effect("treats malformed live responses as failures without replacing verified gates", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const client = yield* makeDictationPolicyClient({
      user,
      bootstrap,
      metadata,
      signal: yield* Effect.abortSignal,
    }).pipe(
      provide(() =>
        Effect.sync(() => {
          attempts += 1;
          return attempts === 1 ? new Response("not-json") : liveResponse();
        }),
      ),
    );
    yield* TestClock.adjust("1 second");
    yield* waitUntil("malformed response", () => attempts === 1);
    assert.isTrue((yield* client.read).composer);
    assert.isFalse((yield* client.read).workspacePermissions);
    yield* TestClock.adjust("29999 millis");
    assert.strictEqual(attempts, 1);
    yield* TestClock.adjust("1 millis");
    yield* client.changes.pipe(
      Stream.filter((value) => value.workspacePermissions),
      Stream.runHead,
    );
    assert.strictEqual(attempts, 2);
    assert.isTrue((yield* client.read).composer);
  }).pipe(steadyJitter, Effect.scoped),
);

it("rejects canonical bootstrap evaluations for another account or user", () => {
  const expected = { accountId: "account", userId: "user" };
  for (const mismatched of [
    { ...user, userID: "other-user" },
    { ...user, customIDs: { account_id: "other-account" } },
  ]) {
    assert.throws(() =>
      decodePolicyBootstrap({ statsigPayload: encodeJson({ user: mismatched }) }, expected),
    );
  }
});

it.effect("delegates V1, compact V2 and absent evaluations to the installed SDK", () =>
  Effect.gen(function* () {
    const defaults = {
      composer: false,
      voiceDictionary: false,
      workspacePermissions: false,
    };
    const fixtures = [
      {
        payload: {
          has_updates: true,
          feature_gates: {
            "4100906017": { value: false },
            [statsigNameHash("4100906017")]: { value: true },
            [statsigNameHash("770071981")]: { value: true },
          },
          dynamic_configs: {
            "3845962714": { value: { dictation_custom_dictionary_enabled: true } },
          },
        },
        expected: { ...defaults, workspacePermissions: true, voiceDictionary: true },
      },
      {
        payload: {
          has_updates: true,
          response_format: "init-v2",
          feature_gates: {
            [statsigNameHash("4100906017")]: { v: true },
            [statsigNameHash("770071981")]: { v: true },
            "1244621283": { v: "true" },
          },
          dynamic_configs: { [statsigNameHash("3845962714")]: { v: 1 } },
          values: [{}, { dictation_custom_dictionary_enabled: true }],
        },
        expected: {
          ...defaults,
          composer: true,
          workspacePermissions: true,
          voiceDictionary: true,
        },
      },
      { payload: { has_updates: true }, expected: defaults },
      { payload: { has_updates: false }, expected: defaults },
      { payload: {}, expected: defaults },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      const identity = { accountId: "fixture-account", userId: `fixture-user-${index}` };
      const canonical = decodePolicyBootstrap(
        {
          statsigPayload: encodeJson({
            user: { userID: identity.userId, customIDs: { account_id: identity.accountId } },
            time: 1,
            hash_used: "djb2",
            feature_gates: {},
            dynamic_configs: {},
            layer_configs: {},
            ...fixture.payload,
          }),
        },
        identity,
      );
      yield* Effect.gen(function* () {
        const client = yield* makeDictationPolicyClient({
          user: canonical.user,
          bootstrap: canonical.statsigPayload,
          metadata,
          signal: yield* Effect.abortSignal,
        });
        assert.deepEqual(yield* client.read, fixture.expected);
      }).pipe(
        provide(() => Effect.sync(() => new Response(encodeJson({ has_updates: false })))),
        Effect.scoped,
      );
    }
  }),
);

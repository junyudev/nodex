import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { ElectronNet } from "./ElectronNet";
import {
  makeDictationPolicyClient,
  makePolicyFallbackUser,
  PolicyUser,
  decodePolicyBootstrap,
} from "./DictationPolicyClient";

import { statsigNameHash } from "../../dictation/DictationPolicyState";

const encodeJson = (value: unknown) => JSON.stringify(value);
const decodeRequest = (body: unknown) =>
  Schema.decodeSync(
    Schema.fromJsonString(
      Schema.Struct({ responseMode: Schema.optionalKey(Schema.String), user: PolicyUser }),
    ),
    { onExcessProperty: "preserve" },
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
    "codex-app-dictation-streaming": { value: false },
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
                feature_gates: ["codex-app-dictation-streaming"],
                dynamic_configs: [],
              },
              feature_gates: {
                "codex-app-dictation-streaming": { value: true },
                "4100906017": { value: false },
              },
            }),
          );
        }),
      ),
    );
    assert.isFalse((yield* client.read).streaming);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(received);
    yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    assert.strictEqual(count, 1);
    // Await the SDK promise continuation before reading the published overlay.
    const next = yield* client.changes.pipe(
      Stream.filter((value) => value.streaming),
      Stream.runHead,
    );
    assert.strictEqual(next._tag, "Some");
    assert.isTrue((yield* client.read).composer);
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
                feature_gates: { "codex-app-dictation-sounds": { value: true } },
                dynamic_configs: {},
                layer_configs: {},
              }),
            );
          }),
        ),
      );
      assert.isTrue((yield* client.read).sounds);
      assert.isFalse((yield* client.read).streaming);
    }).pipe(Effect.scoped),
);

it.effect("closing the policy Scope aborts active SDK requests and stops future refreshes", () =>
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
    yield* TestClock.adjust("10 seconds");
    assert.strictEqual(count, 1);
  }).pipe(Effect.scoped),
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
      global: false,
      streaming: false,
      sounds: false,
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
            [statsigNameHash("codex-app-dictation-sounds")]: { value: true },
          },
          dynamic_configs: {
            "3845962714": { value: { dictation_custom_dictionary_enabled: true } },
          },
        },
        expected: { ...defaults, sounds: true, voiceDictionary: true },
      },
      {
        payload: {
          has_updates: true,
          response_format: "init-v2",
          feature_gates: {
            [statsigNameHash("4100906017")]: { v: true },
            "codex-app-dictation-streaming": { v: true },
            [statsigNameHash("codex-app-dictation-sounds")]: { v: true },
            "1244621283": { v: "true" },
          },
          dynamic_configs: { [statsigNameHash("3845962714")]: { v: 1 } },
          values: [{}, { dictation_custom_dictionary_enabled: true }],
        },
        expected: {
          ...defaults,
          composer: true,
          streaming: true,
          sounds: true,
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

import { assert, it } from "@effect/vitest";
import * as Stream from "effect/Stream";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import type { ExperimentalFeature } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CoreModules } from "../core-runtime/CoreModules";
import { coreRuntimeError, type CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreModuleResponseError } from "../core-client/core-client";
import {
  EMPTY_REALTIME_VOICE_PRODUCT_POLICY,
  type RealtimeVoiceProductPolicy,
} from "../dictation/RealtimeVoicePolicyState";
import { CodexMedia } from "./CodexMedia";
import { ConversationEntityMap, live as entityLive } from "./internal/ConversationEntityMap";
import { targetThread } from "./CodexThreadTargets.test-support";
import { make } from "./CodexRealtimeVoicePolicy";

const target = { hostId: "ssh:owner", threadId: "voice" };
const missing = coreRuntimeError({
  operation: "workspace.read",
  reason: "operation",
  retryable: false,
  cause: new CoreModuleResponseError({
    code: "not_found",
    message: "Missing Thread",
    retryable: false,
    recovery: { kind: "none" },
  }),
});
const feature = (enabled: boolean): ExperimentalFeature => ({
  name: "in_app_voice",
  stage: "underDevelopment",
  displayName: null,
  description: null,
  announcement: null,
  enabled,
  defaultEnabled: false,
});
const allowed: RealtimeVoiceProductPolicy = {
  ...EMPTY_REALTIME_VOICE_PRODUCT_POLICY,
  status: "ready",
  accountId: "account",
  userId: "user",
  entryPoint: true,
  accessAllowed: true,
  config: { existing_thread_voice_enabled: true },
};

const fixture = Effect.fn("RealtimeVoicePolicyTest.fixture")(function* () {
  const entities = Context.get(
    yield* Layer.buildWithScope(entityLive, yield* Scope.Scope),
    ConversationEntityMap,
  );
  const entity = entities.entity(target.threadId);
  const install = (hostId: string) =>
    entity.acceptCanonicalState(
      createCodexCanonicalConversationState(targetThread(target.threadId), {
        hostId,
        turnParamsById: {},
      }),
    );
  install(target.hostId);
  let product = allowed;
  let version = "0.162.0-alpha.17.2";
  let sourceEpoch = "source-one";
  let coreRead: Effect.Effect<unknown, CoreRuntimeError> = Effect.fail(missing);
  const requests: { host: string; params: unknown; fence: unknown }[] = [];
  let featurePage: (host: string, cursor: string | null) => Effect.Effect<unknown> = () =>
    Effect.succeed({ data: [], nextCursor: null });
  const policy = yield* make.pipe(
    Effect.provideService(CodexMedia, {
      realtimeVoiceProductPolicy: Effect.sync(() => product),
    } as CodexMedia["Service"]),
    Effect.provideService(ConversationEntityMap, entities),
    Effect.provideService(CoreModules, {
      workspace: { read: () => coreRead },
    } as unknown as CoreModules["Service"]),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: (hostId) =>
          Effect.succeed(
            createCodexAppServerCapabilitySnapshot({
              hostId,
              generation: 1,
              sourceEpoch,
              userAgent: `codex/${version}`,
            }),
          ),
        forThread: () => Effect.die("Voice must use its explicit host"),
        isCurrent: (captured) => Effect.succeed(captured.sourceEpoch === sourceEpoch),
      }),
    ),
    Effect.provideService(CodexGateway, {
      localHostId: "local",
      requestOnHost: (
        host: string,
        method: string,
        params: { cursor?: string | null },
        fence: unknown,
      ) => {
        assert.strictEqual(method, "experimentalFeature/list");
        requests.push({ host, params, fence });
        return featurePage(host, params.cursor ?? null);
      },
    } as unknown as CodexGateway["Service"]),
  );
  return {
    policy,
    entity,
    requests,
    install,
    setProduct: (value: RealtimeVoiceProductPolicy) => {
      product = value;
    },
    setVersion: (value: string) => {
      version = value;
    },
    resetSource: () => {
      sourceEpoch = "source-two";
    },
    setCoreRead: (read: Effect.Effect<unknown, CoreRuntimeError>) => {
      coreRead = read;
    },
    setFeaturePage: (read: typeof featurePage) => {
      featurePage = read;
    },
  };
});

it.effect(
  "unknown account/rollout and explicit foreign bindings cannot request native Voice features",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const product of [
        EMPTY_REALTIME_VOICE_PRODUCT_POLICY,
        { ...allowed, entryPoint: false },
        { ...allowed, accessAllowed: false },
        { ...allowed, config: {} },
      ]) {
        f.setProduct(product);
        assert.isFalse(yield* f.policy.isAvailable(target));
      }
      f.setProduct(allowed);
      f.setCoreRead(
        Effect.succeed({
          value: {
            kind: "thread",
            thread: { backend_binding: { kind: "codex" }, execution_host_id: "foreign" },
          },
        }),
      );
      assert.isFalse(yield* f.policy.isAvailable(target));
      assert.strictEqual(f.requests.length, 0);
    }).pipe(Effect.scoped),
);

it.effect(
  "reads actual-host and default-host native feature pages with their physical generation fences",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setFeaturePage((host, cursor) =>
        Effect.succeed(
          host === target.hostId && cursor === null
            ? { data: [], nextCursor: "next" }
            : { data: [feature(true)], nextCursor: null },
        ),
      );
      const prepared = yield* f.policy.prepare(target);
      assert.strictEqual(prepared.hostId, target.hostId);
      assert.strictEqual(prepared.nativeStart.version, "v1");
      assert.deepStrictEqual(
        f.requests.map(({ host, params, fence }) => [host, params, fence]),
        [
          [
            target.hostId,
            { cursor: null, limit: 100 },
            { expectedHostId: target.hostId, expectedGeneration: 1 },
          ],
          [
            target.hostId,
            { cursor: "next", limit: 100 },
            { expectedHostId: target.hostId, expectedGeneration: 1 },
          ],
          [
            "local",
            { cursor: null, limit: 100 },
            { expectedHostId: "local", expectedGeneration: 1 },
          ],
        ],
      );
      f.resetSource();
      assert.strictEqual(
        (yield* f.policy.assertCurrent(prepared).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.scoped),
);

it.effect(
  "native explicit false, malformed page cursors and unsupported existing-call transport fail closed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      f.setFeaturePage(() => Effect.succeed({ data: [feature(false)], nextCursor: null }));
      assert.isFalse(yield* f.policy.isAvailable(target));
      f.setFeaturePage(() => Effect.succeed({ data: [], nextCursor: "repeat" }));
      assert.isFalse(yield* f.policy.isAvailable(target));
      const count = f.requests.length;
      for (const version of ["0.0.0", "0.146.0-alpha.1"]) {
        f.setVersion(version);
        assert.isFalse(yield* f.policy.isAvailable(target));
      }
      f.setVersion("0.162.0-alpha.17.2");
      f.setProduct({ ...allowed, clientOwnedCall: true });
      assert.isFalse(yield* f.policy.isAvailable(target));
      assert.strictEqual(f.requests.length, count);
    }).pipe(Effect.scoped),
);

it.effect("rechecks the account, entity host and Endpoint after yielded admission reads", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<unknown>();
    f.setCoreRead(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(resume))),
    );
    const prepare = yield* f.policy.prepare(target).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    f.install("foreign");
    yield* Deferred.succeed(resume, {
      value: {
        kind: "thread",
        thread: { backend_binding: { kind: "codex" }, execution_host_id: target.hostId },
      },
    });
    assert.strictEqual((yield* Fiber.join(prepare))._tag, "Failure");
    assert.strictEqual(f.requests.length, 0);
    f.install(target.hostId);
    f.setCoreRead(Effect.fail(missing));
    f.setFeaturePage(() =>
      Effect.sync(() => {
        f.setProduct(EMPTY_REALTIME_VOICE_PRODUCT_POLICY);
        return { data: [], nextCursor: null };
      }),
    );
    assert.isFalse(yield* f.policy.isAvailable(target));
  }).pipe(Effect.scoped),
);

it.effect(
  "captures session configuration without invalidating a call for an unrelated configuration refresh",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const prepared = yield* f.policy.prepare(target);
      f.setProduct({ ...allowed, config: { ...allowed.config, prompt: "Next call only" } });
      yield* f.policy.assertCurrent(prepared);
      assert.notStrictEqual(prepared.nativeStart.prompt, "Next call only");
      f.setProduct({ ...allowed, accountId: "replacement-account" });
      assert.strictEqual(
        (yield* f.policy.assertCurrent(prepared).pipe(Effect.result))._tag,
        "Failure",
      );
    }).pipe(Effect.scoped),
);

it.effect("uses its captured Runtime voice source after the construction Context is gone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const nativeCalls: string[] = [];
      const localTarget = { hostId: "local", threadId: "runtime-thread" };
      const source = {
        runtimeGeneration: "runtime",
        threadId: localTarget.threadId,
        providerSessionId: "session",
        nativeGeneration: 1,
        providerThreadId: "provider",
        nativeThreadId: "native",
      };
      const f = yield* fixture().pipe(
        Effect.provideService(AgentRuntimeApplication, {
          nativeThread: (threadId: string) => {
            assert.equal(threadId, localTarget.threadId);
            return Effect.succeed({
              connection: {
                subscribeNotifications: Effect.succeed(Stream.never),
                request: (method: string) =>
                  Effect.sync(() => {
                    nativeCalls.push(method);
                    if (method === "native.voice.prepare")
                      return {
                        source,
                        userAgent: "codex/0.162.0-alpha.20",
                        voices: { v1: ["arbor"], defaultV1: "arbor" },
                        features: [],
                        history: [],
                      };
                    if (method === "native.voice.current") return true;
                    return null;
                  }),
              },
            });
          },
        } as unknown as AgentRuntimeApplication["Service"]),
      );
      assert.isTrue(yield* f.policy.isAvailable(localTarget));
      assert.deepEqual(nativeCalls, []);
      const prepared = yield* f.policy.prepare(localTarget);
      assert.isDefined(prepared.runtime);
      assert.deepEqual(prepared.runtime!.capture.source, source);
      assert.deepEqual(f.requests, []);
      yield* prepared.runtime!.release;
      assert.equal(nativeCalls.at(-1), "native.voice.release");
    }),
  ),
);

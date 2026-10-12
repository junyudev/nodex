import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import type {
  ClientRequestMethod,
  ClientRequestResponsesByMethod,
  ServerNotificationMethod,
} from "@nodex/effect-codex-app-server/rpc";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import { live as authStateLive } from "../codex-runtime/CodexExecutionHostAuthState";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexInternalThreadRegistry, make as makeRegistry } from "./CodexInternalThreadRegistry";
import { ThreadCreationRuntime } from "./ThreadCreationRuntime";
import { transparentThreadCreationRuntime } from "./ThreadCreationRuntime.test-support";
import {
  make,
  readCodexComposerPredictionEnvironment,
  NODEX_COMPOSER_PREDICTION_CONFIG_ENV,
  CodexComposerPredictionRequest,
  CodexComposerPredictionClear,
  type CodexComposerPredictionConfiguration,
} from "./CodexComposerPrediction";
import { buildAgentActivityV2CorpusThread } from "../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";

const configuration: CodexComposerPredictionConfiguration = {
  is_enabled: true,
  prompt: "Suggest a useful next message",
  prompt_version: "fixture-1",
  prediction_reasoning_effort: "low",
};
const input = {
  hostId: "local",
  threadId: "parent",
  latestTurnId: "latest",
  generationTrigger: "live" as const,
};
const completedTurn = {
  id: "prediction-turn",
  rootTurnId: null,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: 1,
  completedAt: 2,
  durationMs: 1000,
};
const notification = (
  method: ServerNotificationMethod,
  params: unknown,
  hostId = "local",
): CodexEndpointEvent =>
  ({
    kind: "notification",
    hostId,
    generation: 1,
    value: { method, params },
  }) as CodexEndpointEvent;
type Request = { readonly method: ClientRequestMethod; readonly params: Record<string, unknown> };
function gatewayFixture(
  events: PubSub.PubSub<CodexEndpointEvent>,
  request: (
    method: ClientRequestMethod,
    params: Record<string, unknown>,
    hostId: string,
  ) => Effect.Effect<unknown, CodexRuntimeError>,
): CodexGateway["Service"] {
  const requestOnHost: CodexGateway["Service"]["requestOnHost"] = (hostId, method, params) =>
    request(method, params as Record<string, unknown>, hostId).pipe(
      Effect.map((value) => value as ClientRequestResponsesByMethod[typeof method]),
    );
  const unused = () => Effect.die(new Error("Unexpected prediction test request"));
  return CodexGateway.of({
    localHostId: "local",
    events: Stream.fromPubSub(events),
    promoteQueuedCatalogPage: Effect.succeed(false),
    requestOnHost,
    requestLocal: unused,
    requestForThread: unused,
    requestRawOnHost: unused,
    requestRawForThread: unused,
    notifyLocal: unused,
    connection: unused,
    connectionChanges: () => Stream.empty,
    awaitReady: unused,
    reconcileHost: unused,
    removeHost: unused,
    restartHost: unused,
  });
}
function fixture(
  events: PubSub.PubSub<CodexEndpointEvent>,
  options: {
    readonly ineligible?: "plan" | "provider" | "model";
    readonly failFork?: boolean;
    readonly holdAck?: Deferred.Deferred<void>;
    readonly holdTurn?: Deferred.Deferred<void>;
    readonly turnStarted?: Deferred.Deferred<void>;
    readonly malformedResult?: boolean;
  } = {},
) {
  const calls: Request[] = [];
  const parent = {
    thread: {
      ...buildAgentActivityV2CorpusThread([]),
      id: "parent",
      path: "/synthetic/parent.jsonl",
      turns: [],
    },
    model: "fixture-model",
    modelProvider: options.ineligible === "provider" ? "custom" : "openai",
    reasoningEffort: "medium",
    serviceTier: "auto",
    collaborationMode: options.ineligible === "plan" ? { mode: "plan" } : null,
  };
  const gateway = gatewayFixture(events, (method, params, hostId) =>
    Effect.gen(function* () {
      const notify = (notificationMethod: ServerNotificationMethod, notificationParams: unknown) =>
        notification(notificationMethod, notificationParams, hostId);
      calls.push({ method, params });
      if (method === "thread/resume") return parent;
      if (method === "thread/fork") {
        if (options.failFork)
          return yield* Effect.fail(
            new CodexRuntimeError({
              operation: "fork",
              message: "fork rejected",
              reason: "request",
              retryable: false,
            }),
          );
        return {
          thread: {
            ...parent.thread,
            id: "temporary",
            ephemeral: true,
            threadSource: "composer_predictions",
          },
        };
      }
      if (method === "thread/unsubscribe" || method === "turn/interrupt") return {};
      if (method !== "turn/start") return yield* Effect.die(new Error(`Unexpected ${method}`));
      yield* PubSub.publish(
        events,
        notify("turn/started", {
          threadId: "temporary",
          turn: { ...completedTurn, status: "inProgress" },
        }),
      );
      yield* Effect.yieldNow;
      if (options.turnStarted) yield* Deferred.succeed(options.turnStarted, undefined);
      if (options.holdTurn) yield* Deferred.await(options.holdTurn);
      yield* PubSub.publish(
        events,
        notify("item/agentMessage/delta", {
          threadId: "temporary",
          turnId: "prediction-turn",
          itemId: "message",
          delta: "incomplete delta",
        }),
      );
      yield* PubSub.publish(
        events,
        notify("item/completed", {
          threadId: "temporary",
          turnId: "prediction-turn",
          item: {
            type: "agentMessage",
            id: "message",
            text: options.malformedResult ? "bad JSON" : '{"suggestion":"  next action  "}',
            phase: null,
            memoryCitation: null,
            delivery: null,
            questions: null,
          },
        }),
      );
      yield* PubSub.publish(
        events,
        notify("thread/tokenUsage/updated", {
          threadId: "temporary",
          turnId: "prediction-turn",
          tokenUsage: {
            last: {
              inputTokens: 100,
              cachedInputTokens: 90,
              outputTokens: 10,
              reasoningOutputTokens: 0,
              totalTokens: 110,
            },
          },
        }),
      );
      yield* PubSub.publish(
        events,
        notify("turn/completed", { threadId: "temporary", turn: completedTurn }),
      );
      if (options.holdAck) yield* Deferred.await(options.holdAck);
      return { turn: { ...completedTurn, status: "inProgress" } };
    }),
  );
  return { gateway, calls };
}
const capability = createCodexAppServerCapabilitySnapshot({
  hostId: "local",
  generation: 1,
  userAgent: "nodex/0.162.0-alpha.17.2",
});
function provide(
  owner: ReturnType<typeof make>,
  gateway: CodexGateway["Service"],
  registry: CodexInternalThreadRegistry["Service"],
  authSignal: AbortSignal = new AbortController().signal,
  auth: Partial<CodexExecutionHostAuthState["Service"]> = {},
) {
  return owner.pipe(
    Effect.provideService(CodexGateway, gateway),
    Effect.provideService(
      CodexExecutionHostAuthState,
      CodexExecutionHostAuthState.of({
        isLoginRequired: () => Effect.succeed(false),
        changes: Stream.empty,
        markLoginRequired: () => Effect.void,
        clearLoginRequired: () => Effect.void,
        captureBackendLease: () => Effect.succeed(authSignal),
        backendLease: () => Effect.succeed(authSignal),
        withAccountMutation: (_hostId, _method, request) => request,
        ...auth,
      }),
    ),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: () => Effect.succeed(true),
      }),
    ),
    Effect.provideService(ThreadCreationRuntime, transparentThreadCreationRuntime),
    Effect.provideService(CodexInternalThreadRegistry, registry),
  );
}

it.effect.each(
  (["configuration", "backend-lease"] as const).flatMap((wait) =>
    (["clear", "scoped-clear", "account-mutation", "host-generation"] as const).map((boundary) => ({
      wait,
      boundary,
    })),
  ),
)("a pending $wait admission is immediately retired by $boundary", ({ wait, boundary }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const { gateway, calls } = fixture(events);
      const registry = yield* makeRegistry;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const auth = new AbortController();
      const blocked = Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
      );
      const owner = yield* provide(
        make({
          configurationForHost: () =>
            wait === "configuration"
              ? blocked.pipe(Effect.as(configuration))
              : Effect.succeed(configuration),
        }),
        gateway,
        registry,
        auth.signal,
        {
          backendLease: () =>
            wait === "backend-lease"
              ? blocked.pipe(Effect.as(auth.signal))
              : Effect.succeed(auth.signal),
        },
      );
      const pending = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      if (boundary === "clear") yield* owner.clear();
      if (boundary === "scoped-clear") yield* owner.clear({ hostId: "local", threadId: "parent" });
      if (boundary === "account-mutation") auth.abort();
      if (boundary === "host-generation")
        yield* PubSub.publish(events, {
          kind: "connection",
          value: { kind: "connecting", hostId: "local", generation: 2 },
        });
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      assert.deepStrictEqual(calls, []);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(calls, []);
    }),
  ),
);

it.effect("same-key requests waiting for configuration still share one inference", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const { gateway, calls } = fixture(events);
      const registry = yield* makeRegistry;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let waiting = 0;
      const owner = yield* provide(
        make({
          configurationForHost: () =>
            Effect.gen(function* () {
              if (++waiting === 2) yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(release);
              return configuration;
            }),
        }),
        gateway,
        registry,
      );
      const first = yield* owner.request(input).pipe(Effect.forkChild);
      const second = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.succeed(release, undefined);
      const result = yield* Fiber.join(first);
      assert.strictEqual(yield* Fiber.join(second), result);
      assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
    }),
  ),
);

it.effect.each([
  { hostId: "remote", threadId: "parent" },
  { hostId: "local", threadId: "other-parent" },
])("an unrelated clear preserves a pending configuration admission (%j)", (scope) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const { gateway, calls } = fixture(events);
      const registry = yield* makeRegistry;
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const owner = yield* provide(
        make({
          configurationForHost: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(configuration),
            ),
        }),
        gateway,
        registry,
      );
      const pending = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* owner.clear(scope);
      yield* Deferred.succeed(release, undefined);
      assert.strictEqual((yield* Fiber.join(pending))?.text, "next action");
      assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
    }),
  ),
);

it.effect(
  "a first request started during an account switch cannot infer under the next principal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const authContext = yield* Layer.build(authStateLive);
        const auth = Context.get(authContext, CodexExecutionHostAuthState);
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const configured = yield* Deferred.make<void>();
        const mutation = yield* auth
          .withAccountMutation(
            "local",
            "account/sessions/switch",
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const owner = yield* provide(
          make({
            configurationForHost: () =>
              Deferred.succeed(configured, undefined).pipe(Effect.as(configuration)),
          }),
          gateway,
          registry,
          undefined,
          auth,
        );
        const pending = yield* owner.request(input).pipe(Effect.forkChild);
        yield* Deferred.await(configured);
        assert.deepStrictEqual(calls, []);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(mutation);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.deepStrictEqual(calls, []);
        assert.strictEqual((yield* owner.request(input))?.text, "next action");
      }),
    ),
);

it.effect(
  "prediction uses an inherited-config ephemeral fork, minimal Turn input and final text/token result",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          gateway,
          registry,
        );
        const result = yield* owner.request(input);
        assert.strictEqual(result?.text, "next action");
        assert.strictEqual(result?.model, "fixture-model");
        assert.strictEqual(result?.reasoningEffort, "low");
        assert.strictEqual(result?.parentReasoningEffort, "medium");
        assert.strictEqual(result?.inputTokens, 100);
        assert.strictEqual(result?.cachedInputTokens, 90);
        assert.deepEqual(calls.find(({ method }) => method === "thread/fork")?.params, {
          threadId: "parent",
          experimentalPredictionMode: true,
          ephemeral: true,
          excludeTurns: true,
          threadSource: "composer_predictions",
        });
        const turn = calls.find(({ method }) => method === "turn/start")!.params;
        assert.deepEqual(
          Object.keys(turn).sort(),
          [
            "clientUserMessageId",
            "effort",
            "input",
            "outputSchema",
            "threadId",
            "turnTrigger",
          ].sort(),
        );
        assert.strictEqual(turn.outputSchema, null);
        assert.strictEqual(calls.filter(({ method }) => method === "thread/unsubscribe").length, 1);
        assert.isFalse(registry.shouldSuppress("temporary"));
        const repeated = yield* owner.request(input);
        assert.strictEqual(repeated, result);
        assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
      }),
    ),
);

it.effect.each([undefined, {}])(
  "global prediction clear invalidates completed results on every host (%j)",
  (clearInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          gateway,
          registry,
        );
        const local = yield* owner.request(input);
        const remoteInput = { ...input, hostId: "remote" };
        const remote = yield* owner.request(remoteInput);
        assert.strictEqual(local?.text, "next action");
        assert.strictEqual(remote?.text, "next action");
        assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 2);
        yield* Schema.decodeUnknownEffect(CodexComposerPredictionClear)(clearInput).pipe(
          Effect.flatMap(owner.clear),
        );
        assert.notStrictEqual(yield* owner.request(input), local);
        assert.notStrictEqual(yield* owner.request(remoteInput), remote);
        assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 4);
      }),
    ),
);

it.effect.each([null, { threadId: "parent" }, { hostId: " " }, { hostId: "local", threadId: " " }])(
  "invalid clear scope is rejected before cached predictions are removed (%j)",
  (clearInput) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          gateway,
          registry,
        );
        const cached = yield* owner.request(input);
        const clear = Schema.decodeUnknownEffect(CodexComposerPredictionClear)(clearInput).pipe(
          Effect.flatMap(owner.clear),
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(clear)));
        assert.strictEqual(yield* owner.request(input), cached);
        assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
      }),
    ),
);

it.effect.each([
  null,
  { ...configuration, is_enabled: false },
  { ...configuration, sample_rate: 0 },
])("unassigned, disabled and unsampled prediction never calls native inference", (config) =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const { gateway, calls } = fixture(events);
      const registry = yield* makeRegistry;
      const owner = yield* provide(
        make({ configurationForHost: (_hostId) => Effect.succeed(config) }),
        gateway,
        registry,
      );
      assert.isNull(yield* owner.request(input));
      assert.deepEqual(calls, []);
    }),
  ),
);

it.effect.each(["plan", "provider", "model"] as const)(
  "%s parent is ineligible without a fork or model Turn",
  (ineligible) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events, { ineligible });
        const registry = yield* makeRegistry;
        const config =
          ineligible === "model"
            ? { ...configuration, unsupported_models: ["fixture-model"] }
            : configuration;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(config) }),
          gateway,
          registry,
        );
        assert.isNull(yield* owner.request(input));
        assert.deepEqual(
          calls.map(({ method }) => method),
          ["thread/resume"],
        );
      }),
    ),
);

it.effect("failed prediction fork does not start a fresh Thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const f = fixture(events, { failFork: true });
      const registry = yield* makeRegistry;
      const owner = yield* provide(
        make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
        f.gateway,
        registry,
      );
      const result = yield* Effect.exit(owner.request(input));
      assert.isTrue(Exit.isFailure(result));
      assert.deepEqual(
        f.calls.map(({ method }) => method),
        ["thread/resume", "thread/fork"],
      );
    }),
  ),
);

it.effect(
  "invalid result releases its temporary Thread and never exposes malformed composer content",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const f = fixture(events, { malformedResult: true });
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          f.gateway,
          registry,
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(owner.request(input))));
        assert.strictEqual(
          f.calls.filter(({ method }) => method === "thread/unsubscribe").length,
          1,
        );
      }),
    ),
);

it.effect(
  "clearing a pending prediction interrupts its native Turn and unsubscribes exactly once",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const holdTurn = yield* Deferred.make<void>();
        const turnStarted = yield* Deferred.make<void>();
        const f = fixture(events, { holdTurn, turnStarted });
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          f.gateway,
          registry,
        );
        const pending = yield* owner.request(input).pipe(Effect.forkChild);
        yield* Deferred.await(turnStarted);
        assert.isTrue(registry.shouldSuppress("temporary"));
        yield* owner.clear({ hostId: "local", threadId: "parent" });
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.strictEqual(f.calls.filter(({ method }) => method === "turn/interrupt").length, 1);
        assert.strictEqual(
          f.calls.filter(({ method }) => method === "thread/unsubscribe").length,
          1,
        );
        assert.isFalse(registry.shouldSuppress("temporary"));
      }),
    ),
);

it.effect("concurrent callers share a failure and a later explicit request can retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const holdTurn = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<void>();
      const options = { holdTurn, turnStarted, malformedResult: true };
      const { gateway, calls } = fixture(events, options);
      const registry = yield* makeRegistry;
      const owner = yield* provide(
        make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
        gateway,
        registry,
      );
      const first = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);
      const second = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
      yield* Deferred.succeed(holdTurn, undefined);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(second)));
      assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
      assert.strictEqual(calls.filter(({ method }) => method === "thread/unsubscribe").length, 1);
      options.malformedResult = false;
      assert.strictEqual((yield* owner.request(input))?.text, "next action");
      assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 2);
      assert.strictEqual(calls.filter(({ method }) => method === "thread/unsubscribe").length, 2);
    }),
  ),
);

it.effect(
  "host assignments stay off until explicitly configured and never disclose inference prompts",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        assert.deepEqual(yield* readCodexComposerPredictionEnvironment({}), {});
        const hosts = yield* readCodexComposerPredictionEnvironment({
          [NODEX_COMPOSER_PREDICTION_CONFIG_ENV]: JSON.stringify({
            hosts: { local: configuration },
          }),
        });
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({
            configurationForHost: (hostId) => Effect.succeed(hosts[hostId] ?? null),
            configurationSource: "environment",
          }),
          gateway,
          registry,
        );
        assert.deepEqual(yield* owner.availability("local"), {
          enabled: true,
          source: "environment",
          scope: "local",
        });
        assert.deepEqual(yield* owner.availability("remote"), {
          enabled: false,
          source: null,
          scope: "remote",
        });
        assert.isNull(yield* owner.request({ ...input, hostId: "remote" }));
        assert.deepEqual(calls, []);
      }),
    ),
);

it.effect.each([
  "invalid-json",
  JSON.stringify({ hosts: { local: { ...configuration, sample_rate: 2 } } }),
])("invalid explicit prediction config fails at the Main configuration boundary", (raw) =>
  Effect.gen(function* () {
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          readCodexComposerPredictionEnvironment({ [NODEX_COMPOSER_PREDICTION_CONFIG_ENV]: raw }),
        ),
      ),
    );
  }),
);

it.effect.each([
  { ...input, hostId: " " },
  { ...input, threadId: "" },
  { ...input, generationTrigger: "other" },
])("IPC prediction identity and trigger are validated before native admission", (raw) =>
  Effect.gen(function* () {
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(Schema.decodeUnknownEffect(CodexComposerPredictionRequest)(raw)),
      ),
    );
  }),
);

it.effect(
  "a completed result releases the helper before a delayed Turn start acknowledgement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const holdAck = yield* Deferred.make<void>();
        const { gateway, calls } = fixture(events, { holdAck });
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({
            configurationForHost: (_hostId) =>
              Effect.succeed({ ...configuration, prediction_reasoning_effort: "" }),
          }),
          gateway,
          registry,
        );
        const result = yield* owner.request(input);
        assert.strictEqual(result?.text, "next action");
        assert.strictEqual(result?.reasoningEffort, "medium");
        assert.isNull(result?.configuredReasoningEffort);
        assert.isFalse(registry.shouldSuppress("temporary"));
        assert.strictEqual(calls.filter(({ method }) => method === "thread/unsubscribe").length, 1);
        assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 0);
      }),
    ),
);

it.effect("a new parent Turn invalidates predictions only for its host", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const holdTurn = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<void>();
      const { gateway, calls } = fixture(events, { holdTurn, turnStarted });
      const registry = yield* makeRegistry;
      const owner = yield* provide(
        make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
        gateway,
        registry,
      );
      const pending = yield* owner.request(input).pipe(Effect.forkChild);
      yield* Deferred.await(turnStarted);
      yield* owner.clear({ hostId: "remote", threadId: "parent" });
      assert.isTrue(registry.shouldSuppress("temporary"));
      assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 0);
      yield* PubSub.publish(
        events,
        notification("turn/started", {
          threadId: "parent",
          turn: { ...completedTurn, id: "parent-new", status: "inProgress" },
        }),
      );
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 1);
      assert.isFalse(registry.shouldSuppress("temporary"));
    }),
  ),
);

it.effect(
  "prediction timeout interrupts the active helper Turn and releases its subscription",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const holdTurn = yield* Deferred.make<void>();
        const turnStarted = yield* Deferred.make<void>();
        const { gateway, calls } = fixture(events, { holdTurn, turnStarted });
        const registry = yield* makeRegistry;
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration), timeoutMs: 50 }),
          gateway,
          registry,
        );
        const pending = yield* owner.request(input).pipe(Effect.forkChild);
        yield* Deferred.await(turnStarted);
        yield* TestClock.adjust(50);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.strictEqual(calls.filter(({ method }) => method === "turn/interrupt").length, 1);
        assert.strictEqual(calls.filter(({ method }) => method === "thread/unsubscribe").length, 1);
        assert.isFalse(registry.shouldSuppress("temporary"));
      }),
    ),
);

it.effect.each(["account-mutation", "logout", "host-generation"] as const)(
  "%s clears completed prediction caches before reuse",
  (boundary) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<CodexEndpointEvent>();
        const { gateway, calls } = fixture(events);
        const registry = yield* makeRegistry;
        const auth = new AbortController();
        const owner = yield* provide(
          make({ configurationForHost: (_hostId) => Effect.succeed(configuration) }),
          gateway,
          registry,
          auth.signal,
        );
        assert.strictEqual((yield* owner.request(input))?.text, "next action");
        if (boundary === "account-mutation") {
          auth.abort();
          yield* Effect.yieldNow;
        }
        if (boundary === "logout")
          yield* PubSub.publish(
            events,
            notification("account/updated", { authMode: null, planType: null }),
          );
        if (boundary === "host-generation")
          yield* PubSub.publish(events, {
            kind: "connection",
            value: { kind: "connecting", hostId: "local", generation: 2 },
          });
        yield* Effect.yieldNow;
        if (boundary === "account-mutation") {
          assert.isTrue(Exit.isFailure(yield* Effect.exit(owner.request(input))));
          assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 1);
          return;
        }
        assert.strictEqual((yield* owner.request(input))?.text, "next action");
        assert.strictEqual(calls.filter(({ method }) => method === "thread/fork").length, 2);
      }),
    ),
);

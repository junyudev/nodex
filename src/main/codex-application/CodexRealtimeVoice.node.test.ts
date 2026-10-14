import { assert, it } from "@effect/vitest";
import type { Thread, TurnCompletedNotification } from "@nodex/codex-app-server-protocol/v2";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createCodexCanonicalConversationState } from "../../shared/codex-conversation-state/codex-conversation-state";
import { DEFAULT_DICTATION_SETTINGS, type DictationSettings } from "../../shared/dictation";
import type { CodexRealtimeVoiceEvent } from "../../shared/codex-realtime-voice";
import type { CodexAppModelContextAttachment } from "../../shared/codex-untrusted-app-input";
import { CodexMedia } from "./CodexMedia";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { DictationRuntime } from "../host-runtime/DictationRuntime";
import { RendererClientRuntime } from "../host-runtime/RendererClientRuntime";
import type { RendererClientEvent } from "../codex/renderer-client-runtime-contracts";
import { makeSharedMicrophoneAuthority } from "../dictation/SharedMicrophoneAuthority";
import { ConversationEntityMap, live as entitiesLive } from "./internal/ConversationEntityMap";
import {
  CodexRealtimeVoicePolicy,
  CodexRealtimeVoicePolicyError,
} from "./CodexRealtimeVoicePolicy";
import { make } from "./CodexRealtimeVoice";
import type { RealtimeVoiceProductPolicy } from "../dictation/RealtimeVoicePolicyState";
import { CodexAppServerRequestError } from "@nodex/effect-codex-app-server/errors";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";

const target = { hostId: "local", threadId: "thread" };
const completedTurn = (threadId = target.threadId, blocked = true): TurnCompletedNotification => ({
  threadId,
  turn: {
    id: "blocked-turn",
    rootTurnId: null,
    items: [],
    itemsView: "full",
    status: blocked ? "failed" : "completed",
    error: blocked
      ? {
          message: "Blocked",
          codexErrorInfo: "misalignmentPolicyViolation",
          additionalDetails: null,
          misalignment: null,
        }
      : null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
  },
});
const metadata: Thread = {
  id: "thread",
  sessionId: "session",
  environments: null,
  extra: null,
  forkedFromId: null,
  parentThreadId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "legacy",
  modelProvider: "openai",
  model: null,
  reasoningEffort: null,
  createdAt: 1,
  updatedAt: 1,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace",
  cliVersion: "0.162.0-alpha.17.2",
  originator: null,
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  turns: [],
};

const fixture = Effect.fn("VoiceTest.fixture")(function* () {
  const scope = yield* Scope.Scope;
  const entities = Context.get(
    yield* Layer.buildWithScope(entitiesLive, scope),
    ConversationEntityMap,
  );
  const entity = entities.entity("thread");
  entity.acceptCanonicalState(
    createCodexCanonicalConversationState(metadata, { hostId: "local", turnParamsById: {} }),
  );
  entity.setResumeState("resumed");
  const microphone = yield* makeSharedMicrophoneAuthority;
  const clientEvents = yield* PubSub.sliding<RendererClientEvent>(8);
  const policyEvents = yield* PubSub.unbounded<RealtimeVoiceProductPolicy>();
  const settingsEvents = yield* PubSub.unbounded<void>();
  let settings: DictationSettings = DEFAULT_DICTATION_SETTINGS;
  const clients = new Map([
    [1, "client-one"],
    [2, "client-two"],
  ]);
  const events: CodexRealtimeVoiceEvent[] = [];
  const requests: { method: string; params: unknown; scheduling: unknown }[] = [];
  let nativeStart: Effect.Effect<unknown> = Effect.succeed({});
  let nativeStop: Effect.Effect<unknown, Error> = Effect.succeed({});
  let nativeSpeech: Effect.Effect<unknown, Error> = Effect.succeed({});
  let nativeInjection: Effect.Effect<unknown, Error> = Effect.succeed({});
  let allowed = true;
  let generation = 1;
  let nextCapabilityCheck: Effect.Effect<void> = Effect.void;
  const capability = createCodexAppServerCapabilitySnapshot({
    hostId: "local",
    generation,
    sourceEpoch: "source-one",
    userAgent: "codex/0.162.0-alpha.17.2",
  });
  const voice = yield* make.pipe(
    Effect.provideService(ConversationEntityMap, entities),
    Effect.provideService(CodexMedia, {
      readRealtimeVoicePreference: () => Effect.succeed(null),
    } as unknown as CodexMedia["Service"]),
    Effect.provideService(
      CodexAppServerCapabilities,
      CodexAppServerCapabilities.of({
        forHost: () => Effect.succeed(capability),
        forThread: () => Effect.succeed(capability),
        isCurrent: (captured) =>
          Effect.suspend(() => {
            const check = nextCapabilityCheck;
            nextCapabilityCheck = Effect.void;
            return check.pipe(Effect.map(() => captured.generation === generation));
          }),
      }),
    ),
    Effect.provideService(
      CodexRealtimeVoicePolicy,
      CodexRealtimeVoicePolicy.of({
        changes: Stream.fromPubSub(policyEvents),
        prepare: (input) =>
          allowed
            ? Effect.succeed({
                ...input,
                bufferInputWhileConnecting: true,
                productPolicy: {
                  status: "ready",
                  accountId: "account",
                  userId: "user",
                  entryPoint: true,
                  accessAllowed: true,
                  clientOwnedCall: false,
                  config: {},
                  sessionConfig: {},
                },
                capabilities: capability,
                nativeStart: {
                  version: "v3",
                  outputModality: "audio",
                  includeStartupContext: false,
                  flushTranscriptTailOnSessionEnd: true,
                },
              })
            : Effect.fail(
                new CodexRealtimeVoicePolicyError({
                  reason: "unavailable",
                  message: "Unknown policy",
                }),
              ),
        isAvailable: () => Effect.succeed(allowed),
        assertCurrent: () =>
          allowed
            ? Effect.void
            : Effect.fail(
                new CodexRealtimeVoicePolicyError({ reason: "changed", message: "Policy changed" }),
              ),
      }),
    ),
    Effect.provideService(
      DictationRuntime,
      DictationRuntime.of({
        changes: Stream.fromPubSub(settingsEvents),
        acquireVoiceMicrophone: (
          input: Parameters<DictationRuntime["Service"]["acquireVoiceMicrophone"]>[0],
        ) => microphone.acquireVoice({ ...input, kind: "realtime-voice" }),
        releaseMicrophone: (owner: number, sessionId: string) =>
          Effect.sync(() => microphone.release(owner, sessionId)),
        readSettings: Effect.sync(() => settings),
        readMicrophoneRouteHint: Effect.succeed(null),
      } as unknown as DictationRuntime["Service"]),
    ),
    Effect.provideService(
      RendererClientRuntime,
      RendererClientRuntime.of({
        getClientIdForWebContentsId: (id) => clients.get(id) ?? null,
        events: Stream.fromPubSub(clientEvents),
        sendCriticalToClient: (_clientId, _channel, event) => {
          events.push(event as CodexRealtimeVoiceEvent);
          return true;
        },
        broadcast: (_channel, event) => {
          events.push(event as CodexRealtimeVoiceEvent);
          return clients.size;
        },
      } as RendererClientRuntime["Service"]),
    ),
    Effect.provideService(
      CodexGateway,
      CodexGateway.of({
        connectionChanges: () => Stream.empty,
        requestOnHost: (_hostId: string, method: string, params: unknown, scheduling: unknown) => {
          if (method === "thread/realtime/listVoices")
            return Effect.succeed({
              voices: { v1: ["arbor"], v2: ["arbor"], defaultV1: "arbor", defaultV2: "arbor" },
            });
          requests.push({ method, params, scheduling });
          if (method === "thread/realtime/start") return nativeStart;
          if (method === "thread/realtime/stop") return nativeStop;
          if (method === "thread/realtime/appendText") return Effect.succeed({});
          if (method === "thread/realtime/appendSpeech") return nativeSpeech;
          if (method === "thread/inject_items") return nativeInjection;
          return Effect.die(`Unexpected native method ${method}`);
        },
      } as unknown as CodexGateway["Service"]),
    ),
  );
  return {
    voice,
    entity,
    entities,
    microphone,
    events,
    requests,
    startWith: (operation: Effect.Effect<unknown>) => {
      nativeStart = operation;
    },
    stopWith: (operation: Effect.Effect<unknown, Error>) => {
      nativeStop = operation;
    },
    speechWith: (operation: Effect.Effect<unknown, Error>) => {
      nativeSpeech = operation;
    },
    injectWith: (operation: Effect.Effect<unknown, Error>) => {
      nativeInjection = operation;
    },
    setAllowed: (value: boolean) => {
      allowed = value;
    },
    replaceHost: () => {
      generation += 1;
    },
    checkCapabilityWith: (check: Effect.Effect<void>) => {
      nextCapabilityCheck = check;
    },
    publishPolicy: (product: RealtimeVoiceProductPolicy) => PubSub.publish(policyEvents, product),
    changeMicrophone: (deviceId: string | null) =>
      Effect.sync(() => {
        settings = { ...settings, microphoneInputDeviceId: deviceId };
      }).pipe(Effect.andThen(PubSub.publish(settingsEvents, undefined))),
    disposeClient: (id: number) =>
      Effect.gen(function* () {
        const clientId = clients.get(id)!;
        clients.delete(id);
        yield* PubSub.publish(clientEvents, {
          kind: "disposed",
          clientId,
          webContentsId: id,
          reason: "gone",
        });
        yield* Effect.yieldNow;
      }),
  };
});

it.effect("claims one cross-window session and keeps current policy unknown fail-closed", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setAllowed(false);
    assert.strictEqual((yield* f.voice.prepare(1, target).pipe(Effect.result))._tag, "Failure");
    assert.isNull(f.microphone.readOwner());
    assert.isNull(f.voice.readSession());
    f.setAllowed(true);
    const grant = yield* f.voice.prepare(1, target);
    assert.deepEqual(yield* f.voice.prepare(1, target), grant);
    assert.strictEqual((yield* f.voice.prepare(2, target).pipe(Effect.result))._tag, "Failure");
    assert.strictEqual(f.microphone.readOwner()?.kind, "realtime-voice");
    assert.isFalse(yield* f.voice.release(2, grant.claimId));
    assert.isTrue(yield* f.voice.release(1, grant.claimId));
    assert.isNull(f.microphone.readOwner());
  }).pipe(Effect.scoped),
);

it.effect("speaks through the owning claim and rejects a retired native acknowledgement", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    yield* f.voice.start(1, grant.claimId, "offer");
    assert.strictEqual(
      (yield* f.voice.appendSpeech(2, grant.claimId, "foreign").pipe(Effect.result))._tag,
      "Failure",
    );
    yield* f.voice.appendSpeech(1, grant.claimId, " exact warning ");
    assert.deepStrictEqual(f.requests.at(-1), {
      method: "thread/realtime/appendSpeech",
      params: { threadId: "thread", text: " exact warning " },
      scheduling: { expectedHostId: "local", expectedGeneration: 1 },
    });
    const entered = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<void>();
    f.speechWith(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
    );
    const pending = yield* f.voice
      .appendSpeech(1, grant.claimId, "held")
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    f.replaceHost();
    yield* Deferred.succeed(accepted, undefined);
    assert.strictEqual((yield* Fiber.join(pending))._tag, "Failure");
    assert.strictEqual(
      f.requests.filter(({ method }) => method === "thread/realtime/appendSpeech").length,
      2,
    );
  }).pipe(Effect.scoped),
);

it.effect("injects captured app context through the owning voice claim before native start", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    const attachments: readonly CodexAppModelContextAttachment[] = [
      {
        id: "widget",
        kind: "context",
        sourceName: "Chart",
        server: "charts",
        untrusted: true,
        content: [{ type: "text", text: "selection", annotations: { audience: ["assistant"] } }],
      },
    ];
    assert.strictEqual(
      (yield* f.voice.injectContext(2, grant.claimId, attachments).pipe(Effect.result))._tag,
      "Failure",
    );
    assert.strictEqual(f.requests.length, 0);
    yield* f.voice.injectContext(1, grant.claimId, attachments);
    yield* f.voice.start(1, grant.claimId, "offer");
    assert.deepStrictEqual(
      f.requests.map(({ method }) => method),
      ["thread/inject_items", "thread/realtime/start"],
    );
    assert.deepInclude(f.requests[0], {
      scheduling: { expectedHostId: "local", expectedGeneration: 1 },
    });
    assert.deepInclude(f.requests[0]?.params, { threadId: "thread" });
    const items = (f.requests[0]?.params as { items: { type: string; output?: unknown[] }[] })
      .items;
    assert.strictEqual(items[0]?.type, "function_call");
    assert.deepInclude(items[1]?.output?.[0], {
      type: "input_text",
      text: '{"kind":"model_context","source":"mcp_app","sourceId":"widget","server":"charts","title":"Chart","text":"selection"}',
    });
  }).pipe(Effect.scoped),
);

it.effect("does not confirm an app-context injection after its native generation retires", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    yield* f.voice.injectContext(1, grant.claimId, []);
    assert.strictEqual(f.requests.length, 0);
    const entered = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<void>();
    f.injectWith(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
    );
    const pending = yield* f.voice
      .injectContext(1, grant.claimId, [
        { id: "widget", title: "Chart", untrusted: true, text: "selected", imageAttachments: [] },
      ])
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    f.replaceHost();
    yield* Deferred.succeed(accepted, undefined);
    assert.strictEqual((yield* Fiber.join(pending))._tag, "Failure");
    assert.strictEqual(
      f.requests.filter(({ method }) => method === "thread/inject_items").length,
      1,
    );
  }).pipe(Effect.scoped),
);

for (const phase of ["starting", "active"] as const)
  it.effect(
    `a matching safety completion retires a ${phase} call without admitting foreign completions`,
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        const grant = yield* f.voice.prepare(1, target);
        if (phase === "active") {
          yield* f.voice.start(1, grant.claimId, "offer");
          yield* f.voice.reportMedia(1, grant.claimId, "connected");
          yield* f.voice.reportMedia(1, grant.claimId, "initialized");
          yield* f.voice.observeNative(
            { hostId: "local", generation: 1 },
            {
              method: "thread/realtime/started",
              params: {
                threadId: target.threadId,
                realtimeSessionId: grant.realtimeSessionId,
                version: "v3",
              },
            },
          );
        }
        for (const source of [
          { hostId: "ssh:foreign", generation: 1 },
          { hostId: "local", generation: 2 },
        ])
          yield* f.voice.observeNative(source, {
            method: "turn/completed",
            params: completedTurn(),
          });
        yield* f.voice.observeNative(
          { hostId: "local", generation: 1 },
          { method: "turn/completed", params: completedTurn("foreign") },
        );
        yield* f.voice.observeNative(
          { hostId: "local", generation: 1 },
          { method: "turn/completed", params: completedTurn("thread", false) },
        );
        assert.strictEqual(f.voice.readSession()?.phase, phase);
        yield* f.voice.observeNative(
          { hostId: "local", generation: 1 },
          { method: "turn/completed", params: completedTurn() },
        );
        assert.strictEqual(f.voice.readSession()?.phase, "stopping");
        assert.deepStrictEqual(
          f.events.filter((event) => event.type === "terminate"),
          [{ type: "terminate", claimId: grant.claimId }],
        );
        assert.strictEqual(
          (yield* f.voice.start(1, grant.claimId, "late-offer").pipe(Effect.result))._tag,
          "Failure",
        );
        assert.strictEqual(f.requests.length, phase === "active" ? 1 : 0);
        yield* f.voice.release(1, grant.claimId);
        assert.isNull(f.voice.readSession());
        assert.isNull(f.microphone.readOwner());
      }).pipe(Effect.scoped),
  );

it.effect(
  "a safety observation awaiting authority cannot retire a reopened call on the same Thread",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.voice.prepare(1, target);
      const entered = yield* Deferred.make<void>();
      const checked = yield* Deferred.make<void>();
      f.checkCapabilityWith(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(checked))),
      );
      const observing = yield* f.voice
        .observeNative(
          { hostId: "local", generation: 1 },
          { method: "turn/completed", params: completedTurn() },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.voice.release(1, first.claimId);
      const reopened = yield* f.voice.prepare(1, target);
      yield* Deferred.succeed(checked, undefined);
      yield* Fiber.join(observing);
      assert.strictEqual(f.voice.readSession()?.claimId, reopened.claimId);
      assert.strictEqual(f.voice.readSession()?.phase, "starting");
      assert.isFalse(
        f.events.some((event) => event.type === "terminate" && event.claimId === reopened.claimId),
      );
      yield* f.voice.release(1, reopened.claimId);
    }).pipe(Effect.scoped),
);

it.effect(
  "does not admit old realtime notifications before its actual startup request is issued",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const grant = yield* f.voice.prepare(1, target);
      const source = { hostId: "local", generation: 1 };
      const before = f.events.length;
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/sdp",
        params: { threadId: target.threadId, sdp: "old-answer" },
      });
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/error",
        params: { threadId: target.threadId, message: "old-error" },
      });
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/closed",
        params: { threadId: target.threadId, reason: "old-close" },
      });
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/started",
        params: {
          threadId: target.threadId,
          realtimeSessionId: grant.realtimeSessionId,
          version: "v3",
        },
      });
      assert.strictEqual(f.events.length, before);
      yield* f.voice.reportMedia(1, grant.claimId, "connected");
      yield* f.voice.reportMedia(1, grant.claimId, "initialized");
      yield* f.voice.start(1, grant.claimId, "offer");
      assert.strictEqual(f.voice.readSession()?.phase, "starting");
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/sdp",
        params: { threadId: target.threadId, sdp: "current-answer" },
      });
      assert.isTrue(
        f.events.some(
          (event) =>
            event.type === "native" &&
            event.notification.method === "thread/realtime/sdp" &&
            event.notification.params.sdp === "current-answer",
        ),
      );
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/started",
        params: {
          threadId: target.threadId,
          realtimeSessionId: grant.realtimeSessionId,
          version: "v3",
        },
      });
      assert.strictEqual(f.voice.readSession()?.phase, "active");
    }).pipe(Effect.scoped),
);

it.effect("requires all four actual startup evidences and shares one native startup request", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const entered = yield* Deferred.make<void>();
    const accepted = yield* Deferred.make<unknown>();
    f.startWith(
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
    );
    const grant = yield* f.voice.prepare(1, target);
    const first = yield* f.voice.start(1, grant.claimId, "offer").pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const duplicate = yield* f.voice.start(1, grant.claimId, "same offer").pipe(Effect.forkChild);
    yield* f.voice.reportMedia(1, grant.claimId, "connected");
    yield* f.voice.reportMedia(1, grant.claimId, "initialized");
    yield* f.voice.observeNative(
      { hostId: "local", generation: 1 },
      {
        method: "thread/realtime/started",
        params: {
          threadId: "thread",
          realtimeSessionId: grant.realtimeSessionId,
          version: "v3",
        },
      },
    );
    assert.strictEqual(f.voice.readSession()?.phase, "starting");
    yield* Deferred.succeed(accepted, {});
    yield* Fiber.join(first);
    yield* Fiber.join(duplicate);
    assert.strictEqual(f.voice.readSession()?.phase, "active");
    assert.strictEqual(f.requests.length, 1);
    assert.deepEqual(f.requests[0]?.params, {
      version: "v3",
      outputModality: "audio",
      includeStartupContext: false,
      flushTranscriptTailOnSessionEnd: true,
      threadId: "thread",
      realtimeSessionId: grant.realtimeSessionId,
      voice: "arbor",
      transport: { type: "webrtc", sdp: "offer" },
    });
    assert.deepEqual(f.requests[0]?.scheduling, { expectedHostId: "local", expectedGeneration: 1 });
    assert.isTrue(
      yield* f.entities.admitExecution(
        "thread",
        { hostId: "local", generation: 1 },
        Effect.succeed(true),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("rejects a foreign renderer, host generation, and stale native session id", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    yield* f.voice.start(1, grant.claimId, "offer");
    yield* f.voice.reportMedia(1, grant.claimId, "connected");
    yield* f.voice.reportMedia(1, grant.claimId, "initialized");
    for (const source of [
      { hostId: "ssh", generation: 1 },
      { hostId: "local", generation: 2 },
    ])
      yield* f.voice.observeNative(source, {
        method: "thread/realtime/started",
        params: { threadId: "thread", realtimeSessionId: grant.realtimeSessionId, version: "v3" },
      });
    yield* f.voice.observeNative(
      { hostId: "local", generation: 1 },
      {
        method: "thread/realtime/started",
        params: { threadId: "thread", realtimeSessionId: "old", version: "v3" },
      },
    );
    assert.strictEqual(f.voice.readSession()?.phase, "starting");
    assert.strictEqual(
      (yield* f.voice.reportMedia(2, grant.claimId, "connected").pipe(Effect.result))._tag,
      "Failure",
    );
    f.replaceHost();
    yield* f.voice.observeNative(
      { hostId: "local", generation: 1 },
      { method: "thread/realtime/sdp", params: { threadId: "thread", sdp: "late" } },
    );
    assert.isFalse(f.events.some((event) => event.type === "native"));
  }).pipe(Effect.scoped),
);

it.effect(
  "restores the active controls on a failed stop and keeps late release away from the next claim",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const first = yield* f.voice.prepare(1, target);
      yield* f.voice.start(1, first.claimId, "offer");
      f.stopWith(Effect.fail(new Error("stop rejected")));
      assert.strictEqual(
        (yield* f.voice.stop(1, first.claimId).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.strictEqual(f.voice.readSession()?.phase, "starting");
      f.stopWith(Effect.succeed({}));
      yield* f.voice.stop(1, first.claimId);
      yield* f.voice.release(1, first.claimId);
      const next = yield* f.voice.prepare(1, target);
      assert.notStrictEqual(first.claimId, next.claimId);
      assert.isFalse(yield* f.voice.release(1, first.claimId));
      assert.strictEqual(f.microphone.readOwner()?.sessionId, next.claimId);
    }).pipe(Effect.scoped),
);

it.effect("cannot grant a disposed Voice caller after an actual delayed Dictation cleanup", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const requested = yield* Deferred.make<void>();
    f.microphone.acquireDictation(
      { kind: "dictation", webContentsId: 2, sessionId: "capturing", surface: "composer" },
      Deferred.succeed(requested, undefined).pipe(Effect.asVoid),
    );
    const preparing = yield* f.voice.prepare(1, target).pipe(Effect.forkChild);
    yield* Deferred.await(requested);
    yield* f.disposeClient(1);
    f.microphone.release(2, "capturing");
    assert.strictEqual((yield* Fiber.await(preparing))._tag, "Failure");
    assert.isNull(f.microphone.readOwner());
    assert.isNull(f.voice.readSession());
  }).pipe(Effect.scoped),
);

it.effect(
  "retires media authority with the captured native lifecycle without freeing its live tracks early",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const grant = yield* f.voice.prepare(1, target);
      yield* f.entities.retire("thread");
      assert.strictEqual(f.voice.readSession()?.phase, "stopping");
      assert.isTrue(
        f.events.some((event) => event.type === "terminate" && event.claimId === grant.claimId),
      );
      assert.strictEqual(f.microphone.readOwner()?.sessionId, grant.claimId);
      yield* f.voice.release(1, grant.claimId);
      assert.isNull(f.microphone.readOwner());
    }).pipe(Effect.scoped),
);

it.effect(
  "holds the claim until old native cleanup completes and rejects stale releases after a replacement",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const grant = yield* f.voice.prepare(1, target);
      yield* f.voice.start(1, grant.claimId, "offer");
      const entered = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<unknown>();
      f.stopWith(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(completed))),
      );
      const release = yield* f.voice.release(1, grant.claimId).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const duplicateCompleted = yield* Deferred.make<void>();
      const duplicate = yield* f.voice.release(1, grant.claimId).pipe(
        Effect.tap(() => Deferred.succeed(duplicateCompleted, undefined)),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      assert.isFalse(yield* Deferred.isDone(duplicateCompleted));
      assert.strictEqual((yield* f.voice.prepare(2, target).pipe(Effect.result))._tag, "Failure");
      assert.strictEqual(f.microphone.readOwner()?.sessionId, grant.claimId);
      yield* Deferred.succeed(completed, {});
      assert.isTrue(yield* Fiber.join(release));
      assert.isTrue(yield* Fiber.join(duplicate));
      assert.isTrue(yield* Deferred.isDone(duplicateCompleted));
      const next = yield* f.voice.prepare(2, target);
      assert.notStrictEqual(next.claimId, grant.claimId);
      assert.isFalse(yield* f.voice.release(1, grant.claimId));
      assert.strictEqual(f.microphone.readOwner()?.sessionId, next.claimId);
    }).pipe(Effect.scoped),
);

it.effect("cannot issue a queued native startup after the same attempt was stopped", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const entered = yield* Deferred.make<void>();
    const completed = yield* Deferred.make<void>();
    const occupied = yield* f.entities
      .admitExecution(
        "thread",
        { hostId: "local", generation: 1 },
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(completed))),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    const grant = yield* f.voice.prepare(1, target);
    const start = yield* f.voice
      .start(1, grant.claimId, "offer")
      .pipe(Effect.result, Effect.forkChild);
    yield* Effect.yieldNow;
    yield* f.voice.stop(1, grant.claimId);
    yield* Deferred.succeed(completed, undefined);
    yield* Fiber.join(occupied);
    assert.strictEqual((yield* Fiber.join(start))._tag, "Failure");
    assert.strictEqual(f.requests.length, 0);
  }).pipe(Effect.scoped),
);

it.effect(
  "broadcasts idle availability changes and retires revoked account access without freeing live media",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const ready: RealtimeVoiceProductPolicy = {
        status: "ready",
        accountId: "account",
        userId: "user",
        entryPoint: true,
        accessAllowed: true,
        clientOwnedCall: false,
        config: {},
        sessionConfig: {},
      };
      yield* f.publishPolicy(ready);
      for (let index = 0; index < 10; index++) yield* Effect.yieldNow;
      assert.isTrue(f.events.some((event) => event.type === "availabilityChanged"));
      assert.isNull(f.microphone.readOwner());
      const grant = yield* f.voice.prepare(1, target);
      yield* f.publishPolicy({ ...ready, accessAllowed: false });
      for (let index = 0; index < 20 && f.voice.readSession()?.phase !== "stopping"; index++)
        yield* Effect.yieldNow;
      assert.strictEqual(f.voice.readSession()?.phase, "stopping");
      assert.isTrue(
        f.events.some((event) => event.type === "terminate" && event.claimId === grant.claimId),
      );
      assert.strictEqual(f.microphone.readOwner()?.sessionId, grant.claimId);
      yield* f.voice.release(1, grant.claimId);
      assert.isNull(f.microphone.readOwner());
    }).pipe(Effect.scoped),
);

it.effect("forwards only changed microphone preferences to the current prepared claim", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    yield* f.changeMicrophone("selected-input");
    for (
      let index = 0;
      index < 20 && !f.events.some((event) => event.type === "microphoneChanged");
      index++
    )
      yield* Effect.yieldNow;
    assert.deepEqual(
      f.events.filter((event) => event.type === "microphoneChanged"),
      [{ type: "microphoneChanged", claimId: grant.claimId, deviceId: "selected-input" }],
    );
    yield* f.changeMicrophone("selected-input");
    for (let index = 0; index < 10; index++) yield* Effect.yieldNow;
    assert.strictEqual(f.events.filter((event) => event.type === "microphoneChanged").length, 1);
    yield* f.voice.release(1, grant.claimId);
    yield* f.changeMicrophone("later-input");
    for (let index = 0; index < 10; index++) yield* Effect.yieldNow;
    assert.strictEqual(f.events.filter((event) => event.type === "microphoneChanged").length, 1);
  }).pipe(Effect.scoped),
);

it.effect("broadcasts acquired and released claim changes without a policy update", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    assert.strictEqual(f.events.filter((event) => event.type === "availabilityChanged").length, 1);
    yield* f.voice.prepare(1, target);
    assert.strictEqual(f.events.filter((event) => event.type === "availabilityChanged").length, 1);
    yield* f.voice.release(1, grant.claimId);
    assert.strictEqual(f.events.filter((event) => event.type === "availabilityChanged").length, 2);
    assert.isNull(f.voice.readSession());
    yield* f.voice.release(1, grant.claimId);
    assert.strictEqual(f.events.filter((event) => event.type === "availabilityChanged").length, 2);
  }).pipe(Effect.scoped),
);

it.effect(
  "account retirement while ordinary stop is pending remains irreversible after the stop rejects",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const grant = yield* f.voice.prepare(1, target);
      yield* f.voice.start(1, grant.claimId, "offer");
      const entered = yield* Deferred.make<void>();
      const rejected = yield* Deferred.make<never, Error>();
      f.stopWith(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(rejected))),
      );
      const stop = yield* f.voice.stop(1, grant.claimId).pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(entered);
      yield* f.publishPolicy({
        status: "ready",
        accountId: "other-account",
        userId: "other-user",
        entryPoint: true,
        accessAllowed: true,
        clientOwnedCall: false,
        config: {},
        sessionConfig: {},
      });
      for (let index = 0; index < 20; index++) yield* Effect.yieldNow;
      const terminated = f.events.some(
        (event) => event.type === "terminate" && event.claimId === grant.claimId,
      );
      yield* Deferred.fail(rejected, new Error("stop rejected"));
      assert.strictEqual((yield* Fiber.join(stop))._tag, "Failure");
      f.stopWith(Effect.succeed({}));
      assert.isTrue(terminated);
      assert.strictEqual(f.voice.readSession()?.phase, "stopping");
      assert.strictEqual(
        (yield* f.voice.reportMedia(1, grant.claimId, "connected").pipe(Effect.result))._tag,
        "Failure",
      );
      yield* f.voice.release(1, grant.claimId);
      assert.isNull(f.microphone.readOwner());
    }).pipe(Effect.scoped),
);

it.effect("a replaced native generation cannot be restored by a rejected ordinary stop", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    yield* f.voice.start(1, grant.claimId, "offer");
    const entered = yield* Deferred.make<void>();
    const rejected = yield* Deferred.make<never, Error>();
    f.stopWith(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(rejected))));
    const stop = yield* f.voice.stop(1, grant.claimId).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(entered);
    f.replaceHost();
    yield* Deferred.fail(rejected, new Error("stop rejected"));
    assert.strictEqual((yield* Fiber.join(stop))._tag, "Failure");
    f.stopWith(Effect.succeed({}));
    assert.strictEqual(f.voice.readSession()?.phase, "stopping");
    assert.isTrue(
      f.events.some((event) => event.type === "terminate" && event.claimId === grant.claimId),
    );
    assert.strictEqual(
      (yield* f.voice.reportMedia(1, grant.claimId, "connected").pipe(Effect.result))._tag,
      "Failure",
    );
    yield* f.voice.release(1, grant.claimId);
    assert.isNull(f.microphone.readOwner());
  }).pipe(Effect.scoped),
);

it.effect(
  "a native missing Thread proof retires the call even while its resident canonical state remains",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const grant = yield* f.voice.prepare(1, target);
      yield* f.voice.start(1, grant.claimId, "offer");
      f.stopWith(
        Effect.fail(
          codexRuntimeError({
            operation: "request",
            reason: "request",
            retryable: false,
            hostId: "local",
            generation: 1,
            method: "thread/realtime/stop",
            cause: new CodexAppServerRequestError({
              method: "thread/realtime/stop",
              operation: "receive-response",
              code: -32600,
              errorMessage: "thread not found: thread",
            }),
          }),
        ),
      );
      assert.strictEqual(
        (yield* f.voice.stop(1, grant.claimId).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.isNotNull(f.entity.readCanonicalState());
      assert.strictEqual(f.voice.readSession()?.phase, "stopping");
      assert.isTrue(
        f.events.some((event) => event.type === "terminate" && event.claimId === grant.claimId),
      );
      const requests = f.requests.length;
      yield* f.voice.release(1, grant.claimId);
      assert.strictEqual(f.requests.length, requests);
      assert.isNull(f.microphone.readOwner());
    }).pipe(Effect.scoped),
);

it.effect("reads the Profile claim independently of another Thread's availability target", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const grant = yield* f.voice.prepare(1, target);
    assert.strictEqual(f.voice.readSession()?.claimId, grant.claimId);
    assert.strictEqual(
      (yield* f.voice.reportMedia(2, grant.claimId, "connected").pipe(Effect.result))._tag,
      "Failure",
    );
    yield* f.voice.release(1, grant.claimId);
    assert.isNull(f.voice.readSession());
  }).pipe(Effect.scoped),
);

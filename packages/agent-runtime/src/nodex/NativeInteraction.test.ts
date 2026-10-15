import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import type {
  CodexNativeInteraction,
  CodexNativeNotification,
} from "@t3tools/provider-core/server/nativeInteraction";
import { make } from "./NativeInteraction.ts";
import type { AgentPredictionInput, AgentRuntimeNotification } from "./Interface.ts";

const fixture = Effect.fnUntraced(function* () {
  const incoming = yield* PubSub.unbounded<CodexNativeNotification>();
  const lifecycle = yield* PubSub.unbounded<never>();
  const requests: Array<{ method: string; params: unknown }> = [];
  const commands: unknown[] = [];
  const cancelledInputs: string[] = [];
  let failNextDispatch = false;
  const notifications: AgentRuntimeNotification[] = [];
  let generation = 1;
  let opened = 0;
  let pins = 0;
  let forkAck: Effect.Effect<unknown> | null = null;
  let startAck: Effect.Effect<unknown> | null = null;
  let stopAck: Effect.Effect<unknown> | null = null;
  let featurePage = 0;
  let featurePages: Array<{
    data: Array<{ name: string; enabled: boolean }>;
    nextCursor: string | null;
  }> = [{ data: [], nextCursor: null }];
  let voiceEnabled = false;
  const helpers = new Set<string>();
  const publish = (method: string, params: unknown) =>
    PubSub.publish(incoming, { method, params }).pipe(Effect.asVoid);
  const native: CodexNativeInteraction = {
    initialize: Effect.succeed({ userAgent: "nodex/0.162.0-alpha.20" }),
    notifications: Stream.fromPubSub(incoming),
    inputs: Stream.fromPubSub(incoming).pipe(
      Stream.filter((event) => event.method === "item/started"),
      Stream.map((event) => {
        const params = event.params as {
          threadId: string;
          turnId: string;
          item: { content: Array<{ text: string }> };
        };
        return {
          nativeThreadId: params.threadId,
          nativeTurnId: params.turnId,
          text: params.item.content.map((part) => part.text).join("\n"),
        };
      }),
    ),
    retain: () =>
      Effect.sync(() => {
        pins++;
        let released = false;
        return Effect.sync(() => {
          if (!released) {
            released = true;
            pins--;
          }
        });
      }),
    hasPendingTurn: () => Effect.succeed(true),
    cancelPendingTurn: (_threadId, turnId) =>
      Effect.sync(() => {
        cancelledInputs.push(turnId);
      }),
    voice: (_id, enabled) =>
      Effect.sync(() => {
        voiceEnabled = enabled;
      }),
    helper: (id, active) =>
      Effect.sync(() => {
        if (active) helpers.add(id);
        else helpers.delete(id);
      }),
    request: (method, params) =>
      Effect.gen(function* () {
        requests.push({ method, params });
        if (method === "thread/realtime/listVoices")
          return { voices: { v1: ["arbor"], defaultV1: "arbor" } };
        if (method === "experimentalFeature/list")
          return featurePages[featurePage++] ?? { data: [], nextCursor: null };
        if (method === "thread/realtime/stop" && stopAck) return yield* stopAck;
        if (method === "thread/resume")
          return {
            model: "parent-model",
            modelProvider: "openai",
            collaborationMode: { mode: "default" },
            reasoningEffort: "high",
            serviceTier: "fast",
          };
        if (method === "thread/fork")
          return forkAck ? yield* forkAck : { thread: { id: "helper" } };
        if (method === "turn/start") {
          if (startAck) return yield* startAck;
          yield* publish("item/completed", {
            threadId: "helper",
            turnId: "prediction-turn",
            item: { type: "agentMessage", text: '{"suggestion":"Continue"}' },
          });
          yield* publish("turn/completed", {
            threadId: "helper",
            turn: { id: "prediction-turn", status: "completed" },
          });
          return { turn: { id: "prediction-turn" } };
        }
        return {};
      }) as never,
  };
  const thread = {
    id: "thread",
    lineage: { rootThreadId: "thread", parentThreadId: null, relationshipToParent: null },
    executionHandoff: null as { operationId: string; recoveryRequired: boolean } | null,
    activeProviderThreadId: "provider-thread",
    modelSelection: { instanceId: "codex", model: "parent-model" },
    archivedAt: null,
    deletedAt: null,
  };
  const providerThread = {
    id: "provider-thread",
    driver: "codex",
    providerInstanceId: "codex",
    providerSessionId: "session",
    nativeThreadRef: { nativeId: "native-thread" },
  };
  const runtime = {
    codexNative: native,
    nativeGeneration: generation,
    resumeThread: () => Effect.succeed(providerThread),
  };
  const api = yield* make("runtime-generation", (event) =>
    Effect.sync(() => {
      notifications.push(event);
    }),
  ).pipe(
    Effect.provideService(ProjectionStoreV2, {
      getThread: () => Effect.succeed(thread),
      getThreadShell: () => Effect.succeed({ latestRunId: "run", activeRunId: null }),
      getThreadRecords: (
        _id: unknown,
        _fields: unknown,
        filter: { providerThreadIds: string[] },
      ) => {
        assert.deepEqual(filter.providerThreadIds, ["provider-thread"]);
        return Effect.succeed({ thread, providerThreads: [providerThread] });
      },
      getHandoffHistory: (input: { budget: number }) => {
        assert.equal(input.budget, 8192);
        return Effect.succeed({
          history: { messages: [{ role: "user", text: "Bounded context" }], omittedItems: 0 },
        });
      },
      getNativeForkBoundary: (_id: unknown, runId: string) => {
        assert.equal(runId, "run");
        return Effect.succeed({
          providerThread,
          providerTurn: { nativeTurnRef: { nativeId: "source-turn" } },
          nativeIncarnationMatches: true,
        });
      },
    } as never),
    Effect.provideService(ProviderSessionManagerV2, {
      get: () => Effect.succeed(Option.some({ ...runtime, nativeGeneration: generation })),
      open: () => {
        opened++;
        return Effect.succeed({ ...runtime, nativeGeneration: generation });
      },
    } as never),
    Effect.provideService(RuntimePolicyV2, {
      resolve: () => Effect.succeed({ runtimeMode: "full-access" }),
    } as never),
    Effect.provideService(ThreadManagementService, {
      dispatch: (command: unknown) =>
        Effect.sync(() => {
          commands.push(command);
          const fail = failNextDispatch;
          failNextDispatch = false;
          return fail;
        }).pipe(
          Effect.flatMap((fail) =>
            fail ? Effect.fail(new Error("Rejected native input")) : Effect.succeed({}),
          ),
        ),
    } as never),
    Effect.provideService(EventSinkV2, {
      latestSequence: () => Effect.succeed(0),
      stream: () => Stream.fromPubSub(lifecycle),
    } as never),
  );
  return {
    api,
    requests,
    commands,
    cancelledInputs,
    rejectNextInput: () => {
      failNextDispatch = true;
    },
    notifications,
    publish,
    retire: () => {
      generation++;
    },
    holdWorkspace: () => {
      thread.executionHandoff = { operationId: "move", recoveryRequired: false };
    },
    pins: () => pins,
    opened: () => opened,
    helpers,
    voiceEnabled: () => voiceEnabled,
    forkAck: (effect: Effect.Effect<unknown>) => {
      forkAck = effect;
    },
    startAck: (effect: Effect.Effect<unknown>) => {
      startAck = effect;
    },
    stopAck: (effect: Effect.Effect<unknown>) => {
      stopAck = effect;
    },
    featurePages: (pages: typeof featurePages) => {
      featurePages = pages;
      featurePage = 0;
    },
  };
});
const prediction: AgentPredictionInput = {
  threadId: "thread",
  latestRunId: "run",
  generationTrigger: "live",
  configuration: { prompt: "Predict", prompt_version: "1", prediction_reasoning_effort: "low" },
};

it.effect("a workspace transaction retires native controls and refuses new voice acquisition", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const capture = yield* f.api.prepare({ threadId: "thread", claimId: "before-move" });
      const opened = f.opened();
      f.holdWorkspace();
      assert.isFalse(yield* f.api.current(capture.source));
      assert.equal(
        (yield* f.api.prepare({ threadId: "thread", claimId: "during-move" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(f.opened(), opened);
      yield* f.api.release("before-move");
      assert.equal(f.pins(), 0);
    }),
  ),
);

it.effect("retains exact voice source, adopts native input identity and rejects old controls", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const capture = yield* f.api.prepare({ threadId: "thread", claimId: "claim" });
      assert.equal(f.pins(), 1);
      yield* f.api.start({
        claimId: "claim",
        source: capture.source,
        settings: { outputModality: "audio" },
        sdp: "offer",
      });
      assert.isTrue(f.voiceEnabled());
      yield* f.publish("item/started", {
        threadId: "native-thread",
        turnId: "spoken-turn",
        item: { type: "userMessage", content: [{ type: "text", text: "Do the work" }] },
      });
      yield* Effect.yieldNow;
      yield* f.publish("item/started", {
        threadId: "native-thread",
        turnId: "spoken-turn",
        item: { type: "userMessage", content: [{ type: "text", text: "Do the work" }] },
      });
      for (let i = 0; i < 100 && f.commands.length < 2; i++) yield* Effect.yieldNow;
      assert.equal(f.commands.length, 2);
      const [first, retry] = f.commands as Array<{
        commandId: string;
        messageId: string;
        nativeInput: { nativeTurnId: string };
      }>;
      assert.equal(first!.commandId, retry!.commandId);
      assert.equal(first!.messageId, retry!.messageId);
      assert.equal(first!.nativeInput.nativeTurnId, "spoken-turn");
      assert.isFalse(f.requests.some((entry) => entry.method === "turn/start"));
      f.retire();
      const result = yield* f.api
        .appendSpeech({ claimId: "claim", source: capture.source, text: "stale" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      yield* f.api.release("claim");
      assert.equal(f.pins(), 0);
    }),
  ),
);

it.effect("keeps unsampled prediction cold and cached", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const input = {
        ...prediction,
        configuration: { ...prediction.configuration, sample_rate: 0 },
      };
      assert.isNull(yield* f.api.predict(input));
      assert.isNull(yield* f.api.predict(input));
      assert.equal(f.opened(), 0);
      assert.equal(f.requests.length, 0);
    }),
  ),
);

it.effect(
  "observes prediction completion before acknowledgement and retires helper resources",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        const result = (yield* f.api.predict(prediction)) as { text: string; sourceTurnId: string };
        assert.equal(result.text, "Continue");
        assert.equal(result.sourceTurnId, "run");
        assert.equal(f.pins(), 0);
        assert.equal(f.helpers.size, 0);
        assert.equal(f.requests.filter((entry) => entry.method === "turn/start").length, 1);
        assert.deepEqual(yield* f.api.predict(prediction), result);
        assert.equal(f.requests.filter((entry) => entry.method === "turn/start").length, 1);
      }),
    ),
);

it.effect("holds fork cleanup through a canceled physical acknowledgement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<unknown>();
      f.forkAck(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      );
      yield* f.api.predict(prediction).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const clear = yield* f.api.clearPredictions("thread").pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(f.pins(), 1);
      yield* Deferred.succeed(accepted, { thread: { id: "helper" } });
      yield* Fiber.join(clear);
      assert.isTrue(f.requests.some((entry) => entry.method === "thread/unsubscribe"));
      assert.isFalse(f.requests.some((entry) => entry.method === "turn/start"));
      assert.equal(f.pins(), 0);
    }),
  ),
);

it.effect("retains late Turn acknowledgement cleanup after logical cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const entered = yield* Deferred.make<void>();
      const accepted = yield* Deferred.make<unknown>();
      f.startAck(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
      );
      yield* f.api.predict(prediction).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* f.api.clearPredictions("thread");
      assert.equal(f.pins(), 1);
      assert.equal(f.helpers.size, 1);
      yield* Deferred.succeed(accepted, { turn: { id: "late-turn" } });
      for (let i = 0; i < 100 && f.pins() !== 0; i++) yield* Effect.yieldNow;
      assert.equal(f.pins(), 0);
      assert.equal(f.helpers.size, 0);
      assert.equal(f.requests.filter((entry) => entry.method === "turn/interrupt").length, 1);
    }),
  ),
);

it.effect("cannot reuse a prediction from a replaced native source", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.api.predict(prediction);
      f.retire();
      yield* f.api.predict(prediction);
      assert.equal(f.requests.filter((entry) => entry.method === "turn/start").length, 2);
    }),
  ),
);

it.effect("holds the Profile voice claim until old native cleanup finishes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      const capture = yield* f.api.prepare({ threadId: "thread", claimId: "old" });
      yield* f.api.start({ claimId: "old", source: capture.source, settings: {}, sdp: "offer" });
      const entered = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<unknown>();
      f.stopAck(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(stopped))));
      const release = yield* f.api.release("old").pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const replacement = yield* f.api
        .prepare({ threadId: "thread", claimId: "new" })
        .pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.equal(f.opened(), 1);
      assert.equal(
        (yield* f.api
          .appendSpeech({ claimId: "old", source: capture.source, text: "old" })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      yield* Deferred.succeed(stopped, {});
      yield* Fiber.join(release);
      yield* Fiber.join(replacement);
      assert.equal(f.pins(), 1);
      yield* f.api.release("old");
      assert.equal(f.pins(), 1);
      yield* f.api.release("new");
      assert.equal(f.pins(), 0);
    }),
  ),
);

it.effect("reads bounded native feature pages and rejects a repeated cursor", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture();
      f.featurePages([
        { data: [{ name: "other", enabled: false }], nextCursor: "next" },
        { data: [{ name: "realtime", enabled: true }], nextCursor: null },
      ]);
      assert.equal(
        (yield* f.api.prepare({ threadId: "thread", claimId: "claim" })).features.length,
        2,
      );
      yield* f.api.release("claim");
      f.featurePages([
        { data: [], nextCursor: "again" },
        { data: [], nextCursor: "again" },
      ]);
      assert.equal(
        (yield* f.api.prepare({ threadId: "thread", claimId: "bad" }).pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(f.pins(), 0);
    }),
  ),
);

it.effect(
  "retires a rejected native input while keeping the source available for the next input",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.api.prepare({ threadId: "thread", claimId: "claim" });
        f.rejectNextInput();
        for (const turnId of ["rejected", "accepted"]) {
          yield* f.publish("item/started", {
            threadId: "native-thread",
            turnId,
            item: { type: "userMessage", content: [{ type: "text", text: "Spoken input" }] },
          });
          for (let i = 0; i < 100 && f.commands.length < (turnId === "rejected" ? 1 : 2); i++)
            yield* Effect.yieldNow;
        }
        assert.equal(f.commands.length, 2);
        assert.deepEqual(f.cancelledInputs, ["rejected"]);
      }),
    ),
);

for (const output of ["delta", "completed"] as const) {
  it.effect(
    `rejects oversized prediction ${output} before a delayed Turn acknowledgement and cleans its accepted Turn`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const f = yield* fixture();
          const entered = yield* Deferred.make<void>();
          const accepted = yield* Deferred.make<unknown>();
          f.startAck(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(accepted))),
          );
          const predictionResult = yield* f.api
            .predict(prediction)
            .pipe(Effect.result, Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* f.publish(output === "delta" ? "item/agentMessage/delta" : "item/completed", {
            threadId: "helper",
            turnId: "late-turn",
            ...(output === "delta"
              ? { delta: "x".repeat(20000) }
              : { item: { type: "agentMessage", text: "x".repeat(20000) } }),
          });
          assert.equal((yield* Fiber.join(predictionResult))._tag, "Failure");
          assert.equal(f.pins(), 1);
          assert.equal(f.helpers.size, 1);
          for (let i = 0; i < 100; i++)
            yield* f.publish("item/agentMessage/delta", {
              threadId: "helper",
              turnId: "late-turn",
              delta: "x".repeat(20000),
            });
          yield* Deferred.succeed(accepted, { turn: { id: "late-turn" } });
          for (let i = 0; i < 100 && f.pins() !== 0; i++) yield* Effect.yieldNow;
          assert.equal(f.pins(), 0);
          assert.equal(f.helpers.size, 0);
          assert.equal(f.requests.filter((entry) => entry.method === "turn/interrupt").length, 1);
        }),
      ),
  );
}

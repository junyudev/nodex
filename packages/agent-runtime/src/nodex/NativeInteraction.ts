import { CommandId, MessageId, ProviderSessionId, RunId, ThreadId } from "@t3tools/contracts";
import type {
  CodexNativeInteraction,
  CodexNativeMethods,
} from "@t3tools/provider-core/server/nativeInteraction";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import { createHash } from "node:crypto";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type {
  AgentNativeSource,
  AgentPredictionInput,
  AgentRuntimeNotification,
  AgentVoiceCapture,
} from "./Interface.ts";

const fail = (message: string) => Effect.fail(new Error(message));
const voiceMethods = new Set([
  "thread/realtime/started",
  "thread/realtime/sdp",
  "thread/realtime/itemAdded",
  "thread/realtime/error",
  "thread/realtime/closed",
  "turn/completed",
]);

/** Owns finite native interactions on managed Sessions; no native process or transcript writer. */
export const make = Effect.fn("NativeInteraction.make")(function* (
  runtimeGeneration: string,
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
) {
  const store = yield* ProjectionStoreV2;
  const sessions = yield* ProviderSessionManagerV2;
  const policy = yield* RuntimePolicyV2;
  const threads = yield* ThreadManagementService;
  const events = yield* EventSinkV2;
  const observationCursor = yield* events.latestSequence();
  yield* events.stream({ eventType: "run.updated", afterSequence: observationCursor }).pipe(
    Stream.runForEach(({ event }) =>
      Effect.gen(function* () {
        if (
          event.type !== "run.updated" ||
          !event.payload.nativeInput ||
          !["cancelled", "interrupted", "failed", "rolled_back"].includes(event.payload.status)
        )
          return;
        const input = event.payload.nativeInput;
        if (input.runtimeGeneration !== runtimeGeneration) return;
        const runtime = yield* sessions.get(input.providerSessionId);
        if (Option.isNone(runtime) || runtime.value.nativeGeneration !== input.nativeGeneration)
          return;
        yield* (
          runtime.value.codexNative
            ?.cancelPendingTurn(input.nativeThreadId, input.nativeTurnId)
            .pipe(Effect.ignore) ?? Effect.void
        );
      }),
    ),
    Effect.forkScoped,
  );
  const owner = yield* Scope.Scope;
  const voicePermit = yield* Semaphore.make(1);
  const voices = new Map<
    string,
    {
      source: AgentNativeSource;
      native: CodexNativeInteraction;
      scope: Scope.Closeable;
      started: boolean;
      closing: boolean;
    }
  >();
  const nativeInputSources = new Set<string>();
  const predictions = new Map<
    string,
    { source: AgentNativeSource | null; fiber: Fiber.Fiber<unknown, Error> }
  >();
  for (const eventType of [
    "run.created",
    "thread.archived",
    "thread.deleted",
    "thread.provider-switched",
  ] as const) {
    yield* events.stream({ eventType, afterSequence: observationCursor }).pipe(
      Stream.runForEach(({ event }) =>
        Effect.gen(function* () {
          for (const [key, entry] of predictions) {
            if (JSON.parse(key)[0] !== event.threadId) continue;
            predictions.delete(key);
            yield* Fiber.interrupt(entry.fiber).pipe(Effect.forkIn(owner));
          }
          if (event.type === "run.created") return;
          for (const [claimId, voice] of voices)
            if (voice.source.threadId === event.threadId)
              yield* notify({ type: "native.voice.closed", claimId, source: voice.source });
        }),
      ),
      Effect.forkScoped,
    );
  }

  const current = Effect.fn("NativeInteraction.current")(function* (source: AgentNativeSource) {
    if (source.runtimeGeneration !== runtimeGeneration) return false;
    const runtime = yield* sessions.get(ProviderSessionId.make(source.providerSessionId));
    if (Option.isNone(runtime) || runtime.value.nativeGeneration !== source.nativeGeneration)
      return false;
    const thread = yield* store.getThread(ThreadId.make(source.threadId));
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.activeProviderThreadId !== source.providerThreadId
    )
      return false;
    const rows = yield* store.getThreadRecords(thread.id, ["providerThreads"], {
      providerThreadIds: [source.providerThreadId as never],
    });
    return rows.providerThreads.some(
      (row) =>
        row.providerSessionId === source.providerSessionId &&
        row.nativeThreadRef?.nativeId === source.nativeThreadId,
    );
  });
  const assertCurrent = (source: AgentNativeSource) =>
    current(source).pipe(
      Effect.flatMap((live) => (live ? Effect.void : fail("Native source retired"))),
    );
  const resolve = Effect.fn("NativeInteraction.resolve")(function* (threadId: string) {
    const thread = yield* store.getThread(ThreadId.make(threadId));
    if (thread.deletedAt || thread.archivedAt || !thread.activeProviderThreadId)
      return yield* fail("Native thread is unavailable");
    const rows = yield* store.getThreadRecords(thread.id, ["providerThreads"], {
      providerThreadIds: [thread.activeProviderThreadId],
    });
    const providerThread = rows.providerThreads[0];
    if (
      !providerThread?.providerSessionId ||
      providerThread.driver !== "codex" ||
      providerThread.providerInstanceId !== thread.modelSelection.instanceId ||
      !providerThread.nativeThreadRef?.nativeId
    )
      return yield* fail("Native Codex thread is unavailable");
    const runtimePolicy = yield* policy.resolve({ thread, modelSelection: thread.modelSelection });
    const runtime = yield* sessions.open({
      threadId: thread.id,
      providerSessionId: providerThread.providerSessionId,
      modelSelection: thread.modelSelection,
      runtimePolicy,
      initialNativeThreadId: providerThread.nativeThreadRef.nativeId,
    });
    if (!runtime.codexNative || runtime.nativeGeneration === undefined)
      return yield* fail("Native interactions are unsupported");
    yield* runtime.resumeThread({
      threadId: thread.id,
      providerThread,
      modelSelection: thread.modelSelection,
      runtimePolicy,
    });
    const initialized = yield* runtime.codexNative.initialize;
    const source: AgentNativeSource = {
      runtimeGeneration,
      threadId,
      providerSessionId: providerThread.providerSessionId,
      nativeGeneration: runtime.nativeGeneration,
      providerThreadId: providerThread.id,
      nativeThreadId: providerThread.nativeThreadRef.nativeId,
    };
    yield* assertCurrent(source);
    return { source, native: runtime.codexNative, thread, userAgent: initialized.userAgent };
  });
  const voice = Effect.fn("NativeInteraction.voice")(function* (
    claimId: string,
    source: AgentNativeSource,
  ) {
    const entry = voices.get(claimId);
    if (!entry || entry.closing || JSON.stringify(entry.source) !== JSON.stringify(source))
      return yield* fail("Voice claim retired");
    yield* assertCurrent(source);
    return entry;
  });
  const closeClaim = Effect.fn("NativeInteraction.closeVoice")(function* (claimId: string) {
    const entry = voices.get(claimId);
    if (!entry) return;
    entry.closing = true;
    yield* Scope.close(entry.scope, Exit.void).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (voices.get(claimId) === entry) voices.delete(claimId);
        }),
      ),
    );
  });
  const release = (claimId: string) => voicePermit.withPermit(closeClaim(claimId));
  yield* Effect.addFinalizer(() => Effect.forEach([...voices.keys()], release, { discard: true }));

  const prepareClaim = Effect.fn("NativeInteraction.prepareVoice")(function* (input: {
    threadId: string;
    claimId: string;
  }) {
    if (voices.size > 0) return yield* fail("Voice is already active");
    const resolved = yield* resolve(input.threadId);
    const scope = yield* Scope.fork(owner, "sequential");
    const entry = {
      source: resolved.source,
      native: resolved.native,
      scope,
      started: false,
      closing: false,
    };
    voices.set(input.claimId, entry);
    const acquire = Effect.gen(function* () {
      const releasePin = yield* resolved.native.retain(resolved.source.nativeThreadId);
      yield* Scope.addFinalizer(scope, releasePin);
      yield* Scope.addFinalizer(
        scope,
        resolved.native.voice(resolved.source.nativeThreadId, false),
      );
      yield* Scope.addFinalizer(
        scope,
        Effect.suspend(() =>
          entry.started
            ? entry.native
                .request("thread/realtime/stop", { threadId: entry.source.nativeThreadId })
                .pipe(Effect.ignore)
            : Effect.void,
        ),
      );
      const sourceKey = JSON.stringify(resolved.source);
      if (!nativeInputSources.has(sourceKey)) {
        nativeInputSources.add(sourceKey);
        yield* resolved.native.inputs.pipe(
          Stream.runForEach(({ nativeThreadId, nativeTurnId, text }) =>
            Effect.gen(function* () {
              if (
                nativeThreadId !== resolved.source.nativeThreadId ||
                !(yield* current(resolved.source)) ||
                !(yield* resolved.native.hasPendingTurn(nativeThreadId, nativeTurnId))
              )
                return;
              const identity = createHash("sha256")
                .update(
                  JSON.stringify([
                    resolved.source.runtimeGeneration,
                    resolved.source.providerSessionId,
                    resolved.source.nativeGeneration,
                    resolved.source.nativeThreadId,
                    nativeTurnId,
                  ]),
                )
                .digest("hex");
              yield* threads
                .dispatch({
                  type: "message.dispatch",
                  threadId: resolved.thread.id,
                  commandId: CommandId.make(`native-input:${identity}`),
                  messageId: MessageId.make(`native-input:${identity}`),
                  text,
                  attachments: [],
                  modelSelection: resolved.thread.modelSelection,
                  dispatchMode: { type: "queue_after_active" },
                  createdBy: "user",
                  creationSource: "web",
                  nativeInput: {
                    runtimeGeneration,
                    providerSessionId: resolved.source.providerSessionId as never,
                    nativeGeneration: resolved.source.nativeGeneration,
                    nativeThreadId: resolved.source.nativeThreadId,
                    nativeTurnId: nativeTurnId,
                  },
                })
                .pipe(
                  Effect.onError(() =>
                    resolved.native
                      .cancelPendingTurn(resolved.source.nativeThreadId, nativeTurnId)
                      .pipe(Effect.ignore),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("Native input admission failed", { cause }),
                  ),
                );
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              nativeInputSources.delete(sourceKey);
            }),
          ),
          Effect.catch((cause) => Effect.logWarning("Native input source retired", { cause })),
          Effect.forkIn(owner, { startImmediately: true }),
        );
      }
      yield* resolved.native.notifications.pipe(
        Stream.filter((event) => voiceMethods.has(event.method)),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            const params = event.params as { threadId?: string };
            if (
              params.threadId !== resolved.source.nativeThreadId ||
              !(yield* current(resolved.source))
            )
              return;
            yield* notify({
              type: "native.voice.event",
              claimId: input.claimId,
              source: resolved.source,
              notification: { method: event.method, params: event.params },
            });
          }),
        ),
        Effect.ensuring(
          notify({ type: "native.voice.closed", claimId: input.claimId, source: resolved.source }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      );
      const voices = yield* resolved.native.request("thread/realtime/listVoices", {});
      const features: Array<{ name: string; enabled: boolean }> = [];
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let page = 0; page < 8; page++) {
        const result: CodexNativeMethods["experimentalFeature/list"][1] =
          yield* resolved.native.request("experimentalFeature/list", { cursor, limit: 100 });
        features.push(...result.data.map(({ name, enabled }) => ({ name, enabled })));
        if (result.nextCursor === null) break;
        if (cursors.has(result.nextCursor) || page === 7)
          return yield* fail("Native feature catalog exceeded its bounded page range");
        cursors.add(result.nextCursor);
        cursor = result.nextCursor;
      }
      const history = yield* store.getHandoffHistory({
        threadId: resolved.thread.id,
        budget: 8192,
      });
      yield* assertCurrent(resolved.source);
      return {
        source: resolved.source,
        userAgent: resolved.userAgent,
        voices: voices.voices,
        features,
        history: history.history.messages.map(({ role, text }) => ({ role, text })),
      } satisfies AgentVoiceCapture;
    });
    return yield* acquire.pipe(Effect.onError(() => closeClaim(input.claimId)));
  });
  const prepare = (input: { threadId: string; claimId: string }) =>
    voicePermit.withPermit(prepareClaim(input));

  const predict = Effect.fn("NativeInteraction.predict")(function* (input: AgentPredictionInput) {
    const key = JSON.stringify([input.threadId, input.latestRunId]);
    const existing = predictions.get(key);
    if (
      existing &&
      (existing.source === null ||
        ((yield* current(existing.source)) &&
          (yield* store.getThreadShell(ThreadId.make(input.threadId)))?.latestRunId ===
            input.latestRunId))
    )
      return yield* Fiber.join(existing.fiber);
    if (existing) yield* Fiber.interrupt(existing.fiber);
    for (const [oldKey, entry] of predictions)
      if (oldKey.startsWith(JSON.stringify([input.threadId]).slice(0, -1) + ",")) {
        predictions.delete(oldKey);
        yield* Fiber.interrupt(entry.fiber);
      }
    let source: AgentNativeSource | null = null;
    const run = Effect.gen(function* () {
      const startedAt = Date.now();
      const rate =
        input.generationTrigger === "live"
          ? input.configuration.live_sample_rate
          : input.configuration.catch_up_sample_rate;
      if ((yield* Random.next) >= (rate ?? input.configuration.sample_rate ?? 1)) return null;
      const resolved = yield* resolve(input.threadId);
      source = resolved.source;
      const shell = yield* store.getThreadShell(resolved.thread.id);
      if (shell?.latestRunId !== input.latestRunId || shell.activeRunId !== null) return null;
      const boundary = yield* store.getNativeForkBoundary(
        resolved.thread.id,
        RunId.make(input.latestRunId),
      );
      if (
        !boundary.nativeIncarnationMatches ||
        boundary.providerThread?.nativeThreadRef?.nativeId !== source.nativeThreadId ||
        !boundary.providerTurn?.nativeTurnRef
      )
        return null;
      const parent = yield* resolved.native.request("thread/resume", {
        threadId: source.nativeThreadId,
        excludeTurns: true,
      });
      if (
        parent.collaborationMode?.mode === "plan" ||
        parent.modelProvider !== "openai" ||
        input.configuration.unsupported_models?.includes(parent.model)
      )
        return null;
      const version = /^[^/();\r\n]+\/v?([^\s;)]+)/u.exec(resolved.userAgent)?.[1];
      if (
        version !== "0.162.0-alpha.17.2" &&
        (!version ||
          !parseSemver(version) ||
          compareSemverVersions(version, "0.162.0-alpha.20") < 0)
      )
        return null;
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const releasePin = yield* resolved.native.retain(source!.nativeThreadId);
          yield* Effect.addFinalizer(() => releasePin);
          const helperState = { ackPending: false, cancelled: false };
          const fork = yield* Effect.acquireRelease(
            resolved.native.request("thread/fork", {
              threadId: source!.nativeThreadId,
              experimentalPredictionMode: true,
              ephemeral: true,
              excludeTurns: true,
              threadSource: "composer_predictions",
            }),
            (fork) =>
              resolved.native
                .request("thread/unsubscribe", { threadId: fork.thread.id })
                .pipe(
                  Effect.ignore,
                  Effect.ensuring(
                    Effect.suspend(() =>
                      helperState.ackPending
                        ? Effect.void
                        : resolved.native.helper(fork.thread.id, false),
                    ),
                  ),
                ),
          );
          yield* resolved.native.helper(fork.thread.id, true);
          yield* assertCurrent(source!);
          const completed = yield* Deferred.make<unknown, Error>();
          let turnId: string | null = null;
          let cancelled = false;
          let interrupted = false;
          let done = false;
          let text = "";
          let textBytes = 0;
          let outputFailed = false;
          let tokens: { inputTokens: number; cachedInputTokens: number } | null = null;
          const interrupt = Effect.suspend(() => {
            if (turnId === null || interrupted || done) return Effect.void;
            interrupted = true;
            return resolved.native
              .request("turn/interrupt", { threadId: fork.thread.id, turnId })
              .pipe(Effect.ignore);
          });
          yield* Effect.addFinalizer(() => {
            cancelled = true;
            helperState.cancelled = true;
            return interrupt;
          });
          yield* resolved.native.notifications.pipe(
            Stream.runForEach((event) =>
              Effect.gen(function* () {
                const p = event.params as {
                  threadId?: string;
                  turnId?: string;
                  delta?: string;
                  item?: { type: string; text?: string };
                  turn?: { id: string; status: string };
                  tokenUsage?: { last: typeof tokens };
                };
                if (
                  outputFailed ||
                  p.threadId !== fork.thread.id ||
                  (p.turnId && turnId && p.turnId !== turnId)
                )
                  return;
                if (event.method === "turn/started") turnId = p.turn!.id;
                if (event.method === "item/agentMessage/delta") {
                  const delta = p.delta ?? "";
                  const deltaBytes = Buffer.byteLength(delta);
                  if (textBytes + deltaBytes > 16384) {
                    outputFailed = true;
                    return yield* Deferred.fail(
                      completed,
                      new Error("Prediction output exceeded its budget"),
                    );
                  }
                  text += delta;
                  textBytes += deltaBytes;
                }
                if (event.method === "item/completed" && p.item?.type === "agentMessage") {
                  const itemBytes = Buffer.byteLength(p.item.text ?? "");
                  if (itemBytes > 16384) {
                    outputFailed = true;
                    return yield* Deferred.fail(
                      completed,
                      new Error("Prediction output exceeded its budget"),
                    );
                  }
                  text = p.item.text ?? "";
                  textBytes = itemBytes;
                }
                if (event.method === "thread/tokenUsage/updated")
                  tokens = p.tokenUsage?.last ?? null;
                if (event.method !== "turn/completed") return;
                done = true;
                if (p.turn?.status !== "completed")
                  return yield* Deferred.fail(completed, new Error("Prediction Turn failed"));
                yield* assertCurrent(source!);
                const parsed = yield* Effect.try(() => JSON.parse(text) as { suggestion: unknown });
                if (parsed.suggestion !== null && typeof parsed.suggestion !== "string")
                  return yield* Deferred.fail(completed, new Error("Invalid prediction output"));
                yield* Deferred.succeed(completed, {
                  requestedAt: new Date().toISOString(),
                  text:
                    typeof parsed.suggestion === "string" ? parsed.suggestion.trim() || null : null,
                  predictionThreadId: fork.thread.id,
                  predictionTurnId: p.turn.id,
                  sourceTurnId: input.latestRunId,
                  generationTrigger: input.generationTrigger,
                  model: parent.model,
                  reasoningEffort:
                    input.configuration.prediction_reasoning_effort || parent.reasoningEffort,
                  serviceTier: parent.serviceTier,
                  parentReasoningEffort: parent.reasoningEffort,
                  configuredReasoningEffort:
                    input.configuration.prediction_reasoning_effort || null,
                  promptVersion: input.configuration.prompt_version,
                  totalDurationMs: Date.now() - startedAt,
                  inputTokens: tokens?.inputTokens ?? null,
                  cachedInputTokens: tokens?.cachedInputTokens ?? null,
                });
              }),
            ),
            Effect.catch((cause) =>
              Deferred.fail(completed, cause instanceof Error ? cause : new Error(String(cause))),
            ),
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          helperState.ackPending = true;
          const ack = yield* Effect.acquireUseRelease(
            resolved.native.retain(source!.nativeThreadId),
            () =>
              resolved.native
                .request("turn/start", {
                  threadId: fork.thread.id,
                  clientUserMessageId: `prediction:${input.latestRunId}`,
                  input: [
                    {
                      type: "text",
                      text: `${input.configuration.prompt}\nReturn only JSON: {"suggestion":string|null}`,
                      text_elements: [],
                    },
                  ],
                  turnTrigger: "composer_predictions",
                  effort: input.configuration.prediction_reasoning_effort as never,
                })
                .pipe(
                  Effect.tap((result) => {
                    turnId = result.turn.id;
                    return cancelled ? interrupt : assertCurrent(source!);
                  }),
                ),
            (release) => release,
          ).pipe(
            Effect.ensuring(
              Effect.suspend(() => {
                helperState.ackPending = false;
                return helperState.cancelled
                  ? resolved.native.helper(fork.thread.id, false)
                  : Effect.void;
              }),
            ),
            Effect.forkIn(owner, { startImmediately: true }),
          );
          return yield* Effect.all(
            { ack: Fiber.join(ack), result: Deferred.await(completed) },
            { concurrency: "unbounded" },
          ).pipe(
            Effect.map(({ result }) => result),
            Effect.timeout("30 seconds"),
          );
        }),
      );
    });
    const entry: { source: AgentNativeSource | null; fiber: Fiber.Fiber<unknown, Error> } = {
      source,
      fiber: yield* run.pipe(
        Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
        Effect.onExit((exit) => {
          if (Exit.isFailure(exit)) predictions.delete(key);
          return Effect.void;
        }),
        Effect.forkIn(owner, { startImmediately: false }),
      ),
    };
    predictions.set(key, entry);
    // Source is captured during the owned inference, not when constructing a lazy Effect.
    const result = yield* Fiber.join(entry.fiber).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          entry.source = source;
        }),
      ),
    );
    return result;
  });
  return {
    prepare,
    current,
    start: Effect.fn("NativeInteraction.startVoice")(function* (input: {
      claimId: string;
      source: AgentNativeSource;
      settings: unknown;
      sdp: string;
    }) {
      const entry = yield* voice(input.claimId, input.source);
      entry.started = true;
      yield* entry.native.voice(input.source.nativeThreadId, true);
      yield* entry.native.request("thread/realtime/start", {
        ...(input.settings as object),
        threadId: input.source.nativeThreadId,
        realtimeSessionId: input.claimId,
        transport: { type: "webrtc", sdp: input.sdp },
      } as never);
      yield* assertCurrent(input.source);
    }),
    stop: Effect.fn("NativeInteraction.stopVoice")(function* (input: {
      claimId: string;
      source: AgentNativeSource;
    }) {
      const entry = yield* voice(input.claimId, input.source);
      yield* entry.native.request("thread/realtime/stop", {
        threadId: input.source.nativeThreadId,
      });
      entry.started = false;
    }),
    appendText: Effect.fn("NativeInteraction.appendText")(function* (input: {
      claimId: string;
      source: AgentNativeSource;
      role: string;
      text: string;
    }) {
      const entry = yield* voice(input.claimId, input.source);
      yield* entry.native.request("thread/realtime/appendText", {
        threadId: input.source.nativeThreadId,
        role: input.role,
        text: input.text,
      } as never);
      yield* assertCurrent(input.source);
    }),
    appendSpeech: Effect.fn("NativeInteraction.appendSpeech")(function* (input: {
      claimId: string;
      source: AgentNativeSource;
      text: string;
    }) {
      const entry = yield* voice(input.claimId, input.source);
      yield* entry.native.request("thread/realtime/appendSpeech", {
        threadId: input.source.nativeThreadId,
        text: input.text,
      });
      yield* assertCurrent(input.source);
    }),
    inject: Effect.fn("NativeInteraction.inject")(function* (input: {
      claimId: string;
      source: AgentNativeSource;
      items: unknown;
    }) {
      const entry = yield* voice(input.claimId, input.source);
      yield* entry.native.request("thread/inject_items", {
        threadId: input.source.nativeThreadId,
        items: input.items,
      } as never);
      yield* assertCurrent(input.source);
    }),
    release,
    predict,
    clearPredictions: (threadId?: string) =>
      Effect.forEach(
        [...predictions].filter(([key]) => !threadId || JSON.parse(key)[0] === threadId),
        ([key, entry]) => {
          predictions.delete(key);
          return Fiber.interrupt(entry.fiber);
        },
        { discard: true },
      ),
  };
});

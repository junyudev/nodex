import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { assert, it } from "@effect/vitest";
import { DEFAULT_DICTATION_SETTINGS } from "../../shared/dictation";
import {
  DictationDictionaryAddSchema,
  DictationDictionaryImportSchema,
} from "../../shared/dictation-dictionary";
import type { ChatGptDesktopRequestInput } from "../codex/chatgpt-desktop-request";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { DictationRuntime } from "../host-runtime/DictationRuntime";
import { ChatGptDesktop, ChatGptDesktopAuthError } from "./ChatGptDesktop";
import { CodexMedia } from "./CodexMedia";
import { DictationDictionary, live } from "./DictationDictionary";
import type { CodexCanonicalItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import { EMPTY_REALTIME_VOICE_PRODUCT_POLICY } from "../dictation/RealtimeVoicePolicyState";
import {
  DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS,
  resolveRealtimeVoiceStartSettings,
  resolveSupportedRealtimeVoice,
  buildRealtimeVoiceInitialItems,
} from "./CodexRealtimeVoiceConfiguration";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import {
  AgentRuntimeApplication,
  type AgentRuntimeApplicationConnection,
} from "../agent-runtime/AgentRuntimeApplication";
import type { AgentRuntimeProcessDelivery } from "../platform/node/AgentRuntimeProcess";
import { captureVoice } from "./CodexRuntimeNative";

describe("DictationDictionary", () => {
  const target = { accountId: "account-a", userId: "user-a" };
  const operationId = "11111111-1111-4111-8111-111111111111";
  const token = (accountId: string, userId: string) =>
    `header.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: userId } })).toString("base64url")}.signature`;
  const makeHarness = (
    respond: (
      input: ChatGptDesktopRequestInput,
    ) => Effect.Effect<Response, ChatGptDesktopAuthError>,
  ) => {
    const state = {
      identity: target,
      enabled: true,
      local: ["Nodex", "Effect"],
      requests: [] as ChatGptDesktopRequestInput[],
    };
    const layer = live.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            ChatGptDesktop,
            ChatGptDesktop.of({
              prepareRequest: () => Effect.die("unused"),
              authStatus: () =>
                Effect.sync(() => ({
                  authMethod: "chatgpt",
                  authToken: token(state.identity.accountId, state.identity.userId),
                  requiresOpenaiAuth: true,
                })),
              authMethod: Effect.succeed("chatgpt"),
              request: (input) =>
                Effect.sync(() => state.requests.push(input)).pipe(Effect.andThen(respond(input))),
            }),
          ),
          Layer.succeed(CodexGateway, {
            requestLocal: () =>
              Effect.succeed({ config: { chatgpt_base_url: "https://chatgpt.test" } }),
          } as unknown as CodexGateway["Service"]),
          Layer.succeed(CodexMedia, {
            dictationPolicySnapshot: Effect.sync(() => ({
              ...target,
              voiceDictionary: state.enabled,
            })),
          } as unknown as CodexMedia["Service"]),
          Layer.succeed(DictationRuntime, {
            readSettings: Effect.sync(() => ({
              ...DEFAULT_DICTATION_SETTINGS,
              dictionary: [...state.local],
            })),
            updateSettings: (patch: import("../../shared/dictation").DictationSettingsPatch) =>
              Effect.sync(() => {
                state.local = [...(patch.dictionary ?? state.local)];
                return { ...DEFAULT_DICTATION_SETTINGS, dictionary: state.local };
              }),
          } as unknown as DictationRuntime["Service"]),
        ),
      ),
    );
    return { state, layer };
  };

  it.effect(
    "captures the account, clamps capacity, deduplicates device words, and supplies both account fences",
    () => {
      const harness = makeHarness(() =>
        Effect.succeed(Response.json({ words: [{ id: "1", text: "Nodex" }], max_words: 500 })),
      );
      harness.state.local = ["Nodex", "Nodex", "Effect"];
      return Effect.gen(function* () {
        const dictionary = yield* DictationDictionary;
        const value = yield* dictionary.read({ operationId });
        assert.deepStrictEqual(value, {
          target,
          words: [{ id: "1", text: "Nodex" }],
          maxWords: 200,
          localWords: ["Nodex", "Effect"],
        });
        assert.deepStrictEqual(harness.state.requests[0]?.expectedAccount, target);
        assert.equal(
          new Headers(harness.state.requests[0]?.headers).get("ChatGPT-Account-ID"),
          "account-a",
        );
        assert.equal(
          new Headers(harness.state.requests[0]?.headers).get("X-OpenAI-Expected-Account-Id"),
          "account-a",
        );
        // this test owns the complete dictionary application layer.
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "rejects a same-user workspace switch and a disabled dictionary before any request",
    () => {
      const harness = makeHarness(() => Effect.succeed(new Response(null, { status: 204 })));
      return Effect.gen(function* () {
        const dictionary = yield* DictationDictionary;
        harness.state.identity = { ...target, accountId: "account-b" };
        const changed = yield* dictionary
          .add({ operationId, target, text: "Nodex" })
          .pipe(Effect.flip);
        assert.equal(changed.errorCode, "account_changed");
        harness.state.identity = target;
        harness.state.enabled = false;
        assert.isTrue(Exit.isFailure(yield* dictionary.read({ operationId }).pipe(Effect.exit)));
        assert.equal(harness.state.requests.length, 0);
        // this test owns the complete dictionary application layer.
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "imports sequentially, accepts duplicate conflicts, and removes only selected current local entries",
    () => {
      let index = 0;
      const harness = makeHarness(() =>
        Effect.sync(() => {
          index++;
          if (index === 1) return Response.json({ error: { code: "duplicate" } }, { status: 409 });
          harness.state.local.push("added while uploading");
          return new Response(null, { status: 204 });
        }),
      );
      return Effect.gen(function* () {
        const dictionary = yield* DictationDictionary;
        yield* dictionary.importWords({ operationId, target, words: ["Nodex", "Nodex", "Effect"] });
        assert.deepStrictEqual(
          harness.state.requests.map((request) => JSON.parse(String(request.body))),
          [{ text: "Nodex" }, { text: "Effect" }],
        );
        assert.deepStrictEqual(harness.state.local, ["added while uploading"]);
        // this test owns the complete dictionary application layer.
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect(
    "does not treat account_changed as a duplicate or clear local words after a partial import",
    () => {
      let index = 0;
      const harness = makeHarness(() =>
        Effect.sync(() =>
          ++index === 1
            ? new Response(null, { status: 204 })
            : Response.json({ detail: { code: "account_changed" } }, { status: 409 }),
        ),
      );
      return Effect.gen(function* () {
        const dictionary = yield* DictationDictionary;
        const error = yield* dictionary
          .importWords({ operationId, target, words: ["Nodex", "Effect", "later"] })
          .pipe(Effect.flip);
        assert.equal(error.errorCode, "account_changed");
        assert.equal(harness.state.requests.length, 2);
        assert.deepStrictEqual(harness.state.local, ["Nodex", "Effect"]);
        // this test owns the complete dictionary application layer.
      }).pipe(Effect.provide(harness.layer));
    },
  );

  it.effect("aborts pending imports without clearing device words or submitting later words", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const harness = makeHarness((input) =>
        Effect.tryPromise({
          try: () =>
            new Promise<Response>((_resolve, reject) => {
              if (input.signal!.aborted) {
                reject(new Error("aborted"));
                return;
              }
              input.signal!.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
              Deferred.doneUnsafe(entered, Effect.void);
            }),
          catch: () => new ChatGptDesktopAuthError({ message: "aborted" }),
        }),
      );
      yield* Effect.gen(function* () {
        const dictionary = yield* DictationDictionary;
        const request = yield* dictionary
          .importWords({ operationId, target, words: ["Nodex", "Effect"] })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        assert.isTrue(yield* dictionary.cancel(operationId));
        assert.isTrue(Exit.isFailure(yield* Fiber.await(request)));
        assert.deepStrictEqual(harness.state.local, ["Nodex", "Effect"]);
        assert.equal(harness.state.requests.length, 1);
        assert.isFalse(yield* dictionary.cancel(operationId));
        // this test owns the complete dictionary application layer.
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("rejects stale responses after account drift and escapes delete identifiers", () => {
    const harness = makeHarness(() =>
      Effect.sync(() => {
        harness.state.identity = { ...target, userId: "user-b" };
        return new Response(null, { status: 204 });
      }),
    );
    return Effect.gen(function* () {
      const dictionary = yield* DictationDictionary;
      const error = yield* dictionary
        .remove({ operationId, target, wordId: "a/b?#" })
        .pipe(Effect.flip);
      assert.equal(error.errorCode, "account_changed");
      assert.equal(
        harness.state.requests[0]?.path,
        "/dictation/custom_dictionary/words/a%2Fb%3F%23",
      );
      // this test owns the complete dictionary application layer.
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("reports an HTTP failure even when the service omits its optional error code", () => {
    const harness = makeHarness(() => Effect.succeed(new Response("unavailable", { status: 503 })));
    return Effect.gen(function* () {
      const dictionary = yield* DictationDictionary;
      const error = yield* dictionary.add({ operationId, target, text: "Nodex" }).pipe(Effect.flip);
      assert.equal(error.status, 503);
      assert.isUndefined(error.errorCode);
      // this test owns the complete dictionary application layer.
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect(
    "rejects duplicate operations and releases their network lease on caller interruption",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const harness = makeHarness(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        );
        yield* Effect.gen(function* () {
          const dictionary = yield* DictationDictionary;
          const request = yield* dictionary
            .importWords({ operationId, target, words: ["Nodex", "Effect"] })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const duplicate = yield* dictionary
            .add({ operationId, target, text: "other" })
            .pipe(Effect.flip);
          assert.equal(duplicate.message, "Voice dictionary request is already running");
          assert.equal(harness.state.requests.length, 1);
          yield* Fiber.interrupt(request);
          assert.isTrue(harness.state.requests[0]!.signal!.aborted);
          assert.isFalse(yield* dictionary.cancel(operationId));
          assert.deepStrictEqual(harness.state.local, ["Nodex", "Effect"]);
          // this test owns the complete dictionary application layer.
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it("validates new words at 100 characters while preserving legacy imported text exactly", () => {
    assert.equal(
      DictationDictionaryAddSchema.parse({ operationId, target, text: ` ${"a".repeat(100)} ` }).text
        .length,
      100,
    );
    assert.isFalse(
      DictationDictionaryAddSchema.safeParse({ operationId, target, text: "a".repeat(101) })
        .success,
    );
    const words = ["  exact  ", "a".repeat(512)];
    assert.deepStrictEqual(
      DictationDictionaryImportSchema.parse({ operationId, target, words }).words,
      words,
    );
  });
});

describe("CodexRealtimeVoiceConfiguration", () => {
  const settings = (config: Record<string, unknown>, sessionConfig: Record<string, unknown> = {}) =>
    resolveRealtimeVoiceStartSettings({
      ...EMPTY_REALTIME_VOICE_PRODUCT_POLICY,
      config,
      sessionConfig,
    });

  describe("Realtime Voice native configuration", () => {
    test("keeps the session model/version in its separate configuration and only emits V3 handoff fields for V3", () => {
      expect(settings({ model: "wrong", version: "v3" })).toMatchObject({
        model: "gpt-live-1-boulder-alpha",
        version: "v1",
        includeStartupContext: false,
        flushTranscriptTailOnSessionEnd: true,
      });
      expect(
        settings(
          { codex_response_handoff_mode: "bemTags" },
          { model: "real-session", version: "v3" },
        ),
      ).toMatchObject({
        model: "real-session",
        version: "v3",
        codexResponseHandoffMode: "bemTags",
      });
      expect(
        settings(
          { codex_response_handoff_mode: "bemTags" },
          { model: "real-session", version: "v2" },
        ).codexResponseHandoffMode,
      ).toBeUndefined();
    });
    test("does not forward invalid session override fields to native startup", () => {
      for (const sessionConfig of [
        { model: "" },
        { model: null },
        { version: "future" },
        { version: null },
      ]) {
        const result = settings({ codex_response_handoff_mode: "bemTags" }, sessionConfig);
        expect(result.model).toBeUndefined();
        expect(result.version).toBeUndefined();
        expect(result.codexResponseHandoffMode).toBeUndefined();
      }
    });
    test("reads a model's prompt override and keeps configuration whitespace while substituting the missing name", () => {
      const config = {
        prompt: " base {{ user_first_name }} ",
        model_overrides: { model: { prompt: " exact {{ user_first_name }} \n" } },
      };
      expect(settings(config, { model: "model", version: "v3" }).prompt).toBe(" exact there \n");
      expect(settings(config, { model: "other" }).prompt).toBe(" base there ");
    });
    test("rejects invalid channel maps as a unit and preserves valid channel values", () => {
      expect(
        settings(
          { codex_response_handoff_channel_prefixes: { commentary: [" X "], analysis: ["Y"] } },
          { version: "v3" },
        ).codexResponseHandoffChannelPrefixes,
      ).toEqual({ commentary: [" X "], analysis: ["Y"] });
      expect(
        settings({ codex_response_handoff_channel_prefixes: {} }, { version: "v3" })
          .codexResponseHandoffChannelPrefixes,
      ).toEqual({});
      for (const prefixes of [{ unknown: ["X"] }, { commentary: [""] }, { commentary: "X" }])
        expect(
          settings({ codex_response_handoff_channel_prefixes: prefixes }, { version: "v3" })
            .codexResponseHandoffChannelPrefixes,
        ).toBeUndefined();
    });
    test("derives a bounded start instruction from the pre-orchestration developer section", () => {
      const developer =
        " Voice coordinator.\nAfter every successful delegation or message sent to another thread, report.\nKeep work responsive.\n## Orchestration\nworker-only instructions";
      const result = settings({
        new_thread_developer_instructions: developer,
      }).realtimeStartInstructions;
      expect(result).toBe(
        "Voice coordinator.\nKeep work responsive.\n\n## Deferred voice-session tools\n\nDuring this voice session, load capture_screen_context and end_realtime_voice_call only when needed. Respect screen-context settings. End only the voice call and only when the user's intent to end it is clear; stopping work, stopping speech, and pausing do not end a call.",
      );
      expect(
        settings({
          realtime_start_instructions: " Explicit ",
          new_thread_developer_instructions: developer,
        }).realtimeStartInstructions,
      ).toBe(" Explicit ");
      expect(
        settings({ new_thread_developer_instructions: "No orchestration" })
          .realtimeStartInstructions,
      ).toBe(DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS);
      expect(
        settings({ new_thread_developer_instructions: "X".repeat(32768) + "\n## Orchestration" })
          .realtimeStartInstructions,
      ).toBe(DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS);
    });
    test("measures the instruction budget in UTF8 bytes and keeps the exact boundary", () => {
      const exact = "界".repeat(10922) + "ab";
      expect(new TextEncoder().encode(exact).length).toBe(32768);
      expect(settings({ realtime_start_instructions: exact }).realtimeStartInstructions).toBe(
        exact,
      );
      expect(settings({ realtime_start_instructions: exact + "a" }).realtimeStartInstructions).toBe(
        DEFAULT_REALTIME_VOICE_START_INSTRUCTIONS,
      );
    });
  });

  test("uses the native supported V1 voice catalog and maps account-only aliases", () => {
    const voices = { v1: ["arbor", "sol", "spruce"] as const, defaultV1: "arbor" as const };
    expect(resolveSupportedRealtimeVoice(voices, "glimmer")).toBe("sol");
    expect(resolveSupportedRealtimeVoice(voices, "orbit")).toBe("spruce");
    expect(resolveSupportedRealtimeVoice(voices, "unsupported")).toBe("arbor");
    expect(resolveSupportedRealtimeVoice({ v1: ["sol"], defaultV1: "arbor" }, null)).toBeNull();
  });

  const assistant = (text: string): CodexCanonicalItem => ({
    type: "agentMessage",
    moderation: null,
    id: text,
    text,
    phase: null,
    delivery: null,
    memoryCitation: null,
    questions: null,
  });
  const user = (text: string): CodexCanonicalItem => ({
    type: "userMessage",
    id: text,
    clientId: null,
    content: [{ type: "text", text, text_elements: [] }],
  });
  test("reads only a configured resident tail, preserves roles and encloses it as existing task context", () => {
    const turns = [
      { items: [user("old"), assistant("old answer")] },
      { items: [user("  current  "), assistant(" answer ")] },
    ];
    expect(buildRealtimeVoiceInitialItems(turns, {}, "v3")).toEqual([]);
    expect(
      buildRealtimeVoiceInitialItems(turns, { realtime_continuity_enabled: true }, "v2"),
    ).toEqual([]);
    const items = buildRealtimeVoiceInitialItems(
      turns,
      { realtime_continuity_enabled: true, realtime_continuity_max_items: 2 },
      "v3",
    );
    expect(items.map((item) => item.role)).toEqual(["developer", "user", "assistant", "developer"]);
    expect(items.slice(1, -1)).toEqual([
      { role: "user", text: "current" },
      { role: "assistant", text: "answer" },
    ]);
    expect(items[0]!.text.startsWith("<recent_background_task_conversation>\n")).toBe(true);
    expect(items.at(-1)!.text.startsWith("</recent_background_task_conversation>\n")).toBe(true);
  });
  test("bounds recent history by both per-message suffix and the aggregate UTF8 token estimate", () => {
    const turns = [
      {
        items: Array.from({ length: 20 }, (_, index) => assistant(`${index} ` + "界".repeat(3999))),
      },
    ];
    const items = buildRealtimeVoiceInitialItems(
      turns,
      {
        realtime_continuity_enabled: true,
        realtime_continuity_max_items: 20,
        realtime_continuity_max_text_length: 4000,
      },
      "v3",
    );
    expect(
      items.reduce(
        (total, item) => total + Math.ceil(new TextEncoder().encode(item.text).byteLength / 4),
        0,
      ),
    ).toBeLessThanOrEqual(8192);
    expect(items.every((item) => !item.text.includes("\uFFFD"))).toBe(true);
    expect(items.some((item) => item.text.includes("…earlier continuity truncated…"))).toBe(true);
    expect(items.at(-2)!.text).toBe(
      turns[0]!.items.at(-1)!.type === "agentMessage"
        ? (
            turns[0]!.items.at(-1)! as Extract<CodexCanonicalItem, { type: "agentMessage" }>
          ).text.slice(-4000)
        : "",
    );
  });
});

describe("CodexRuntimeNative", () => {
  it.effect(
    "routes voice through its captured Runtime source and bounds lost release replies",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const incoming = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
          const calls: Array<{ method: string; input: unknown }> = [];
          let subscribed = false;
          let released = false;
          let claimId = "";
          const source = {
            runtimeGeneration: "runtime",
            threadId: "product-thread",
            providerSessionId: "provider-session",
            nativeGeneration: 7,
            providerThreadId: "provider-thread",
            nativeThreadId: "native-thread",
          };
          const connection = {
            subscribeNotifications: Effect.gen(function* () {
              subscribed = true;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true;
                }),
              );
              const subscription = yield* PubSub.subscribe(incoming);
              return Stream.fromSubscription(subscription);
            }),
            request: (method: string, input: unknown) =>
              Effect.suspend(() => {
                if (method === "native.voice.release") {
                  calls.push({ method, input });
                  return Effect.never;
                }
                return Effect.sync(() => {
                  calls.push({ method, input });
                  if (method === "native.voice.prepare") {
                    assert.isTrue(subscribed);
                    assert.deepEqual((input as { threadId: string }).threadId, "product-thread");
                    claimId = (input as { claimId: string }).claimId;
                    return {
                      source,
                      userAgent: "codex/0.162.0-alpha.20",
                      voices: { v1: ["arbor"], defaultV1: "arbor" },
                      features: [],
                      history: [],
                    };
                  }
                  if (method === "native.voice.current") return true;
                  return null;
                });
              }),
          } as unknown as AgentRuntimeApplicationConnection;
          const capture = yield* captureVoice(
            { hostId: "local", threadId: "product-thread" },
            Option.some({
              nativeThread: () => Effect.succeed({ connection }),
            } as unknown as AgentRuntimeApplication["Service"]),
          );
          assert.isNotNull(capture);
          const voice = capture!;
          yield* voice.request("thread/realtime/appendSpeech", {
            threadId: "native-thread",
            text: "Say this",
          });
          assert.deepEqual(calls.at(-1), {
            method: "native.voice.append-speech",
            input: { claimId, source, threadId: "native-thread", text: "Say this" },
          });
          const result = yield* voice.notifications.pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* PubSub.publish(incoming, {
            delivery: 1,
            notification: { type: "native.voice.closed", claimId: "unrelated", source },
          });
          yield* PubSub.publish(incoming, {
            delivery: 2,
            notification: { type: "native.voice.closed", claimId, source },
          });
          assert.equal((yield* Fiber.join(result)).length, 1);
          const gap = yield* voice.notifications.pipe(
            Stream.runDrain,
            Effect.result,
            Effect.forkScoped,
          );
          yield* Effect.yieldNow;
          yield* PubSub.publish(incoming, {
            delivery: 4,
            notification: { type: "native.voice.closed", claimId, source },
          });
          assert.equal((yield* Fiber.join(gap))._tag, "Failure");
          assert.isFalse(yield* voice.current);
          const releasing = yield* voice.release.pipe(Effect.forkScoped);
          yield* TestClock.adjust("2 seconds");
          yield* Fiber.join(releasing);
          assert.isTrue(released);
          assert.isFalse(yield* voice.current);
          assert.equal(calls.at(-1)?.method, "native.voice.release");
        }),
      ),
  );
});

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

const target = { accountId: "account-a", userId: "user-a" };
const operationId = "11111111-1111-4111-8111-111111111111";
const token = (accountId: string, userId: string) =>
  `header.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: userId } })).toString("base64url")}.signature`;
const makeHarness = (
  respond: (input: ChatGptDesktopRequestInput) => Effect.Effect<Response, ChatGptDesktopAuthError>,
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
    assert.equal(harness.state.requests[0]?.path, "/dictation/custom_dictionary/words/a%2Fb%3F%23");
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
  }).pipe(Effect.provide(harness.layer));
});

it.effect("reports an HTTP failure even when the service omits its optional error code", () => {
  const harness = makeHarness(() => Effect.succeed(new Response("unavailable", { status: 503 })));
  return Effect.gen(function* () {
    const dictionary = yield* DictationDictionary;
    const error = yield* dictionary.add({ operationId, target, text: "Nodex" }).pipe(Effect.flip);
    assert.equal(error.status, 503);
    assert.isUndefined(error.errorCode);
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this test owns the complete dictionary application layer.
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
    DictationDictionaryAddSchema.safeParse({ operationId, target, text: "a".repeat(101) }).success,
  );
  const words = ["  exact  ", "a".repeat(512)];
  assert.deepStrictEqual(
    DictationDictionaryImportSchema.parse({ operationId, target, words }).words,
    words,
  );
});

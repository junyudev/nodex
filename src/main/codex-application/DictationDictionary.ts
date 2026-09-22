import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ConfigReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigReadResponse";
import {
  DICTATION_DICTIONARY_MAX_WORDS,
  type DictationDictionaryAddInput,
  type DictationDictionaryImportInput,
  type DictationDictionaryReadInput,
  type DictationDictionaryRemoveInput,
  type DictationDictionarySnapshot,
  type DictationDictionaryTarget,
} from "../../shared/dictation-dictionary";
import { decodeChatGptBackendIdentity } from "../codex/chatgpt-backend-auth";
import { resolveChatGptBaseUrl } from "../codex/chatgpt-base-url";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { DictationRuntime } from "../host-runtime/DictationRuntime";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { CodexMedia } from "./CodexMedia";

export class DictationDictionaryError extends Schema.TaggedError<DictationDictionaryError>()(
  "DictationDictionaryError",
  {
    message: Schema.String,
    status: Schema.optionalKey(Schema.Number),
    errorCode: Schema.optionalKey(Schema.String),
  },
) {}

export class DictationDictionary extends Context.Service<
  DictationDictionary,
  {
    readonly read: (
      input: DictationDictionaryReadInput,
    ) => Effect.Effect<DictationDictionarySnapshot, DictationDictionaryError>;
    readonly add: (
      input: DictationDictionaryAddInput,
    ) => Effect.Effect<void, DictationDictionaryError>;
    readonly remove: (
      input: DictationDictionaryRemoveInput,
    ) => Effect.Effect<void, DictationDictionaryError>;
    readonly importWords: (
      input: DictationDictionaryImportInput,
    ) => Effect.Effect<void, DictationDictionaryError>;
    readonly cancel: (operationId: string) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-application/DictationDictionary") {}

const decodeDictionary = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      words: Schema.Array(Schema.Struct({ id: Schema.String, text: Schema.String })),
      max_words: Schema.Number,
    }),
  ),
);
const decodeFailure = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
      code: Schema.optionalKey(Schema.String),
      detail: Schema.optionalKey(Schema.Struct({ code: Schema.optionalKey(Schema.String) })),
    }),
  ),
);
const failure = (message: string, errorCode?: string) =>
  new DictationDictionaryError({ message, errorCode });
const currentAccountChanged = () =>
  failure(
    "The active account or workspace changed. Reopen the voice dictionary.",
    "account_changed",
  );
const readResponse = (response: Response) =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: () => failure("Could not read the voice dictionary response"),
  });

export const live: Layer.Layer<
  DictationDictionary,
  never,
  ChatGptDesktop | CodexGateway | DictationRuntime | CodexMedia
> = Layer.effect(
  DictationDictionary,
  Effect.gen(function* () {
    const chatgpt = yield* ChatGptDesktop;
    const gateway = yield* CodexGateway;
    const dictation = yield* DictationRuntime;
    const media = yield* CodexMedia;
    const operations = new Map<string, AbortController>();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const controller of operations.values()) controller.abort();
        operations.clear();
      }),
    );

    const readTarget = Effect.fn("DictationDictionary.readTarget")(function* () {
      const policy = yield* media.dictationPolicySnapshot;
      if (!policy.voiceDictionary) {
        return yield* failure("The voice dictionary is unavailable for this account");
      }
      const status = yield* chatgpt
        .authStatus(true, false)
        .pipe(Effect.mapError(() => failure("Could not read the active account")));
      const identity = status.authToken ? decodeChatGptBackendIdentity(status.authToken) : null;
      if (!identity) return yield* failure("Sign in to ChatGPT to manage the voice dictionary");
      if (policy.accountId !== identity.accountId || policy.userId !== identity.userId) {
        return yield* currentAccountChanged();
      }
      return { accountId: identity.accountId, userId: identity.userId };
    });
    const assertTarget = Effect.fn("DictationDictionary.assertTarget")(function* (
      target: DictationDictionaryTarget,
    ) {
      const current = yield* readTarget();
      if (current.accountId !== target.accountId || current.userId !== target.userId)
        return yield* currentAccountChanged();
    });
    const assertActive = (signal: AbortSignal) =>
      Effect.suspend(() =>
        signal.aborted
          ? Effect.fail(failure("Voice dictionary request was cancelled", "aborted"))
          : Effect.void,
      );

    const run = <A>(
      operationId: string,
      use: (signal: AbortSignal) => Effect.Effect<A, DictationDictionaryError>,
    ) =>
      Effect.suspend(() => {
        if (operations.has(operationId))
          return Effect.fail(failure("Voice dictionary request is already running"));
        const controller = new AbortController();
        operations.set(operationId, controller);
        return use(controller.signal).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              controller.abort();
              operations.delete(operationId);
            }),
          ),
        );
      });

    const request = Effect.fn("DictationDictionary.request")(function* (
      target: DictationDictionaryTarget,
      signal: AbortSignal,
      method: string,
      path: string,
      text?: string,
    ) {
      yield* assertActive(signal);
      yield* assertTarget(target);
      const config = yield* gateway
        .requestLocal("config/read", { includeLayers: false })
        .pipe(Effect.mapError(() => failure("Could not read agent configuration")));
      const baseUrl = yield* Effect.try({
        try: () => resolveChatGptBaseUrl(config as ConfigReadResponse),
        catch: () => failure("ChatGPT endpoint is unavailable"),
      });
      const response = yield* chatgpt
        .request({
          method,
          baseUrl,
          path,
          action: "manage the voice dictionary",
          signal,
          expectedAccount: target,
          headers: {
            "ChatGPT-Account-ID": target.accountId,
            "X-OpenAI-Expected-Account-Id": target.accountId,
            "Content-Type": "application/json",
          },
          body: text === undefined ? undefined : JSON.stringify({ text }),
        })
        .pipe(
          Effect.mapError((cause) =>
            failure(cause.message, signal.aborted ? "aborted" : undefined),
          ),
        );
      const body = yield* readResponse(response);
      yield* assertActive(signal);
      yield* assertTarget(target);
      if (response.ok) return body;
      const detail = yield* decodeFailure(body).pipe(Effect.catch(() => Effect.succeed(null)));
      return yield* new DictationDictionaryError({
        message: "Could not save or load the voice dictionary",
        status: response.status,
        errorCode: detail?.error?.code ?? detail?.code ?? detail?.detail?.code,
      });
    });
    const addWord = (target: DictationDictionaryTarget, signal: AbortSignal, text: string) =>
      request(target, signal, "POST", "/dictation/custom_dictionary/words", text).pipe(
        Effect.asVoid,
      );

    return DictationDictionary.of({
      read: (input) =>
        run(
          input.operationId,
          Effect.fn("DictationDictionary.read")(function* (signal) {
            const target = input.target ?? (yield* readTarget());
            const body = yield* request(target, signal, "GET", "/dictation/custom_dictionary");
            const dictionary = yield* decodeDictionary(body).pipe(
              Effect.mapError(() => failure("Invalid voice dictionary response")),
            );
            const settings = yield* dictation.readSettings.pipe(
              Effect.mapError(() => failure("Could not read words from this device")),
            );
            yield* assertActive(signal);
            yield* assertTarget(target);
            return {
              target,
              words: dictionary.words,
              maxWords: Math.max(
                0,
                Math.min(Math.floor(dictionary.max_words), DICTATION_DICTIONARY_MAX_WORDS),
              ),
              localWords: [...new Set(settings.dictionary)],
            };
          }),
        ),
      add: (input) => run(input.operationId, (signal) => addWord(input.target, signal, input.text)),
      remove: (input) =>
        run(input.operationId, (signal) =>
          request(
            input.target,
            signal,
            "DELETE",
            `/dictation/custom_dictionary/words/${encodeURIComponent(input.wordId)}`,
          ).pipe(Effect.asVoid),
        ),
      importWords: (input) =>
        run(
          input.operationId,
          Effect.fn("DictationDictionary.importWords")(function* (signal) {
            for (const word of new Set(input.words)) {
              yield* addWord(input.target, signal, word).pipe(
                Effect.catch((error) =>
                  error.status === 409 && error.errorCode !== "account_changed"
                    ? Effect.void
                    : Effect.fail(error),
                ),
              );
            }
            yield* assertActive(signal);
            yield* assertTarget(input.target);
            // Re-read after the network work so unrelated local edits are retained.
            const settings = yield* dictation.readSettings.pipe(
              Effect.mapError(() => failure("Could not read words from this device")),
            );
            yield* assertActive(signal);
            yield* assertTarget(input.target);
            yield* dictation
              .updateSettings({
                dictionary: settings.dictionary.filter((word) => !input.words.includes(word)),
              })
              .pipe(Effect.mapError(() => failure("Could not update words on this device")));
          }),
        ),
      cancel: (operationId) =>
        Effect.sync(() => {
          const controller = operations.get(operationId);
          if (!controller) return false;
          controller.abort();
          return true;
        }),
    });
  }),
);

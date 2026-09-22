import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { vi, beforeEach } from "vitest";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import { live as hostAuthStateLive } from "../codex-runtime/CodexExecutionHostAuthState";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { DEFAULT_DICTATION_SETTINGS } from "../../shared/dictation";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { DictationRuntime } from "../host-runtime/DictationRuntime";
import { ChatGptDesktop } from "./ChatGptDesktop";
import { CodexAccount } from "./CodexAccount";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { CodexConnection } from "./CodexConnection";
import { CodexMedia, live as codexMediaLive } from "./CodexMedia";

const policyFlags = vi.hoisted(() => ({
  composer: true,
  global: true,
  sounds: false,
  streaming: true,
  workspace: false,
  token: "test-token" as string | null,
  authReads: 0,
  authController: new AbortController(),
}));

vi.mock("../dictation/DictationPolicy", async () => {
  const Effect = await import("effect/Effect");
  const Stream = await import("effect/Stream");
  const read = Effect.sync(() => ({
    composer: policyFlags.composer,
    global: policyFlags.global,
    streaming: policyFlags.streaming,
    sounds: policyFlags.sounds,
    voiceDictionary: false,
    accountId: null,
    userId: null,
  }));
  return { makeDictationPolicy: Effect.succeed({ read, refresh: read, changes: Stream.empty }) };
});
vi.mock("../codex/chatgpt-backend-auth", async () => {
  const Effect = await import("effect/Effect");
  return {
    readChatGptBackendRequestAuth: () =>
      Effect.gen(function* () {
        policyFlags.authReads += 1;
        if (!policyFlags.token)
          return yield* Effect.fail({ _tag: "TestAuthError" as const, message: "Missing token" });
        return {
          token: policyFlags.token,
          identity: { accountId: "account", userId: "user", isFedramp: false },
          routing: policyFlags.workspace
            ? { kind: "workspace" as const }
            : { kind: "legacy" as const },
          planType: "plus",
          signal: policyFlags.authController.signal,
        };
      }),
  };
});
beforeEach(() => {
  policyFlags.composer = true;
  policyFlags.global = true;
  policyFlags.sounds = false;
  policyFlags.streaming = true;
  policyFlags.workspace = false;
  policyFlags.token = "test-token";
  policyFlags.authReads = 0;
  policyFlags.authController = new AbortController();
});

const unsupported = () => Effect.die(new Error("Unsupported test operation"));

const gateway = CodexGateway.of({
  localHostId: "local",
  requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
  requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
  events: Stream.empty,
  requestLocal: ((method: string) => {
    if (method === "config/read") {
      return Effect.succeed({ config: { chatgpt_base_url: "https://chatgpt.test" } });
    }
    throw new Error(`Unexpected request: ${method}`);
  }) as CodexGateway["Service"]["requestLocal"],
  requestOnHost: unsupported,
  requestForThread: unsupported,
  notifyLocal: unsupported,
  connection: unsupported,
  connectionChanges: () => Stream.empty,
  awaitReady: () => Effect.void,
  reconcileHost: unsupported,
  removeHost: unsupported,
  restartHost: unsupported,
});

const build = Effect.fn("CodexMediaTest.build")(function* (
  chatgpt: ChatGptDesktop["Service"],
  scope: Scope.Closeable,
  setEnabled: DictationRuntime["Service"]["setEnabled"] = () => Effect.void,
) {
  const accountSnapshot = yield* SubscriptionRef.make({
    account: null,
    requiresOpenAiAuth: false,
  });
  return yield* Layer.buildWithScope(
    codexMediaLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          hostAuthStateLive,
          Layer.succeed(CodexGateway, gateway),
          Layer.succeed(CodexWorkspaceRouting, CodexWorkspaceRouting.of({ discover: unsupported })),
          Layer.succeed(
            CodexAppServerCapabilities,
            CodexAppServerCapabilities.of({
              forHost: unsupported,
              forThread: unsupported,
              isCurrent: unsupported,
            }),
          ),
          Layer.succeed(ChatGptDesktop, chatgpt),
          Layer.succeed(
            CodexAccount,
            CodexAccount.of({ snapshot: accountSnapshot } as CodexAccount["Service"]),
          ),
          Layer.succeed(
            CodexApplicationEventHub,
            CodexApplicationEventHub.of({ events: Stream.empty, publish: () => undefined }),
          ),
          Layer.succeed(
            CodexConnection,
            CodexConnection.of({
              readAll: Effect.succeed(
                new Map([["local", { status: "connected" as const, retries: 0 }]]),
              ),
              allChanges: Stream.empty,
              read: Effect.succeed({ status: "connected", retries: 0 }),
              readForHost: () => Effect.succeed({ status: "connected", retries: 0 }),
              changes: Stream.empty,
            }),
          ),
          Layer.succeed(
            DictationRuntime,
            DictationRuntime.of({
              changes: Stream.empty,
              globalAvailable: () => true,
              microphoneOwner: () => "none",
              setEnabled,
              readSettings: Effect.succeed({
                ...DEFAULT_DICTATION_SETTINGS,
                dictionary: ["Nodex", "useCartState"],
              }),
            } as unknown as DictationRuntime["Service"]),
          ),
          Layer.succeed(
            ElectronNet,
            ElectronNet.of({
              appVersion: "test",
              fetch: () =>
                Effect.succeed(
                  new Response(Uint8Array.from([1, 2, 3]), {
                    status: 200,
                    headers: { "content-type": "image/png" },
                  }),
                ),
              readBase64: (response) =>
                Effect.tryPromise(() =>
                  response.arrayBuffer().then((bytes) => Buffer.from(bytes).toString("base64")),
                ),
            }),
          ),
        ),
      ),
    ),
    scope,
  );
});

it.effect("owns dictation projection and transcription", () =>
  Effect.gen(function* () {
    const requests: string[] = [];
    const requestBodies: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* build(
      ChatGptDesktop.of({
        authStatus: () => Effect.die(new Error("unused")),
        authMethod: Effect.succeed("chatgptAuthTokens"),
        request: (input) => {
          requests.push(input.path);
          if (typeof input.body === "string") requestBodies.push(input.body);
          return Effect.succeed(
            input.path === "/codex/responses"
              ? new Response(
                  'data: {"type":"response.output_text.delta","delta":"Nodex works"}\n\ndata: {"type":"response.output_text.done","text":"Nodex works"}\n\ndata: [DONE]\n\n',
                  { status: 200 },
                )
              : new Response(JSON.stringify({ text: "hello" }), { status: 200 }),
          );
        },
      }),
      scope,
    );
    const media = Context.get(context, CodexMedia);
    assert.deepEqual(yield* media.dictationState, {
      isEnabled: true,
      authMethod: "chatgpt",
      shortcutLabel: "Ctrl+M",
      capabilities: {
        composer: true,
        global: true,
        history: true,
        streaming: "available",
        semanticCleanup: true,
        sounds: false,
        voiceDictionary: false,
        microphoneOwner: "none",
        auth: "chatgpt",
      },
    });
    assert.strictEqual(
      (yield* media.transcribe({
        requestId: "4ee71509-91df-4ebe-adef-9cc41b200af1",
        contentType: "audio/webm",
        base64Payload: "AQID",
      })).text,
      "hello",
    );
    assert.strictEqual(
      (yield* media.cleanupTranscript({
        requestId: "4ee71509-91df-4ebe-adef-9cc41b200af1",
        transcript: "node x works",
        surroundingText: "The project is open.",
      })).text,
      "Nodex works",
    );
    assert.deepEqual(requests, ["/transcribe", "/codex/responses"]);
    const cleanupRequest = JSON.parse(requestBodies.at(-1) ?? "") as {
      model: string;
      stream: boolean;
      input: Array<{ content: Array<{ text: string }> }>;
    };
    assert.strictEqual(cleanupRequest.model, "gpt-5.6-luna");
    assert.isTrue(cleanupRequest.stream);
    assert.match(cleanupRequest.input[0]?.content[0]?.text ?? "", /Nodex\nuseCartState/u);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("resolves generated images without leaking transport failures", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* build(
      ChatGptDesktop.of({
        authStatus: () => Effect.die(new Error("unused")),
        authMethod: Effect.succeed("chatgpt"),
        request: () =>
          Effect.succeed(
            new Response(
              JSON.stringify({ status: "success", download_url: "https://files.test/image" }),
              { status: 200 },
            ),
          ),
      }),
      scope,
    );
    const media = Context.get(context, CodexMedia);
    assert.deepEqual(
      yield* media.resolveImage({ hostId: "local", pointer: "file-service://file-1" }),
      { ok: true, dataBase64: "AQID", mimeType: "image/png" },
    );
    assert.deepEqual(
      yield* media.resolveImage({ hostId: "remote", pointer: "file-service://file-1" }),
      { ok: false, message: "Unsupported Codex image asset host: remote", status: null },
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "prepares authenticated WebSocket connections locally without a connect-info HTTP request",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      policyFlags.token = null;
      const context = yield* build(
        ChatGptDesktop.of({
          authMethod: Effect.succeed("chatgpt"),
          authStatus: () => Effect.die("auth handled by backend boundary"),
          request: () => Effect.die("Connection preparation must not make an HTTP request"),
        }),
        scope,
      );
      const media = Context.get(context, CodexMedia);
      assert.strictEqual((yield* media.dictationState).capabilities.streaming, "available");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(media.prepareStreamingConnectInfo)));
      assert.strictEqual((yield* media.dictationState).capabilities.streaming, "available");
      policyFlags.token = "test-token";
      assert.deepEqual(yield* media.prepareStreamingConnectInfo, {
        websocketUrl: "wss://chatgpt.test/dictation/stream",
        protocols: ["chatgpt-dictation", "openai-bearer.test-token", "codex-desktop"],
      });
      assert.strictEqual(policyFlags.authReads, 2);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect(
  "returns diagnostic evidence when HTTP transcription fails and cleanup keeps the original text",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* build(
        ChatGptDesktop.of({
          authMethod: Effect.succeed("chatgpt"),
          authStatus: () => Effect.die("unused"),
          request: () => Effect.succeed(new Response("private service error", { status: 429 })),
        }),
        scope,
      );
      const media = Context.get(context, CodexMedia);
      const requestId = "4ee71509-91df-4ebe-adef-9cc41b200af1";
      const transcription = yield* media.transcribe({
        requestId,
        contentType: "audio/webm",
        base64Payload: "AQID",
      });
      assert.strictEqual(transcription.text, "");
      assert.strictEqual(transcription.diagnostics.status, 429);
      assert.strictEqual(transcription.diagnostics.outcome, "failed");
      const cleanup = yield* media.cleanupTranscript({
        requestId,
        transcript: "original",
        surroundingText: null,
      });
      assert.strictEqual(cleanup.text, "original");
      assert.strictEqual(cleanup.diagnostics.outcome, "failed");
      assert.strictEqual(cleanup.diagnostics.status, 429);
      yield* Scope.close(scope, Exit.void);
    }),
);

it.effect("reads and updates the account voice language through typed requests", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const requests: Array<{ path: string; method: string }> = [];
    let remoteLanguage = "ja";
    const context = yield* build(
      ChatGptDesktop.of({
        authMethod: Effect.succeed("chatgpt"),
        authStatus: () => Effect.die("unused"),
        request: (input) => {
          requests.push({ path: input.path, method: input.method ?? "GET" });
          return Effect.succeed(
            new Response(JSON.stringify({ settings: { voice_main_language: remoteLanguage } }), {
              status: 200,
            }),
          );
        },
      }),
      scope,
    );
    const media = Context.get(context, CodexMedia);
    assert.strictEqual(yield* media.readVoiceLanguage, "ja");
    assert.strictEqual(yield* media.updateVoiceLanguage("auto"), "auto");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(media.updateVoiceLanguage("not-a-language"))));
    assert.deepEqual(requests, [
      { path: "/settings/user", method: "GET" },
      {
        path: "/settings/account_user_setting?feature=voice_main_language&value=auto",
        method: "PATCH",
      },
    ]);
    remoteLanguage = "not-a-language";
    assert.isTrue(Exit.isFailure(yield* Effect.exit(media.readVoiceLanguage)));
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("denies streams when the account policy or workspace routing disallows them", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* build(
      ChatGptDesktop.of({
        authMethod: Effect.succeed("chatgpt"),
        authStatus: () => {
          return Effect.succeed({
            authMethod: "chatgpt",
            authToken: "token",
            requiresOpenaiAuth: true,
          });
        },
        request: () => Effect.die("unused"),
      }),
      scope,
    );
    const media = Context.get(context, CodexMedia);
    policyFlags.streaming = false;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(media.prepareStreamingConnectInfo)));
    assert.strictEqual(policyFlags.authReads, 0);
    policyFlags.streaming = true;
    policyFlags.workspace = true;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(media.prepareStreamingConnectInfo)));
    assert.strictEqual(policyFlags.authReads, 1);
    policyFlags.workspace = false;
    policyFlags.authController.abort();
    assert.isTrue(Exit.isFailure(yield* Effect.exit(media.prepareStreamingConnectInfo)));
    assert.strictEqual(policyFlags.authReads, 2);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "honors global policy for API-key auth while keeping Composer and streams unavailable",
  () =>
    Effect.gen(function* () {
      policyFlags.composer = false;
      policyFlags.global = true;
      policyFlags.sounds = true;
      const activated: boolean[] = [];
      const scope = yield* Scope.make();
      const context = yield* build(
        ChatGptDesktop.of({
          authMethod: Effect.succeed("apiKey"),
          authStatus: unsupported,
          request: unsupported,
        }),
        scope,
        (enabled) =>
          Effect.sync(() => {
            activated.push(enabled);
          }),
      );
      const media = Context.get(context, CodexMedia);
      assert.deepEqual(yield* media.dictationState, {
        isEnabled: false,
        authMethod: "apiKey",
        shortcutLabel: "Ctrl+M",
        capabilities: {
          composer: false,
          global: true,
          history: true,
          streaming: "unavailable",
          semanticCleanup: false,
          sounds: true,
          voiceDictionary: false,
          microphoneOwner: "none",
          auth: "unsupported",
        },
      });
      assert.strictEqual(activated.at(-1), true);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(media.prepareStreamingConnectInfo)));
      assert.strictEqual(policyFlags.authReads, 0);
      yield* Scope.close(scope, Exit.void);
    }),
);

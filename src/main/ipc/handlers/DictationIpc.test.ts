import { dictationTextResult } from "../../../../tests/fixtures/dictation-diagnostics";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexMedia, CodexMediaError } from "../../codex-application/CodexMedia";
import {
  DictationDictionary,
  DictationDictionaryError,
} from "../../codex-application/DictationDictionary";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { DictationIpcError, live } from "./DictationIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, DictationIpcError | CodexMediaError | DictationDictionaryError>;

it.effect("cancels only the owning renderer's active transcription fiber", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const interrupted = yield* Deferred.make<void>();
    const dictionaryCancelled = yield* Deferred.make<void>();
    const dictionary = DictationDictionary.of({
      read: () => Effect.die("unused"),
      add: () => Deferred.await(dictionaryCancelled),
      remove: () => Effect.die("unused"),
      importWords: () => Effect.die("unused"),
      cancel: () => Deferred.succeed(dictionaryCancelled, undefined),
    });
    const ipc = makeTestElectronIpc({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as Handler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: () => Effect.void,
    });
    const media = CodexMedia.of({
      dictationState: Effect.die("unused"),
      dictationPolicySnapshot: Effect.die("unused"),
      readVoiceLanguage: Effect.succeed("auto"),
      updateVoiceLanguage: (language) => Effect.succeed(language),
      transcribe: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      cleanupTranscript: ({ transcript }) =>
        Effect.succeed(dictationTextResult(`cleaned:${transcript}`, "cleanup")),
      prepareStreamingConnectInfo: Effect.succeed({
        websocketUrl: "wss://chatgpt.com/backend-api/dictation/stream",
        protocols: ["chatgpt-dictation", "openai-bearer.fixture-token", "codex-desktop"],
      }),
      resolveImage: () => Effect.die("unused"),
    });
    const dictation = DictationRuntime.of({
      ownsGlobalRenderer: () => false,
      captureBareModifierHotkey: (webContentsId: number, allowsBareModifiers: boolean) =>
        Effect.succeed(webContentsId === 7 && allowsBareModifiers ? "Ctrl+Fn" : null),
      cancelHotkeyCapture: (webContentsId: number) => Effect.succeed(webContentsId === 7),
    } as unknown as DictationRuntime["Service"]);
    const desktop = ElectronDesktop.of({
      dialog: null as never,
      menu: null as never,
      nativeTheme: null as never,
      safeStorage: null as never,
      shell: null as never,
      showMessage: () => Effect.die("unused"),
      showNotification: () => Effect.die("unused"),
      onPowerEvent: () => Effect.void,
    });
    const windows = WindowRuntime.of({
      get: () => null,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({
        authorize: (event, capability) => {
          if (
            (capability === "Dictation streaming connection" ||
              capability.startsWith("Voice language") ||
              capability === "Global dictation shortcut") &&
            event.sender.id !== 7
          )
            throw new Error("Untrusted renderer");
        },
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexMedia, media),
            Layer.succeed(DictationDictionary, dictionary),
            Layer.succeed(DictationRuntime, dictation),
            Layer.succeed(ElectronDesktop, desktop),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );

    const requestId = "44ad6887-2d86-4e3a-a9ed-d9397907ffad";
    const owner = { sender: { id: 7 } } as IpcMainInvokeEvent;
    const stranger = { sender: { id: 8 } } as IpcMainInvokeEvent;
    assert.strictEqual(
      yield* handlers.get("global-dictation-capture-bare-modifier-hotkey")!(owner, true),
      "Ctrl+Fn",
    );
    assert.strictEqual(
      yield* handlers.get("global-dictation-capture-bare-modifier-hotkey")!(owner, false),
      null,
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handlers.get("global-dictation-capture-bare-modifier-hotkey")!(owner, "false"),
        ),
      ),
    );
    assert.strictEqual(yield* handlers.get("global-dictation-hotkey-capture:cancel")!(owner), true);
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          handlers.get("global-dictation-capture-bare-modifier-hotkey")!(stranger, true),
        ),
      ),
    );
    const dictionaryOperationId = "a60a7efa-0983-42be-8b20-e00e394adf13";
    const dictionaryFiber = yield* Effect.forkChild(
      handlers.get("codex:dictation:dictionary:add")!(owner, {
        operationId: dictionaryOperationId,
        target: { accountId: "account", userId: "user" },
        text: "Nodex",
      }),
    );
    yield* Effect.yieldNow;
    assert.isFalse(
      (yield* handlers.get("codex:dictation:dictionary:cancel")!(
        stranger,
        dictionaryOperationId,
      )) as boolean,
    );
    assert.isTrue(
      (yield* handlers.get("codex:dictation:dictionary:cancel")!(
        owner,
        dictionaryOperationId,
      )) as boolean,
    );
    yield* Fiber.join(dictionaryFiber);
    assert.isFalse(
      (yield* handlers.get("codex:dictation:dictionary:cancel")!(
        owner,
        dictionaryOperationId,
      )) as boolean,
    );
    assert.strictEqual(yield* handlers.get("codex:dictation:voice-language:read")!(owner), "auto");
    assert.strictEqual(
      yield* handlers.get("codex:dictation:voice-language:update")!(owner, "en"),
      "en",
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(handlers.get("codex:dictation:voice-language:update")!(owner, 42)),
      ),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(handlers.get("codex:dictation:voice-language:read")!(stranger)),
      ),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(handlers.get("codex:dictation:voice-language:update")!(stranger, "en")),
      ),
    );
    assert.deepEqual(yield* handlers.get("codex:dictation:streaming-connect-info:read")!(owner), {
      websocketUrl: "wss://chatgpt.com/backend-api/dictation/stream",
      protocols: ["chatgpt-dictation", "openai-bearer.fixture-token", "codex-desktop"],
    });
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(handlers.get("codex:dictation:streaming-connect-info:read")!(stranger)),
      ),
    );
    const requestFiber = yield* Effect.forkChild(
      handlers.get("codex:dictation:transcribe")!(owner, {
        contentType: "multipart/form-data; boundary=nodex-test",
        base64Payload: "AQID",
        requestId,
      }),
    );
    yield* Effect.yieldNow;
    assert.isFalse(
      (yield* handlers.get("codex:dictation:transcribe:cancel")!(stranger, requestId)) as boolean,
    );
    assert.isTrue(
      (yield* handlers.get("codex:dictation:transcribe:cancel")!(owner, requestId)) as boolean,
    );
    yield* Deferred.await(interrupted);
    assert.isTrue(Exit.isFailure(yield* Fiber.await(requestFiber)));
    assert.isFalse(
      (yield* handlers.get("codex:dictation:transcribe:cancel")!(owner, requestId)) as boolean,
    );

    const unauthorizedContextMenu = yield* Effect.exit(
      handlers.get("global-dictation:context-menu")!(stranger),
    );
    assert.isTrue(Exit.isFailure(unauthorizedContextMenu));

    assert.deepEqual(
      yield* handlers.get("codex:dictation:cleanup")!(owner, {
        transcript: "hello nodex",
        surroundingText: null,
        requestId: "6d23f70b-f145-4ca0-943b-0042ea9fe091",
      }),
      dictationTextResult("cleaned:hello nodex", "cleanup"),
    );

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);

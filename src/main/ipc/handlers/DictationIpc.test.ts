import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import { CodexMedia, CodexMediaError } from "../../codex-application/CodexMedia";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { DictationIpcError, live } from "./DictationIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, DictationIpcError | CodexMediaError>;

it.effect("cancels only the owning renderer's active transcription fiber", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, Handler>();
    const interrupted = yield* Deferred.make<void>();
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
      transcribe: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
      cleanupTranscript: ({ transcript }) => Effect.succeed(`cleaned:${transcript}`),
      prepareStreamingConnectInfo: Effect.die("unused"),
      resolveImage: () => Effect.die("unused"),
    });
    const dictation = DictationRuntime.of({
      ownsGlobalRenderer: () => false,
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
    const callbacks = ScopedCallbackRuntime.of({
      fork: () => null,
      runPromise: () => Promise.reject(new Error("unused")),
    });
    const windows = WindowRuntime.of({
      get: () => null,
    } as unknown as WindowRuntime["Service"]);
    const scope = yield* Scope.make();
    yield* Layer.buildWithScope(
      live({
        authorize: () => undefined,
        registerStreaming: () => () => undefined,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(CodexMedia, media),
            Layer.succeed(DictationRuntime, dictation),
            Layer.succeed(ElectronDesktop, desktop),
            Layer.succeed(ElectronIpc, ipc),
            mainConfigLayer(),
            Layer.succeed(ScopedCallbackRuntime, callbacks),
            Layer.succeed(WindowRuntime, windows),
          ),
        ),
      ),
      scope,
    );

    const requestId = "44ad6887-2d86-4e3a-a9ed-d9397907ffad";
    const owner = { sender: { id: 7 } } as IpcMainInvokeEvent;
    const stranger = { sender: { id: 8 } } as IpcMainInvokeEvent;
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

    assert.strictEqual(
      yield* handlers.get("codex:dictation:cleanup")!(owner, {
        transcript: "hello nodex",
        surroundingText: null,
        requestId: "6d23f70b-f145-4ca0-943b-0042ea9fe091",
      }),
      "cleaned:hello nodex",
    );

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
  }),
);

import { describe, vi, expect } from "vite-plus/test";
import * as Stream from "effect/Stream";
import { EMPTY_REALTIME_VOICE_PRODUCT_POLICY } from "../../dictation/RealtimeVoicePolicyState";
import { dictationTextResult } from "../../../../tests/fixtures/dictation-diagnostics";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type {
  BrowserWindow,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
  IpcMainEvent,
  MessagePortMain,
  WebContents,
} from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DictationRecordingImportInput,
  DictationRecordingMetadata,
} from "../../../shared/dictation-history";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import { CodexMedia, CodexMediaError } from "../../codex-application/CodexMedia";
import {
  DictationDictionary,
  DictationDictionaryError,
} from "../../codex-application/DictationDictionary";
import { DictationRuntime } from "../../host-runtime/DictationRuntime";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc, ElectronSyncIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { DictationIpcError, live } from "./DictationIpc";
import type { WebContentsDestructionSource } from "../../platform/electron/WebContentsDestructionSubscriptions";
import { EventEmitter } from "node:events";
import { DICTATION_STREAM_CONNECT_CHANNEL } from "../../../shared/dictation-stream-transport";
import { layer as callbacksLayer } from "../../app/ScopedCallbackRuntime";
import type { connectDictationStreamingRpc } from "../../platform/electron/DictationStreamingRpc";
import { live as liveDictationStreamingIpc } from "./DictationStreamingIpc";

describe("DictationIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    ...args: readonly unknown[]
  ) => Effect.Effect<unknown, DictationIpcError | CodexMediaError | DictationDictionaryError>;

  it.effect(
    "imports only a trusted window's single native WebM selection and preserves cancellation",
    () =>
      Effect.gen(function* () {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-dictation-import-ipc-"));
        const scope = yield* Scope.make();
        try {
          const selected = path.join(root, "Interview.webm");
          const bytes = new Uint8Array([
            0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, 0x18, 0x53,
            0x80, 0x67, 0xff, 0xe7, 0x81, 0,
          ]);
          fs.writeFileSync(selected, bytes);
          const handlers = new Map<string, Handler>();
          const imports: DictationRecordingImportInput[] = [];
          let selection: OpenDialogReturnValue = { canceled: true, filePaths: [] };
          const showOpenDialog = vi.fn(
            async (_owner: BrowserWindow, _options: OpenDialogOptions) => selection,
          );
          let destroyed = false;
          const owner = { isDestroyed: () => destroyed } as BrowserWindow;
          const ipc = makeTestElectronIpc({
            handle: (channel, handler) =>
              Effect.acquireRelease(
                Effect.sync(() => handlers.set(channel, handler as Handler)),
                () => Effect.sync(() => handlers.delete(channel)),
              ).pipe(Effect.asVoid),
            on: () => Effect.void,
          });
          yield* Layer.buildWithScope(
            live({
              authorize: (event) => {
                if (event.sender.id === 9) throw new Error("Untrusted renderer");
              },
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(ElectronIpc, ipc),
                  mainConfigLayer(),
                  Layer.succeed(CodexMedia, {} as CodexMedia["Service"]),
                  Layer.succeed(DictationDictionary, {} as DictationDictionary["Service"]),
                  Layer.succeed(DictationRuntime, {
                    importRecording: (input: DictationRecordingImportInput) =>
                      Effect.sync(() => {
                        imports.push(input);
                        return {
                          schemaVersion: 1,
                          id: input.id,
                          fileName: input.fileName,
                          createdAtMs: 1,
                          updatedAtMs: 1,
                          durationMs: 0,
                          mimeType: "audio/webm",
                          sizeBytes: input.bytes.byteLength,
                          chunkCount: 1,
                          status: "completed",
                          surface: "file",
                        } satisfies DictationRecordingMetadata;
                      }),
                  } as unknown as DictationRuntime["Service"]),
                  Layer.succeed(ElectronDesktop, {
                    dialog: { showOpenDialog },
                  } as unknown as ElectronDesktop["Service"]),
                  Layer.succeed(WindowRuntime, {
                    get: (id: number) => (id === 7 ? owner : null),
                  } as WindowRuntime["Service"]),
                ),
              ),
            ),
            scope,
          );
          const invoke = (id: number) =>
            handlers.get("codex:dictation:history:import-file")!({
              sender: { id },
            } as IpcMainInvokeEvent);
          assert.isTrue(Exit.isFailure(yield* Effect.exit(invoke(9))));
          assert.isTrue(Exit.isFailure(yield* Effect.exit(invoke(8))));
          assert.strictEqual(showOpenDialog.mock.calls.length, 0);
          assert.strictEqual(yield* invoke(7), null);
          assert.strictEqual(imports.length, 0);
          selection = { canceled: false, filePaths: [selected] };
          const imported = (yield* invoke(7)) as DictationRecordingMetadata;
          assert.strictEqual(imported.fileName, "Interview.webm");
          assert.strictEqual(imported.surface, "file");
          assert.match(imported.id, /^[a-f0-9-]{36}$/u);
          assert.deepStrictEqual(imports[0]?.bytes, bytes);
          assert.deepStrictEqual(Object.keys(imports[0]!).sort(), ["bytes", "fileName", "id"]);
          assert.strictEqual(showOpenDialog.mock.calls[0]?.[0], owner);
          const invalid = path.join(root, "NotAudio.webm");
          fs.writeFileSync(invalid, new Uint8Array([1, 2, 3]));
          selection = { canceled: false, filePaths: [invalid] };
          assert.isTrue(Exit.isFailure(yield* Effect.exit(invoke(7))));
          selection = { canceled: false, filePaths: [selected, invalid] };
          assert.isTrue(Exit.isFailure(yield* Effect.exit(invoke(7))));
          assert.strictEqual(imports.length, 1);
          selection = { canceled: false, filePaths: [selected] };
          showOpenDialog.mockImplementationOnce(async () => {
            destroyed = true;
            return selection;
          });
          assert.isTrue(Exit.isFailure(yield* Effect.exit(invoke(7))));
          assert.strictEqual(imports.length, 1);
        } finally {
          yield* Scope.close(scope, Exit.void);
          fs.rmSync(root, { recursive: true, force: true });
        }
      }),
  );

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
        readRealtimeVoicePreference: () => Effect.succeed(null),
        realtimeVoiceProductPolicy: Effect.succeed(EMPTY_REALTIME_VOICE_PRODUCT_POLICY),
        realtimeVoicePolicyChanges: Stream.empty,
        dictationState: Effect.die("unused"),
        dictationPolicySnapshot: Effect.die("unused"),
        readVoiceLanguage: Effect.succeed("auto"),
        updateVoiceLanguage: (language) => Effect.succeed(language),
        transcribe: () =>
          Effect.never.pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        cleanupTranscript: ({ transcript }) =>
          Effect.succeed(dictationTextResult(`cleaned:${transcript}`, "cleanup")),
        openStreaming: () => Effect.die("unused"),
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
        createDownloadView: () => {
          throw new Error("unused");
        },
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
      assert.strictEqual(
        yield* handlers.get("global-dictation-hotkey-capture:cancel")!(owner),
        true,
      );
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
      assert.strictEqual(
        yield* handlers.get("codex:dictation:voice-language:read")!(owner),
        "auto",
      );
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
          yield* Effect.exit(
            handlers.get("codex:dictation:voice-language:update")!(stranger, "en"),
          ),
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
});

describe("DictationStreamingIpc", () => {
  class Port extends EventEmitter {
    closed = false;
    close(): void {
      if (this.closed) return;
      this.closed = true;
      this.emit("close");
    }
  }
  class Sender extends EventEmitter implements WebContentsDestructionSource {
    destroyed = false;
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
      this.emit("destroyed");
    }
    constructor(readonly id: number) {
      super();
    }
  }

  const fixture = Effect.fn("fixture")(function* () {
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    let ingress: ((event: IpcMainEvent, ...args: unknown[]) => void) | undefined;
    const retired = vi.fn();
    const connect = vi.fn((..._args: Parameters<typeof connectDictationStreamingRpc>) => ({
      dispose: retired,
    }));
    const ipc = ElectronSyncIpc.of({
      on: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            expect(channel).toBe(DICTATION_STREAM_CONNECT_CHANNEL);
            ingress = (event, ...args) => {
              Reflect.apply(handler, undefined, [event, ...args]);
            };
          }),
          () =>
            Effect.sync(() => {
              ingress = undefined;
            }),
        ),
    });
    yield* Layer.buildWithScope(
      liveDictationStreamingIpc({
        authorize: (event) => {
          if (event.sender.id === 9) throw new Error("Untrusted renderer");
        },
        connect,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            callbacksLayer,
            mainConfigLayer(),
            Layer.succeed(ElectronSyncIpc, ipc),
            Layer.succeed(CodexMedia, CodexMedia.of({} as CodexMedia["Service"])),
            Layer.succeed(
              DictationRuntime,
              DictationRuntime.of({
                ownsGlobalRenderer: (id: number) => id === 2,
              } as unknown as DictationRuntime["Service"]),
            ),
            Layer.succeed(
              WindowRuntime,
              WindowRuntime.of({
                has: (id: number) => id === 1,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
      ),
      scope,
    );
    const invoke = (sender: Sender, ports: Port[], ...args: unknown[]): void => {
      if (!ingress) throw new Error("Missing streaming port ingress");
      ingress(
        {
          sender: sender as unknown as WebContents,
          ports: ports as unknown as MessagePortMain[],
        } as IpcMainEvent,
        ...args,
      );
    };
    return { scope, connect, retired, invoke };
  });

  it.effect(
    "rejects untrusted, unowned, extra-port and payload requests before socket admission",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture();
        const cases = [
          { id: 9, ports: [new Port()], args: [] },
          { id: 3, ports: [new Port()], args: [] },
          { id: 1, ports: [new Port(), new Port()], args: [] },
          { id: 1, ports: [new Port()], args: [{ token: "renderer-input" }] },
          { id: 1, ports: [new Port()], args: [undefined, "extra"] },
        ];
        for (const input of cases) {
          context.invoke(new Sender(input.id), input.ports, ...input.args);
          expect(input.ports.every((port) => port.closed)).toBe(true);
        }
        const destroyed = new Sender(1);
        destroyed.destroy();
        const orphan = new Port();
        context.invoke(destroyed, [orphan]);
        expect(orphan.closed).toBe(true);
        expect(destroyed.eventNames()).toEqual([]);
        yield* Effect.yieldNow;
        expect(context.connect).not.toHaveBeenCalled();
      }),
  );

  it.effect(
    "binds overlapping composer and global attempts to their owning surface and lifetime",
    () =>
      Effect.gen(function* () {
        const context = yield* fixture();
        const composer = new Sender(1);
        const global = new Sender(2);
        const composerPorts = Array.from({ length: 2 }, () => new Port());
        for (const port of composerPorts) context.invoke(composer, [port], undefined);
        context.invoke(global, [new Port()], undefined);
        yield* Effect.tryPromise(async () => {
          await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(3));
          expect(composer.listenerCount("destroyed")).toBe(1);
          expect(global.listenerCount("destroyed")).toBe(1);
          expect(context.connect.mock.calls.map((args) => args[4])).toEqual([
            "composer",
            "composer",
            "global",
          ]);
          composerPorts[0]!.close();
          await vi.waitFor(() => expect(context.retired).toHaveBeenCalledTimes(1));
          const replacement = new Port();
          context.invoke(composer, [replacement]);
          await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(4));
          expect(replacement.closed).toBe(false);
          expect(composerPorts[1]!.closed).toBe(false);
        });
      }),
  );

  it.effect("retires ports on renderer reload or destruction and removes lifecycle listeners", () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const sender = new Sender(1);
      const port = new Port();
      context.invoke(sender, [port]);
      yield* Effect.tryPromise(async () => {
        await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(1));
        sender.emit("did-start-navigation", {}, "nodex://renderer/#route", true, true);
        sender.emit("did-start-navigation", {}, "https://guest.example", false, false);
        expect(port.closed).toBe(false);
        sender.emit("did-start-navigation", {}, "nodex://renderer/", false, true);
        await vi.waitFor(() => expect(context.retired).toHaveBeenCalledTimes(1));
        expect(port.closed).toBe(true);
        expect(sender.listenerCount("destroyed")).toBe(0);
        expect(sender.listenerCount("did-start-navigation")).toBe(0);
        const replacement = new Port();
        context.invoke(sender, [replacement]);
        await vi.waitFor(() => expect(context.connect).toHaveBeenCalledTimes(2));
        sender.destroy();
        expect(replacement.closed).toBe(true);
        expect(context.retired).toHaveBeenCalledTimes(2);
      });
    }),
  );

  it.effect("closes every admitted port when the application Scope shuts down", () =>
    Effect.gen(function* () {
      const context = yield* fixture();
      const port = new Port();
      context.invoke(new Sender(1), [port]);
      yield* Effect.tryPromise(async () => {
        await vi.waitFor(() => expect(context.connect).toHaveBeenCalledOnce());
      });
      yield* Scope.close(context.scope, Exit.void);
      expect(port.closed).toBe(true);
      expect(context.retired).toHaveBeenCalledOnce();
    }),
  );
});

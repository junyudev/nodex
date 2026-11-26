import { describe, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent, IpcMainEvent, BrowserWindow } from "electron";
import type { BlockTransferIntent } from "../../../shared/block-transfer";
import { blockTransferFailure } from "../../../shared/block-transfer-transport";
import type { DocumentMutationRequest } from "../../../shared/block-documents/document-operations";
import { documentMutationFailure } from "../../../shared/block-documents/document-operation-transport";
import { testLayer as mainConfigLayer } from "../../app/MainConfig";
import type { RendererClientRuntimeService } from "../../codex/renderer-client-runtime-contracts";
import {
  DesktopDocumentSessionRuntime,
  type DesktopDocumentSessionService,
} from "../../core-client";
import { RendererClientRuntime } from "../../host-runtime/RendererClientRuntime";
import { EditorHistoryRuntime } from "../../host-runtime/EditorHistoryRuntime";
import { DatabaseModule } from "../../database-application/DatabaseModule";
import { LibraryModule } from "../../library-application/LibraryModule";
import { makeTestElectronIpc } from "../../platform/electron/ElectronIpc.test-support";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { live } from "./CoreMutationIpc";
import {
  CodexApplicationRequestInbox,
  make as makeRequestInbox,
} from "../../codex-runtime/CodexApplicationRequestInbox";
import { CODEX_HOST_CHUNK_ACK_CHANNEL } from "../../../shared/codex-host-chunked-message";
import { CodexAppProtocolTools } from "../../codex-application/CodexAppProtocolTools";
import {
  CodexApplicationEventHub,
  make as makeApplicationEvents,
} from "../../codex-application/CodexApplicationEventHub";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "../../codex-application/CodexRendererPresentationRegistry";
import { CodexUserInputAutoResolution } from "../../codex-application/CodexUserInputAutoResolution";
import {
  live as liveCodexRendererIpc,
  routeRendererDeliveryAcknowledgment,
} from "./CodexRendererIpc";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { MainShutdown, type MainShutdownReason } from "../../app/MainShutdown";
import { StoreAdministration } from "../../core-runtime/StoreAdministration";
import { live as liveStoreAdministrationIpc } from "./StoreAdministrationIpc";
import { ApplicationWindowRuntime } from "../../window-runtime/ApplicationWindowRuntime";
import {
  ApplicationWindowIpcError,
  live as liveApplicationWindowIpc,
} from "./ApplicationWindowIpc";
import { ApplicationMenuRuntime } from "../../host-runtime/ApplicationMenuRuntime";

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  // The consolidated handlers load these native adapters before their test Layers are supplied.
  protocol: { registerSchemesAsPrivileged: () => {} },
  systemPreferences: undefined,
  nativeTheme: undefined,
}));

describe("CoreMutationIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

  const rendererEvent = (id: number): IpcMainInvokeEvent => {
    const frame = { url: "app://-/index.html" };
    return {
      sender: { getType: () => "window", id, mainFrame: frame },
      senderFrame: frame,
    } as unknown as IpcMainInvokeEvent;
  };

  const mutation: DocumentMutationRequest = {
    mutationId: "mutation:one",
    projectId: "project:one",
    storeEpoch: "epoch:one",
    clientSessionId: "spoofed",
    actor: { kind: "spoofed" },
    documentId: "document:one",
    generation: 1,
    expectedHeadSeq: 3,
    operations: [
      {
        kind: "set_rich_title",
        richTitle: [{ type: "text", text: "Current", styles: {} }],
      },
    ],
  };

  const transfer = {
    operationId: "transfer:one",
    projectId: "project:one",
    storeEpoch: "epoch:one",
    mode: "move",
    rootBlockIds: ["block:one"],
    causalDependencies: [],
    source: { kind: "document", documentId: "document:one" },
    target: { kind: "document", documentId: "document:two" },
    promotionPolicy: "literal",
  } as const;

  it.effect("owns typed Core mutation ingress and binds exact renderer and Project authority", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.die("unused"),
      });
      const documentMutations: DocumentMutationRequest[] = [];
      const transfers: BlockTransferIntent[] = [];
      const transferOwners: number[] = [];
      const abandonedTransfers: BlockTransferIntent[] = [];
      const historyReads: unknown[] = [];
      const documents = {
        applyDocumentMutation: (request: DocumentMutationRequest) => {
          documentMutations.push(request);
          return Effect.succeed({
            ok: false as const,
            error: documentMutationFailure("unknown", "captured", {
              mutationId: request.mutationId,
            }),
          });
        },
        transferBlocks: (intent: BlockTransferIntent) => {
          transfers.push(intent);
          return Effect.succeed({
            ok: false as const,
            error: blockTransferFailure("unknown", "captured", {
              operationId: intent.operationId,
            }),
          });
        },
        listVersions: (request: unknown) => {
          historyReads.push(request);
          return Effect.succeed({ ok: true as const, value: [] });
        },
      } as unknown as DesktopDocumentSessionService;
      const rendererClients = {
        ensureClient: (target: { readonly id: number }) => ({
          clientId: `renderer:${target.id}`,
          webContentsId: target.id,
          release: Effect.void,
        }),
      } as unknown as RendererClientRuntimeService;
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(DatabaseModule, DatabaseModule.of({} as DatabaseModule["Service"])),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(DesktopDocumentSessionRuntime, documents),
              Layer.succeed(RendererClientRuntime, rendererClients),
              Layer.succeed(LibraryModule, LibraryModule.of({} as LibraryModule["Service"])),
              Layer.succeed(
                EditorHistoryRuntime,
                EditorHistoryRuntime.of({
                  applyDatabase: () => Effect.die("unexpected Database mutation"),
                  applyLibraryDatabase: () => Effect.die("unexpected Library Database mutation"),
                  transferBlocks: (target, intent) => {
                    transferOwners.push(target.id);
                    return documents.transferBlocks(intent);
                  },
                  reverseBlockTransfer: () => Effect.die("unexpected transfer reversal"),
                  apply: () => Effect.die("unexpected history mutation"),
                  handoffRelease: () => Effect.die("unexpected cleanup"),
                  handoffAbandon: () => Effect.die("unexpected abandoned replay"),
                  handoffAbandonTransfer: (target, intent) => {
                    assert.equal(target.id, 7);
                    abandonedTransfers.push(intent);
                    return Effect.succeed({ accepted: true });
                  },
                }),
              ),
              mainConfigLayer(),
              Layer.succeed(WindowRuntime, {
                has: (id: number) => id === 7,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );

      const trusted = rendererEvent(7);
      const untrusted = rendererEvent(8);
      const mutate = handlers.get("block-documents:mutate")!;
      const denied = yield* mutate(untrusted, "project:one", "document:one", mutation);
      assert.isFalse((denied as { readonly ok: boolean }).ok);
      const mismatched = yield* mutate(trusted, "project:other", "document:one", mutation);
      assert.isFalse((mismatched as { readonly ok: boolean }).ok);
      assert.strictEqual(documentMutations.length, 0);
      yield* mutate(trusted, "project:one", "document:one", mutation);
      assert.deepStrictEqual(documentMutations[0]?.actor, {
        kind: "electron_renderer",
        clientId: "renderer:7",
      });
      assert.strictEqual(documentMutations[0]?.clientSessionId, "renderer:7");

      yield* handlers.get("blocks:transfer")!(trusted, "project:one", transfer);
      assert.deepStrictEqual(transferOwners, [7]);
      assert.strictEqual(transfers[0]?.projectId, "project:one");
      assert.strictEqual(transfers[0]?.clientSessionId, "renderer:7");
      assert.deepStrictEqual(transfers[0]?.actor, {
        kind: "electron_renderer",
        clientId: "renderer:7",
      });
      const abandon = handlers.get("editor-history:abandon-transfer")!;
      const deniedAbandon = yield* abandon(untrusted, "project:one", transfer);
      assert.isFalse((deniedAbandon as { accepted: boolean }).accepted);
      const mismatchAbandon = yield* abandon(trusted, "project:other", transfer);
      assert.isFalse((mismatchAbandon as { accepted: boolean }).accepted);
      assert.deepEqual(abandonedTransfers, []);
      assert.deepEqual(yield* abandon(trusted, "project:one", transfer), { accepted: true });
      assert.deepEqual(abandonedTransfers, transfers);

      const listed = yield* handlers.get("block-documents:history:list")!(trusted, {
        projectId: "project:one",
        documentId: "document:one",
        limit: 25,
      });
      assert.isTrue((listed as { readonly ok: boolean }).ok);
      assert.deepStrictEqual(historyReads, [
        { projectId: "project:one", documentId: "document:one", limit: 25 },
      ]);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(handlers.size, 0);
    }),
  );
});

describe("CodexRendererIpc", () => {
  type OnHandler = (event: IpcMainEvent, ...args: readonly unknown[]) => Effect.Effect<void>;

  it.effect("registers ACK ingress and routes only validated renderer delivery envelopes", () =>
    Effect.gen(function* () {
      const onHandlers = new Map<string, OnHandler>();
      const register = (channel: string, handler?: OnHandler) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            if (handler) onHandlers.set(channel, handler);
          }),
          () => Effect.sync(() => onHandlers.delete(channel)),
        );
      const ipc = makeTestElectronIpc({
        handle: (channel: string) => register(channel),
        on: (channel: string, handler: OnHandler) => register(channel, handler),
      });
      const handled: Array<readonly [string, number]> = [];
      const rendererClients = RendererClientRuntime.of(
        {} as unknown as RendererClientRuntime["Service"],
      );
      const scope = yield* Scope.make();
      const empty = {} as never;
      yield* Layer.buildWithScope(
        liveCodexRendererIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.effect(CodexApplicationRequestInbox, makeRequestInbox),
              Layer.succeed(
                CodexAppProtocolTools,
                empty as unknown as CodexAppProtocolTools["Service"],
              ),
              Layer.effect(CodexApplicationEventHub, makeApplicationEvents),
              Layer.effect(CodexRendererPresentationRegistry, makePresentationRegistry),
              Layer.succeed(
                CodexUserInputAutoResolution,
                empty as unknown as CodexUserInputAutoResolution["Service"],
              ),
              Layer.succeed(ElectronIpc, ipc),
              mainConfigLayer(),
              Layer.succeed(RendererClientRuntime, rendererClients),
              Layer.succeed(WindowRuntime, {
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );

      assert.isDefined(onHandlers.get(CODEX_HOST_CHUNK_ACK_CHANNEL));
      const route = (transferId: unknown, sequence: unknown) =>
        routeRendererDeliveryAcknowledgment(
          transferId,
          sequence,
          (parsedTransferId, parsedSequence) =>
            Effect.sync(() => {
              handled.push([parsedTransferId, parsedSequence]);
            }),
        );
      yield* route("transfer:one", 2);
      yield* route("transfer:one", 2.5);
      yield* route(7, 2);

      assert.deepEqual(handled, [["transfer:one", 2]]);
      yield* Scope.close(scope, Exit.void);
      assert.isFalse(onHandlers.has(CODEX_HOST_CHUNK_ACK_CHANNEL));
    }),
  );
});

describe("StoreAdministrationIpc", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: readonly unknown[]) => Effect.Effect<unknown>;

  it.effect("owns Store administration ingress and commits restore shutdown atomically", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel: string, handler: Handler) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              handlers.set(channel, handler);
            }),
            () => Effect.sync(() => handlers.delete(channel)),
          ),
        on: () => Effect.die("unused"),
      });
      const shutdownReasons: MainShutdownReason[] = [];
      const shutdownRequested = yield* Deferred.make<void>();
      const finishShutdownRequest = yield* Deferred.make<void>();
      const shutdown = MainShutdown.of({
        request: (reason) =>
          Effect.gen(function* () {
            shutdownReasons.push(reason);
            yield* Deferred.succeed(shutdownRequested, undefined);
            yield* Deferred.await(finishShutdownRequest);
            return true;
          }),
        isRequested: Effect.succeed(false),
        awaitRequest: Effect.never,
        markRuntimeClosed: () => Effect.succeed(true),
        awaitRuntimeClosed: Effect.never,
      });
      const administration = StoreAdministration.of({
        listBackups: Effect.succeed([]),
        backupCapacity: Effect.succeed({
          availableBytes: 1_000_000,
          estimatedNextBackupBytes: 120,
          safetyMarginBytes: 512,
          totalReadyBytes: 0,
          manualReadyBytes: 0,
          automaticReadyBytes: 0,
          canCreate: true,
        }),
        snapshotStorageOptimization: Effect.succeed({
          optimizing: false,
          commitHead: 0,
          replayFloor: 0,
          pendingCommitMetadata: 0,
          pendingReceiptMetadata: 0,
          retainedCommitCount: 0,
          retainedDeliveryBytes: 0,
          retainedReceiptCount: 0,
          retainedReceiptBytes: 0,
          receiptFloorAt: null,
          lastPrunedCommit: 0,
          freelistPages: 0,
          reclaimableBytes: 0,
        }),
        createBackup: () => Effect.die("unused"),
        startBackup: () => Effect.die("unused"),
        backupJob: () => Effect.succeed(null),
        cancelBackup: () => Effect.die("unused"),
        deleteBackup: () => Effect.die("unused"),
        restoreBackup: (input) =>
          Effect.succeed({ success: true, restoredBackupId: input.backupId }),
        pruneBackups: () => Effect.die("unused"),
        planMaintenance: () => Effect.die("unused"),
        runMaintenance: () => Effect.die("unused"),
        requestErasure: Effect.void,
        erasureRequests: Stream.empty,
      });
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        liveStoreAdministrationIpc.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ElectronIpc, ipc),
              mainConfigLayer(),
              Layer.succeed(MainShutdown, shutdown),
              Layer.succeed(StoreAdministration, administration),
              Layer.succeed(WindowRuntime, {
                has: () => true,
              } as unknown as WindowRuntime["Service"]),
            ),
          ),
        ),
        scope,
      );

      const frame = { url: "app://-/index.html" };
      const event = {
        sender: { getType: () => "window", id: 7, mainFrame: frame },
        senderFrame: frame,
      } as unknown as IpcMainInvokeEvent;
      const restoreFiber = yield* Effect.forkChild(
        handlers.get("backup:restore")!(event, {
          backupId: "backup-1",
          confirm: true,
        }),
      );
      yield* Deferred.await(shutdownRequested);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(restoreFiber));
      assert.deepStrictEqual(shutdownReasons, [{ _tag: "StoreRestoreRelaunch" }]);
      yield* Deferred.succeed(finishShutdownRequest, undefined);
      yield* Fiber.join(interruption);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(handlers.size, 0);
    }),
  );
});

describe("ApplicationWindowIpc", () => {
  type Handler = (
    event: IpcMainInvokeEvent,
    ...args: readonly unknown[]
  ) => Effect.Effect<unknown, ApplicationWindowIpcError>;

  it.effect("owns trusted window ingress and validates new-window requests", () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = makeTestElectronIpc({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      const openForRequest = vi.fn();
      const validatePageTarget = vi.fn((): Effect.Effect<void, Error> => Effect.void);
      const publishHistory = vi.fn(() => Effect.void);
      const snapshot = vi.fn(() => Effect.succeed({ menus: [] }));
      const invoke = vi.fn(() => Effect.succeed(true));
      const applicationWindows = ApplicationWindowRuntime.of({
        openForRequest,
      } as unknown as ApplicationWindowRuntime["Service"]);
      const focusedWindow = {
        isFocused: () => true,
        isFullScreen: () => true,
      } as unknown as BrowserWindow;
      const resolveRendererGeneration = vi.fn(() => "renderer-1");
      const windows = WindowRuntime.of({
        get: () => focusedWindow,
        has: () => true,
        bootstrap: () => ({ activeSpaceId: undefined }),
        resolveRendererGeneration,
      } as unknown as WindowRuntime["Service"]);
      const scope = yield* Scope.make();
      yield* Layer.buildWithScope(
        liveApplicationWindowIpc({ validatePageTarget }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ApplicationWindowRuntime, applicationWindows),
              Layer.succeed(ElectronIpc, ipc),
              mainConfigLayer({ rendererUrl: "http://localhost:5173" }),
              Layer.succeed(WindowRuntime, windows),
              Layer.succeed(
                ApplicationMenuRuntime,
                ApplicationMenuRuntime.of({
                  snapshot,
                  invoke,
                  refresh: () => undefined,
                  bindHistory: () => Effect.succeed(1),
                  publishHistory,
                }),
              ),
            ),
          ),
        ),
        scope,
      );

      const frame = { url: "http://localhost:5173" };
      const sender = {
        getType: () => "window",
        id: 17,
        mainFrame: frame,
      };
      const event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
      assert.deepEqual(yield* handlers.get("application-menu:snapshot")!(event), { menus: [] });
      assert.isTrue(yield* handlers.get("application-menu:invoke")!(event, "menu-item-1"));
      assert.deepEqual(snapshot.mock.calls, [[17]]);
      assert.deepEqual(invoke.mock.calls, [[17, "menu-item-1"]]);
      assert.isTrue(yield* handlers.get("electron-window:fullscreen:get")!(event));
      for (const input of [null, 10, "", {}]) {
        assert.isTrue(
          Exit.isFailure(
            yield* handlers.get("application-menu:invoke")!(event, input).pipe(Effect.exit),
          ),
        );
      }
      assert.isTrue(
        Exit.isFailure(
          yield* handlers.get("window:appearance:sync")!(event, {
            theme: "dark",
            shellZoom: -1,
          }).pipe(Effect.exit),
        ),
      );
      yield* handlers.get("window:new")!(event, { activeProjectSessionId: "session-1" });
      assert.strictEqual(openForRequest.mock.calls.length, 1);
      assert.deepEqual(openForRequest.mock.calls[0], [17, { activeProjectSessionId: "session-1" }]);
      const newWindow = handlers.get("window:new")!;
      const page = { pageId: "page-1" };
      const malformed = yield* newWindow(event, { page: { ...page, pageId: "" } }).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(malformed));
      assert.strictEqual(validatePageTarget.mock.calls.length, 0);
      validatePageTarget.mockReturnValueOnce(Effect.fail(new Error("This Page is unavailable")));
      assert.isTrue(Exit.isFailure(yield* newWindow(event, { page }).pipe(Effect.exit)));
      assert.strictEqual(openForRequest.mock.calls.length, 1);
      resolveRendererGeneration.mockReturnValueOnce("previous-renderer");
      assert.isTrue(Exit.isFailure(yield* newWindow(event, { page }).pipe(Effect.exit)));
      assert.strictEqual(openForRequest.mock.calls.length, 1);
      assert.isTrue(yield* newWindow(event, { page }));
      assert.deepEqual(openForRequest.mock.calls[1], [17, { page }]);
      assert.strictEqual(yield* handlers.get("surface-history:bind")!(event), 1);
      const publication = { generation: 1, sequence: 1, snapshot: null };
      yield* handlers.get("surface-history:publish")!(event, publication);
      assert.deepEqual(publishHistory.mock.calls, [[17, publication]]);
      const invalid = yield* handlers.get("surface-history:publish")!(event, {
        ...publication,
        generation: -1,
      }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(invalid));
      const foreign = {
        ...event,
        senderFrame: { url: "https://untrusted.example" },
      } as unknown as IpcMainInvokeEvent;
      const rejected = yield* handlers.get("surface-history:publish")!(foreign, publication).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(rejected));
      assert.isTrue(
        Exit.isFailure(
          yield* handlers.get("application-menu:invoke")!(foreign, "menu-item-1").pipe(Effect.exit),
        ),
      );
      assert.strictEqual(publishHistory.mock.calls.length, 1);

      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(handlers.size, 0);
    }),
  );
});

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import { vi } from "vite-plus/test";
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

vi.mock("electron", () => ({ BrowserWindow: { fromWebContents: () => ({}) } }));

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

    assert.strictEqual(handlers.size, 24);
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

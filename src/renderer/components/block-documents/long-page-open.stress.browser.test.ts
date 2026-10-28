import { BlockNoteEditor } from "@blocknote/core";
import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";

import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  type DocumentSyncApplyRequest,
  type DocumentSyncRealtimeEvent,
} from "../../../shared/block-documents";
import { createPageDocumentGenesis } from "../../../shared/block-documents/block-document-codec";
import { BlockDocumentSurfaceRuntime } from "../../lib/block-document-surface-runtime";
import type { DocumentSyncAdapter } from "../../lib/nodex-y-provider";
import { createNfmEditorModeOptions } from "../board/editor/nfm-editor-source";
import type { PrimaryPageBlockDocumentDescriptor } from "./block-document-surface";

const LONG_CARD_SECTION =
  "## Working notes\n\nThis is a **formatted** paragraph with enough text to exercise collaborative rendering.\n\n:::toggle[Details]\n  Nested explanation\n\n  - Nested list item\n:::\n\n### Follow-up\n\nAnother paragraph after the nested content.";

class LongCardAdapter implements DocumentSyncAdapter {
  readonly serverDocument: Y.Doc;
  headSeq = 20;
  applyCalls = 0;
  private readonly listeners = new Set<(event: DocumentSyncRealtimeEvent) => void>();

  constructor(document: Y.Doc) {
    this.serverDocument = document;
  }

  sync: DocumentSyncAdapter["sync"] = async (request) => ({
    ok: true,
    value: {
      documentId: request.documentId,
      storeEpoch: "store-edited-long-card",
      generation: 1,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.serverDocument),
      update: Y.encodeStateAsUpdate(this.serverDocument, request.stateVector),
    },
  });

  applyUpdate = async (request: DocumentSyncApplyRequest) => {
    this.applyCalls += 1;
    const before = Y.encodeStateAsUpdate(this.serverDocument);
    Y.applyUpdate(this.serverDocument, request.update);
    const after = Y.encodeStateAsUpdate(this.serverDocument);
    const changed =
      before.byteLength !== after.byteLength ||
      before.some((value, index) => value !== after[index]);
    if (!changed) {
      return {
        ok: false as const,
        error: {
          code: "invalid_document_update" as const,
          message: "Document update does not add any new causal or delete state",
          retryable: false,
          resetRequired: false,
        },
      };
    }
    this.headSeq += 1;
    return {
      ok: true as const,
      value: {
        documentId: request.documentId,
        storeEpoch: request.storeEpoch,
        generation: request.generation,
        updateId: request.updateId,
        committedSeq: this.headSeq,
        headSeq: this.headSeq,
        stateVector: Y.encodeStateVector(this.serverDocument),
        duplicate: false,
        status: "committed" as const,
        commit: {
          store_epoch: request.storeEpoch,
          commit_seq: this.headSeq,
          manifest_hash: "f".repeat(64),
        },
      },
    };
  };

  subscribe: DocumentSyncAdapter["subscribe"] = (_request, listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  publishAwareness: DocumentSyncAdapter["publishAwareness"] = async () => ({
    ok: true,
    value: { accepted: true },
  });
}

const deleteCheckpointDatabase = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase("nodex-document-cache");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("checkpoint database deletion blocked"));
  });

const waitForRuntimeOutcome = async (
  runtime: BlockDocumentSurfaceRuntime,
): Promise<ReturnType<BlockDocumentSurfaceRuntime["getStatus"]>> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = runtime.getStatus();
    if (status.ready || status.error) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return runtime.getStatus();
};

describe("long Card collaborative open lifecycle", () => {
  test("opens an edited long Card on every mount", async () => {
    await deleteCheckpointDatabase();
    let nextBlockId = 0;
    const genesis = createPageDocumentGenesis({
      documentId: "document:edited-long-card-browser",
      title: "Edited long Card",
      markdown: Array.from(
        { length: 48 },
        (_, index) => `${LONG_CARD_SECTION}\nParagraph ${index + 1}`,
      ).join("\n"),
      allocateBlockId: () => `long-card-block-${++nextBlockId}`,
    });
    const serverDocument = genesis.document;
    const title = serverDocument.getText("title");
    for (let index = 0; index < 64; index += 1) {
      const transient = ` transient-${index}`;
      title.insert(title.length, transient);
      title.delete(title.length - transient.length, transient.length);
    }
    expect(Y.decodeUpdate(Y.encodeStateAsUpdate(serverDocument)).ds.clients.size).toBeGreaterThan(
      0,
    );
    const adapter = new LongCardAdapter(serverDocument);
    const descriptor: PrimaryPageBlockDocumentDescriptor = {
      libraryId: "library-edited-long-card",
      routingContext: {
        kind: "project",
        projectId: "project-edited-long-card",
      },
      ownerBlockId: "card-edited-long-card",
      ownerType: "page",
      ownerLifecycle: "active",
      documentId: serverDocument.guid,
      storeEpoch: "store-edited-long-card",
      generation: 1,
      headSeq: adapter.headSeq,
      schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
      schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
      readiness: "ready",
      sync: { kind: "yjs", stateVector: Y.encodeStateVector(serverDocument) },
    };
    const errors: string[] = [];

    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const runtime = new BlockDocumentSurfaceRuntime({ descriptor, adapter });
      let editor: BlockNoteEditor | null = null;
      const host = document.createElement("div");
      document.body.append(host);
      try {
        await runtime.connect();
        const status = await waitForRuntimeOutcome(runtime);
        const ready = runtime.getReadyDocument();
        if (!ready || ready.kind !== "page") {
          throw (
            status.error ??
            new Error(
              `runtime did not become ready: ${JSON.stringify({
                phase: status.phase,
                provider: status.provider,
              })}`,
            )
          );
        }
        editor = BlockNoteEditor.create(
          createNfmEditorModeOptions({
            kind: "collaborative-document",
            documentId: descriptor.documentId,
            storeEpoch: descriptor.storeEpoch,
            generation: descriptor.generation,
            clientSessionId: runtime.clientSessionId,
            fragment: ready.body,
            user: { name: "Browser", color: "#2563eb" },
          }),
        );
        editor.mount(host);
        await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      } catch (error) {
        errors.push(
          `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        editor?.unmount();
        host.remove();
        const close = await runtime.close();
        if (close.flush === "failed" || close.checkpoint === "failed") {
          errors.push(`attempt ${attempt} close: ${JSON.stringify(close)}`);
        }
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
    expect(adapter.applyCalls).toBe(0);
    serverDocument.destroy();
  });
});

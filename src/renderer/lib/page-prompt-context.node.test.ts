import { describe, expect, test, vi } from "vite-plus/test";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents";
import { createPageDocumentGenesis } from "../../shared/block-documents/block-document-codec";
import type { BlockDocumentSurfaceRuntime } from "./block-document-surface-runtime";
import type { DocumentSyncAdapter } from "./nodex-y-provider";
import { buildPagePromptContext, materializePreparedPageDocument } from "./page-prompt-context";

const descriptor = (): OwnedDocumentDescriptor => ({
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-a" },
  ownerBlockId: "page-1",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document-1",
  storeEpoch: "epoch-1",
  generation: 1,
  headSeq: 1,
  schemaKey: "nodex.page",
  schemaVersion: 3,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array() },
});

describe("page prompt context", () => {
  test("compiles canonical Page NFM into a stable prompt with image inputs", () => {
    const context = buildPagePromptContext({
      projectId: "project-a",
      pageId: "page-1",
      pageKey: "LAB-13",
      title: "Release plan",
      nfm: '<image source="nodex://assets/diagram.png">Architecture</image>\n\nShip it',
    });

    expect(context.source).toBe("nodex://pages/page-1");
    expect(context.pageKey).toBe("LAB-13");
    expect(context.promptInput.text).toBe(
      "Page: Release plan\nPage key: LAB-13\nSource: nodex://pages/page-1\n\n[Image #1] (caption: Architecture)\nShip it",
    );
    expect(context.promptInput.images).toEqual([
      {
        source: "nodex://assets/diagram.png",
        caption: "Architecture",
      },
    ]);
  });

  test("uses the stable untitled label when the canonical title is empty", () => {
    const context = buildPagePromptContext({
      projectId: "project-a",
      pageId: "page-1",
      title: "  ",
      nfm: "Body",
    });

    expect(context.title).toBe("Untitled Page");
    expect(context.pageKey).toBeUndefined();
    expect(context.promptInput.text.startsWith("Page: Untitled Page")).toBe(true);
  });

  test("materializes prepared Page content and closes its runtime", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document-1",
      title: "Canonical title",
      nfm: "# Release\n\nShip it",
    });
    const connect = vi.fn(async () => undefined);
    const whenReady = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const runtime = {
      document: genesis.document,
      connect,
      whenReady,
      close,
    } as unknown as BlockDocumentSurfaceRuntime;

    try {
      const materialized = await materializePreparedPageDocument({
        routingContext: { kind: "project", projectId: "project-a" },
        descriptor: descriptor(),
        createRuntime: () => runtime,
        createAdapter: () => ({}) as DocumentSyncAdapter,
      });

      expect(materialized.title).toBe("Canonical title");
      expect(materialized.nfm).toBe("# Release\nShip it");
      expect(connect).toHaveBeenCalledOnce();
      expect(whenReady).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
    } finally {
      genesis.document.destroy();
    }
  });

  test("closes the Page runtime when readiness fails", async () => {
    const genesis = createPageDocumentGenesis({
      documentId: "document-1",
      title: "Canonical title",
      nfm: "Body",
    });
    const close = vi.fn(async () => undefined);
    const runtime = {
      document: genesis.document,
      connect: vi.fn(async () => undefined),
      whenReady: vi.fn(async () => {
        throw new Error("sync failed");
      }),
      close,
    } as unknown as BlockDocumentSurfaceRuntime;

    try {
      await expect(
        materializePreparedPageDocument({
          routingContext: { kind: "project", projectId: "project-a" },
          descriptor: descriptor(),
          createRuntime: () => runtime,
          createAdapter: () => ({}) as DocumentSyncAdapter,
        }),
      ).rejects.toThrow("sync failed");
      expect(close).toHaveBeenCalledOnce();
    } finally {
      genesis.document.destroy();
    }
  });
});

import { act, fireEvent, waitFor } from "@testing-library/react";
import { Activity } from "react";
import { describe, expect, test } from "vite-plus/test";
import * as Y from "yjs";
import {
  PAGE_DOCUMENT_SCHEMA_KEY,
  PAGE_DOCUMENT_SCHEMA_VERSION,
  createPageDocument,
} from "../../../shared/block-documents/page-document";
import {
  createSyncedBlockDocument,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
  SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
  SYNCED_BLOCK_SOURCE_TYPE,
} from "../../../shared/block-documents/synced-block-document";
import type {
  DocumentSyncApplyRequest,
  DocumentSyncCommandResult,
  DocumentSyncRealtimeEvent,
  DocumentSyncResponse,
} from "../../../shared/block-documents/document-sync";
import { populateBlockDocumentBodyFromBlockTree } from "../../../shared/block-documents/block-document-codec";
import { render } from "@/test/dom";
import { BlockDocumentSurfaceRuntime } from "@/lib/block-document-surface-runtime";
import type { DocumentSyncAdapter } from "@/lib/nodex-y-provider";
import {
  BlockDocumentSurface,
  OwnedBlockDocumentSurface,
  type BlockDocumentSurfaceDependencies,
  type PrimaryPageBlockDocumentDescriptor,
  type PrimaryOwnedBlockDocumentDescriptor,
} from "./block-document-surface";

const descriptor = (
  overrides: Partial<PrimaryPageBlockDocumentDescriptor> = {},
): PrimaryPageBlockDocumentDescriptor => ({
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-1" },
  ownerBlockId: "card-1",
  ownerType: "page",
  ownerLifecycle: "active",
  documentId: "document:card-1",
  storeEpoch: "store-1",
  generation: 1,
  headSeq: 0,
  schemaKey: PAGE_DOCUMENT_SCHEMA_KEY,
  schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "yjs", stateVector: new Uint8Array([0]) },
  ...overrides,
});

class SurfaceTestAdapter implements DocumentSyncAdapter {
  readonly server: {
    readonly documentId: string;
    readonly document: Y.Doc;
  };
  subscriptions = 0;
  unsubscriptions = 0;
  awarenessPublishes = 0;
  headSeq = 0;

  private readonly listeners = new Set<(event: DocumentSyncRealtimeEvent) => void>();

  constructor(
    server: {
      readonly documentId: string;
      readonly document: Y.Doc;
    } = createPageDocument({
      documentId: "document:card-1",
      initialTitle: "Synced title",
    }),
  ) {
    this.server = server;
  }

  sync = async (request: {
    readonly stateVector: Uint8Array;
  }): Promise<DocumentSyncCommandResult<DocumentSyncResponse>> => ({
    ok: true,
    value: {
      documentId: this.server.documentId,
      storeEpoch: "store-1",
      generation: 1,
      headSeq: this.headSeq,
      stateVector: Y.encodeStateVector(this.server.document),
      update: Y.encodeStateAsUpdate(this.server.document, request.stateVector),
    },
  });

  applyUpdate = async (request: DocumentSyncApplyRequest) => {
    Y.applyUpdate(this.server.document, request.update, "surface-test-client");
    this.headSeq += 1;
    return {
      ok: true as const,
      value: {
        documentId: request.documentId,
        storeEpoch: "store-1",
        generation: 1,
        updateId: request.updateId,
        committedSeq: this.headSeq,
        headSeq: this.headSeq,
        stateVector: Y.encodeStateVector(this.server.document),
        duplicate: false,
        status: "committed" as const,
        commit: {
          store_epoch: "store-1",
          commit_seq: this.headSeq,
          manifest_hash: "f".repeat(64),
        },
      },
    };
  };

  subscribe = (_request: unknown, listener: (event: DocumentSyncRealtimeEvent) => void) => {
    this.subscriptions += 1;
    this.listeners.add(listener);
    return () => {
      this.unsubscriptions += 1;
      this.listeners.delete(listener);
    };
  };

  publishAwareness = async () => {
    this.awarenessPublishes += 1;
    return { ok: true as const, value: { accepted: true as const } };
  };

  emit = (event: DocumentSyncRealtimeEvent): void => {
    this.listeners.forEach((listener) => listener(event));
  };

  destroy = (): void => this.server.document.destroy();
}

describe("BlockDocumentSurface", () => {
  test("uses a surface-specific placeholder until initial sync is ready", async () => {
    const adapter = new SurfaceTestAdapter();
    const view = render(
      <BlockDocumentSurface
        descriptor={descriptor()}
        isActive
        dependencies={{ createAdapter: () => adapter }}
        pendingFallback={<div>Card loading shell</div>}
      >
        {(surface) => <div>{surface.title.toString()}</div>}
      </BlockDocumentSurface>,
    );

    expect(view.getByText("Card loading shell").textContent).toBe("Card loading shell");
    expect(view.queryByText("Opening content…")).toBe(null);
    await waitFor(() => expect(view.getByText("Synced title")).toBeTruthy());

    view.unmount();
    adapter.destroy();
  });

  test("registry-dispatches a body-only Synced Block surface without inventing a title root", async () => {
    const server = createSyncedBlockDocument({
      documentId: "document:synced-source-1",
      initializeBody: false,
    });
    populateBlockDocumentBodyFromBlockTree(server.body, [
      {
        id: "synced-paragraph",
        type: "paragraph",
        props: {},
        content: [{ type: "text", text: "Shared body", styles: {} }],
        children: [],
      },
    ]);
    const adapter = new SurfaceTestAdapter(server);
    const syncedDescriptor: PrimaryOwnedBlockDocumentDescriptor = {
      ...descriptor(),
      ownerBlockId: "synced-source-1",
      ownerType: SYNCED_BLOCK_SOURCE_TYPE,
      documentId: server.documentId,
      schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
      schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
    };
    const view = render(
      <OwnedBlockDocumentSurface
        descriptor={syncedDescriptor}
        isActive
        dependencies={{
          createAdapter: () => adapter,
          createRuntime: (options) =>
            new BlockDocumentSurfaceRuntime({
              ...options,
              localCheckpointStore: null,
            }),
        }}
      >
        {(surface) => (
          <div>
            {surface.kind}:{[...surface.document.share.keys()].sort().join(",")}
          </div>
        )}
      </OwnedBlockDocumentSurface>,
    );

    await waitFor(() => {
      expect(view.getByText("synced_block:body").textContent).toBe("synced_block:body");
    });
    view.unmount();
    adapter.destroy();
  });

  test("opens after sync, retains content sync without inactive presence, and clears its runtime ref on close", async () => {
    const adapter = new SurfaceTestAdapter();
    const runtimeRef: { current: BlockDocumentSurfaceRuntime | null } = {
      current: null,
    };
    const dependencies: BlockDocumentSurfaceDependencies = {
      createAdapter: () => adapter,
      createRuntime: (options) =>
        new BlockDocumentSurfaceRuntime({
          ...options,
          localCheckpointStore: null,
          closeTimeoutMs: 100,
        }),
    };
    const ownedDescriptor = descriptor();
    const renderSurface = (isActive: boolean) => (
      <BlockDocumentSurface
        descriptor={ownedDescriptor}
        isActive={isActive}
        localAwarenessState={{ user: { name: "Ada" } }}
        dependencies={dependencies}
        runtimeRef={runtimeRef}
      >
        {(surface) => <div>{surface.title.toString()}</div>}
      </BlockDocumentSurface>
    );
    const view = render(renderSurface(true));

    await waitFor(() => {
      expect(view.getByText("Synced title").textContent).toBe("Synced title");
    });
    const runtime = runtimeRef.current;
    expect(runtime).not.toBeNull();
    expect(adapter.subscriptions).toBe(1);
    expect(
      (
        runtime?.awareness.getLocalState()?.nodex as {
          clientSessionId?: string;
        }
      ).clientSessionId,
    ).toBe(runtime?.clientSessionId);

    view.rerender(renderSurface(false));
    await waitFor(() => {
      expect(runtime?.awareness.getLocalState()).toBe(null);
    });
    expect(adapter.unsubscriptions).toBe(0);
    expect(runtime?.getStatus().ready).toBe(true);

    view.rerender(renderSurface(true));
    await waitFor(() => {
      expect(runtime?.awareness.getLocalState() === null).toBe(false);
    });
    expect((runtime?.awareness.getLocalState()?.user as { name?: string }).name).toBe("Ada");

    await act(async () => {
      await runtime?.persist();
      view.unmount();
      await Promise.resolve();
    });
    expect(runtimeRef.current).toBe(null);
    await waitFor(() => expect(adapter.unsubscriptions).toBe(1));
    adapter.destroy();
  });

  test("recreates independent collaborative runtimes across retained Project Activity switches", async () => {
    const alphaAdapter = new SurfaceTestAdapter(
      createPageDocument({
        documentId: "document:alpha-card",
        initialTitle: "Alpha title",
      }),
    );
    const betaAdapter = new SurfaceTestAdapter(
      createPageDocument({
        documentId: "document:beta-card",
        initialTitle: "Beta title",
      }),
    );
    const alphaRuntimes: BlockDocumentSurfaceRuntime[] = [];
    const betaRuntimes: BlockDocumentSurfaceRuntime[] = [];
    const makeDependencies = (
      adapter: SurfaceTestAdapter,
      runtimes: BlockDocumentSurfaceRuntime[],
    ): BlockDocumentSurfaceDependencies => ({
      createAdapter: () => adapter,
      createRuntime: (options) => {
        const runtime = new BlockDocumentSurfaceRuntime({
          ...options,
          localCheckpointStore: null,
          closeTimeoutMs: 100,
        });
        runtimes.push(runtime);
        return runtime;
      },
    });
    const alphaDependencies = makeDependencies(alphaAdapter, alphaRuntimes);
    const betaDependencies = makeDependencies(betaAdapter, betaRuntimes);
    const renderProjects = (activeProjectId: "alpha" | "beta") => (
      <>
        <Activity mode={activeProjectId === "alpha" ? "visible" : "hidden"}>
          <BlockDocumentSurface
            descriptor={descriptor({
              routingContext: { kind: "project", projectId: "alpha" },
              ownerBlockId: "alpha-card",
              documentId: "document:alpha-card",
            })}
            isActive={activeProjectId === "alpha"}
            dependencies={alphaDependencies}
          >
            {(surface) => <div>{surface.title.toString()}</div>}
          </BlockDocumentSurface>
        </Activity>
        <Activity mode={activeProjectId === "beta" ? "visible" : "hidden"}>
          <BlockDocumentSurface
            descriptor={descriptor({
              routingContext: { kind: "project", projectId: "beta" },
              ownerBlockId: "beta-card",
              documentId: "document:beta-card",
            })}
            isActive={activeProjectId === "beta"}
            dependencies={betaDependencies}
          >
            {(surface) => <div>{surface.title.toString()}</div>}
          </BlockDocumentSurface>
        </Activity>
      </>
    );

    const view = render(renderProjects("alpha"));
    await waitFor(() => expect(view.getByText("Alpha title")).toBeTruthy());
    const firstAlphaRuntime = alphaRuntimes[0];
    expect(firstAlphaRuntime).toBeDefined();
    expect(betaRuntimes).toHaveLength(0);

    view.rerender(renderProjects("beta"));
    await waitFor(() => expect(view.getByText("Beta title")).toBeTruthy());
    await waitFor(() => expect(firstAlphaRuntime?.getStatus().phase).toBe("closed"));
    const firstBetaRuntime = betaRuntimes[0];
    expect(firstBetaRuntime).toBeDefined();

    view.rerender(renderProjects("alpha"));
    await waitFor(() => expect(view.getByText("Alpha title")).toBeTruthy());
    await waitFor(() => expect(firstBetaRuntime?.getStatus().phase).toBe("closed"));
    expect(alphaRuntimes).toHaveLength(2);
    expect(alphaRuntimes[1]).not.toBe(firstAlphaRuntime);
    expect(alphaRuntimes[1]?.clientSessionId).not.toBe(firstAlphaRuntime?.clientSessionId);

    view.unmount();
    await waitFor(() => expect(alphaRuntimes[1]?.getStatus().phase).toBe("closed"));
    alphaAdapter.destroy();
    betaAdapter.destroy();
  });

  test("surfaces adapter failures without rewriting descriptor access identity", async () => {
    const originalClipboard = navigator.clipboard;
    const clipboardWrites: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          clipboardWrites.push(value);
        },
      },
    });
    const libraryDescriptor: PrimaryPageBlockDocumentDescriptor = {
      ...descriptor(),
      routingContext: { kind: "library" },
    };
    let observedRoutingContext: unknown;
    const dependencies: BlockDocumentSurfaceDependencies = {
      createAdapter: (routingContext) => {
        observedRoutingContext = routingContext;
        throw new Error("Document adapter unavailable");
      },
    };
    try {
      const view = render(
        <BlockDocumentSurface descriptor={libraryDescriptor} isActive dependencies={dependencies}>
          {() => <div>Should not render</div>}
        </BlockDocumentSurface>,
      );

      await waitFor(() => {
        expect(view.getByText("Document adapter unavailable")).toBeTruthy();
      });
      fireEvent.click(view.getByRole("button", { name: "Details" }));
      expect(view.getByText(/Code: runtime_error/)).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Copy diagnostics" }));
      await waitFor(() => expect(clipboardWrites).toHaveLength(1));
      expect(clipboardWrites[0]).toContain("Library: library-1");
      expect(clipboardWrites[0]).toContain("Access: library");
      expect(observedRoutingContext).toEqual({ kind: "library" });
      expect(view.getByRole("button", { name: "Copied" })).toBeTruthy();
    } finally {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  test("lets an embedding surface preserve its own shell around startup recovery", async () => {
    const view = render(
      <BlockDocumentSurface
        descriptor={descriptor()}
        isActive
        dependencies={{
          createAdapter: () => {
            throw new Error("Document adapter unavailable");
          },
        }}
        renderFailureFallback={({ error, reload }) => (
          <section data-testid="embedding-shell">
            <span>{error.message}</span>
            <button type="button" onClick={() => void reload?.()}>
              Retry in place
            </button>
          </section>
        )}
      >
        {() => <div>Should not render</div>}
      </BlockDocumentSurface>,
    );

    await waitFor(() => {
      expect(view.getByTestId("embedding-shell")).toBeTruthy();
      expect(view.getByRole("button", { name: "Retry in place" })).toBeTruthy();
    });
    expect(view.queryByText("Couldn’t open this collaborative content.")).toBeNull();
    view.unmount();
  });

  test("automatically recreates a mounted surface after a whole-store reset", async () => {
    const adapter = new SurfaceTestAdapter();
    let reloads = 0;
    const dependencies: BlockDocumentSurfaceDependencies = {
      createAdapter: () => adapter,
      createRuntime: (options) =>
        new BlockDocumentSurfaceRuntime({
          ...options,
          localCheckpointStore: null,
          closeTimeoutMs: 100,
        }),
    };
    const view = render(
      <BlockDocumentSurface
        descriptor={descriptor()}
        isActive
        dependencies={dependencies}
        onReload={async () => {
          reloads += 1;
        }}
      >
        {(surface) => <div>{surface.title.toString()}</div>}
      </BlockDocumentSurface>,
    );
    await waitFor(() => {
      expect(view.getByText("Synced title").textContent).toBe("Synced title");
    });

    await act(async () => {
      adapter.emit({
        kind: "store-reset",
        documentId: "document:card-1",
        storeEpoch: "store-restored",
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(reloads).toBe(1));
    await waitFor(() => expect(adapter.unsubscriptions > 0).toBe(true));

    view.unmount();
    adapter.destroy();
  });
});

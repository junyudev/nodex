import { act, fireEvent, waitFor } from "@testing-library/react";
import { Activity } from "react";
import { describe, expect, test, vi } from "vite-plus/test";
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
import type { OwnedDocumentDescriptor } from "../../../shared/block-documents/contracts";
import { TestQueryProvider } from "@/test/query";
import {
  OwnedBlockDocumentBoundary,
  RegisteredOwnedBlockDocumentBoundary,
} from "./owned-block-document-boundary";
import { OwnedBlockDocumentBoundaryError } from "@/lib/owned-block-document";
import { FileIcon } from "@/components/shared/icons";
import { BlockDisclosureStateStore } from "@/lib/block-disclosure-state";
import { ReferenceSurfaceActivationBudget } from "@/lib/reference-surface-state";
import { OwnedDocumentReferenceSurface } from "./owned-document-reference-surface";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import type { DatabaseViewReadModel } from "../../../shared/database-views";
import type { DatabasePageSummary } from "@/lib/types";
import { DatabaseViewReferenceSurface } from "./reference-block-surfaces";

describe("block document surface", () => {
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

      await view.findByText("Synced title");
      const runtime = runtimeRef.current;
      if (!runtime) throw new Error("Expected a live Block Document runtime");
      expect(adapter.subscriptions).toBe(1);

      const activeAwareness = {
        nodex: { clientSessionId: runtime.clientSessionId },
        user: { name: "Ada" },
      };
      // The title can commit before the presence effect runs.
      await waitFor(() => {
        expect(runtime.awareness.getLocalState()).toMatchObject(activeAwareness);
      });

      view.rerender(renderSurface(false));
      await waitFor(() => {
        expect(runtime.awareness.getLocalState()).toBe(null);
      });
      expect(adapter.unsubscriptions).toBe(0);
      expect(runtime.getStatus().ready).toBe(true);

      view.rerender(renderSurface(true));
      await waitFor(() => {
        expect(runtime.awareness.getLocalState()).toMatchObject(activeAwareness);
      });

      await act(async () => {
        await runtime.persist();
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
});

describe("owned block document boundary", () => {
  const descriptor = (): OwnedDocumentDescriptor => ({
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
  });

  describe("OwnedBlockDocumentBoundary", () => {
    test("renders the explicit authority model and can prepare it again after reload", async () => {
      let fetches = 0;
      const fetchDescriptor = async () => {
        fetches += 1;
        return descriptor();
      };
      const view = render(
        <TestQueryProvider>
          <OwnedBlockDocumentBoundary
            routingContext={{ kind: "project", projectId: "project-1" }}
            ownerBlockId="card-1"
            dependencies={{ fetchDescriptor }}
          >
            {(model, controls) => (
              <div>
                <span data-testid="authority">{model.status}</span>
                <button type="button" onClick={() => void controls.reload()}>
                  Reload descriptor
                </button>
              </div>
            )}
          </OwnedBlockDocumentBoundary>
        </TestQueryProvider>,
      );

      await waitFor(() => {
        expect(view.getByTestId("authority").textContent).toBe("ready");
      });
      expect(fetches).toBe(1);

      fireEvent.click(view.getByRole("button", { name: "Reload descriptor" }));
      await waitFor(() => expect(fetches).toBe(2));
      expect(view.getByTestId("authority").textContent).toBe("ready");
    });

    test("opens a registered non-Page document-bearing Block descriptor", async () => {
      const view = render(
        <TestQueryProvider>
          <RegisteredOwnedBlockDocumentBoundary
            routingContext={{ kind: "project", projectId: "project-1" }}
            ownerBlockId="synced-source-1"
            dependencies={{
              fetchDescriptor: async () => ({
                ...descriptor(),
                ownerBlockId: "synced-source-1",
                ownerType: SYNCED_BLOCK_SOURCE_TYPE,
                documentId: "document:synced-source-1",
                schemaKey: SYNCED_BLOCK_DOCUMENT_SCHEMA_KEY,
                schemaVersion: SYNCED_BLOCK_DOCUMENT_SCHEMA_VERSION,
              }),
            }}
          >
            {(model) => <span data-testid="authority">{model.status}</span>}
          </RegisteredOwnedBlockDocumentBoundary>
        </TestQueryProvider>,
      );

      await waitFor(() => {
        expect(view.getByTestId("authority").textContent).toBe("ready");
      });
    });

    test("shows a productized busy state and retries a retryable descriptor read", async () => {
      let fetches = 0;
      const view = render(
        <TestQueryProvider>
          <OwnedBlockDocumentBoundary
            routingContext={{ kind: "project", projectId: "project-1" }}
            ownerBlockId="card-1"
            dependencies={{
              fetchDescriptor: async () => {
                fetches += 1;
                if (fetches < 3) {
                  throw new OwnedBlockDocumentBoundaryError(
                    "fetch_failed",
                    "Core request deadline was exceeded",
                    { retryable: true },
                  );
                }
                return descriptor();
              },
            }}
          >
            {(model) => (
              <span data-testid="authority">
                {model.status === "error" ? model.error.message : model.status}
              </span>
            )}
          </OwnedBlockDocumentBoundary>
        </TestQueryProvider>,
      );

      await waitFor(() => {
        expect(view.getByTestId("authority").textContent).toContain("Core is busy");
      });
      expect(view.getByTestId("authority").textContent).not.toContain("deadline exceeded");
      await waitFor(() => {
        expect(view.getByTestId("authority").textContent).toBe("ready");
      });
      expect(fetches).toBe(3);
    });

    test("does not retry a non-retryable descriptor failure", async () => {
      let fetches = 0;
      const view = render(
        <TestQueryProvider>
          <OwnedBlockDocumentBoundary
            routingContext={{ kind: "project", projectId: "project-1" }}
            ownerBlockId="card-1"
            dependencies={{
              fetchDescriptor: async () => {
                fetches += 1;
                throw new OwnedBlockDocumentBoundaryError(
                  "document_state_corrupt",
                  "Document state is corrupt",
                );
              },
            }}
          >
            {(model) => (
              <span data-testid="authority">
                {model.status === "error" ? model.error.message : model.status}
              </span>
            )}
          </OwnedBlockDocumentBoundary>
        </TestQueryProvider>,
      );

      await waitFor(() => {
        expect(view.getByTestId("authority").textContent).toBe("Document state is corrupt");
      });
      expect(fetches).toBe(1);
    });

    test("cancels the retry chain when the document surface unmounts", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let fetches = 0;
        const view = render(
          <TestQueryProvider>
            <OwnedBlockDocumentBoundary
              routingContext={{ kind: "project", projectId: "project-1" }}
              ownerBlockId="card-1"
              dependencies={{
                fetchDescriptor: async () => {
                  fetches += 1;
                  throw new OwnedBlockDocumentBoundaryError(
                    "fetch_failed",
                    "Core request deadline was exceeded",
                    { retryable: true },
                  );
                },
              }}
            >
              {(model) => <span>{model.status}</span>}
            </OwnedBlockDocumentBoundary>
          </TestQueryProvider>,
        );

        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(fetches).toBe(1);
        view.unmount();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(350);
        });
        expect(fetches).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("owned document reference surface", () => {
  const renderIcon = () => <FileIcon aria-hidden="true" className="size-3.5" />;

  describe("OwnedDocumentReferenceSurface", () => {
    test("does not mount the foreign provider surface until local expansion", async () => {
      const disclosureStore = new BlockDisclosureStateStore();
      const activationBudget = new ReferenceSurfaceActivationBudget(1);
      const view = render(
        <OwnedDocumentReferenceSurface
          disclosureKey="host:template-shell"
          ownerBlockId="template-owner"
          icon={renderIcon()}
          label="Document"
          detail="Architecture notes"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
          renderDocument={({ ownerBlockId }) => (
            <div data-testid="owned-document-provider">{ownerBlockId}</div>
          )}
        />,
      );

      expect(view.queryByTestId("owned-document-provider") === null).toBe(true);

      await act(async () => {
        fireEvent.click(
          view.getByRole("button", {
            name: "Expand Document: Architecture notes",
          }),
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(view.getByTestId("owned-document-provider").textContent).toBe("template-owner");
      });

      await act(async () => {
        fireEvent.click(
          view.getByRole("button", {
            name: "Collapse Document: Architecture notes",
          }),
        );
        await Promise.resolve();
      });
      expect(view.queryByTestId("owned-document-provider") === null).toBe(true);
      expect(activationBudget.getActiveKeys().length).toBe(0);
    });

    test("keeps a cycle-marked owner non-expandable", () => {
      const view = render(
        <OwnedDocumentReferenceSurface
          disclosureKey="recursive-template"
          ownerBlockId="template-owner"
          icon={renderIcon()}
          label="Template"
          detail="Incident review"
          disabledReason="Cycle"
          visibilityOverride
          renderDocument={() => <div data-testid="must-not-mount">Recursive provider</div>}
        />,
      );

      expect(
        (
          view.getByRole("button", {
            name: "Expand Template: Incident review",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(view.getByText("Cycle").textContent).toBe("Cycle");
      expect(view.queryByTestId("must-not-mount") === null).toBe(true);
    });

    test("unmounts an expanded provider as soon as its shell leaves view", async () => {
      const disclosureStore = new BlockDisclosureStateStore();
      const activationBudget = new ReferenceSurfaceActivationBudget(1);
      const makeSurface = (visible: boolean) => (
        <OwnedDocumentReferenceSurface
          disclosureKey="visible-template"
          ownerBlockId="template-owner"
          icon={renderIcon()}
          label="Template"
          detail="Release checklist"
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride={visible}
          renderDocument={() => <div data-testid="visible-provider">Collaborative template</div>}
        />
      );
      const view = render(makeSurface(true));

      await act(async () => {
        fireEvent.click(
          view.getByRole("button", {
            name: "Expand Template: Release checklist",
          }),
        );
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(view.queryByTestId("visible-provider") === null).toBe(false);
      });

      view.rerender(makeSurface(false));
      expect(view.queryByTestId("visible-provider") === null).toBe(true);
    });
  });
});

describe("reference block surfaces", () => {
  const makeCard = (id: string, title: string): DatabasePageSummary => ({
    id,
    pageKey: null,
    status: "doing",
    archived: false,
    title,
    richTitle: plainTextToPortableRichText(title),
    priority: "p1-high",
    estimate: "m",
    tags: [],
    created: new Date("2026-01-01T00:00:00.000Z"),
    order: 0,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  });

  describe("DatabaseViewReferenceSurface", () => {
    test("preserves Library access when a referenced Page opens", () => {
      const card = makeCard("card-a", "Card A");
      const opened: unknown[] = [];
      const model: DatabaseViewReadModel = {
        statusOptions: [],
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        dataSourceId: "data-source:test",
        view: {
          id: "library-view",
          databaseBlockId: "database-1",
          projectId: null,
          name: "Library view",
          layout: "list",
          config: {},
          isPrimary: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        rows: [{ page: card, groupKey: null, subgroupKey: null, rankKey: "a" }],
      };
      const view = render(
        <DatabaseViewReferenceSurface
          referenceKey="library-view"
          displayHint=""
          model={model}
          routingContext={{ kind: "library" }}
          onOpenPage={(input) => {
            opened.push(input);
          }}
        />,
      );

      fireEvent.click(view.getByRole("button", { name: "Open Card A" }));

      expect(opened).toEqual([
        {
          routingContext: { kind: "library" },
          pageId: "card-a",
          titleSnapshot: "Card A",
        },
      ]);
    });

    test("does not mount a Database row that closes an ancestor Card cycle", () => {
      const card = makeCard("card-a", "Card A");
      const model: DatabaseViewReadModel = {
        statusOptions: [],
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        dataSourceId: "data-source:test",
        view: {
          id: "cycle-view",
          databaseBlockId: "database-1",
          projectId: "database-project",
          name: "Cycle view",
          layout: "list",
          config: {},
          isPrimary: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        rows: [{ page: card, groupKey: "triage", subgroupKey: null, rankKey: "a" }],
      };
      const view = render(
        <DatabaseViewReferenceSurface
          referenceKey="card-b-view"
          displayHint=""
          model={model}
          hostPageId="card-b"
          ancestorPageIds={["card-a", "card-b"]}
          visibilityOverride
          renderDocument={() => <div>Must not mount</div>}
        />,
      );

      expect(
        (view.getByRole("button", { name: "Expand Card A" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(view.getByText("Cycle").textContent).toBe("Cycle");
    });

    test("bounds simultaneous referenced Card providers across a large expanded view", async () => {
      const cards = [
        makeCard("card-1", "Card One"),
        makeCard("card-2", "Card Two"),
        makeCard("card-3", "Card Three"),
        makeCard("card-4", "Card Four"),
      ];
      const model: DatabaseViewReadModel = {
        statusOptions: [],
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        dataSourceId: "data-source:test",
        view: {
          id: "view-1",
          databaseBlockId: "database-1",
          projectId: "database-project",
          name: "Focused work",
          layout: "list",
          config: {},
          isPrimary: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        rows: cards.map((card, index) => ({
          page: card,
          groupKey: null,
          subgroupKey: null,
          rankKey: String(index),
        })),
      };
      const disclosureStore = new BlockDisclosureStateStore();
      const activationBudget = new ReferenceSurfaceActivationBudget(2);
      const view = render(
        <DatabaseViewReferenceSurface
          referenceKey="host:view-1"
          displayHint=""
          model={model}
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
          renderDocument={({ routingContext, card }) => (
            <div data-testid="database-row-document">
              {routingContext.kind === "project" ? routingContext.projectId : "library"}:{card.id}
            </div>
          )}
        />,
      );

      await act(async () => {
        for (const card of cards) {
          fireEvent.click(view.getByRole("button", { name: `Expand ${card.title}` }));
          await Promise.resolve();
        }
      });
      await waitFor(() => {
        expect(view.getAllByTestId("database-row-document").length).toBe(2);
      });
      const activeText = view
        .getAllByTestId("database-row-document")
        .map((element) => element.textContent)
        .join(",");
      expect(activeText.includes("database-project:card-3")).toBe(true);
      expect(activeText.includes("database-project:card-4")).toBe(true);
      expect(activeText.includes("card-1")).toBe(false);

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Collapse Card Four" }));
        await Promise.resolve();
      });
      await waitFor(() => {
        const resumedText = view
          .getAllByTestId("database-row-document")
          .map((element) => element.textContent)
          .join(",");
        expect(resumedText.includes("database-project:card-2")).toBe(true);
        expect(resumedText.includes("database-project:card-3")).toBe(true);
      });
    });

    test("keeps the focused inline editor resident when a newer row activates", async () => {
      const cards = [
        makeCard("focus-1", "Focus One"),
        makeCard("focus-2", "Focus Two"),
        makeCard("focus-3", "Focus Three"),
      ];
      const model: DatabaseViewReadModel = {
        statusOptions: [],
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        dataSourceId: "data-source:test",
        view: {
          id: "focus-view",
          databaseBlockId: "database-1",
          projectId: "database-project",
          name: "Focus order",
          layout: "list",
          config: {},
          isPrimary: false,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        rows: cards.map((card, index) => ({
          page: card,
          groupKey: null,
          subgroupKey: null,
          rankKey: String(index),
        })),
      };
      const disclosureStore = new BlockDisclosureStateStore();
      const activationBudget = new ReferenceSurfaceActivationBudget(2);
      const view = render(
        <DatabaseViewReferenceSurface
          referenceKey="focus-view"
          displayHint=""
          model={model}
          disclosureStore={disclosureStore}
          activationBudget={activationBudget}
          visibilityOverride
          renderDocument={({ card }) => (
            <input data-testid={`focus-${card.id}`} defaultValue={card.title} />
          )}
        />,
      );

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Expand Focus One" }));
        fireEvent.click(view.getByRole("button", { name: "Expand Focus Two" }));
        await Promise.resolve();
      });
      fireEvent.focus(view.getByTestId("focus-focus-1"));
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Expand Focus Three" }));
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(view.queryByTestId("focus-focus-1") === null).toBe(false);
        expect(view.queryByTestId("focus-focus-2") === null).toBe(true);
        expect(view.queryByTestId("focus-focus-3") === null).toBe(false);
      });
    });
  });
});

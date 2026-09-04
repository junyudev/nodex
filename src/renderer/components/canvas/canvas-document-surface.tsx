import { RecoveryEntry } from "@/features/document-recovery/recovery-entry";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import "@excalidraw/excalidraw/index.css";
import {
  loadCanvasCardSidebar,
  loadExcalidraw,
  RegisteredOwnedBlockDocumentBoundary,
  compactCanvasScene,
  createCanvasSceneSyncAdapter,
  createDefaultCanvasSceneOutbox,
  useTheme,
  readCanvasSceneCompaction,
} from "../board/canvas-view-deps";
import {
  createPageElement,
  collectPlacedPageIds,
  isCardElement,
  getPageIdFromElement,
  getPageTitleHintFromElement,
  syncPlacedPageIds,
  updatePageElements,
} from "@/lib/canvas-card-elements";
import type { BoardSummary, DatabasePageSummary } from "@/lib/types";
import type { PortableCanvasScene } from "../../../shared/block-documents";
import {
  CanvasBinaryFileResolver,
  createCanvasFileBridge,
  subscribeCanvasFileAuthority,
  type CanvasBinaryFiles,
} from "@/lib/canvas-assets";
import { CanvasSceneBinding } from "@/lib/canvas-scene-binding";
import { CanvasSceneProvider } from "@/lib/canvas-scene-provider";
import { canvasDocumentSessionRegistry } from "@/lib/canvas-document-session";
import type {
  ContentAccessContext,
  ContentPageNavigationTarget,
} from "../../../shared/content-access-context";
import { canvasSceneSurfaceRegistry } from "@/lib/canvas-scene-surface-runtime";
import type { ReadyRegisteredOwnedBlockDocumentDescriptor } from "@/lib/owned-block-document";
import { LayoutGrid } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { CanvasDocumentState } from "../board/canvas-document-state";
import {
  createCanvasPresenceController,
  type CanvasPresenceController,
} from "@/lib/canvas-presence-controller";
import {
  createCanvasViewportPersistence,
  readCanvasViewportPreference,
  type CanvasViewportPersistence,
} from "@/lib/canvas-presentation-preference";

const ExcalidrawLazy = lazy(async () => {
  const mod = await loadExcalidraw();
  return { default: mod.Excalidraw };
});

const CanvasCardSidebarLazy = lazy(async () => {
  const mod = await loadCanvasCardSidebar();
  return { default: mod.CanvasCardSidebar };
});

// Lazy-load convertToExcalidrawElements alongside Excalidraw
const convertPromise = loadExcalidraw().then((mod) => mod.convertToExcalidrawElements);

const collaborationPromise = loadExcalidraw().then((mod) => ({
  reconcileElements: mod.reconcileElements,
  CaptureUpdateAction: mod.CaptureUpdateAction,
  newElementWith: mod.newElementWith,
}));

export interface CanvasPagePaletteCapability {
  readonly board: BoardSummary | null;
  readonly createPage: () => Promise<DatabasePageSummary | null>;
}

export type CanvasOpenPageInput = ContentPageNavigationTarget;

export interface CanvasDocumentSurfaceProps {
  readonly accessContext: ContentAccessContext;
  readonly canvasBlockId: string;
  readonly surfaceKey: string;
  readonly viewportPreferenceScope: string;
  readonly variant: "inline" | "stage";
  readonly active: boolean;
  readonly pagePalette?: CanvasPagePaletteCapability;
  readonly onOpenPage?: (input: CanvasOpenPageInput) => void;
  readonly activePageId?: string;
  readonly onCloseActivePage?: () => Promise<void>;
}

export function CanvasDocumentSurface({
  accessContext,
  canvasBlockId,
  surfaceKey,
  viewportPreferenceScope,
  variant,
  active,
  pagePalette,
  onOpenPage,
  activePageId,
  onCloseActivePage,
}: CanvasDocumentSurfaceProps) {
  if (!active) return null;
  return (
    <RegisteredOwnedBlockDocumentBoundary
      accessContext={accessContext}
      ownerBlockId={canvasBlockId}
    >
      {(model, controls) => {
        if (model.status === "loading") {
          return <CanvasDocumentState status="loading" label="Opening canvas…" />;
        }
        if (model.status === "error") {
          return (
            <CanvasDocumentState
              status="error"
              message={model.error.message}
              onRetry={() => void controls.reload()}
            />
          );
        }
        const descriptor = model.descriptor;
        if (descriptor.sync.kind !== "canvas_scene") {
          return (
            <CanvasDocumentState
              status="error"
              message="Canvas requires the scene-native sync engine"
              onRetry={() => void controls.reload()}
            />
          );
        }
        return (
          <CanvasEditor
            key={JSON.stringify([
              model.descriptor.storeEpoch,
              model.descriptor.documentId,
              viewportPreferenceScope,
            ])}
            surfaceKey={surfaceKey}
            viewportPreferenceScope={viewportPreferenceScope}
            variant={variant}
            descriptor={descriptor as CanvasEditorProps["descriptor"]}
            onReload={controls.reload}
            pagePalette={pagePalette}
            onOpenPage={onOpenPage}
            activePageId={activePageId}
            onCloseActivePage={onCloseActivePage}
          />
        );
      }}
    </RegisteredOwnedBlockDocumentBoundary>
  );
}

interface CanvasEditorProps extends Omit<
  CanvasDocumentSurfaceProps,
  "active" | "accessContext" | "canvasBlockId"
> {
  readonly descriptor: ReadyRegisteredOwnedBlockDocumentDescriptor & {
    readonly sync: { readonly kind: "canvas_scene" };
  };
  readonly onReload: () => Promise<void>;
}

function CanvasEditor({
  surfaceKey,
  viewportPreferenceScope,
  variant,
  descriptor,
  onReload,
  pagePalette,
  onOpenPage,
  activePageId,
  onCloseActivePage,
}: CanvasEditorProps) {
  const board = pagePalette?.board ?? null;
  const { resolved: themeResolved } = useTheme();
  const excalidrawApiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const bindingRef = useRef<CanvasSceneBinding | null>(null);
  const presenceRef = useRef<CanvasPresenceController | null>(null);
  const viewportPersistenceRef = useRef<CanvasViewportPersistence | null>(null);
  const documentClientSessionIdRef = useRef(
    `canvas-document:${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
  );
  const presenceClientSessionIdRef = useRef(
    `canvas-surface:${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}`,
  );
  const [restoredViewport] = useState(() =>
    readCanvasViewportPreference({
      storeEpoch: descriptor.storeEpoch,
      documentId: descriptor.documentId,
      preferenceScope: viewportPreferenceScope,
    }),
  );
  const [resolvedScene, setResolvedScene] = useState<{
    readonly materialization: PortableCanvasScene;
    readonly files: CanvasBinaryFiles;
  } | null>(null);
  const [fileReadGeneration, setFileReadGeneration] = useState(0);
  const [sceneError, setSceneError] = useState<string | null>(null);
  const exportRecoveryRef = useRef<(() => Promise<void>) | null>(null);
  const retrySceneRef = useRef<(() => void) | null>(null);
  const latestElementsRef = useRef<readonly OrderedExcalidrawElement[]>([]);
  const [placedPageIds, setPlacedPageIds] = useState(() =>
    collectPlacedPageIds(latestElementsRef.current),
  );
  const [writeFrozen, setWriteFrozen] = useState(false);

  const handleExcalidrawAPI = useCallback((api: ExcalidrawImperativeAPI) => {
    excalidrawApiRef.current = api;
    const collaborators = presenceRef.current?.getCollaborators();
    if (!collaborators) return;
    void collaborationPromise.then(({ CaptureUpdateAction }) => {
      if (excalidrawApiRef.current !== api) return;
      api.updateScene({
        collaborators: new Map(collaborators),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    });
  }, []);

  const handleViewportChange = useCallback(
    (scrollX: number, scrollY: number, zoom: AppState["zoom"]) => {
      viewportPersistenceRef.current?.observe({
        scrollX,
        scrollY,
        zoom: zoom.value,
      });
    },
    [],
  );

  const generateIdForFile = useCallback(
    () =>
      globalThis.crypto?.randomUUID?.() ??
      `canvas-file:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    [],
  );

  useLayoutEffect(() => {
    const persistence = createCanvasViewportPersistence({
      storeEpoch: descriptor.storeEpoch,
      documentId: descriptor.documentId,
      preferenceScope: viewportPreferenceScope,
    });
    viewportPersistenceRef.current = persistence;
    const flushCurrentViewport = (): void => {
      const appState = excalidrawApiRef.current?.getAppState();
      if (appState) {
        persistence.observe({
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
          zoom: appState.zoom.value,
        });
      }
      persistence.flush();
    };
    window.addEventListener("beforeunload", flushCurrentViewport);
    return () => {
      window.removeEventListener("beforeunload", flushCurrentViewport);
      flushCurrentViewport();
      persistence.dispose();
      if (viewportPersistenceRef.current === persistence) {
        viewportPersistenceRef.current = null;
      }
    };
  }, [descriptor.documentId, descriptor.storeEpoch, viewportPreferenceScope]);

  useEffect(() => {
    let active = true;
    let preferencesRevision = 0;
    const fileBridge = createCanvasFileBridge(
      {
        libraryId: descriptor.libraryId,
        storeEpoch: descriptor.storeEpoch,
        contentAccessContext: descriptor.accessContext,
      },
      (file) => ({ kind: "canvas", canvas_id: descriptor.ownerBlockId, scene_file_id: file.id }),
    );
    const fileResolver = new CanvasBinaryFileResolver(fileBridge);
    let binding: CanvasSceneBinding | null = null;
    let presence: CanvasPresenceController | null = null;
    const documentSession = canvasDocumentSessionRegistry.acquire({
      libraryId: descriptor.libraryId,
      accessContext: descriptor.accessContext,
      ownerBlockId: descriptor.ownerBlockId,
      documentId: descriptor.documentId,
      storeEpoch: descriptor.storeEpoch,
      generation: descriptor.generation,
      createProvider: ({ onScene, onPresence }) =>
        new CanvasSceneProvider({
          libraryId: descriptor.libraryId,
          accessContext: descriptor.accessContext,
          documentId: descriptor.documentId,
          clientSessionId: documentClientSessionIdRef.current,
          expectedStoreEpoch: descriptor.storeEpoch,
          expectedGeneration: descriptor.generation,
          adapter: createCanvasSceneSyncAdapter({
            libraryId: descriptor.libraryId,
            accessContext: descriptor.accessContext,
          }),
          outbox: createDefaultCanvasSceneOutbox(descriptor.libraryId),
          onScene,
          onPresence,
        }),
    });
    const provider = documentSession.provider;
    const unsubscribeStatus = provider.subscribeStatus(() => {
      if (!active) return;
      const status = provider.getStatus();
      const frozen =
        status.writeFrozen ||
        status.phase === "reset-required" ||
        status.phase === "error" ||
        status.phase === "closing" ||
        status.phase === "closed";
      setWriteFrozen(frozen);
      presence?.setEnabled(
        !frozen && status.connected && (status.phase === "ready" || status.phase === "saving"),
      );
      if (status.error) setSceneError(status.error.message);
    });
    presence = createCanvasPresenceController({
      publish: (clock, state) =>
        provider.publishPresenceFor(presenceClientSessionIdRef.current, clock, state),
      onCollaborators: (collaborators) => {
        if (!active) return;
        const api = excalidrawApiRef.current;
        if (!api) return;
        void collaborationPromise.then(({ CaptureUpdateAction }) => {
          if (!active || excalidrawApiRef.current !== api) return;
          api.updateScene({
            collaborators: new Map(collaborators),
            captureUpdate: CaptureUpdateAction.NEVER,
          });
        });
      },
    });
    presence.setEnabled(false);
    presenceRef.current = presence;
    const updateIdleState = (): void => {
      if (!presence) return;
      if (document.visibilityState === "hidden") {
        presence.setIdle("away");
        return;
      }
      presence.setIdle(document.hasFocus() ? "active" : "idle");
    };
    const handleWindowFocus = (): void => updateIdleState();
    const handleWindowBlur = (): void => updateIdleState();
    document.addEventListener("visibilitychange", updateIdleState);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    binding = new CanvasSceneBinding({
      provider,
      assetDependencies: fileBridge,
      stagedFileCatalog: documentSession.stagedFileCatalog,
      onRemoteScene: (scene) => {
        void presentScene(scene);
      },
      onError: (error) => {
        if (active) setSceneError(error.message);
      },
    });
    bindingRef.current = binding;
    let fileAuthorityReloading = false;
    const releaseFileAuthority = subscribeCanvasFileAuthority(
      {
        libraryId: descriptor.libraryId,
        storeEpoch: descriptor.storeEpoch,
        contentAccessContext: descriptor.accessContext,
      },
      { canvasId: descriptor.ownerBlockId, documentId: descriptor.documentId },
      () => {
        if (!active) return;
        if (fileAuthorityReloading) return;
        fileAuthorityReloading = true;
        preferencesRevision += 1;
        fileResolver.clear();
        excalidrawApiRef.current = null;
        setResolvedScene(null);
        setFileReadGeneration((value) => value + 1);
        void (async () => {
          try {
            await binding?.persistDurable();
          } catch {
            await provider.checkpointRecovery();
          }
          await onReload();
        })().catch((error: unknown) => {
          if (active) setSceneError(error instanceof Error ? error.message : String(error));
        });
      },
    );
    const unsubscribeScene = documentSession.subscribeScene(binding.presentRemoteScene);
    const unsubscribePresence = documentSession.subscribePresence(presence.receive);
    const runtime = canvasSceneSurfaceRegistry.acquire({
      key: surfaceKey,
      descriptor,
      provider,
      connectDocumentSession: documentSession.connect,
      presence,
      binding,
      fileResolver,
      releaseDocumentSession: documentSession.release,
      maintainIfIdle: async () => {
        const request = {
          accessContext: descriptor.accessContext,
          documentId: descriptor.documentId,
          clientSessionId: documentClientSessionIdRef.current,
        };
        const eligibility = await readCanvasSceneCompaction(request);
        if (!eligibility.ok || !eligibility.value.eligible) return;
        await compactCanvasScene({
          ...request,
          mutationId:
            globalThis.crypto?.randomUUID?.() ?? `canvas-maintenance:${Date.now().toString(36)}`,
          trigger: "automatic_idle",
        });
      },
      disposeSubscriptions: () => {
        releaseFileAuthority();
        unsubscribeScene();
        unsubscribePresence();
        unsubscribeStatus();
        document.removeEventListener("visibilitychange", updateIdleState);
        window.removeEventListener("focus", handleWindowFocus);
        window.removeEventListener("blur", handleWindowBlur);
      },
    });

    async function presentScene(materialization: PortableCanvasScene): Promise<void> {
      const revision = ++preferencesRevision;
      try {
        const [files, collaboration] = await Promise.all([
          fileResolver.resolve(materialization.files),
          collaborationPromise,
        ]);
        if (!active || revision !== preferencesRevision) return;

        const api = excalidrawApiRef.current;
        if (!api) {
          setResolvedScene({ materialization, files });
          setSceneError(null);
          return;
        }

        const localElements = api.getSceneElementsIncludingDeleted();
        const remoteElements = materialization.elements as unknown as Parameters<
          typeof collaboration.reconcileElements
        >[1];
        const reconciled = collaboration.reconcileElements(
          localElements,
          remoteElements,
          api.getAppState(),
        );
        binding?.acceptRemotePresentation(reconciled);
        api.addFiles(Object.values(files) as unknown as BinaryFileData[]);
        api.updateScene({
          elements: reconciled,
          appState: materialization.appState as unknown as AppState,
          captureUpdate: collaboration.CaptureUpdateAction.NEVER,
        });
        latestElementsRef.current = reconciled;
        setPlacedPageIds((previous) => syncPlacedPageIds(previous, reconciled));
        setResolvedScene({ materialization, files });
        setSceneError(null);
      } catch (error) {
        if (!active || revision !== preferencesRevision) return;
        setSceneError(error instanceof Error ? error.message : String(error));
      }
    }

    const retry = (): void => {
      void (async () => {
        const api = excalidrawApiRef.current;
        const currentStatus = provider.getStatus();
        if (api && currentStatus.phase !== "reset-required" && currentStatus.phase !== "error") {
          await binding.submitLocalScene({
            elementsIncludingDeleted: api.getSceneElementsIncludingDeleted(),
            appState: api.getAppState() as unknown as Record<string, unknown>,
            binaryFiles: api.getFiles() as unknown as CanvasBinaryFiles,
          }).committed;
        }
        const status = provider.getStatus();
        if (status.phase === "reset-required" || status.phase === "error") {
          // Retiring a failed replica must preserve its pending intents first.
          await provider.checkpointRecovery();
          await onReload();
          return;
        }
        await provider.connect();
        await presentScene(binding.getCurrentScene());
      })().catch((error: unknown) => {
        if (!active) return;
        setSceneError(error instanceof Error ? error.message : String(error));
      });
    };
    const exportRecovery = async (): Promise<void> => {
      const data = await provider.exportRecovery();
      const url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "nodex-canvas-recovery.json";
      link.click();
      globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
    };
    exportRecoveryRef.current = exportRecovery;
    retrySceneRef.current = retry;
    void runtime.connect().catch((error: unknown) => {
      if (active) setSceneError(error instanceof Error ? error.message : String(error));
    });

    return () => {
      active = false;
      if (exportRecoveryRef.current === exportRecovery) exportRecoveryRef.current = null;
      if (retrySceneRef.current === retry) retrySceneRef.current = null;
      if (bindingRef.current === binding) bindingRef.current = null;
      if (presenceRef.current === presence) presenceRef.current = null;
      void canvasSceneSurfaceRegistry.release(surfaceKey, runtime).catch(() => undefined);
    };
  }, [descriptor, onReload, surfaceKey]);

  // Sync card labels when board changes
  useEffect(() => {
    const api = excalidrawApiRef.current;
    const binding = bindingRef.current;
    if (!api || !binding || !board || writeFrozen) return;
    let active = true;

    void collaborationPromise
      .then(async ({ CaptureUpdateAction, newElementWith }) => {
        if (!active) return;
        const elements = api.getSceneElementsIncludingDeleted();
        const updated = updatePageElements(
          elements as readonly Record<string, unknown>[],
          board,
          (element, changes) =>
            newElementWith(
              element as unknown as OrderedExcalidrawElement,
              changes as never,
            ) as unknown as Record<string, unknown>,
        );
        if (!updated || !active) return;

        const nextElements = updated as unknown as readonly OrderedExcalidrawElement[];
        latestElementsRef.current = nextElements;
        api.updateScene({
          elements: nextElements,
          captureUpdate: CaptureUpdateAction.NEVER,
        });
        setPlacedPageIds((previous) => syncPlacedPageIds(previous, nextElements));
        await binding.submitLocalScene({
          elementsIncludingDeleted: nextElements,
          appState: api.getAppState() as unknown as Record<string, unknown>,
          binaryFiles: api.getFiles() as unknown as CanvasBinaryFiles,
        }).committed;
      })
      .catch((error: unknown) => {
        if (active) {
          setSceneError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      active = false;
    };
  }, [board, resolvedScene, writeFrozen]);

  // Excalidraw renders a native link badge on elements with a `link` property.
  // Clicking that badge fires onLinkOpen — we intercept to open the page-stage.
  const handleLinkOpen = useCallback(
    async (element: any, event: any) => {
      if (!isCardElement(element)) return;
      event.preventDefault();

      const pageId = getPageIdFromElement(element);
      if (!pageId) return;

      // Toggle: clicking the already-peeked card closes it (matches board/list behavior)
      if (activePageId === pageId) {
        await onCloseActivePage?.();
        return;
      }

      onOpenPage?.({
        accessContext: descriptor.accessContext,
        pageId,
        titleSnapshot: getPageTitleHintFromElement(element),
      });
    },
    [activePageId, descriptor.accessContext, onCloseActivePage, onOpenPage],
  );

  // Place an existing card on the canvas
  const handlePlaceCard = useCallback(
    async (card: DatabasePageSummary) => {
      const api = excalidrawApiRef.current;
      const binding = bindingRef.current;
      if (!api || !binding || writeFrozen) return;
      const [convert, collaboration] = await Promise.all([convertPromise, collaborationPromise]);

      const skeleton = createPageElement(card, {
        x: 100 + Math.random() * 300,
        y: 100 + Math.random() * 300,
      });
      const elements = convert([skeleton] as Parameters<typeof convert>[0]);
      const existing = api.getSceneElementsIncludingDeleted();
      const nextElements = [...existing, ...elements] as readonly OrderedExcalidrawElement[];
      latestElementsRef.current = nextElements;
      api.updateScene({
        elements: nextElements,
        captureUpdate: collaboration.CaptureUpdateAction.IMMEDIATELY,
      });
      setPlacedPageIds((previous) => syncPlacedPageIds(previous, nextElements));
      await binding.submitLocalScene({
        elementsIncludingDeleted: nextElements,
        appState: api.getAppState() as unknown as Record<string, unknown>,
        binaryFiles: api.getFiles() as unknown as CanvasBinaryFiles,
      }).committed;
    },
    [writeFrozen],
  );

  const handlePointerUpdate = useCallback(
    (payload: {
      readonly pointer: {
        readonly x: number;
        readonly y: number;
        readonly tool: "pointer" | "laser";
      };
      readonly button: "down" | "up";
    }) => {
      presenceRef.current?.updatePointer({
        ...payload.pointer,
        button: payload.button,
      });
    },
    [],
  );

  // Create a new card and place it on canvas
  const handleCreateAndPlace = useCallback(async () => {
    if (!excalidrawApiRef.current || !pagePalette) return;
    const card = await pagePalette.createPage();
    if (!card) return;
    await handlePlaceCard(card);
  }, [handlePlaceCard, pagePalette]);

  // Excalidraw observations become mergeable scene mutations with explicit tombstones.
  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      const api = excalidrawApiRef.current;
      const binding = bindingRef.current;
      presenceRef.current?.updateSelection(
        Object.entries(appState.selectedElementIds ?? {})
          .filter(([, selected]) => selected)
          .map(([elementId]) => elementId),
      );
      if (!api || !binding || writeFrozen) return;
      latestElementsRef.current = elements;
      setPlacedPageIds((previous) => syncPlacedPageIds(previous, elements));
      void binding
        .submitLocalScene({
          elementsIncludingDeleted: api.getSceneElementsIncludingDeleted(),
          appState: appState as unknown as Record<string, unknown>,
          binaryFiles: files as unknown as CanvasBinaryFiles,
        })
        .committed.catch((error: unknown) => {
          setSceneError(error instanceof Error ? error.message : String(error));
        });
    },
    [writeFrozen],
  );

  // Render top-right UI: card sidebar toggle button
  const renderTopRightUI = useCallback(() => {
    return (
      <NodexTooltip tooltipContent="Pages">
        <button
          type="button"
          onClick={() =>
            excalidrawApiRef.current?.toggleSidebar({
              name: "cards",
              tab: "browse",
            })
          }
          className="excalidraw-button"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            padding: "6px 10px",
            fontSize: 13,
          }}
        >
          <LayoutGrid size={16} />
          Pages
        </button>
      </NodexTooltip>
    );
  }, []);

  if (!resolvedScene) {
    if (!sceneError) {
      return <CanvasDocumentState status="loading" label="Opening canvas assets…" />;
    }
    return (
      <CanvasDocumentState
        status="error"
        message={sceneError}
        onRetry={() => retrySceneRef.current?.()}
      />
    );
  }

  return (
    <div
      className={variant === "inline" ? "h-full min-h-0 w-full" : "h-full min-h-0 w-full px-4 pb-4"}
    >
      <div className="flex justify-end py-1">
        <RecoveryEntry
          scope={{ libraryId: descriptor.libraryId, accessContext: descriptor.accessContext }}
          documentId={descriptor.documentId}
          refreshKey={sceneError ?? undefined}
          exportLocal={async () => {
            await exportRecoveryRef.current?.();
          }}
        />
      </div>
      {sceneError ? (
        <div
          role="alert"
          className="mb-2 flex items-center justify-between gap-3 text-xs text-(--foreground-secondary)"
        >
          <span className="truncate">{sceneError}</span>
          <button
            type="button"
            className="shrink-0 text-(--foreground) underline"
            onClick={() => retrySceneRef.current?.()}
          >
            Retry sync
          </button>
        </div>
      ) : null}
      <Suspense
        fallback={
          <div className="flex h-full flex-1 items-center justify-center">
            <div className="text-sm text-(--foreground-secondary)">Loading Excalidraw...</div>
          </div>
        }
      >
        {/* Excalidraw's fixed, viewport-sized SVG layer must remain visual-only. */}
        <div
          data-excalidraw-embed-boundary={variant}
          data-canvas-surface-key={surfaceKey}
          className="h-full min-h-0 overflow-hidden rounded-lg border border-(--border) [&_.excalidraw_.SVGLayer]:absolute! [&_.excalidraw_.SVGLayer]:inset-0! [&_.excalidraw_.SVGLayer]:size-full! [&_.excalidraw_.SVGLayer]:pointer-events-none! [&_.excalidraw_.SVGLayer_svg]:pointer-events-none!"
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <ExcalidrawLazy
            key={fileReadGeneration}
            name={surfaceKey}
            excalidrawAPI={handleExcalidrawAPI}
            initialData={{
              elements: resolvedScene.materialization
                .elements as unknown as readonly OrderedExcalidrawElement[],
              appState: {
                ...resolvedScene.materialization.appState,
                ...(restoredViewport
                  ? {
                      scrollX: restoredViewport.scrollX,
                      scrollY: restoredViewport.scrollY,
                      zoom: {
                        value: restoredViewport.zoom,
                      } as AppState["zoom"],
                    }
                  : {}),
                theme: themeResolved,
              },
              files: resolvedScene.files as unknown as BinaryFiles,
              scrollToContent: restoredViewport ? false : undefined,
            }}
            theme={themeResolved}
            isCollaborating
            viewModeEnabled={writeFrozen}
            onChange={handleChange}
            onScrollChange={handleViewportChange}
            onPointerUpdate={handlePointerUpdate}
            onLinkOpen={handleLinkOpen}
            generateIdForFile={generateIdForFile}
            renderTopRightUI={pagePalette ? renderTopRightUI : undefined}
            UIOptions={{
              canvasActions: {
                loadScene: false,
              },
            }}
          >
            {pagePalette ? (
              <CanvasCardSidebarLazy
                board={board}
                placedPageIds={placedPageIds}
                onPlaceCard={handlePlaceCard}
                onCreateAndPlace={handleCreateAndPlace}
              />
            ) : null}
          </ExcalidrawLazy>
        </div>
      </Suspense>
    </div>
  );
}

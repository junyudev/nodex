import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { createHash } from "node:crypto";
import type { BoardSummary, DatabasePageSummary } from "@/lib/types";
import { settleAsyncRender, textContent } from "@/test/dom";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import {
  canonicalPortableCanvasSceneFingerprint,
  chooseCanvasSceneElementWinner,
  materializePortableCanvasScene,
  type PortableCanvasScene,
} from "../../../shared/block-documents/canvas-scene";
import { CANVAS_DOCUMENT_SCHEMA_VERSION } from "../../../shared/block-documents/canvas-document-identity";
import {
  type CanvasSceneMutationRequest,
  type CanvasSceneRealtimeEvent,
} from "../../../shared/block-documents/canvas-scene-sync";
import type { CanvasPresenceRealtimeEvent } from "../../../shared/block-documents/document-presence";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { MemoryCanvasSceneOutbox } from "@/lib/canvas-scene-outbox";
import type { CanvasSceneSyncAdapter } from "@/lib/canvas-scene-provider";
import { noOpLocalCommit } from "../../../shared/testing/local-commit";
import type { ContentAccessContext } from "../../../shared/content-access-context";
import {
  readCanvasViewportPreference,
  writeCanvasViewportPreference,
} from "@/lib/canvas-presentation-preference";

type MockCanvasElement = Record<string, unknown> & {
  readonly id: string;
  readonly type: string;
};

let serverScene: PortableCanvasScene;
let serverHead = 1;
let realtimeListener: ((event: CanvasSceneRealtimeEvent) => void) | null = null;
let presenceListener: ((event: CanvasPresenceRealtimeEvent) => void) | null = null;
let appliedMutations: CanvasSceneMutationRequest[] = [];
let closeFlushHandlers = new Set<() => void | Promise<void>>();
let mockSceneElements: MockCanvasElement[] = [];
let mockAppState: Record<string, unknown> = {};
let mockFiles: Record<string, unknown> = {};
let mockApiInitialized = false;
let latestOnChange:
  | ((
      elements: readonly MockCanvasElement[],
      appState: Record<string, unknown>,
      files: Record<string, unknown>,
    ) => void)
  | null = null;
let latestOnScrollChange:
  | ((scrollX: number, scrollY: number, zoom: { readonly value: number }) => void)
  | null = null;
let mockInitialScrollToContent: boolean | undefined;
let toggleSidebarCalls = 0;
let updateSceneCalls: Array<{
  readonly captureUpdate?: string;
  readonly elements?: readonly MockCanvasElement[];
  readonly collaborators?: ReadonlyMap<string, unknown>;
}> = [];
let sidebarRenderCount = 0;
let maintenanceEligible = false;
let maintenanceReadCount = 0;
let maintenanceApplyCount = 0;
let openedCards: Array<{
  readonly accessContext: ContentAccessContext;
  readonly pageId: string;
  readonly title?: string;
}> = [];
let requestedOwnerBlockIds: string[] = [];

const mockBoard = {
  columns: [
    {
      id: "triage",
      name: "Triage",
      cards: [makeCardSummary("card-1", "One"), makeCardSummary("card-2", "Two")],
    },
  ],
} as unknown as BoardSummary;

function makeCardSummary(id: string, title: string): DatabasePageSummary {
  return {
    id,
    pageKey: null,
    title,
    richTitle: plainTextToPortableRichText(title),
    status: "triage",
    archived: false,
    priority: undefined,
    estimate: undefined,
    tags: [],
    dueDate: undefined,
    scheduledStart: undefined,
    scheduledEnd: undefined,
    isAllDay: false,
    recurrence: undefined,
    reminders: [],
    scheduleTimezone: undefined,
    assignee: undefined,
    runInTarget: undefined,
    runInLocalPath: undefined,
    runInBaseBranch: undefined,
    runInWorktreePath: undefined,
    runInEnvironmentPath: undefined,
    revision: 1,
    created: new Date("2026-06-01T00:00:00.000Z"),
    order: 1,
    descriptionPreview: "",
    descriptionLength: 0,
    hasDescription: false,
  };
}

function makePlacedElement(pageId: string, version = 1): MockCanvasElement {
  const title = pageId === "card-2" ? "Two" : pageId === "standalone-card" ? "Standalone" : "One";
  return {
    id: `element-${pageId}`,
    type: "rectangle",
    index: pageId === "card-2" ? "b1" : "a1",
    version,
    versionNonce: pageId === "card-2" ? 22 : 11,
    isDeleted: false,
    backgroundColor: "#f8f9fa",
    customData: {
      type: "nodex-card-reference",
      targetBlockId: pageId,
      titleHint: title,
    },
    label: { text: title },
  };
}

const syncResponse = (syncRequestId: string) => ({
  kind: "snapshot" as const,
  syncRequestId,
  libraryId: "library-1",
  accessContext: { kind: "project" as const, projectId: "project-1" },
  documentId: descriptor.documentId,
  storeEpoch: descriptor.storeEpoch,
  generation: descriptor.generation,
  headSeq: serverHead,
  sceneHash: createHash("sha256")
    .update(canonicalPortableCanvasSceneFingerprint(serverScene))
    .digest("hex"),
  scene: serverScene,
});

const adapter: CanvasSceneSyncAdapter = {
  subscribe: (_request, listener, nextPresenceListener) => {
    realtimeListener = listener;
    presenceListener = nextPresenceListener ?? null;
    return () => {
      if (realtimeListener === listener) realtimeListener = null;
      if (presenceListener === nextPresenceListener) presenceListener = null;
    };
  },
  sync: async (request) => ({
    ok: true,
    value: syncResponse(request.syncRequestId),
  }),
  applyMutation: async (request) => {
    appliedMutations.push(request);
    const nextAppState = { ...serverScene.appState } as Record<string, unknown>;
    for (const [key, intent] of Object.entries(request.appStateIntents)) {
      const expected = intent.expected.kind === "value" ? intent.expected.value : undefined;
      if (JSON.stringify(nextAppState[key]) !== JSON.stringify(expected)) continue;
      if (intent.value.kind === "value") nextAppState[key] = intent.value.value;
      else delete nextAppState[key];
    }
    const elements = new Map(
      serverScene.elements.map((element) => [element.id as string, element]),
    );
    for (const candidate of request.elementCandidates) {
      const id = candidate.id as string;
      const current = elements.get(id);
      elements.set(id, current ? chooseCanvasSceneElementWinner(current, candidate) : candidate);
    }
    serverScene = materializePortableCanvasScene({
      elements: [...elements.values()],
      appState: nextAppState,
      files: { ...serverScene.files, ...request.fileAdditions },
    });
    const baseHeadSeq = serverHead;
    serverHead += 1;
    return {
      ok: true,
      localCommit: noOpLocalCommit(request.storeEpoch, serverHead),
      value: {
        mutationId: request.mutationId,
        libraryId: descriptor.libraryId,
        accessContext: request.accessContext,
        documentId: request.documentId,
        storeEpoch: request.storeEpoch,
        generation: request.generation,
        baseHeadSeq,
        headSeq: serverHead,
        duplicate: false,
        outcome: "committed",
        sceneHash: createHash("sha256")
          .update(canonicalPortableCanvasSceneFingerprint(serverScene))
          .digest("hex"),
        changedElementIds: request.elementCandidates.map((element) => element.id as string),
        appliedAppStateKeys: Object.keys(request.appStateIntents),
        skippedAppStateKeys: [],
        addedFileIds: Object.keys(request.fileAdditions),
        removedFileIds: [],
        committedAt: "2026-07-13T00:00:00.000Z",
        committedDelta: {
          elementUpdates: request.elementCandidates,
          appState: serverScene.appState,
          fileAdditions: request.fileAdditions,
          removedFileIds: [],
        },
      },
    };
  },
  publishPresence: async () => ({
    ok: true,
    value: { accepted: true, applied: true },
  }),
};

function MockExcalidraw(props: {
  readonly excalidrawAPI?: (api: unknown) => void;
  readonly initialData?: {
    readonly elements?: readonly MockCanvasElement[];
    readonly appState?: Record<string, unknown>;
    readonly files?: Record<string, unknown>;
    readonly scrollToContent?: boolean;
  };
  readonly onChange?: (
    elements: readonly MockCanvasElement[],
    appState: Record<string, unknown>,
    files: Record<string, unknown>,
  ) => void;
  readonly onScrollChange?: (
    scrollX: number,
    scrollY: number,
    zoom: { readonly value: number },
  ) => void;
  readonly renderTopRightUI?: () => ReactNode;
  readonly onLinkOpen?: (element: MockCanvasElement, event: { preventDefault: () => void }) => void;
  readonly children?: ReactNode;
}) {
  if (!mockApiInitialized) {
    mockApiInitialized = true;
    mockSceneElements = [...(props.initialData?.elements ?? [])];
    mockAppState = {
      scrollX: 0,
      scrollY: 0,
      zoom: { value: 1 },
      ...(props.initialData?.appState ?? {}),
    };
    mockFiles = { ...(props.initialData?.files ?? {}) };
    mockInitialScrollToContent = props.initialData?.scrollToContent;
  }
  props.excalidrawAPI?.({
    getSceneElementsIncludingDeleted: () => mockSceneElements,
    getAppState: () => mockAppState,
    getFiles: () => mockFiles,
    addFiles: (files: readonly { id: string }[]) => {
      for (const file of files) mockFiles[file.id] = file;
    },
    updateScene: ({
      elements,
      appState,
      collaborators,
      captureUpdate,
    }: {
      readonly elements?: readonly MockCanvasElement[];
      readonly appState?: Record<string, unknown>;
      readonly collaborators?: ReadonlyMap<string, unknown>;
      readonly captureUpdate?: string;
    }) => {
      updateSceneCalls.push({ captureUpdate, elements, collaborators });
      if (elements) mockSceneElements = [...elements];
      if (appState) mockAppState = { ...mockAppState, ...appState };
    },
    toggleSidebar: (payload: { name: string; tab: string }) => {
      if (payload.name === "cards" && payload.tab === "browse") toggleSidebarCalls += 1;
    },
  });
  latestOnChange = props.onChange ?? null;
  latestOnScrollChange = props.onScrollChange ?? null;
  return createElement(
    "div",
    { "data-testid": "excalidraw" },
    props.renderTopRightUI?.(),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => latestOnChange?.(mockSceneElements, mockAppState, mockFiles),
      },
      "emit change",
    ),
    createElement(
      "button",
      {
        type: "button",
        onClick: () => {
          const element = mockSceneElements[0];
          if (element) props.onLinkOpen?.(element, { preventDefault: () => undefined });
        },
      },
      "open first card",
    ),
    props.children,
  );
}

const descriptor = {
  libraryId: "library-1",
  accessContext: { kind: "project", projectId: "project-1" },
  ownerBlockId: "019f7399-7676-70ae-b2aa-168692b64d20",
  ownerType: "canvas",
  ownerLifecycle: "active",
  documentId: "019f7399-7676-70ae-b2aa-168692b64d22",
  storeEpoch: "epoch-1",
  generation: 1,
  headSeq: 1,
  schemaKey: "nodex.canvas",
  schemaVersion: CANVAS_DOCUMENT_SCHEMA_VERSION,
  readiness: "ready",
  sync: { kind: "canvas_scene" },
} as const;

vi.mock("@excalidraw/excalidraw/index.css", () => ({}));

vi.mock("@/features/document-recovery/recovery-entry", () => ({
  RecoveryEntry: () => null,
}));

vi.mock("./canvas-view-deps", () => ({
  loadExcalidraw: async () => ({
    Excalidraw: MockExcalidraw,
    convertToExcalidrawElements: (skeletons: readonly MockCanvasElement[]) => skeletons,
    reconcileElements: (
      local: readonly MockCanvasElement[],
      remote: readonly MockCanvasElement[],
    ) => {
      const localById = new Map(local.map((element) => [element.id, element]));
      return remote.map((element) => {
        const current = localById.get(element.id);
        return Number(current?.version ?? 0) > Number(element.version ?? 0) ? current : element;
      });
    },
    CaptureUpdateAction: { NEVER: "never", EVENTUALLY: "eventually", IMMEDIATELY: "immediately" },
    newElementWith: (element: MockCanvasElement, changes: Record<string, unknown>) => ({
      ...element,
      ...changes,
      version: Number(element.version ?? 0) + 1,
      versionNonce: 1,
    }),
  }),
  loadCanvasCardSidebar: async () => ({
    CanvasCardSidebar: ({ placedPageIds }: { placedPageIds: Set<string> }) => {
      sidebarRenderCount += 1;
      return createElement(
        "div",
        { "data-testid": "card-sidebar" },
        `placed:${[...placedPageIds].sort().join(",")}`,
      );
    },
  }),
  RegisteredOwnedBlockDocumentBoundary: ({
    children,
    ownerBlockId,
  }: {
    readonly children: (model: unknown, controls: unknown) => ReactNode;
    readonly ownerBlockId: string;
  }) => {
    requestedOwnerBlockIds.push(ownerBlockId);
    return children(
      {
        status: "ydoc_primary",
        accessContext: descriptor.accessContext,
        ownerBlockId,
        descriptor: { ...descriptor, ownerBlockId },
      },
      { reload: async () => undefined },
    );
  },
  createCanvasSceneSyncAdapter: () => adapter,
  createDefaultCanvasSceneOutbox: (libraryId: string) => new MemoryCanvasSceneOutbox(libraryId),
  readCanvasSceneCompaction: async () => {
    maintenanceReadCount += 1;
    return {
      ok: true,
      value: {
        documentId: descriptor.documentId,
        generation: descriptor.generation,
        headSeq: serverHead,
        sceneHash: "a".repeat(64),
        tombstoneCount: maintenanceEligible ? 5_000 : 0,
        tombstoneBytes: 0,
        eligible: maintenanceEligible,
      },
    };
  },
  compactCanvasScene: async () => {
    maintenanceApplyCount += 1;
    return {
      ok: false,
      error: {
        code: "unknown",
        message: "deferred in renderer test",
        retryable: true,
        resetRequired: false,
      },
    };
  },
  registerAppCloseFlushHandler: (handler: () => void | Promise<void>) => {
    closeFlushHandlers.add(handler);
    return () => closeFlushHandlers.delete(handler);
  },
  useTheme: () => ({ resolved: "light" }),
}));

async function renderCanvas(strict = false) {
  const { CanvasDocumentSurface } = await import("../canvas/canvas-document-surface");
  const canvas = createElement(CanvasDocumentSurface, {
    accessContext: descriptor.accessContext,
    canvasBlockId: descriptor.ownerBlockId,
    surfaceKey: "canvas:test",
    viewportPreferenceScope: "stage:test",
    variant: "stage",
    active: true,
    pagePalette: {
      board: mockBoard,
      createPage: async () => makeCardSummary("card-new", "New Card"),
    },
    onOpenPage: ({ accessContext, pageId, titleSnapshot }) => {
      openedCards.push({ accessContext, pageId, title: titleSnapshot });
    },
    activePageId: undefined,
    onCloseActivePage: async () => undefined,
  });
  return render(strict ? createElement(StrictMode, null, canvas) : canvas);
}

async function runThroughCanvasMutationDebounce(action: () => void): Promise<void> {
  vi.useFakeTimers();
  try {
    await act(async () => {
      action();
      await vi.advanceTimersByTimeAsync(180);
    });
  } finally {
    vi.useRealTimers();
  }
}

describe("CanvasDocumentSurface", () => {
  beforeEach(() => {
    serverScene = materializePortableCanvasScene({ elements: [makePlacedElement("card-1")] });
    serverHead = 1;
    realtimeListener = null;
    presenceListener = null;
    appliedMutations = [];
    closeFlushHandlers = new Set();
    mockSceneElements = [];
    mockAppState = {};
    mockFiles = {};
    mockApiInitialized = false;
    latestOnChange = null;
    latestOnScrollChange = null;
    mockInitialScrollToContent = undefined;
    toggleSidebarCalls = 0;
    updateSceneCalls = [];
    sidebarRenderCount = 0;
    maintenanceEligible = false;
    maintenanceReadCount = 0;
    maintenanceApplyCount = 0;
    openedCards = [];
    requestedOwnerBlockIds = [];
    localStorage.clear();
  });

  test("mounts one scene-native Canvas surface without a component close handler", async () => {
    const view = await renderCanvas(true);
    await view.findByTestId("excalidraw");
    expect(closeFlushHandlers.size).toBe(0);
    mockSceneElements = [makePlacedElement("card-1", 2)];
    await runThroughCanvasMutationDebounce(() => {
      fireEvent.click(view.getByRole("button", { name: "emit change" }));
    });
    expect(appliedMutations).toHaveLength(1);
  });

  test("opens an arbitrary Canvas owner without requiring a Page palette", async () => {
    const { CanvasDocumentSurface } = await import("../canvas/canvas-document-surface");
    const canvasId = "019f7399-7676-70ae-b2aa-168692b64d21";
    const view = render(
      createElement(CanvasDocumentSurface, {
        accessContext: descriptor.accessContext,
        canvasBlockId: canvasId,
        surfaceKey: "canvas:standalone",
        viewportPreferenceScope: "stage:standalone",
        variant: "stage",
        active: true,
      }),
    );

    await view.findByTestId("excalidraw");
    expect(requestedOwnerBlockIds).toEqual([canvasId]);
    expect(view.queryByRole("button", { name: "Pages" })).toBeNull();
    expect(view.queryByTestId("card-sidebar")).toBeNull();
  });

  test("Pages button toggles the Excalidraw sidebar", async () => {
    const view = await renderCanvas();
    fireEvent.click(await view.findByRole("button", { name: "Pages" }));
    expect(toggleSidebarCalls).toBe(1);
  });

  test("restores and flushes the last profile-local Document viewport", async () => {
    writeCanvasViewportPreference(
      {
        storeEpoch: descriptor.storeEpoch,
        documentId: descriptor.documentId,
        preferenceScope: "stage:test",
      },
      {
        scrollX: -320,
        scrollY: 180,
        zoom: 1.75,
      },
    );
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");

    expect(mockAppState).toMatchObject({
      scrollX: -320,
      scrollY: 180,
      zoom: { value: 1.75 },
    });
    expect(mockInitialScrollToContent).toBe(false);

    mockAppState = {
      ...mockAppState,
      scrollX: 640,
      scrollY: -80,
      zoom: { value: 2.25 },
    };
    act(() => latestOnScrollChange?.(640, -80, { value: 2.25 }));
    const mutationCount = appliedMutations.length;
    view.unmount();

    expect(
      readCanvasViewportPreference({
        storeEpoch: descriptor.storeEpoch,
        documentId: descriptor.documentId,
        preferenceScope: "stage:test",
      }),
    ).toEqual({
      scrollX: 640,
      scrollY: -80,
      zoom: 2.25,
    });
    expect(appliedMutations).toHaveLength(mutationCount);
  });

  test("keeps maintenance invisible and attempts it only after the surface closes", async () => {
    maintenanceEligible = true;
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    expect(view.queryByRole("button", { name: "Optimize" })).toBeNull();
    expect(maintenanceReadCount).toBe(0);

    view.unmount();

    await waitFor(() => expect(maintenanceReadCount).toBe(1));
    expect(maintenanceApplyCount).toBe(1);
  });

  test("opens a referenced standalone Card by Block identity", async () => {
    serverScene = materializePortableCanvasScene({
      elements: [makePlacedElement("standalone-card")],
    });
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    fireEvent.click(view.getByRole("button", { name: "open first card" }));
    expect(openedCards).toEqual([
      {
        accessContext: descriptor.accessContext,
        pageId: "standalone-card",
        title: "Standalone",
      },
    ]);
  });

  test("local observations persist through the scene provider", async () => {
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    await settleAsyncRender();
    const initialSidebarRenderCount = sidebarRenderCount;
    mockSceneElements = [makePlacedElement("card-1"), makePlacedElement("card-2")];
    await runThroughCanvasMutationDebounce(() => {
      fireEvent.click(view.getByRole("button", { name: "emit change" }));
    });
    await waitFor(() => expect(appliedMutations).toHaveLength(1));
    expect(serverScene.elements).toHaveLength(2);
    expect(sidebarRenderCount > initialSidebarRenderCount).toBe(true);
    expect(textContent(view.container).includes("placed:card-1,card-2")).toBe(true);
  });

  test("Retry sync resubmits the visible scene after validation failure", async () => {
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    mockSceneElements = [{ ...makePlacedElement("card-1", 2), customData: () => undefined }];
    await runThroughCanvasMutationDebounce(() => {
      fireEvent.click(view.getByRole("button", { name: "emit change" }));
    });
    await view.findByRole("button", { name: "Retry sync" });
    mockSceneElements = [{ ...makePlacedElement("card-1", 3), x: 320 }];
    await runThroughCanvasMutationDebounce(() => {
      fireEvent.click(view.getByRole("button", { name: "Retry sync" }));
    });
    await waitFor(() => expect(serverScene.elements[0]?.x).toBe(320));
    expect(view.queryByRole("button", { name: "Retry sync" })).toBeNull();
  });

  test("remote canonical scenes reconcile without entering local undo", async () => {
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    mockAppState = {
      ...mockAppState,
      scrollX: 220,
      scrollY: -140,
      zoom: { value: 1.5 },
    };
    const callsBeforeRemote = updateSceneCalls.length;
    serverScene = materializePortableCanvasScene({
      elements: [{ ...makePlacedElement("card-1", 2), x: 240 }],
      appState: { gridModeEnabled: true },
    });
    serverHead += 1;
    act(() =>
      realtimeListener?.({
        type: "canvas_scene_resync_required",
        libraryId: descriptor.libraryId,
        accessContext: descriptor.accessContext,
        documentId: descriptor.documentId,
        storeEpoch: descriptor.storeEpoch,
        generation: descriptor.generation,
        headSeq: serverHead,
      }),
    );
    await waitFor(() => expect(updateSceneCalls.length > callsBeforeRemote).toBe(true));
    const latest = updateSceneCalls.at(-1);
    expect(latest?.captureUpdate).toBe("never");
    expect(mockSceneElements[0]?.x).toBe(240);
    expect(mockAppState.gridModeEnabled).toBe(true);
    expect(mockAppState).toMatchObject({
      scrollX: 220,
      scrollY: -140,
      zoom: { value: 1.5 },
    });
  });

  test("remote presence renders collaborators without durable scene mutations", async () => {
    const view = await renderCanvas();
    await view.findByTestId("excalidraw");
    await settleAsyncRender();
    const mutationCount = appliedMutations.length;
    act(() =>
      presenceListener?.({
        type: "canvas_presence_updated",
        libraryId: descriptor.libraryId,
        accessContext: descriptor.accessContext,
        presence: {
          engine: "canvas_scene",
          documentId: descriptor.documentId,
          generation: descriptor.generation,
          clock: 1,
          state: {
            pointer: {
              x: 40,
              y: 60,
              button: "up",
              tool: "pointer",
            },
            selectedElementIds: [],
            idle: "active",
          },
          clientSessionId: "remote-session",
          user: {
            id: "window:2",
            displayName: "Window 2",
            color: "#1971c2",
          },
        },
      }),
    );
    await waitFor(() => expect(updateSceneCalls.at(-1)?.collaborators?.size).toBe(1));
    expect(updateSceneCalls.at(-1)?.captureUpdate).toBe("never");
    expect(appliedMutations).toHaveLength(mutationCount);
  });
});

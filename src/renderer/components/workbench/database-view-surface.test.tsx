import { deferred } from "./agent-instance-settings.test-fixtures";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createEvent, fireEvent, waitFor, within } from "@testing-library/react";
import { act, useRef, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  groupScopeKeyForPath,
  type DatabaseViewRenderModel,
} from "@/lib/database-view-render-model";
import {
  commitDatabaseViewOperations,
  type DatabaseViewMutationReceipt,
} from "@/lib/database-view-row-mutations";
import type { DatabaseListWindowSnapshot } from "../../../shared/database-views";
import type { DatabaseDataEditUndoRecipeV2 } from "../../../shared/database-module-v2";
import {
  createDatabaseViewMutationHistory,
  databaseViewHistoryScopeKey,
} from "./database-view-mutation-history";
import { plainTextToPortableRichText } from "../../../shared/block-documents/portable-rich-text";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
  parseDataSourceOptionId,
} from "../../../shared/database-identities";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { upgradeDatabaseViewConfigV2 } from "../../../shared/database-view-presentation";
import { render as renderDom, settleAsyncRender } from "../../test/dom";
import { DatabaseViewSurface } from "./database-view-surface";
import { DatabaseViewTabContent, DatabaseViewTabSurface } from "./workbench-db-view-panel";
import { handleWorkbenchShortcut } from "@/lib/use-workbench-shortcuts";
import { createMaitaiStore } from "@/lib/maitai";
import { TestMaitaiRoot } from "@/test/app-maitai";
import { resetContextualKeyboardActionRegistryForTests } from "@/lib/contextual-keyboard-actions";
import {
  beginLocalBlockDragSession,
  endLocalBlockDragSession,
} from "./block-transfer/cross-surface-drag";
import { createDefaultWorkbenchLayoutSnapshot } from "../../../shared/workbench-layout";
import {
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  makeWorkbenchSceneKey,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import {
  createScopeHandle,
  disposeMaitaiStore,
  getMaitaiRootView,
} from "@/lib/maitai/maitai-store";
import { getWorkbenchWindowOwner } from "@/lib/workbench-window-owner";
import { captureWorkbenchViewContent } from "@/lib/workbench-view-content";

const render: typeof renderDom = (element, options) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const store = createMaitaiStore({ queryClient });
  const withClient = (children: ReactNode) => (
    <TestMaitaiRoot store={store}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </TestMaitaiRoot>
  );
  const result = renderDom(withClient(element), options);
  return {
    ...result,
    rerender: (nextElement) => result.rerender(withClient(nextElement)),
  };
};

const readListWindow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  readDatabaseListWindow: readListWindow,
}));

const optionRuntime = vi.hoisted(() => ({ read: vi.fn() }));
const pageChatRuntime = vi.hoisted(() => ({
  readWindow: vi.fn<typeof import("@/lib/page-chat-runtime").readPageChatWindow>(),
  summaries: [] as Array<{
    pageId: string;
    relatedCount: number;
    workingCount: number;
    waitingOnApprovalCount: number;
    waitingOnUserInputCount: number;
    errorCount: number;
    unreadCount: number;
    soleSessionId: string | null;
    runtimeSessionIds: string[];
    work: import("@/lib/types").PageChatActivitySummary["work"];
  }>,
}));
vi.mock("@/lib/database-property-options-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/database-property-options-runtime")>()),
  readPropertyOptionWindow: optionRuntime.read,
}));
vi.mock("@/lib/page-chat-runtime", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/page-chat-runtime")>();
  return {
    ...original,
    readPageChatWindow: pageChatRuntime.readWindow,
    readPageChatActivitySummaries: async () => ({
      summaries: pageChatRuntime.summaries,
      projectionRevision: 1,
    }),
  };
});

const timestamp = "2026-07-12T00:00:00.000Z";
const dataSourceId = parseDataSourceId("source-1");
const databaseId = parseDatabaseId("database-1");
const viewId = parseDatabaseViewId("view-focused");
const tagsPropertyId = parseDataSourcePropertyId("tags");
const statusPropertyId = parseDataSourcePropertyId("status");
const priorityPropertyId = parseDataSourcePropertyId("priority");

const mutationReceipt = (
  operationKinds: DatabaseViewMutationReceipt["operationKinds"],
): DatabaseViewMutationReceipt => ({
  operationId: "operation-1",
  projectId: "project-1",
  libraryId: "library-1",
  storeEpoch: "epoch-1",
  duplicate: false,
  operationKinds,
  operationOutcomes: [],
  affectedDatabaseIds: [databaseId],
  affectedDataSourceIds: [dataSourceId],
  affectedPageIds: [],
  affectedViewIds: [viewId],
  committedRevisions: {},
  commitSeq: 3,
  committedAt: timestamp,
});

const model: DatabaseViewRenderModel = {
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-1" },
  databaseViewId: viewId,
  databaseId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Pages",
  viewName: "Focused",
  storeEpoch: "epoch-1",
  commitSeq: 2,
  query: {
    database: {
      databaseId,
      libraryId: "library-1",
      name: "Tasks",
      lifecycle: "active",
      defaultViewId: parseDatabaseViewId("view-default"),
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSource: {
      dataSourceId,
      libraryId: "library-1",
      homeDatabaseId: databaseId,
      name: "Pages",
      schemaKey: "nodex.pages",
      schemaRevision: 1,
      lifecycle: "active",
      rankKey: "a",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    view: {
      viewId,
      databaseId,
      dataSourceId,
      name: "Focused",
      layout: "list",
      config: upgradeDatabaseViewConfigV2({
        schemaKey: "nodex.database-view",
        schemaVersion: 2,
        filter: { kind: "group", operator: "and", children: [] },
        sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
        group: null,
        display: { propertyIds: [tagsPropertyId], showTitle: true },
      }),
      isDefault: false,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    properties: [
      {
        propertyId: tagsPropertyId,
        dataSourceId,
        name: "Tags",
        ...testPropertySemantics("multi_select", 2),
        valueType: "multi_select",
        config: {
          options: [
            { id: "o_AAAAAAAA", name: "Selected View" },
            { id: "o_BBBBBBBB", name: "Next" },
          ],
        },
        rankKey: "a",
        lifecycle: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    rows: [
      {
        pageKey: null,
        membership: {
          membershipId: "membership-focused",
          dataSourceId,
          revision: 1,
          createdAt: timestamp,
        },
        page: {
          pageId: "page-focused",
          libraryId: "library-1",
          parent: { kind: "data_source", dataSourceId },
          lifecycle: "active",
          parentRevision: 1,
          metadataRevision: 1,
          documentId: "document-focused",
          documentGeneration: 1,
          documentHeadSeq: 1,
          title: "Focused Page",
          richTitle: plainTextToPortableRichText("Focused Page"),
          preview: "",
          plainText: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        values: {
          [tagsPropertyId]: {
            propertyId: tagsPropertyId,
            valueType: "multi_select",
            value: ["o_AAAAAAAA"],
            revision: 1,
          },
        },
        work: { unsatisfiedCount: 0, blockers: [], owner: null, assignee: null, autoStart: false },
        taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
        position: { rankKey: "a", revision: 1 },
        effectiveGroupKey: null,
        effectiveSubgroupKey: null,
      },
    ],
  },
  columns: [
    {
      id: "doing",
      groupKey: "doing",
      scopeKey: "key:doing",
      name: "In Progress",
      rows: [
        {
          pageId: "page-focused",
          pageKey: null,
          groupKey: "doing",
          subgroupKey: null,
          status: "doing",
          title: "Focused Page",
          preview: "",
          plainText: "",
          tags: ["selected-view"],
          taskParentValueRevision: 1,
          documentGeneration: 1,
          documentHeadSeq: 1,
          metadataRevision: 1,
          createdAt: new Date(timestamp),
        },
      ],
    },
  ],
};

const boardModel = (): DatabaseViewRenderModel => {
  const firstAuthority = model.query.rows[0]!;
  const firstRow = model.columns[0]!.rows[0]!;
  const secondAuthority = {
    ...firstAuthority,
    membership: {
      ...firstAuthority.membership,
      membershipId: "membership-next",
    },
    page: {
      ...firstAuthority.page,
      pageId: "page-next",
      documentId: "document-next",
      title: "Next Page",
      richTitle: plainTextToPortableRichText("Next Page"),
    },
    position: { rankKey: "b", revision: 2 },
  };
  return {
    ...model,
    query: {
      ...model.query,
      view: { ...model.query.view, layout: "board" },
      rows: [firstAuthority, secondAuthority],
    },
    columns: [
      {
        ...model.columns[0]!,
        rows: [
          firstRow,
          {
            ...firstRow,
            pageId: "page-next",
            title: "Next Page",
          },
        ],
      },
    ],
  };
};

const listModel = (): DatabaseViewRenderModel => {
  const next = boardModel();
  return {
    ...next,
    query: {
      ...next.query,
      view: { ...next.query.view, layout: "list" },
    },
    columns: [
      {
        id: "all",
        groupKey: null,
        scopeKey: "all",
        name: "Focused",
        rows: next.columns.flatMap((column) => column.rows),
      },
    ],
  };
};

const priorityGroupedBoardModel = (): DatabaseViewRenderModel => {
  const next = boardModel();
  const priorityProperty = {
    propertyId: priorityPropertyId,
    dataSourceId,
    name: "Priority",
    ...testPropertySemantics("select", 4),
    valueType: "select" as const,
    config: {
      options: [
        { id: "p1-high", name: "P1 - High", color: "red" },
        { id: "p3-low", name: "P3 - Low", color: "gray" },
      ],
    },
    rankKey: "0",
    lifecycle: "active" as const,
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    ...next,
    query: {
      ...next.query,
      view: {
        ...next.query.view,
        layout: "board",
        config: {
          ...next.query.view.config,
          presentation: {
            ...next.query.view.config.presentation,
            group: { propertyId: priorityPropertyId },
            display: {
              ...next.query.view.config.presentation.display,
              fields: [
                { kind: "property", propertyId: priorityPropertyId },
                { kind: "property", propertyId: tagsPropertyId },
              ],
            },
          },
        },
      },
      properties: [priorityProperty, ...next.query.properties],
      rows: next.query.rows.map((row) => ({
        ...row,
        values: {
          ...row.values,
          [priorityPropertyId]: {
            propertyId: priorityPropertyId,
            valueType: "select" as const,
            value: "p1-high",
            revision: 1,
          },
        },
        effectiveGroupKey: "p1-high",
      })),
    },
  };
};

const prioritySortedBoardModel = (): DatabaseViewRenderModel => {
  const next = priorityGroupedBoardModel();
  return {
    ...next,
    query: {
      ...next.query,
      view: {
        ...next.query.view,
        config: {
          ...next.query.view.config,
          rules: {
            ...next.query.view.config.rules,
            sorts: [
              {
                field: { kind: "property", propertyId: priorityPropertyId },
                direction: "asc",
                nulls: "last",
              },
            ],
          },
          presentation: { ...next.query.view.config.presentation, group: null },
        },
      },
      rows: next.query.rows.map((row, index) => ({
        ...row,
        values: {
          ...row.values,
          [priorityPropertyId]: {
            ...row.values[priorityPropertyId]!,
            value: index === 0 ? "p1-high" : "p3-low",
          },
        },
        effectiveGroupKey: null,
      })),
    },
  };
};

const shortcutEvent = (
  key: string,
  input: {
    readonly code?: string;
    readonly altKey?: boolean;
    readonly shiftKey?: boolean;
  } = {},
) => ({
  key,
  code: input.code,
  ctrlKey: false,
  metaKey: false,
  shiftKey: input.shiftKey ?? false,
  altKey: input.altKey ?? false,
  target: null,
});

const databaseViewPageDataTransfer = (): DataTransfer => {
  const data = new Map<string, string>();
  return {
    effectAllowed: "none",
    dropEffect: "none",
    get types() {
      return [...data.keys()];
    },
    getData: (type: string) => data.get(type) ?? "",
    setData: (type: string, value: string) => data.set(type, value),
    setDragImage: () => undefined,
  } as unknown as DataTransfer;
};

describe("DatabaseViewSurface", () => {
  beforeEach(() => {
    resetContextualKeyboardActionRegistryForTests();
    pageChatRuntime.summaries = [];
    pageChatRuntime.readWindow.mockReset();
    optionRuntime.read.mockReset().mockImplementation(async (_context, property) => ({
      options:
        property.propertyId === statusPropertyId
          ? [
              { id: "triage", name: "Triage" },
              { id: "plan", name: "Planned" },
              { id: "doing", name: "In progress" },
              { id: "review", name: "Review" },
              { id: "done", name: "Shipped" },
            ]
          : property.propertyId === priorityPropertyId
            ? [
                { id: "p0-critical", name: "P0 - Critical" },
                { id: "p1-high", name: "P1 - High" },
                { id: "p2-medium", name: "P2 - Medium" },
                { id: "p3-low", name: "P3 - Low" },
              ]
            : [],
      nextCursor: null,
      projectionRevision: 1,
    }));
  });

  test("publishes the committed Board or List body and revokes its display reader on unmount", async () => {
    const store = createMaitaiStore();
    const sceneOwner = { kind: "project" as const, projectId: "project-1" };
    // The Project's Board opens beside its Inbox Home as an ordinary tab.
    const boardSurface = {
      id: "surface:board",
      kind: "db_view",
      titleSnapshot: "Board",
      config: {
        routingContext: { kind: "project", projectId: "project-1" },
        target: { kind: "project-default" },
      },
      stateKey: 0,
      state: null,
    } satisfies WorkbenchSurfaceDescriptor;
    const scene = createWorkbenchSceneSurface(materializeInitialWorkbenchScene(sceneOwner), {
      panelId: "right",
      surface: boardSurface,
    });
    const owner = getWorkbenchWindowOwner(createScopeHandle(getMaitaiRootView(store)), {
      ...createDefaultWorkbenchLayoutSnapshot(),
      location: sceneOwner,
      scenesByOwnerKey: { [makeWorkbenchSceneKey(sceneOwner)]: scene },
    });
    owner.initialize();
    const release = owner.registerResolvedDatabaseView(
      sceneOwner,
      boardSurface,
      model.databaseViewId,
    );
    const binding = {
      presentation: { owner, sceneOwner, surface: boardSurface },
      preferencesRevision: 3,
      preferencesPending: false,
      loading: false,
    };
    const capture = () =>
      captureWorkbenchViewContent(
        owner,
        {
          kind: "capture_view",
          sceneOwner,
          tabId: boardSurface.id,
          expectedPresentationRevision: owner.read().presentationRevision,
          purpose: "display",
          range: "loaded",
          offset: 0,
          limit: 200,
        },
        () => true,
      );
    const surface = (viewModel: DatabaseViewRenderModel) => (
      <DatabaseViewSurface
        workbenchContent={binding}
        model={viewModel}
        searchQuery=""
        onOpenPage={() => {}}
      />
    );
    const screen = render(surface(boardModel()));
    try {
      await settleAsyncRender();
      expect(capture()).toMatchObject({
        status: "ready",
        layout: "board",
        preferencesRevision: 3,
        coverage: {
          loadedOccurrenceCount: 2,
          mountedOccurrenceCount: 2,
          viewportOccurrenceCount: 0,
          viewportKnown: false,
        },
      });
      const board = capture();
      if (board.status !== "ready") throw new Error("Expected Board capture");
      expect(board.occurrences.map((entry) => entry.pageId)).toEqual(["page-focused", "page-next"]);
      await act(async () => {
        screen.rerender(surface(model));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(capture()).toMatchObject({
          status: "ready",
          layout: "list",
          coverage: { loadedOccurrenceCount: 1 },
        }),
      );
      await act(async () => {
        screen.unmount();
        await Promise.resolve();
      });
      expect(capture()).toEqual({ status: "surface_unavailable" });
    } finally {
      screen.unmount();
      release();
      disposeMaitaiStore(store);
    }
  });

  test("accepts Block promotion during protected dragover payload access", async () => {
    const data = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: "none",
      dropEffect: "none",
      get types() {
        return [...data.keys()];
      },
      getData: () => {
        throw new Error("drag payload is protected outside drop");
      },
      setData: (type: string, value: string) => data.set(type, value),
      setDragImage: () => undefined,
    } as unknown as DataTransfer;
    const session = beginLocalBlockDragSession(
      {
        sourceSurfaceId: "editor:source",
        projectId: "project-1",
        storeEpoch: "epoch-1",
        source: { kind: "document", documentId: "document:source" },
        rootBlockIds: ["block:source"],
        displayHints: ["paragraph"],
      },
      dataTransfer,
    );
    const screen = render(
      <DatabaseViewSurface model={boardModel()} searchQuery="" onOpenPage={() => undefined} />,
    );
    const column = screen.container.querySelector<HTMLElement>('[data-board-column-root="true"]');
    if (!column) throw new Error("Board column fixture is incomplete");
    const dragOver = createEvent.dragOver(column, { dataTransfer, clientY: 1 });

    try {
      await act(async () => {
        fireEvent(column, dragOver);
        await Promise.resolve();
      });
      expect(dragOver.defaultPrevented).toBe(true);
      expect(dataTransfer.dropEffect).toBe("move");
    } finally {
      endLocalBlockDragSession({ sessionId: session.sessionId });
    }
  });

  test("preserves the active selection when the same View switches layout", () => {
    const screen = render(
      <DatabaseViewSurface
        model={boardModel()}
        presentationLayout="board"
        searchQuery=""
        keyboardSurface={{ surfaceId: "layout", presentationId: "same-view" }}
        onOpenPage={() => undefined}
      />,
    );
    const actions = { projectOrder: [], switchToProjectIndex: () => undefined };

    act(() => {
      handleWorkbenchShortcut(shortcutEvent("j", { code: "KeyJ" }), actions, true);
    });
    act(() => {
      handleWorkbenchShortcut(shortcutEvent("x", { code: "KeyX" }), actions, true);
    });
    expect(screen.getAllByRole("article")[0]?.getAttribute("aria-selected")).toBe("true");

    screen.rerender(
      <DatabaseViewSurface
        model={boardModel()}
        presentationLayout="list"
        searchQuery=""
        keyboardSurface={{ surfaceId: "layout", presentationId: "same-view" }}
        onOpenPage={() => undefined}
      />,
    );

    expect(
      screen.container
        .querySelectorAll<HTMLElement>("[data-list-row=true]")[0]
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.container.querySelectorAll<HTMLElement>("[data-list-row=true]")[0]?.tabIndex,
    ).toBe(0);
  });

  test("keeps external editor focus across List projection refreshes and selection", async () => {
    const renderSurface = (viewModel: DatabaseViewRenderModel) => (
      <>
        <input aria-label="Page editor" />
        <DatabaseViewSurface
          model={viewModel}
          presentationLayout="list"
          searchQuery=""
          onOpenPage={() => undefined}
        />
      </>
    );
    const screen = render(renderSurface(listModel()));
    const row = screen.container.querySelector<HTMLElement>(
      '[data-database-view-page-id="page-focused"]',
    );
    if (!row) throw new Error("Expected the focused List row");
    await act(async () => {
      fireEvent.focus(row);
      await Promise.resolve();
    });

    const editor = screen.getByRole("textbox", { name: "Page editor" });
    editor.focus();
    screen.rerender(renderSurface(listModel()));
    await waitFor(() => expect(document.activeElement).toBe(editor));

    const checkbox = screen.getByRole("checkbox", {
      name: "Select Focused Page",
    });
    checkbox.focus();
    await act(async () => {
      fireEvent.click(checkbox);
      await Promise.resolve();
    });
    await waitFor(() => expect(document.activeElement).toBe(checkbox));
  });

  test("routes List Page session and delete commands through the shared action port", async () => {
    const openInNewChat = vi.fn();
    const deletePage = vi.fn(async () => undefined);
    const screen = render(
      <DatabaseViewSurface
        model={listModel()}
        presentationLayout="list"
        searchQuery=""
        onOpenPage={() => undefined}
        pageActionPort={{ openInNewChat, deletePage }}
      />,
    );
    const row = screen.container.querySelector<HTMLElement>(
      '[data-database-view-page-id="page-focused"]',
    );
    if (!row) throw new Error("Expected a List row context target");

    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 240, clientY: 120 });
      await Promise.resolve();
    });
    const search = await screen.findByRole("textbox", {
      name: "Search Page actions and properties",
    });
    await waitFor(() => expect(search).toBe(document.activeElement));
    await act(async () => {
      fireEvent.pointerMove(screen.getByRole("menuitem", { name: "Open in" }), {
        pointerType: "mouse",
        clientX: 240,
        clientY: 120,
        movementX: 0,
        movementY: 2,
      });
      await Promise.resolve();
    });
    const openInNewChatItem = await screen.findByRole("menuitem", {
      name: "Open in new chat",
    });
    await act(async () => {
      fireEvent.click(openInNewChatItem);
      await Promise.resolve();
    });
    expect(openInNewChat).toHaveBeenCalledWith({
      projectId: "project-1",
      pageId: "page-focused",
      titleSnapshot: "Focused Page",
    });

    await act(async () => {
      fireEvent.contextMenu(row, { clientX: 240, clientY: 120 });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
      await Promise.resolve();
    });
    expect(deletePage).toHaveBeenCalledWith({
      routingContext: { kind: "project", projectId: "project-1" },
      libraryId: "library-1",
      projectId: "project-1",
      pageId: "page-focused",
      pageKey: null,
      titleSnapshot: "Focused Page",
    });
  });

  test("keeps admitted List rows visible when a continuation fails and retries it", async () => {
    const onLoadMoreGroup = vi.fn();
    const screen = render(
      <DatabaseViewSurface
        model={listModel()}
        presentationLayout="list"
        searchQuery=""
        groupPagination={
          new Map([
            [
              "all",
              {
                scopeKey: "all",
                loadedRows: 2,
                totalRows: 8,
                hasMore: true,
                loadingMore: false,
                error: "Couldn’t load the next List window.",
              },
            ],
          ])
        }
        onLoadMoreGroup={onLoadMoreGroup}
        onOpenPage={() => undefined}
      />,
    );

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load the next List window.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await Promise.resolve();
    });
    expect(onLoadMoreGroup).toHaveBeenCalledWith("all");
  });

  test("keeps a Board reorder projected until receipt-fenced authority converges", async () => {
    let resolveCommit:
      | ((receipt: { readonly storeEpoch: string; readonly commitSeq: number }) => void)
      | undefined;
    const commitOperations = vi.fn<typeof commitDatabaseViewOperations>(
      () =>
        new Promise((resolve) => {
          resolveCommit = (receipt) =>
            resolve({ ...mutationReceipt(["position_pages"]), ...receipt });
        }),
    );
    const current = boardModel();
    const groupPagination = new Map(
      current.query.rows.map((row) => {
        const scopeKey = groupScopeKeyForPath(row.effectiveGroupKey, row.effectiveSubgroupKey);
        return [
          scopeKey,
          {
            scopeKey,
            loadedRows: 2,
            totalRows: 2,
            hasMore: false,
            loadingMore: false,
            error: null,
          },
        ];
      }),
    );
    const screen = render(
      <DatabaseViewSurface
        model={current}
        groupPagination={groupPagination}
        searchQuery=""
        onOpenPage={() => undefined}
        commitOperations={commitOperations}
      />,
    );
    const dataTransfer = databaseViewPageDataTransfer();
    const source = screen.container.querySelector<HTMLElement>(
      '[data-board-uuid-v7="page-focused"]',
    );
    const column = source?.closest<HTMLElement>("[data-board-column-root]");
    if (!source || !column) throw new Error("Board drag fixture is incomplete");
    const pageOrder = () =>
      Array.from(column.querySelectorAll<HTMLElement>("[data-board-uuid-v7]")).map(
        (element) => element.dataset.boardUuidV7,
      );

    await act(async () => {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.drop(column, { dataTransfer, clientY: 1 });
      await Promise.resolve();
    });
    expect(pageOrder()).toEqual(["page-next", "page-focused"]);
    expect(source.draggable).toBe(false);
    expect(commitOperations).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCommit?.({ storeEpoch: current.storeEpoch, commitSeq: 3 });
      await Promise.resolve();
    });
    expect(pageOrder()).toEqual(["page-next", "page-focused"]);
    expect(source.draggable).toBe(false);

    const canonical = {
      ...current,
      commitSeq: 3,
      query: {
        ...current.query,
        rows: [current.query.rows[1]!, current.query.rows[0]!],
      },
    };
    await act(async () => {
      screen.rerender(
        <DatabaseViewSurface
          model={canonical}
          groupPagination={groupPagination}
          searchQuery=""
          onOpenPage={() => undefined}
          commitOperations={commitOperations}
        />,
      );
      await Promise.resolve();
    });
    expect(pageOrder()).toEqual(["page-next", "page-focused"]);
    expect(source.draggable).toBe(true);
  });

  test.each(["board", "list"] as const)(
    "%s keeps Undo scoped to the view when a Property input or Linked chats has focus",
    async (layout) => {
      const current = layout === "board" ? boardModel() : listModel();
      const history = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(current));
      const recipe: DatabaseDataEditUndoRecipeV2 = {
        propertyStates: [
          {
            address: { pageId: "page-focused", dataSourceId, propertyId: statusPropertyId },
            propertyType: "select",
            beforeValue: {
              kind: "select",
              optionId: parseDataSourceOptionId({ propertyId: statusPropertyId, value: "doing" }),
            },
            afterValue: {
              kind: "select",
              optionId: parseDataSourceOptionId({ propertyId: statusPropertyId, value: "review" }),
            },
          },
        ],
        positionStates: [],
      };
      let finish = () => {};
      const commitOperations = vi.fn<typeof commitDatabaseViewOperations>(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(mutationReceipt(["reverse_data_edit"]));
          }),
      );
      commitOperations.mockResolvedValueOnce({
        ...mutationReceipt(["edit_property_values"]),
        operationOutcomes: [
          { kind: "data_edit", operationIndex: 0, operationCount: 1, undoRecipe: recipe },
        ],
      });
      await history.executeOperations({
        model: current,
        operations: [
          {
            kind: "edit_property_values",
            edits: [
              {
                pageId: "page-focused",
                dataSourceId,
                propertyId: statusPropertyId,
                edit: {
                  kind: "replace",
                  expectedValueRevision: 1,
                  value: {
                    kind: "select",
                    optionId: parseDataSourceOptionId({
                      propertyId: statusPropertyId,
                      value: "review",
                    }),
                  },
                },
              },
            ],
          },
        ],
        commitOperations,
      });
      commitOperations.mockClear();
      pageChatRuntime.summaries = [
        {
          pageId: "page-focused",
          relatedCount: 2,
          workingCount: 0,
          waitingOnApprovalCount: 0,
          waitingOnUserInputCount: 0,
          errorCount: 0,
          unreadCount: 0,
          soleSessionId: null,
          work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
          runtimeSessionIds: [],
        },
      ];
      pageChatRuntime.readWindow.mockResolvedValue({
        items: ["Investigation", "Follow-up"].map((displayTitle, index) => ({
          sessionId: `session-${index}`,
          projectId: "project-1",
          projectName: "Nodex",
          displayTitle,
          threadId: null,
          executionRef: null,
          threadPreview: "",
          threadStatus: null,
          threadArchived: false,
          unread: false,
          report: null,
          sessionArchived: false,
          conversationRecencyAt: 1,
          linkedAt: timestamp,
        })),
        nextCursor: null,
        hasMore: false,
        projectionRevision: 1,
      });
      const screen = render(
        <DatabaseViewSurface
          model={current}
          presentationLayout={layout}
          pageActionPort={{ openRelatedChat: () => undefined }}
          searchQuery=""
          onOpenPage={() => undefined}
          mutationHistory={history}
          commitOperations={commitOperations}
        />,
      );
      const row = screen.container.querySelector<HTMLElement>(
        layout === "board" ? "[data-board-uuid-v7]" : "[data-database-view-page-id]",
      );
      if (!row) throw new Error("Missing View row");
      const nestedInput = document.createElement("input");
      try {
        await act(async () => {
          row.append(nestedInput);
          nestedInput.focus();
          fireEvent.keyDown(nestedInput, { key: "z", metaKey: true });
          await Promise.resolve();
        });
        expect(commitOperations).not.toHaveBeenCalled();
        const linkedChats = await screen.findByRole("button", { name: "2 linked chats" });
        await act(async () => {
          nestedInput.remove();
          fireEvent.click(linkedChats);
          await Promise.resolve();
        });
        const picker = await screen.findByRole("dialog", { name: "Linked chats" });
        const chat = await within(picker).findByRole("button", { name: /^Investigation/u });
        await act(async () => {
          chat.focus();
          fireEvent.keyDown(chat, { key: "z", metaKey: true });
          await Promise.resolve();
        });
        expect(commitOperations).not.toHaveBeenCalled();
        await act(async () => {
          fireEvent.keyDown(chat, { key: "Escape" });
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(screen.queryByRole("dialog", { name: "Linked chats" })).toBeNull(),
        );
        await act(async () => {
          row.focus();
          fireEvent.keyDown(row, { key: "z", metaKey: true });
          fireEvent.keyDown(row, { key: "z", metaKey: true });
          await Promise.resolve();
        });
        await waitFor(() => expect(commitOperations).toHaveBeenCalledOnce());
        expect(commitOperations.mock.calls[0]?.[0]).toMatchObject({
          operations: [{ kind: "reverse_data_edit", recipe }],
          operationId: expect.any(String),
        });
        await act(async () => {
          finish();
          await Promise.resolve();
        });
        await waitFor(() => expect(history.snapshot().undo.status).toBe("empty"));
        expect(commitOperations).toHaveBeenCalledOnce();
      } finally {
        nestedInput.remove();
        await act(async () => {
          finish();
          await Promise.resolve();
        });
      }
    },
  );

  test("submits a sorted Board drop with its exact Property edit and position in one request", async () => {
    const commitOperations = vi.fn<typeof commitDatabaseViewOperations>(async () =>
      mutationReceipt(["edit_property_values", "position_pages"]),
    );
    const current = prioritySortedBoardModel();
    const screen = render(
      <DatabaseViewSurface
        model={current}
        searchQuery=""
        onOpenPage={() => undefined}
        commitOperations={commitOperations}
      />,
    );
    const dataTransfer = databaseViewPageDataTransfer();
    const source = screen.container.querySelector<HTMLElement>(
      '[data-board-uuid-v7="page-focused"]',
    );
    const column = source?.closest<HTMLElement>("[data-board-column-root]");
    if (!source || !column) throw new Error("Sorted Board drag fixture is incomplete");

    await act(async () => {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.drop(column, { dataTransfer, clientY: 1 });
      await Promise.resolve();
    });

    expect(commitOperations).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: expect.any(String),
        operations: [
          {
            kind: "edit_property_values",
            edits: [
              expect.objectContaining({
                pageId: "page-focused",
                propertyId: priorityPropertyId,
                edit: expect.objectContaining({
                  kind: "replace",
                  value: { kind: "select", optionId: "p3-low" },
                }),
              }),
            ],
          },
          expect.objectContaining({
            kind: "position_pages",
            pages: [expect.objectContaining({ pageId: "page-focused" })],
          }),
        ],
      }),
    );
  });

  test("keeps an uncertain Board drop visible and blocks older history", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const current = prioritySortedBoardModel();
    const history = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(current));
    const commitOperations = vi.fn<typeof commitDatabaseViewOperations>(async () => {
      throw new Error("injected Board failure");
    });
    const screen = render(
      <DatabaseViewSurface
        model={current}
        searchQuery=""
        onOpenPage={() => undefined}
        mutationHistory={history}
        commitOperations={commitOperations}
      />,
    );
    const dataTransfer = databaseViewPageDataTransfer();
    const source = screen.container.querySelector<HTMLElement>(
      '[data-board-uuid-v7="page-focused"]',
    );
    const column = source?.closest<HTMLElement>("[data-board-column-root]");
    if (!source || !column) throw new Error("Failed Board drag fixture is incomplete");

    await act(async () => {
      fireEvent.dragStart(source, { dataTransfer });
      fireEvent.drop(column, { dataTransfer, clientY: 1 });
      await Promise.resolve();
    });

    await waitFor(() => expect(history.snapshot().undo.status).toBe("waiting"));
    expect(screen.container.querySelector('[data-board-uuid-v7="page-focused"]')).not.toBeNull();
    expect(await history.undoLast()).toBe(false);
    expect(commitOperations).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledOnce();
    await act(async () => {
      history.close();
      await Promise.resolve();
    });
    consoleError.mockRestore();
  });

  test("keeps a successful option registry usable when a sibling registry fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const brokenPropertyId = parseDataSourcePropertyId("p_0123abcd");
    const loadingModel: DatabaseViewRenderModel = {
      ...model,
      query: {
        ...model.query,
        view: {
          ...model.query.view,
          config: {
            ...model.query.view.config,
            presentation: {
              ...model.query.view.config.presentation,
              display: {
                ...model.query.view.config.presentation.display,
                fields: [tagsPropertyId, brokenPropertyId].map((propertyId) => ({
                  kind: "property" as const,
                  propertyId,
                })),
              },
            },
          },
        },
        properties: [
          { ...model.query.properties[0]!, optionCount: 3 },
          {
            ...model.query.properties[0]!,
            propertyId: brokenPropertyId,
            name: "Broken select",
            ...testPropertySemantics("select", 1),
            valueType: "select",
            config: {},
            optionCount: 1,
            rankKey: "b",
          },
        ],
        rows: model.query.rows.map((row) => ({
          ...row,
          values: {
            ...row.values,
            [tagsPropertyId]: {
              ...row.values[tagsPropertyId]!,
              value: ["o_CCCCCCCC"],
            },
            [brokenPropertyId]: {
              propertyId: brokenPropertyId,
              valueType: "select",
              value: "o_BROKEN00",
              revision: 1,
            },
          },
        })),
      },
    };
    optionRuntime.read.mockImplementation(async (_context, property) => {
      if (property.propertyId === brokenPropertyId) {
        throw new Error("registry unavailable");
      }
      return {
        options: [
          { id: "o_AAAAAAAA", name: "Selected View" },
          { id: "o_BBBBBBBB", name: "Next" },
          { id: "o_CCCCCCCC", name: "Loaded sibling" },
        ],
        nextCursor: null,
        projectionRevision: 1,
      };
    });
    try {
      let screen!: ReturnType<typeof render>;
      await act(async () => {
        screen = render(
          <DatabaseViewSurface model={loadingModel} searchQuery="" onOpenPage={() => undefined} />,
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(optionRuntime.read).toHaveBeenCalledTimes(2));
      await waitFor(() =>
        expect(
          screen.getByRole("button", {
            name: "Edit Tags",
          }).textContent,
        ).toContain("Loaded sibling"),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit Tags" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByRole("option", { name: "Loaded sibling" })).toBeTruthy(),
      );
      expect(optionRuntime.read).toHaveBeenCalledTimes(2);
      await act(async () => {
        screen.rerender(
          <DatabaseViewSurface
            model={{ ...loadingModel, commitSeq: loadingModel.commitSeq + 1 }}
            searchQuery=""
            onOpenPage={() => undefined}
          />,
        );
        await Promise.resolve();
      });
      expect(optionRuntime.read).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("option", { name: "Loaded sibling" })).toBeTruthy();
      await act(async () => {
        fireEvent.keyDown(screen.getByRole("combobox", { name: "Search Tags options" }), {
          key: "Escape",
        });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", {
              name: "Edit Tags",
            })
            .getAttribute("aria-expanded"),
        ).toBe("false"),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit Broken select" }));
        await Promise.resolve();
      });
      const retry = await waitFor(() =>
        screen.getByRole("button", {
          name: "Couldn’t load options. Retry",
        }),
      );
      expect(screen.queryByText("registry unavailable")).toBeNull();
      expect(optionRuntime.read).toHaveBeenCalledTimes(3);
      await act(async () => {
        fireEvent.keyDown(retry, { key: "Escape" });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", {
              name: "Edit Broken select",
            })
            .getAttribute("aria-expanded"),
        ).toBe("false"),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit Tags" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          screen.getByRole("option", {
            name: "Loaded sibling",
          }),
        ).toBeTruthy(),
      );
      expect(optionRuntime.read).toHaveBeenCalledTimes(3);
    } finally {
      consoleError.mockRestore();
    }
  });

  test("keeps a sibling Property interactive while another Property mutation is pending", async () => {
    const flagPropertyId = parseDataSourcePropertyId("p_0123abcd");
    let resolveFirst: (() => void) | undefined;
    const commitOperations = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<null>((resolve) => {
            resolveFirst = () => resolve(null);
          }),
      )
      .mockResolvedValue(null);
    const scopedModel: DatabaseViewRenderModel = {
      ...model,
      query: {
        ...model.query,
        view: {
          ...model.query.view,
          config: {
            ...model.query.view.config,
            presentation: {
              ...model.query.view.config.presentation,
              display: {
                ...model.query.view.config.presentation.display,
                fields: [tagsPropertyId, flagPropertyId].map((propertyId) => ({
                  kind: "property" as const,
                  propertyId,
                })),
              },
            },
          },
        },
        properties: [
          ...model.query.properties,
          {
            ...model.query.properties[0]!,
            propertyId: flagPropertyId,
            name: "Flag",
            ...testPropertySemantics("checkbox"),
            valueType: "checkbox",
            config: {},
            optionCount: 0,
            rankKey: "b",
          },
        ],
        rows: model.query.rows.map((row) => ({
          ...row,
          values: {
            ...row.values,
            [flagPropertyId]: {
              propertyId: flagPropertyId,
              valueType: "checkbox",
              value: true,
              revision: 1,
            },
          },
        })),
      },
    };
    const screen = render(
      <DatabaseViewSurface
        model={scopedModel}
        searchQuery=""
        onOpenPage={() => undefined}
        commitOperations={commitOperations}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: "Next" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(commitOperations).toHaveBeenCalledTimes(1));
    const flag = screen.getByRole("checkbox", { name: "Flag value" }) as HTMLButtonElement;
    expect(flag.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(flag);
      await Promise.resolve();
    });
    expect(commitOperations).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(commitOperations).toHaveBeenCalledTimes(2));
  });

  test("an uncertain Property edit blocks older Undo through repeated lost responses", async () => {
    const history = createDatabaseViewMutationHistory(databaseViewHistoryScopeKey(model));
    const recipe: DatabaseDataEditUndoRecipeV2 = {
      propertyStates: [
        {
          address: { pageId: "page-focused", dataSourceId, propertyId: tagsPropertyId },
          propertyType: "multi_select",
          beforeValue: { kind: "multi_select", optionIds: [] },
          afterValue: {
            kind: "multi_select",
            optionIds: [
              parseDataSourceOptionId({ propertyId: tagsPropertyId, value: "o_BBBBBBBB" }),
            ],
          },
        },
      ],
      positionStates: [],
    };
    const receipt = {
      ...mutationReceipt(["edit_property_values"]),
      operationOutcomes: [
        { kind: "data_edit" as const, operationIndex: 0, operationCount: 1, undoRecipe: recipe },
      ],
    };
    const commit = vi.fn<typeof commitDatabaseViewOperations>(async () => receipt);
    await history.executeOperations({
      model,
      operations: [
        {
          kind: "position_pages",
          viewId,
          pages: [{ pageId: "page-focused", expectedPositionRevision: 0 }],
        },
      ],
      commitOperations: commit,
    });
    commit.mockClear();
    commit
      .mockRejectedValueOnce(new Error("Response lost"))
      .mockRejectedValueOnce(new Error("Response still lost"));
    const view = render(
      <DatabaseViewSurface
        model={model}
        searchQuery=""
        onOpenPage={() => undefined}
        mutationHistory={history}
        commitOperations={commit}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit Tags" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("option", { name: "Next" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(history.snapshot().undo.status).toBe("waiting"));
    await act(async () => {
      expect(await history.undoLast()).toBe(false);
    });
    expect(commit).toHaveBeenCalledOnce();
    await act(async () => {
      expect((await history.recover().result).status).toBe("recovering");
    });
    expect(await history.undoLast()).toBe(false);
    expect(commit).toHaveBeenCalledTimes(2);
    await act(async () => {
      await history.recover().result;
    });
    expect(commit.mock.calls[1]?.[0]).toEqual(commit.mock.calls[0]?.[0]);
    expect(commit.mock.calls[2]?.[0]).toEqual(commit.mock.calls[0]?.[0]);
    await act(async () => {
      expect(await history.undoLast()).toBe(true);
    });
    expect(commit.mock.calls[3]?.[0].operations).toEqual([{ kind: "reverse_data_edit", recipe }]);
  });

  test("keeps option creation open and local when the atomic commit fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const screen = render(
      <DatabaseViewSurface
        model={model}
        searchQuery=""
        onOpenPage={() => undefined}
        commitOperations={async () => {
          throw new Error("atomic option rejected");
        }}
      />,
    );
    try {
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Edit Tags" }));
        await Promise.resolve();
      });
      const search = screen.getByRole("combobox", { name: "Search Tags options" });
      await act(async () => {
        fireEvent.change(search, { target: { value: "Fresh" } });
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Create “Fresh”" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(screen.getByText("Couldn’t create option. Try again.")).toBeTruthy(),
      );
      expect(screen.queryByText("atomic option rejected")).toBeNull();
      expect(screen.getByRole("combobox", { name: "Search Tags options" })).toBeTruthy();
    } finally {
      consoleError.mockRestore();
    }
  });
});

function DatabaseViewTabHarness({
  viewModel,
  onOpenPage,
}: {
  readonly viewModel: DatabaseViewRenderModel;
  readonly onOpenPage: (pageId: string, title: string, mode: "preview" | "durable") => void;
}) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <DatabaseViewTabSurface
      toolbar={{
        items: [
          { id: viewModel.databaseViewId, label: viewModel.viewName, onSelect: () => undefined },
        ],
        activeSearchQuery: query,
        taskSearchOpen: searchOpen,
        searchShortcutLabel: "Ctrl+F",
        taskSearchInputRef: searchInputRef,
        onSearchQueryChange: setQuery,
        onOpenTaskSearch: () => setSearchOpen(true),
        onCloseTaskSearch: () => setSearchOpen(false),
      }}
    >
      <DatabaseViewTabContent model={viewModel} activeSearchQuery={query} onOpenPage={onOpenPage} />
    </DatabaseViewTabSurface>
  );
}

describe("Database View tab", () => {
  test("retains the visible List until Core finds a Page beyond its first window", async () => {
    const viewModel = listModel();
    const row = viewModel.query.rows[0]!;
    const unfiltered = (item: typeof row, complete: boolean): DatabaseListWindowSnapshot => ({
      projectId: "project-1",
      libraryId: viewModel.libraryId,
      databaseId: viewModel.databaseId,
      viewId: viewModel.databaseViewId,
      dataSourceId: viewModel.dataSourceId,
      storeEpoch: viewModel.storeEpoch,
      commitSeq: viewModel.commitSeq,
      projection: {
        scopeKey: "list-scope",
        schemaVersion: 1,
        revision: 1,
        coveredCommitSeq: 2,
        effectHash: null,
      },
      rows: [
        {
          kind: "page",
          occurrenceKey: item.page.pageId,
          row: item,
          groupPath: [],
          ancestorPageIds: [],
          depth: 0,
          hasChildren: false,
          subtreeOccurrenceCount: 1,
          concreteSubtreePageCount: 1,
          subtreeHeight: 0,
          firstChildOccurrenceKey: null,
          transientKind: "none",
        },
      ],
      groups: [],
      nextCursor: complete ? null : "browse-next",
      totalProjectionRowCount: complete ? 1 : 2,
      totalModelCount: complete ? 1 : 2,
      totalOccurrenceCount: complete ? 1 : 2,
      windowStart: 0,
      windowEnd: 1,
      isComplete: complete,
    });
    const pending = deferred<DatabaseListWindowSnapshot>();
    const browseContinuation = deferred<DatabaseListWindowSnapshot>();
    readListWindow.mockImplementation((_projectId, input) =>
      input.searchQuery
        ? pending.promise
        : input.after
          ? browseContinuation.promise
          : Promise.resolve(unfiltered(row, false)),
    );
    const onOpenPage = vi.fn();
    const screen = render(
      <DatabaseViewTabHarness
        viewModel={{
          ...viewModel,
          boundedRead: {
            identity: "view",
            windowKey: "first",
            storeEpoch: viewModel.storeEpoch,
            commitSeq: viewModel.commitSeq,
            scopeKey: "list-scope",
            pageIds: [row.page.pageId],
          },
        }}
        onOpenPage={onOpenPage}
      />,
    );
    expect(await screen.findByRole("button", { name: "Open Page Focused Page" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Search tasks" }), {
      target: { value: "zirconium" },
    });
    await waitFor(() =>
      expect(readListWindow).toHaveBeenCalledWith(
        "project-1",
        expect.objectContaining({ searchQuery: "zirconium" }),
      ),
    );
    expect(screen.getByRole("button", { name: "Open Page Focused Page" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open Page Later Page" })).toBeNull();
    await act(async () =>
      pending.resolve({
        ...unfiltered(
          {
            ...row,
            page: { ...row.page, pageId: "page-outside-window", title: "Later Page" },
            searchEvidence: {
              title_parts: [{ text: "Later Page", highlighted: false }],
              excerpt_parts: [{ text: "zirconium", highlighted: true }],
              matches: [
                {
                  source: "body",
                  block_id: "body",
                  block_type: "paragraph",
                  quality: "exact",
                  parts: [{ text: "zirconium", highlighted: true }],
                },
              ],
            },
          },
          true,
        ),
        search: {
          query: "zirconium",
          result_key: "search-key",
          coverage: "complete",
          truncated: false,
        },
      }),
    );
    const result = await screen.findByRole("button", { name: "Open Page Later Page" });
    expect(screen.queryByRole("button", { name: "Open Page Focused Page" })).toBeNull();
    expect(screen.getByText("zirconium").tagName).toBe("MARK");
    fireEvent.click(result);
    expect(onOpenPage).toHaveBeenCalledWith("page-outside-window", "Later Page", "preview");
  });
});

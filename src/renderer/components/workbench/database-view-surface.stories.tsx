import type { Meta, StoryObj } from "@storybook/react-vite";
import { fireEvent, getByRole, waitFor } from "@testing-library/dom";
import { useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { plainTextToPortableRichText } from "../../../shared/block-documents";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../shared/database-identities";
import { testPropertySemantics } from "../../../shared/testing/database-property-record";
import { upgradeDatabaseViewConfigV2 } from "../../../shared/database-view-presentation";
import { DatabaseViewSurface } from "./database-view-surface";
import { DatabaseViewTabSurface } from "./workbench-db-view-panel";
import { DatabaseViewGroupLimitNotice } from "./workbench-database-view-surface";
import { executeContextualKeyboardAction } from "@/lib/contextual-keyboard-actions";
import { DatabaseListDndProvider } from "./database-list/database-list-dnd";
import {
  databaseListGridTemplate,
  projectDatabaseListPageIdentity,
} from "./database-list/database-list-grid";
import {
  buildDatabaseListProjection,
  emptyDatabaseListSelection,
} from "./database-list/database-list-model";
import { databaseListNestingContinuations } from "./database-list/database-list-nesting-lines";
import { DatabaseListRow } from "./database-list/database-list-row";
import { DATABASE_LIST_THEME_CLASS_NAME } from "./database-list/database-list-theme";
import { queryKeys } from "@/lib/query-keys";

const timestamp = "2026-07-12T00:00:00.000Z";
const libraryId = "library:nodex";
const databaseId = parseDatabaseId("database:nodex:primary");
const dataSourceId = parseDataSourceId("data-source:nodex:primary");
const viewId = parseDatabaseViewId("database-view:nodex:focused");
const statusPropertyId = parseDataSourcePropertyId("status");
const tagsPropertyId = parseDataSourcePropertyId("tags");
const priorityPropertyId = parseDataSourcePropertyId("priority");
const estimatePropertyId = parseDataSourcePropertyId("estimate");
const dueDatePropertyId = parseDataSourcePropertyId("due_date");
const assigneePropertyId = parseDataSourcePropertyId("assignee");
const relationPropertyId = parseDataSourcePropertyId("p_RELATE01");
const notesPropertyId = parseDataSourcePropertyId("p_NOTES001");
const pointsPropertyId = parseDataSourcePropertyId("p_POINTS01");
const approvedPropertyId = parseDataSourcePropertyId("p_APPROVE1");
const databaseStoryQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const model: DatabaseViewRenderModel = {
  libraryId,
  accessContext: { kind: "project", projectId: "nodex" },
  databaseViewId: viewId,
  databaseId,
  dataSourceId,
  databaseName: "Tasks",
  dataSourceName: "Pages",
  viewName: "Focused work",
  storeEpoch: "story",
  commitSeq: 1,
  authorization: null,
  readOnlyReason: null,
  query: {
    database: {
      databaseId,
      libraryId,
      name: "Tasks",
      lifecycle: "active",
      defaultViewId: parseDatabaseViewId("database-view:nodex:default"),
      accessRevision: 1,
      metadataRevision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    dataSource: {
      dataSourceId,
      libraryId,
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
      name: "Focused work",
      layout: "board",
      config: (() => {
        const config = upgradeDatabaseViewConfigV2({
          schemaKey: "nodex.database-view",
          schemaVersion: 2,
          filter: { kind: "group", operator: "and", children: [] },
          sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
          group: { propertyId: statusPropertyId },
          display: { propertyIds: [tagsPropertyId], showTitle: true },
        });
        return {
          ...config,
          presentation: {
            ...config.presentation,
            display: { ...config.presentation.display },
          },
        };
      })(),
      isDefault: false,
      revision: 1,
      rankKey: "a",
      lifecycle: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    properties: [
      {
        propertyId: statusPropertyId,
        dataSourceId,
        name: "Status",
        ...testPropertySemantics("select", 2),
        valueType: "select",
        config: {
          options: [
            { id: "triage", name: "Triage" },
            { id: "plan", name: "Plan" },
            { id: "build", name: "Build" },
            { id: "review", name: "Review" },
            { id: "ship", name: "Ship" },
          ],
        },
        rankKey: "a",
        lifecycle: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        propertyId: tagsPropertyId,
        dataSourceId,
        name: "Tags",
        ...testPropertySemantics("multi_select", 1),
        valueType: "multi_select",
        config: { options: [{ id: "o_AAAAAAAA", name: "Page first" }] },
        rankKey: "b",
        lifecycle: "active",
        revision: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    rows: [
      {
        pageKey: "LAB-13",
        membership: {
          membershipId: "membership-1",
          dataSourceId,
          revision: 1,
          createdAt: timestamp,
        },
        page: {
          pageId: "page-1",
          libraryId,
          parent: { kind: "data_source", dataSourceId },
          lifecycle: "active",
          parentRevision: 1,
          metadataRevision: 1,
          documentId: "document-1",
          documentGeneration: 1,
          documentHeadSeq: 1,
          title: "Unify Database View rendering",
          richTitle: plainTextToPortableRichText("Unify Database View rendering"),
          preview: "",
          plainText: "",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        values: {
          [statusPropertyId]: {
            propertyId: statusPropertyId,
            valueType: "select",
            value: "build",
            revision: 1,
          },
          [tagsPropertyId]: {
            propertyId: tagsPropertyId,
            valueType: "multi_select",
            value: ["o_AAAAAAAA"],
            revision: 1,
          },
        },
        taskParent: { parentPageId: null, siblingRank: null, valueRevision: 1 },
        position: { rankKey: "a", revision: 1 },
        effectiveGroupKey: "build",
        effectiveSubgroupKey: null,
      },
    ],
  },
  columns: [
    {
      id: "build",
      groupKey: "build",
      scopeKey: "key:build",
      name: "Build",
      rows: [
        {
          pageId: "page-1",
          pageKey: "LAB-13",
          groupKey: "build",
          subgroupKey: null,
          status: "build",
          title: "Unify Database View rendering",
          preview: "",
          plainText: "",
          tags: ["page-first"],
          taskParentValueRevision: 1,
          documentGeneration: 1,
          documentHeadSeq: 1,
          metadataRevision: 1,
          createdAt: new Date(timestamp),
        },
      ],
    },
    { id: "ship", groupKey: "ship", name: "Ship", scopeKey: "key:ship", rows: [] },
  ],
};

const meta = {
  title: "Workbench/Database View",
  component: DatabaseViewSurface,
  parameters: { layout: "fullscreen" },
  args: {
    model,
    searchQuery: "",
    onOpenPage: () => undefined,
    commitOperations: async () => null,
    onSelectedPageIdsChange: () => undefined,
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={databaseStoryQueryClient}>
        <div className="h-[640px]">
          <Story />
        </div>
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof DatabaseViewSurface>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SecondaryView: Story = {};

export const BoardWithPageKey: Story = {
  args: {
    effectivePresentation: {
      layout: "board",
      rules: model.query.view.config.rules,
      presentation: {
        ...model.query.view.config.presentation,
        display: {
          ...model.query.view.config.presentation.display,
          fields: [
            { kind: "intrinsic", field: "page_key" },
            ...model.query.view.config.presentation.display.fields,
          ],
        },
      },
    },
  },
};

export const PresentedPage: Story = {
  args: {
    presentedPageIds: new Set(["page-1"]),
  },
};

function KeyboardSelectedBoard() {
  useEffect(() => {
    executeContextualKeyboardAction("boardFocusNext");
    const frame = requestAnimationFrame(() => {
      executeContextualKeyboardAction("boardToggleSelection");
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <DatabaseViewSurface
      model={model}
      searchQuery=""
      keyboardSurface={{
        surfaceId: "story-keyboard-board",
        presentationId: "story-keyboard-tab",
      }}
      onOpenPage={() => undefined}
      commitOperations={async () => null}
    />
  );
}

export const KeyboardHighlightedSelection: Story = {
  render: () => <KeyboardSelectedBoard />,
};

function SelectionPreservingLayoutSwitch() {
  const [layout, setLayout] = useState<"board" | "list">("board");
  useEffect(() => {
    executeContextualKeyboardAction("boardFocusNext");
    const frame = requestAnimationFrame(() => {
      executeContextualKeyboardAction("boardToggleSelection");
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b-[0.5px] border-token-border/50 px-3">
        {(["board", "list"] as const).map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={layout === candidate}
            className="rounded-md px-2 py-1 text-xs capitalize aria-pressed:bg-token-foreground/7"
            onClick={() => setLayout(candidate)}
          >
            {candidate}
          </button>
        ))}
        <span className="ml-2 text-xs text-token-description-foreground">
          The active selection survives layout changes.
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <DatabaseViewSurface
          model={model}
          presentationLayout={layout}
          searchQuery=""
          keyboardSurface={{
            surfaceId: "story-layout-switch",
            presentationId: "story-same-view",
          }}
          onOpenPage={() => undefined}
          commitOperations={async () => null}
        />
      </div>
    </div>
  );
}

export const BoardListSelectionContinuity: Story = {
  render: () => <SelectionPreservingLayoutSwitch />,
};

const withLayout = (layout: "board" | "list"): DatabaseViewRenderModel => ({
  ...model,
  query: {
    ...model.query,
    view: {
      ...model.query.view,
      layout,
      config: {
        ...model.query.view.config,
        presentation: {
          ...model.query.view.config.presentation,
          group: null,
        },
      },
    },
  },
  columns: [
    {
      id: "all",
      groupKey: null,
      scopeKey: "all",
      name: "Focused work",
      rows: model.columns.flatMap((column) => column.rows),
    },
  ],
});

const withNestedList = (): DatabaseViewRenderModel => {
  const base = withLayout("list");
  const authority = base.query.rows[0];
  const renderRow = base.columns[0]?.rows[0];
  if (!authority || !renderRow) return base;
  const pageSpecs = [
    { id: "page-1", title: "Unify Database View rendering", parentId: null },
    { id: "page-2", title: "Define the List occurrence projection", parentId: "page-1" },
    { id: "page-3", title: "Verify nested keyboard navigation", parentId: "page-2" },
    { id: "page-6", title: "Align the sibling hierarchy guide", parentId: "page-1" },
    { id: "page-4", title: "Polish responsive property columns", parentId: null },
    {
      id: "page-5",
      title: "Exercise a deliberately long task title without disturbing adjacent metadata",
      parentId: null,
    },
  ] as const;
  const authorities = pageSpecs.map((page, index) => ({
    ...authority,
    membership: {
      ...authority.membership,
      membershipId: `membership-${index + 1}`,
    },
    page: {
      ...authority.page,
      pageId: page.id,
      documentId: `document-${index + 1}`,
      title: page.title,
      richTitle: plainTextToPortableRichText(page.title),
    },
    position: { rankKey: String.fromCharCode(97 + index), revision: 1 },
    taskParent: {
      parentPageId: page.parentId ?? null,
      siblingRank: page.parentId ? String.fromCharCode(97 + index) : null,
      valueRevision: 1,
    },
  }));
  return {
    ...base,
    query: {
      ...base.query,
      view: {
        ...base.query.view,
        config: {
          ...base.query.view.config,
          presentation: {
            ...base.query.view.config.presentation,
            hierarchy: { showSubPages: true, nestedSubPages: true },
            display: {
              fields: [
                { kind: "property", propertyId: tagsPropertyId },
                { kind: "intrinsic", field: "updated_at" },
              ],
              propertyOrder: [tagsPropertyId],
              showEmptyGroups: false,
            },
          },
        },
      },
      rows: authorities,
    },
    columns: [
      {
        ...base.columns[0]!,
        rows: pageSpecs.map((page, index) => ({
          ...renderRow,
          pageId: page.id,
          title: page.title,
          parentPageId: page.parentId ?? undefined,
          createdAt: new Date(Date.parse(timestamp) + index * 86_400_000),
        })),
      },
    ],
  };
};

const withNestedGroupedList = (): DatabaseViewRenderModel => {
  const base = withNestedList();
  const groupKeyByPageId = new Map<string, "build" | "ship">([
    ["page-1", "build"],
    ["page-2", "ship"],
    ["page-3", "ship"],
    ["page-6", "build"],
    ["page-4", "ship"],
    ["page-5", "build"],
  ] as const);
  const rows = base.query.rows.map((row) => {
    const groupKey = groupKeyByPageId.get(row.page.pageId) ?? "build";
    return {
      ...row,
      values: {
        ...row.values,
        [statusPropertyId]: {
          propertyId: statusPropertyId,
          valueType: "select" as const,
          value: groupKey,
          revision: 1,
        },
      },
      effectiveGroupKey: groupKey,
    };
  });
  const renderRows = base.columns
    .flatMap((column) => column.rows)
    .map((row) => {
      const groupKey = groupKeyByPageId.get(row.pageId) ?? "build";
      return { ...row, groupKey, status: groupKey };
    });
  return {
    ...base,
    query: {
      ...base.query,
      view: {
        ...base.query.view,
        config: {
          ...base.query.view.config,
          presentation: {
            ...base.query.view.config.presentation,
            group: { propertyId: statusPropertyId },
          },
        },
      },
      rows,
    },
    columns: ["build", "ship"].map((groupKey) => ({
      id: groupKey,
      groupKey,
      scopeKey: `key:${groupKey}`,
      name: groupKey === "build" ? "Build" : "Ship",
      rows: renderRows.filter((row) => row.groupKey === groupKey),
    })),
  };
};

export const ListView: Story = { args: { model: withLayout("list") } };

function RelatedChatActivityDatabaseView({ layout }: { readonly layout: "board" | "list" }) {
  const queryClient = useQueryClient();
  const viewModel = withLayout(layout);
  const pageIds = viewModel.query.rows.map((row) => row.page.pageId);
  queryClient.setQueryData(queryKeys.pageChats.activity("nodex", pageIds), {
    summaries: pageIds.map((pageId, index) => ({
      pageId,
      relatedCount: index === 0 ? 2 : 1,
      workingCount: index === 0 ? 1 : 0,
      waitingOnApprovalCount: 0,
      waitingOnUserInputCount: 0,
      errorCount: 0,
      unreadCount: 1,
      soleSessionId: index === 0 ? null : `session-${pageId}`,
    })),
    projectionRevision: 4,
  });
  return (
    <DatabaseViewSurface
      model={viewModel}
      searchQuery=""
      onOpenPage={() => undefined}
      pageActionPort={{ openRelatedChat: () => undefined }}
      onSelectedPageIdsChange={() => undefined}
      commitOperations={async () => null}
    />
  );
}

export const BoardRelatedChatActivity: Story = {
  render: () => <RelatedChatActivityDatabaseView layout="board" />,
};

export const ListRelatedChatActivity: Story = {
  render: () => <RelatedChatActivityDatabaseView layout="list" />,
};
export const ListIdentityRhythm: Story = {
  parameters: {
    docs: {
      description: {
        story: "A short Page key exercises the balanced ID, status, and title rhythm.",
      },
    },
  },
  args: {
    model: (() => {
      const base = withLayout("list");
      const pageKey = "NO-13";
      return {
        ...base,
        query: {
          ...base.query,
          view: {
            ...base.query.view,
            config: {
              ...base.query.view.config,
              presentation: {
                ...base.query.view.config.presentation,
                display: {
                  ...base.query.view.config.presentation.display,
                  fields: [
                    ...base.query.view.config.presentation.display.fields,
                    { kind: "property", propertyId: statusPropertyId },
                  ],
                },
              },
            },
          },
          rows: base.query.rows.map((row) => ({ ...row, pageKey })),
        },
        columns: base.columns.map((column) => ({
          ...column,
          rows: column.rows.map((row) => ({ ...row, pageKey })),
        })),
      };
    })(),
  },
};
export const ListPageKeyAction: Story = {
  args: { model: withLayout("list") },
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>("[data-database-view-page-id=page-1]");
    if (!row) throw new Error("Expected the keyed List row");
    fireEvent.contextMenu(row);
    const copyTrigger = await waitFor(() =>
      getByRole(canvasElement.ownerDocument.body, "menuitem", { name: "Copy" }),
    );
    fireEvent.pointerMove(copyTrigger, { pointerType: "mouse" });
    await waitFor(() =>
      getByRole(canvasElement.ownerDocument.body, "menuitem", { name: "Copy ID" }),
    );
  },
};
export const NestedListHierarchy: Story = {
  args: { model: withNestedList() },
  play: async ({ canvasElement }) => {
    const layoutGrid = canvasElement.querySelector<HTMLElement>("[data-list-layout-grid=true]");
    const row = canvasElement.querySelector<HTMLElement>("[data-database-view-page-id]");
    if (!layoutGrid || !row) throw new Error("Expected the nested List grid and a Page row");

    await waitFor(() => {
      const view = canvasElement.ownerDocument.defaultView;
      if (!view) throw new Error("Expected the Storybook window");
      if (view.getComputedStyle(layoutGrid).gridTemplateColumns === "none") {
        throw new Error("Hidden public ID invalidated the List grid template");
      }
      for (const cell of row.querySelectorAll<HTMLElement>(":scope > [data-list-grid-column]")) {
        if (view.getComputedStyle(cell).gridColumnStart === "auto") {
          throw new Error(`${cell.dataset.listGridColumn} lost its named grid placement`);
        }
      }
    });
  },
};
export const NestedListAcrossGroups: Story = {
  args: { model: withNestedGroupedList() },
};
export const NestedListSubtreeSelection: Story = {
  args: {
    model: withNestedList(),
    initialSelectedPageIds: new Set(["page-1", "page-2", "page-3"]),
  },
};
export const GroupedList: Story = {
  args: {
    model,
    presentationLayout: "list",
    pageCreateSurfaceId: "story-grouped-list",
    onRequestCreatePage: () => undefined,
  },
};

const withEmptyListGroups = (): DatabaseViewRenderModel => ({
  ...model,
  query: {
    ...model.query,
    view: {
      ...model.query.view,
      layout: "list",
      config: {
        ...model.query.view.config,
        presentation: {
          ...model.query.view.config.presentation,
          display: {
            ...model.query.view.config.presentation.display,
            showEmptyGroups: true,
          },
        },
      },
    },
  },
});

export const EmptyGroupedList: Story = {
  args: {
    model: withEmptyListGroups(),
    presentationLayout: "list",
    pageCreateSurfaceId: "story-empty-grouped-list",
    onRequestCreatePage: () => undefined,
  },
};

export const SelectedList: Story = {
  args: {
    model: withNestedList(),
    initialSelectedPageIds: new Set(["page-2", "page-3"]),
  },
};

const withListFieldStress = (): DatabaseViewRenderModel => {
  const base = withNestedList();
  const labelOptions = [
    { id: "o_AAAAAAAA", name: "Page first", color: "#BB87FC" },
    { id: "o_BBBBBBBB", name: "Renderer", color: "#56ABFD" },
    { id: "o_CCCCCCCC", name: "Core", color: "#77D677" },
    { id: "o_DDDDDDDD", name: "Accessibility", color: "#F8C531" },
    { id: "o_EEEEEEEE", name: "Performance", color: "#F67E49" },
  ] as const;
  const priorityOptions = [
    { id: "p0-critical", name: "Critical" },
    { id: "p1-high", name: "High" },
    { id: "p2-medium", name: "Medium" },
    { id: "p3-low", name: "Low" },
  ] as const;
  const estimateOptions = [
    { id: "xs", name: "XS" },
    { id: "s", name: "S" },
    { id: "m", name: "M" },
    { id: "l", name: "L" },
    { id: "xl", name: "XL" },
  ];
  const extraProperties: DataSourcePropertyRecordV2[] = [
    {
      propertyId: priorityPropertyId,
      dataSourceId,
      name: "Priority",
      ...testPropertySemantics("select", priorityOptions.length),
      valueType: "select" as const,
      config: { options: [...priorityOptions] },
      rankKey: "c",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: estimatePropertyId,
      dataSourceId,
      name: "Estimate",
      ...testPropertySemantics("select", estimateOptions.length),
      valueType: "select" as const,
      config: { options: [...estimateOptions] },
      rankKey: "d",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: dueDatePropertyId,
      dataSourceId,
      name: "Due date",
      ...testPropertySemantics("date"),
      valueType: "date" as const,
      config: {},
      rankKey: "e",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: assigneePropertyId,
      dataSourceId,
      name: "Assignee",
      ...testPropertySemantics("text"),
      valueType: "text" as const,
      config: {},
      rankKey: "f",
      lifecycle: "active" as const,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  return {
    ...base,
    query: {
      ...base.query,
      view: {
        ...base.query.view,
        config: {
          ...base.query.view.config,
          presentation: {
            ...base.query.view.config.presentation,
            group: { propertyId: statusPropertyId },
            display: {
              ...base.query.view.config.presentation.display,
              fields: [
                { kind: "property", propertyId: priorityPropertyId },
                { kind: "property", propertyId: statusPropertyId },
                { kind: "property", propertyId: tagsPropertyId },
                { kind: "property", propertyId: estimatePropertyId },
                { kind: "property", propertyId: dueDatePropertyId },
                { kind: "property", propertyId: assigneePropertyId },
                { kind: "intrinsic", field: "updated_at" },
              ],
            },
          },
        },
      },
      properties: [
        ...base.query.properties.map((property) =>
          property.propertyId === tagsPropertyId
            ? { ...property, config: { options: labelOptions } }
            : property,
        ),
        ...extraProperties,
      ],
      rows: base.query.rows.map((row, index) => {
        if (index === 3) {
          const values = { ...row.values };
          delete values[tagsPropertyId];
          return { ...row, values };
        }
        const priority = priorityOptions[index % priorityOptions.length]!.id;
        const estimate = estimateOptions[index % estimateOptions.length]!.id;
        return {
          ...row,
          values: {
            ...row.values,
            [priorityPropertyId]: {
              propertyId: priorityPropertyId,
              valueType: "select" as const,
              value: priority,
              revision: 2,
            },
            [tagsPropertyId]: {
              propertyId: tagsPropertyId,
              valueType: "multi_select" as const,
              value:
                index === 1
                  ? labelOptions.map((option) => option.id)
                  : [labelOptions[index % labelOptions.length]!.id],
              revision: 2,
            },
            [estimatePropertyId]: {
              propertyId: estimatePropertyId,
              valueType: "select" as const,
              value: estimate,
              revision: 2,
            },
            [dueDatePropertyId]: {
              propertyId: dueDatePropertyId,
              valueType: "date" as const,
              value: `2026-08-${String(12 + index).padStart(2, "0")}`,
              revision: 2,
            },
            [assigneePropertyId]: {
              propertyId: assigneePropertyId,
              valueType: "text" as const,
              value: index % 2 === 0 ? "Aster" : "Mina",
              revision: 2,
            },
          },
        };
      }),
    },
    columns: base.columns.map((column) => ({
      ...column,
      rows: column.rows.map((row, index) => ({
        ...row,
        priority: index === 3 ? undefined : priorityOptions[index % priorityOptions.length]!.id,
      })),
    })),
  };
};

export const ListPropertyDensity: Story = {
  args: { model: withListFieldStress() },
};

export const ListDarkMode: Story = {
  args: {
    model: withListFieldStress(),
    initialSelectedPageIds: new Set(["page-2", "page-3"]),
  },
  globals: { theme: "dark" },
};

const withBoardPropertyChips = (): DatabaseViewRenderModel => {
  const base = withListFieldStress();
  const extraProperties: DataSourcePropertyRecordV2[] = [
    {
      propertyId: relationPropertyId,
      dataSourceId,
      name: "Blocked by",
      ...testPropertySemantics("relation"),
      valueType: "relation",
      config: {},
      rankKey: "g",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: notesPropertyId,
      dataSourceId,
      name: "Notes",
      ...testPropertySemantics("text"),
      valueType: "text",
      config: {},
      rankKey: "h",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: pointsPropertyId,
      dataSourceId,
      name: "Points",
      ...testPropertySemantics("number"),
      valueType: "number",
      config: {},
      rankKey: "i",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      propertyId: approvedPropertyId,
      dataSourceId,
      name: "Approved",
      ...testPropertySemantics("checkbox"),
      valueType: "checkbox",
      config: {},
      rankKey: "j",
      lifecycle: "active",
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
  return {
    ...base,
    query: {
      ...base.query,
      view: {
        ...base.query.view,
        layout: "board",
        config: {
          ...base.query.view.config,
          presentation: {
            ...base.query.view.config.presentation,
            group: null,
            subgroup: null,
            display: {
              ...base.query.view.config.presentation.display,
              fields: [
                { kind: "property", propertyId: priorityPropertyId },
                { kind: "property", propertyId: statusPropertyId },
                { kind: "property", propertyId: estimatePropertyId },
                { kind: "property", propertyId: tagsPropertyId },
                { kind: "property", propertyId: assigneePropertyId },
                { kind: "property", propertyId: dueDatePropertyId },
                { kind: "intrinsic", field: "created_at" },
                { kind: "property", propertyId: relationPropertyId },
                { kind: "property", propertyId: notesPropertyId },
                { kind: "property", propertyId: pointsPropertyId },
                { kind: "property", propertyId: approvedPropertyId },
                { kind: "intrinsic", field: "updated_at" },
              ],
            },
          },
        },
      },
      properties: [...base.query.properties, ...extraProperties],
      rows: base.query.rows.map((row, index) => ({
        ...row,
        page: {
          ...row.page,
          createdAt: index === 0 ? "2026-02-10T10:00:00.000Z" : "2026-08-12T10:00:00.000Z",
          updatedAt: "2026-08-17T10:00:00.000Z",
        },
        values: {
          ...row.values,
          [relationPropertyId]: {
            propertyId: relationPropertyId,
            valueType: "relation" as const,
            value: {
              kind: "relation",
              value: {
                value_revision: 1,
                total_count: 1,
                targets: [
                  {
                    kind: "visible",
                    edge_id: String(index + 1).repeat(64),
                    page_id: `related-page-${index + 1}`,
                    title: index % 2 === 0 ? "Design tokens" : "Keyboard navigation",
                    lifecycle: "active",
                    membership_state: "active_in_target_source",
                  },
                ],
                restricted_count: 0,
                has_more: false,
              },
            },
            revision: 1,
          },
          [notesPropertyId]: {
            propertyId: notesPropertyId,
            valueType: "text" as const,
            value: index % 2 === 0 ? "Polish pass" : "Ready for review",
            revision: 1,
          },
          [approvedPropertyId]: {
            propertyId: approvedPropertyId,
            valueType: "checkbox" as const,
            value: index % 2 === 0,
            revision: 1,
          },
          [pointsPropertyId]: {
            propertyId: pointsPropertyId,
            valueType: "number" as const,
            value: index + 1,
            revision: 1,
          },
        },
      })),
    },
  };
};

export const BoardPropertyChips: Story = {
  args: { model: withBoardPropertyChips() },
};

export const BoardPropertyChipsNarrow: Story = {
  args: { model: withBoardPropertyChips() },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[520px] border-r-[0.5px] border-token-border/50">
        <Story />
      </div>
    ),
  ],
};

export const BoardPropertyChipsDarkMode: Story = {
  args: { model: withBoardPropertyChips() },
  globals: { theme: "dark" },
};

const withLargeListFixture = (count: number): DatabaseViewRenderModel => {
  const base = withLayout("list");
  const authority = base.query.rows[0];
  const renderRow = base.columns[0]?.rows[0];
  if (!authority || !renderRow) return base;
  const pageIds = Array.from({ length: count }, (_, index) => `large-page-${index + 1}`);
  return {
    ...base,
    query: {
      ...base.query,
      rows: pageIds.map((pageId, index) => {
        const title = `Large fixture Page ${String(index + 1).padStart(5, "0")}`;
        return {
          ...authority,
          membership: {
            ...authority.membership,
            membershipId: `large-membership-${index + 1}`,
          },
          page: {
            ...authority.page,
            pageId,
            documentId: `large-document-${index + 1}`,
            title,
            richTitle: plainTextToPortableRichText(title),
          },
          position: {
            rankKey: String(index + 1).padStart(8, "0"),
            revision: 1,
          },
        };
      }),
    },
    columns: [
      {
        id: "all",
        groupKey: null,
        scopeKey: "all",
        name: "Focused work",
        rows: pageIds.map((pageId, index) => ({
          ...renderRow,
          pageId,
          title: `Large fixture Page ${String(index + 1).padStart(5, "0")}`,
          createdAt: new Date(Date.parse(timestamp) + index * 1_000),
        })),
      },
    ],
  };
};

const tenThousandListModel = withLargeListFixture(10_000);

export const TenThousandList: Story = {
  render: () => (
    <DatabaseViewSurface
      model={tenThousandListModel}
      searchQuery=""
      onOpenPage={() => undefined}
      commitOperations={async () => null}
    />
  ),
};

function ListWithOpenContextMenu() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        const row = hostRef.current?.querySelector<HTMLElement>("[data-database-view-page-id]");
        row?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            button: 2,
            clientX: 420,
            clientY: 190,
          }),
        );
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, []);
  return (
    <div ref={hostRef} className="h-full">
      <DatabaseViewSurface
        model={withNestedList()}
        searchQuery=""
        onOpenPage={() => undefined}
        commitOperations={async () => null}
      />
    </div>
  );
}

export const ListContextMenu: Story = {
  render: () => <ListWithOpenContextMenu />,
};

const withEmptyList = (): DatabaseViewRenderModel => {
  const base = withLayout("list");
  return {
    ...base,
    query: { ...base.query, rows: [] },
    columns: [
      {
        id: "all",
        groupKey: null,
        scopeKey: "all",
        name: "Focused work",
        rows: [],
      },
    ],
  };
};

export const EmptyList: Story = {
  args: { model: withEmptyList() },
};

export const RetainedListBackgroundRefresh: Story = {
  args: {
    model: withNestedList(),
    groupPagination: new Map([
      [
        "all",
        {
          scopeKey: "all",
          loadedRows: 5,
          totalRows: 28,
          hasMore: true,
          loadingMore: true,
          error: null,
        },
      ],
    ]),
  },
  parameters: {
    docs: {
      description: {
        story:
          "The admitted List rows remain readable while a background window continues loading.",
      },
    },
  },
};

export const FailedListWindow: Story = {
  args: {
    model: withNestedList(),
    groupPagination: new Map([
      [
        "all",
        {
          scopeKey: "all",
          loadedRows: 5,
          totalRows: 28,
          hasMore: true,
          loadingMore: false,
          error: "Couldn’t load the next List window.",
        },
      ],
    ]),
    onLoadMoreGroup: () => undefined,
  },
};

const withSubgroups = (layout: "board" | "list"): DatabaseViewRenderModel => {
  const first = model.query.rows[0];
  if (!first) return model;
  const second = {
    ...first,
    membership: { ...first.membership, membershipId: "membership-2" },
    page: {
      ...first.page,
      pageId: "page-2",
      documentId: "document-2",
      title: "Polish keyboard focus recovery",
      richTitle: plainTextToPortableRichText("Polish keyboard focus recovery"),
    },
    values: {
      ...first.values,
      [priorityPropertyId]: {
        propertyId: priorityPropertyId,
        valueType: "select" as const,
        value: "p3-low",
        revision: 1,
      },
    },
    position: { rankKey: "b", revision: 1 },
    effectiveSubgroupKey: "p3-low",
  };
  const firstWithPriority = {
    ...first,
    values: {
      ...first.values,
      [priorityPropertyId]: {
        propertyId: priorityPropertyId,
        valueType: "select" as const,
        value: "p0-critical",
        revision: 1,
      },
    },
    effectiveSubgroupKey: "p0-critical",
  };
  return {
    ...model,
    query: {
      ...model.query,
      view: {
        ...model.query.view,
        layout: layout,
        config: {
          ...model.query.view.config,
          presentation: {
            ...model.query.view.config.presentation,
            subgroup: { propertyId: priorityPropertyId },
          },
        },
      },
      properties: [
        ...model.query.properties,
        {
          propertyId: priorityPropertyId,
          dataSourceId,
          name: "Priority",
          ...testPropertySemantics("select", 3),
          valueType: "select" as const,
          config: {
            options: [
              { id: "p0-critical", name: "Critical" },
              { id: "p1-high", name: "High" },
              { id: "p2-medium", name: "Medium" },
              { id: "p3-low", name: "Low" },
            ],
          },
          rankKey: "c",
          lifecycle: "active" as const,
          revision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      rows: [firstWithPriority, second],
    },
  };
};

const withPriorityGrouping = (): DatabaseViewRenderModel => {
  const next = withSubgroups("board");
  return {
    ...next,
    query: {
      ...next.query,
      view: {
        ...next.query.view,
        config: {
          ...next.query.view.config,
          presentation: {
            ...next.query.view.config.presentation,
            group: { propertyId: priorityPropertyId },
            subgroup: null,
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
      rows: next.query.rows.map((row) => ({
        ...row,
        effectiveGroupKey: row.effectiveSubgroupKey,
        effectiveSubgroupKey: null,
      })),
    },
  };
};

const customGroupPropertyId = parseDataSourcePropertyId("p_GROUP001");

const withCustomGrouping = (
  valueType: "select" | "multi_select" | "checkbox",
): DatabaseViewRenderModel => {
  const next = withSubgroups("board");
  const groupValues =
    valueType === "checkbox"
      ? [true, false]
      : valueType === "multi_select"
        ? [["o_PLATFORM"], []]
        : ["o_PLATFORM", null];
  const groupKeys =
    valueType === "checkbox"
      ? ["true", "false"]
      : valueType === "multi_select"
        ? ['["o_PLATFORM"]', null]
        : ["o_PLATFORM", null];
  const groupProperty: DataSourcePropertyRecordV2 = {
    propertyId: customGroupPropertyId,
    dataSourceId,
    name: valueType === "checkbox" ? "Approved" : "Team",
    ...testPropertySemantics(valueType, 1),
    valueType,
    config:
      valueType === "select" || valueType === "multi_select"
        ? { options: [{ id: "o_PLATFORM", name: "Platform", color: "blue" }] }
        : {},
    rankKey: "d",
    lifecycle: "active",
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
        config: {
          ...next.query.view.config,
          presentation: {
            ...next.query.view.config.presentation,
            group: { propertyId: customGroupPropertyId },
            subgroup: null,
            display: {
              ...next.query.view.config.presentation.display,
              fields: [
                { kind: "property", propertyId: customGroupPropertyId },
                { kind: "property", propertyId: tagsPropertyId },
              ],
            },
          },
        },
      },
      properties: [...next.query.properties, groupProperty],
      rows: next.query.rows.map((row, index) => ({
        ...row,
        values: {
          ...row.values,
          [customGroupPropertyId]: {
            propertyId: customGroupPropertyId,
            valueType,
            value: groupValues[index] ?? null,
            revision: 1,
          },
        },
        effectiveGroupKey: groupKeys[index] ?? null,
        effectiveSubgroupKey: null,
      })),
    },
  };
};

export const PriorityGroupedBoard: Story = {
  args: { model: withPriorityGrouping() },
};

export const PriorityGroupedBoardDarkMode: Story = {
  args: {
    model: withPriorityGrouping(),
    presentedPageIds: new Set(["page-1"]),
  },
  globals: { theme: "dark" },
};

export const CustomSelectGroupedBoard: Story = {
  args: { model: withCustomGrouping("select") },
};

export const CheckboxGroupedBoard: Story = {
  args: { model: withCustomGrouping("checkbox") },
};

export const MultiSelectGroupedBoard: Story = {
  args: { model: withCustomGrouping("multi_select") },
};

export const SubgroupedBoard: Story = {
  args: { model: withSubgroups("board") },
};

export const SubgroupedList: Story = {
  args: { model: withSubgroups("list") },
};

export const GroupCombinationLimit: Story = {
  render: () => (
    <div className="pt-1">
      <DatabaseViewGroupLimitNotice totalGroups={225} groupLimit={200} />
      <div className="mt-2 h-[560px]">
        <DatabaseViewSurface
          model={withLayout("list")}
          searchQuery=""
          onOpenPage={() => undefined}
          commitOperations={async () => null}
        />
      </div>
    </div>
  ),
};
export const NarrowList: Story = {
  args: { model: withLayout("list") },
  decorators: [
    (Story) => (
      <div className="h-[640px] w-[520px] border-r-[0.5px] border-token-border/50">
        <Story />
      </div>
    ),
  ],
};
function FullDatabaseViewTab({ viewModel }: { readonly viewModel: DatabaseViewRenderModel }) {
  const [query, setQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <DatabaseViewTabSurface
      model={viewModel}
      activeSearchQuery={query}
      taskSearchOpen={searchOpen}
      searchShortcutLabel="Ctrl+F"
      taskSearchInputRef={searchInputRef}
      onSearchQueryChange={setQuery}
      onOpenTaskSearch={() => setSearchOpen(true)}
      onCloseTaskSearch={() => setSearchOpen(false)}
      onOpenPage={() => undefined}
    />
  );
}

export const FullTabSurface: Story = {
  render: (args) => <FullDatabaseViewTab viewModel={args.model} />,
};

export const FullNestedList: Story = {
  render: () => <FullDatabaseViewTab viewModel={withNestedList()} />,
};

function ListSubtreeDragFixture() {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const fixtureModel = withNestedList();
  const rows = buildDatabaseListProjection({
    columns: fixtureModel.columns,
    grouped: false,
    subgrouped: false,
    showSubPages: true,
    nested: true,
    collapsedOccurrenceKeys: new Set(),
  });
  const continuations = databaseListNestingContinuations(rows);
  return (
    <DatabaseListDndProvider
      rows={rows}
      selection={emptyDatabaseListSelection()}
      scrollerRef={scrollerRef}
      disabled={false}
      overlayColumns={{ priority: true, identifier: true, status: true }}
      onCommit={() => undefined}
    >
      <div
        ref={scrollerRef}
        role="grid"
        aria-label="Database List drag preview fixture"
        className={`grid h-[640px] w-[1100px] content-start gap-x-2 overflow-hidden bg-[var(--database-list-surface)] ${DATABASE_LIST_THEME_CLASS_NAME}`}
        style={{
          gridTemplateColumns: databaseListGridTemplate([], {
            priority: true,
            identifier: true,
            status: true,
          }),
        }}
      >
        {rows.map((item, index) =>
          item.kind === "page" ? (
            <DatabaseListRow
              key={item.key}
              item={item}
              libraryId={libraryId}
              selected={false}
              selectedBefore={false}
              selectedAfter={false}
              active={index === 0}
              presented={false}
              inlineProperties={null}
              trailingCells={null}
              onSelect={() => undefined}
              onActivate={() => undefined}
              onOpen={() => undefined}
              statusOptions={[
                { id: "triage", name: "Triage" },
                { id: "plan", name: "Plan" },
                { id: "build", name: "Build" },
                { id: "review", name: "Review" },
                { id: "ship", name: "Ship" },
              ]}
              priorityOptions={[
                { id: "p0-critical", name: "Urgent" },
                { id: "p1-high", name: "High" },
                { id: "p2-medium", name: "Medium" },
                { id: "p3-low", name: "Low" },
              ]}
              onSetStatus={() => undefined}
              onSetPriority={() => undefined}
              statusMutationDisabled={false}
              priorityMutationDisabled={false}
              showPriority
              showStatus
              identity={projectDatabaseListPageIdentity(item.row.pageKey, ["page_key"])}
              nestingContinuations={continuations.get(item.key) ?? []}
              ariaRowIndex={index + 1}
            />
          ) : null,
        )}
      </div>
    </DatabaseListDndProvider>
  );
}

export const ListSubtreeDragPreview: Story = {
  render: () => <ListSubtreeDragFixture />,
  parameters: {
    docs: {
      description: {
        story:
          "Interactive nested drag coverage for the canonical insertion pin and visible-column preview.",
      },
    },
  },
};

function ListFocusRetentionStory() {
  const [title, setTitle] = useState("Unify Database View rendering");
  const [viewModel, setViewModel] = useState(() => withNestedList());
  return (
    <div className="grid h-[640px] w-[1100px] grid-cols-[minmax(0,1fr)_360px] overflow-hidden bg-token-main-surface-primary">
      <div className="min-w-0 border-r-[0.5px] border-token-border/50">
        <FullDatabaseViewTab viewModel={viewModel} />
      </div>
      <label className="flex min-w-0 flex-col gap-2 px-8 py-10 text-xs text-token-description-foreground">
        Page Stage title
        <input
          aria-label="Page Stage title"
          className="min-w-0 bg-transparent text-xl font-semibold text-token-foreground outline-none"
          value={title}
          onChange={(event) => {
            const nextTitle = event.target.value;
            setTitle(nextTitle);
            setViewModel((current) => ({
              ...current,
              commitSeq: current.commitSeq + 1,
              query: {
                ...current.query,
                rows: current.query.rows.map((row) =>
                  row.page.pageId === "page-1"
                    ? {
                        ...row,
                        page: {
                          ...row.page,
                          title: nextTitle,
                          richTitle: plainTextToPortableRichText(nextTitle),
                          metadataRevision: row.page.metadataRevision + 1,
                        },
                      }
                    : row,
                ),
              },
              columns: current.columns.map((column) => ({
                ...column,
                rows: column.rows.map((row) =>
                  row.pageId === "page-1"
                    ? {
                        ...row,
                        title: nextTitle,
                        metadataRevision: row.metadataRevision + 1,
                      }
                    : row,
                ),
              })),
            }));
          }}
        />
      </label>
    </div>
  );
}

export const ListBesideFocusedPageEditor: Story = {
  render: () => <ListFocusRetentionStory />,
  play: async ({ canvasElement }) => {
    const row = canvasElement.querySelector<HTMLElement>("[data-list-row=true]");
    if (!row) throw new Error("Expected a Database List row");
    fireEvent.focus(row);
    const editor = getByRole(canvasElement, "textbox", {
      name: "Page Stage title",
    });
    editor.focus();
    fireEvent.change(editor, { target: { value: "Focused Page updated" } });
    await waitFor(() => {
      if (document.activeElement !== editor) {
        throw new Error("Database projection refresh moved focus out of Page Stage");
      }
    });
  },
};

export const FullNestedListNarrow: Story = {
  render: () => (
    <div className="h-full w-[680px] border-r-[0.5px] border-token-border/50">
      <FullDatabaseViewTab viewModel={withNestedList()} />
    </div>
  ),
};

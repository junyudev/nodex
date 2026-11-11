import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, within } from "@testing-library/react";
import type { ReactElement } from "react";

import type { PageStageCorePage } from "@/lib/page-stage-page";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { TestQueryProvider } from "@/test/query";
import { inboxAgentsFixture } from "@/features/inbox/inbox-agents.test-support";
import { PageStagePropertiesSection } from "./properties-section";
import type { PageStageController } from "./use-page-stage-controller";
import type { PageStagePropertyControls } from "./use-page-stage-properties";
import type {
  LibraryPageFileInventory,
  LibraryPageFileItem,
} from "../../../../shared/library-files";
import type { PageTurn } from "../../../../shared/page-turn";
import {
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "../../../../shared/database-identities";
import { testPropertySemantics } from "../../../../shared/testing/database-property-record";

const api = vi.hoisted(() => ({
  applyLibraryModule: vi.fn(),
  prepareFileBlob: vi.fn(),
  readFileBytes: vi.fn(),
  saveFile: vi.fn(),
  readLibraryModule: vi.fn(),
  subscribeAutomationChanges: vi.fn(() => () => undefined),
  subscribeAutomationRunsUpdates: vi.fn(() => () => undefined),
}));
const turnState = vi.hoisted(() => ({ turn: null as PageTurn | null }));
vi.mock("@/lib/page-turn-runtime", () => ({
  usePageTurn: () => ({
    data: turnState.turn ? { turn: turnState.turn, activeChat: null } : undefined,
  }),
  acceptPageWork: vi.fn(),
}));
vi.mock("@/lib/page-workspace-runtime", () => ({ usePageWorkspace: () => ({ data: undefined }) }));
const modal = vi.hoisted(() => ({ openModal: vi.fn() }));

vi.mock("@/lib/api", () => api);
vi.mock("@/lib/members-runtime", () => ({
  useLocalMember: () => ({ data: { id: "person" } }),
  useMembers: () => ({ data: [{ id: "person", display_name: "You", lifecycle: "active" }] }),
}));
vi.mock("@/lib/use-agent-runtime-providers", () => ({
  useAgentRuntimeProviders: () => ({ data: [] }),
}));
vi.mock("@/features/inbox/inbox-agent-picker", async (original) => ({
  ...(await original<typeof import("@/features/inbox/inbox-agent-picker")>()),
  useInboxAgents: () => inboxAgentsFixture(),
}));
vi.mock("@/lib/modal-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modal-registry")>()),
  openModal: modal.openModal,
}));
vi.mock("@/lib/maitai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/maitai")>()),
  useScopeHandle: () => ({ scope: "test" }),
}));

const emptyManifest = {
  page_id: "nested-page",
  revision: 0,
  body_usage_revision: 0,
  files: [],
  next_cursor: null,
  has_more: false,
  total: 0,
  unplaced_total: 0,
  placed_total: 0,
} satisfies LibraryPageFileInventory;

const pageFile = (
  fileId: string,
  logicalPath: string,
  bodyUsage:
    | { readonly kind: "not_in_body" }
    | { readonly kind: "placed"; readonly placementCount: number },
): LibraryPageFileItem => ({
  logical_path: logicalPath,
  attachment: {
    attached_by: { type: "service" as const, kind: "maintenance" as const },
    attached_at: null,
  },
  body_count: bodyUsage.kind === "placed" ? bodyUsage.placementCount : 0,
  file: {
    file_id: fileId,
    library_id: "library-1",
    default_name: logicalPath,
    mime_type: logicalPath.endsWith(".png") ? "image/png" : "text/plain",
    byte_length: 12,
    head_version: 1,
    blob_etag: `etag-${fileId}`,
    lifecycle: "live",
    revision: 1,
    created_by: { type: "member" as const, member_id: "member-local" },
    created_by_turn_id: null,
    created_at: "2026-08-28T00:00:00.000Z",
    updated_at: "2026-08-28T00:00:00.000Z",
  },
});

const manifestResponse = (manifest: LibraryPageFileInventory) => ({
  ok: true,
  value: {
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    commitSeq: 1,
    value: {
      kind: "page_file_inventory",
      value: manifest,
    },
  },
});

beforeEach(() => {
  turnState.turn = null;
  modal.openModal.mockReset();
  api.readLibraryModule.mockReset();
  api.readLibraryModule.mockResolvedValue(manifestResponse(emptyManifest));
});

const page = {
  id: "nested-page",
  pageKey: null,
  archived: false,
  title: "Nested Page",
  richTitle: [],
  isAllDay: false,
  pageWork: { owner: "person", assignee: null, auto_start: false },
  reminders: [],
  revision: 1,
  created: new Date("2026-07-15T00:00:00.000Z"),
} satisfies PageStageCorePage;

const emptyPropertyControls: PageStagePropertyControls = {
  pageId: null,
  properties: [],
  rows: [],
  semanticValues: null,
  options: {},
  optionRegistryStates: {},
  requestOptions: vi.fn(),
  requestMoreOptions: vi.fn(),
  optionRegistryHasMore: {},
  optionRegistryLoadingMore: {},
  busyPropertyIds: new Set(),
  errors: {},
  edit: async () => ({ status: "updated", didMutate: false }),
  patchRelation: async () => ({ status: "updated", didMutate: false }),
  replaceRelation: async () => ({ status: "updated", didMutate: false }),
  patchMultiSelect: async () => ({ status: "updated", didMutate: false }),
  createOptionAndSelect: async () => ({ status: "updated", didMutate: false }),
  loadRelationTargets: async (property) => ({
    valueRevision: property.valueRevision,
    totalCount: 0,
    targets: [],
    nextCursor: null,
    projectionRevision: 0,
  }),
  searchRelationCandidates: async () => ({
    candidates: [],
    nextCursor: null,
    projectionRevision: 0,
  }),
  loadRelationTargetDescriptor: async () => null,
  refreshRelationValue: async () => undefined,
};

const buildController = (overrides: Partial<PageStageController> = {}): PageStageController =>
  ({
    page,
    contentRoutingContext: { kind: "project", projectId: "project-1" },
    hasRelatedChatsRow: false,
    relatedChats: [],
    relatedChatsLoading: false,
    relatedChatsError: null,
    relatedChatsHasMore: false,
    relatedChatsLoadingMore: false,
    relatedChatCandidates: [],
    saving: false,
    propertyControls: emptyPropertyControls,
    ...overrides,
  }) as PageStageController;

const renderProperties = (element: ReactElement) =>
  renderWithAppMaitai(element, { wrapper: TestQueryProvider });

const statusItem = {
  property: {
    propertyId: parseDataSourcePropertyId("status"),
    dataSourceId: parseDataSourceId("source-1"),
    name: "Status",
    ...testPropertySemantics("select", 6),
    valueType: "select",
    config: {},
    optionCount: 6,
    rankKey: "0",
    lifecycle: "active",
    revision: 1,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  },
  value: null,
  valueRevision: 1,
  error: null,
  pageVisibility: "hide_when_empty",
} as const;
const statusControls: PageStagePropertyControls = {
  ...emptyPropertyControls,
  pageId: "nested-page",
  properties: [statusItem],
  rows: [{ kind: "property", key: "status", item: statusItem, shownByLayout: false, empty: true }],
};

describe("PageStagePropertiesSection", () => {
  test("Status carries whose move the Page waits for, with no separate Turn row", async () => {
    turnState.turn = {
      page_id: "nested-page",
      actor: { kind: "member", member_id: "person" },
      reason: "question",
      since: "now",
      episode: "episode",
    };
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({ propertyControls: statusControls })}
      />,
    );
    const status = view.container.querySelector('[data-page-stage-property-id="status"]');
    expect(status?.textContent).toContain("Needs your answer");
    expect(view.queryByText("Turn")).toBeNull();
  });

  test("a Page without work keeps a plain Status, tucked away while empty", async () => {
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({ propertyControls: statusControls })}
      />,
    );
    expect(view.container.querySelector('[data-page-stage-property-id="status"]')).toBeNull();
    expect(view.container.querySelector("[data-page-turn-line]")).toBeNull();
  });

  test("work in a Page without a Status Property still says whose move it is", () => {
    turnState.turn = {
      page_id: "nested-page",
      actor: { kind: "page", page_id: "prerequisite", key: "NODEX-2" },
      reason: "waiting_on_prerequisite",
      since: "now",
      episode: "episode",
    };
    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);
    expect(view.getByText("Status")).toBeTruthy();
    expect(view.getByRole("link", { name: "Waiting for NODEX-2" })).toBeTruthy();
  });

  test("offers empty properties by name and never as rows that say Empty", async () => {
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({ propertyControls: statusControls })}
      />,
    );

    expect(view.getByRole("region", { name: "Properties" })).toBeTruthy();
    const more = await view.findByRole("button", { name: "3 more properties" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByRole("group", { name: "Empty properties" })).toBeNull();
    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");

    const choices = within(view.getByRole("group", { name: "Empty properties" }));
    // A Project Page that names no Agent offers one beside its empty Properties.
    expect(choices.getAllByRole("button").map((choice) => choice.textContent)).toEqual([
      "Status",
      "Assignee",
      "Files",
    ]);
    // Files stays mounted while tucked away, but nothing on screen says Empty.
    expect(
      view.queryAllByText("Empty", { exact: true }).filter((node) => !node.closest("[hidden]")),
    ).toEqual([]);
    expect(view.container.querySelector('[data-page-stage-property-id="status"]')).toBeNull();
  });

  test("a chosen property joins the list and stays when the disclosure closes", async () => {
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({ propertyControls: statusControls })}
      />,
    );
    const found1 = await view.findByRole("button", { name: "3 more properties" });
    await act(async () => {
      fireEvent.click(found1);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Status" }));
      await Promise.resolve();
    });

    expect(view.container.querySelector('[data-page-stage-property-id="status"]')).toBeTruthy();
    const hide = view.getByRole("button", { name: "Hide 2 properties" });
    await act(async () => {
      fireEvent.click(hide);
      await Promise.resolve();
    });
    expect(view.container.querySelector('[data-page-stage-property-id="status"]')).toBeTruthy();
    expect(view.getByRole("button", { name: "2 more properties" })).toBeTruthy();
  });

  test("choosing Files opens the Page's File manager", async () => {
    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);

    expect(view.queryByRole("button", { name: "Add Page Files" })).toBeNull();
    const found2 = await view.findByRole("button", { name: "2 more properties" });
    await act(async () => {
      fireEvent.click(found2);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Files" }));
      await Promise.resolve();
    });
    expect(modal.openModal).toHaveBeenCalledOnce();
    expect(modal.openModal.mock.calls[0]?.[2]).toMatchObject({
      routingContext: { kind: "project", projectId: "project-1" },
      pageId: "nested-page",
    });
    expect(view.getByRole("button", { name: "Add Page Files" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Hide 1 property" })).toBeTruthy();
  });

  test("choosing Assignee adds its row", async () => {
    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);

    expect(view.queryByRole("button", { name: "Choose Assignee" })).toBeNull();
    const found3 = await view.findByRole("button", { name: "2 more properties" });
    await act(async () => {
      fireEvent.click(found3);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Assignee" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Choose Assignee" })).toBeTruthy();
  });

  test("choosing Linked chats adds its row with the chat menu open", async () => {
    const onCreateRelatedChat = vi.fn(async () => undefined);
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({
          hasRelatedChatsRow: true,
          relatedChats: [],
          relatedChatCandidates: [],
          onCreateRelatedChat,
          saving: false,
        })}
      />,
    );

    expect(view.queryByRole("button", { name: "Add chat" })).toBeNull();
    const more = await view.findByRole("button", { name: "3 more properties" });
    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Linked chats" }));
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "Add chat" })).toBeTruthy();

    const found4 = await view.findByRole("menuitem", { name: "New chat" });
    await act(async () => {
      fireEvent.click(found4);
      await Promise.resolve();
    });
    expect(onCreateRelatedChat).toHaveBeenCalledTimes(1);
  });

  test("shows Chat relation chips and links an existing Chat from the trailing action", async () => {
    const handleOpenRelatedChat = vi.fn(async () => undefined);
    const handleRemoveRelatedChat = vi.fn(async () => undefined);
    const onLinkRelatedChat = vi.fn(async () => undefined);
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({
          hasRelatedChatsRow: true,
          relatedChats: [
            {
              sessionId: "session-threadless",
              projectId: "project-1",
              projectName: "Nodex",
              displayTitle: "Research follow-up",
              threadId: null,
              executionRef: null,
              threadPreview: "",
              threadStatus: null,
              threadArchived: false,
              unread: false,
              report: null,
              sessionArchived: false,
              conversationRecencyAt: null,
              linkedAt: "2026-08-24T00:00:00Z",
            },
          ],
          relatedChatsLoading: false,
          relatedChatsError: null,
          relatedChatsHasMore: false,
          relatedChatsLoadingMore: false,
          relatedChatCandidates: [
            {
              sessionId: "session-candidate",
              displayTitle: "Implementation plan",
              projectName: "Nodex",
            },
          ],
          onCreateRelatedChat: vi.fn(async () => undefined),
          onLinkRelatedChat,
          onOpenRelatedChat: handleOpenRelatedChat,
          onRemoveRelatedChat: handleRemoveRelatedChat,
          handleOpenRelatedChat,
          handleRemoveRelatedChat,
          currentSessionId: "session-threadless",
          saving: false,
        })}
      />,
    );

    await view.findByRole("button", { name: "2 more properties" });

    expect(view.queryByText("Nodex")).toBeNull();
    expect(view.queryByText("No thread yet")).toBeNull();
    expect(view.queryByText("1 linked")).toBeNull();
    expect(
      view.getByRole("button", { name: /^Research follow-up/ }).getAttribute("aria-current"),
    ).toBe("true");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /^Research follow-up/ }));
      fireEvent.click(view.getByRole("button", { name: "Remove relation to Research follow-up" }));
      await Promise.resolve();
    });
    expect(handleOpenRelatedChat).toHaveBeenCalledWith("session-threadless");
    expect(handleRemoveRelatedChat).toHaveBeenCalledWith("session-threadless");

    await act(async () => {
      const trigger = view.getByRole("button", { name: "Add chat" });
      fireEvent.pointerDown(trigger, {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    const linkExisting = view.getByRole("menuitem", { name: "Link to chat…" });
    await act(async () => {
      fireEvent.click(linkExisting);
      await Promise.resolve();
    });
    const candidate = await view.findByRole("button", { name: /Implementation plan/ });
    await act(async () => {
      fireEvent.click(candidate);
      await Promise.resolve();
    });
    expect(onLinkRelatedChat).toHaveBeenCalledWith("session-candidate");
  });

  test("offers the Chat whose Scene shows the Page first when linking", async () => {
    const view = renderProperties(
      <PageStagePropertiesSection
        controller={buildController({
          hasRelatedChatsRow: true,
          relatedChats: [
            {
              sessionId: "session-linked",
              projectId: "project-1",
              projectName: "Nodex",
              displayTitle: "Research follow-up",
              threadId: null,
              executionRef: null,
              threadPreview: "",
              threadStatus: null,
              threadArchived: false,
              unread: false,
              report: null,
              sessionArchived: false,
              conversationRecencyAt: null,
              linkedAt: "2026-08-24T00:00:00Z",
            },
          ],
          relatedChatsLoading: false,
          relatedChatsError: null,
          relatedChatsHasMore: false,
          relatedChatsLoadingMore: false,
          relatedChatCandidates: [
            { sessionId: "session-recent", displayTitle: "Release notes", projectName: "Nodex" },
            { sessionId: "session-current", displayTitle: "Fix login", projectName: "Nodex" },
          ],
          onLinkRelatedChat: vi.fn(async () => undefined),
          currentSessionId: "session-current",
          saving: false,
        })}
      />,
    );

    const trigger = await view.findByRole("button", { name: "Add chat" });
    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "Link to chat…" }));
      await Promise.resolve();
    });
    await view.findByRole("button", { name: /Release notes/ });
    const rows = view
      .getAllByRole("button")
      .filter((button) => /Fix login|Release notes/.test(button.textContent ?? ""));
    expect(rows.map((row) => row.textContent)).toEqual([
      "Fix loginThis chat",
      "Release notesNodex",
    ]);
  });

  test("shows an unplaced File without requiring disclosure", async () => {
    api.readLibraryModule.mockResolvedValue(
      manifestResponse({
        ...emptyManifest,
        revision: 1,
        files: [pageFile("file-brief", "brief.txt", { kind: "not_in_body" })],
        total: 1,
        unplaced_total: 1,
      }),
    );

    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);

    expect(await view.findByRole("treeitem", { name: "brief.txt" })).toBeTruthy();
    expect(await view.findByRole("button", { name: "1 more property" })).toBeTruthy();
  });

  test("keeps Files represented in the body behind the disclosure without calling them Empty", async () => {
    api.readLibraryModule.mockResolvedValue(
      manifestResponse({
        ...emptyManifest,
        revision: 1,
        body_usage_revision: 1,
        files: [pageFile("file-image", "image.png", { kind: "placed", placementCount: 1 })],
        total: 1,
        placed_total: 1,
      }),
    );

    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);
    const more = await view.findByRole("button", { name: "2 more properties" });
    expect(view.queryByRole("treeitem", { name: "image.png" })).toBeNull();

    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });

    expect(view.getByRole("button", { name: /^1 file/u }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(view.getByRole("treeitem", { name: "image.png" })).toBeTruthy();
    expect(
      within(view.getByRole("group", { name: "Empty properties" }))
        .getAllByRole("button")
        .map((choice) => choice.textContent),
    ).toEqual(["Assignee"]);
    expect(view.queryByText("Empty", { exact: true })).toBeNull();
  });
});

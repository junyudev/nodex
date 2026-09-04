import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import type { ReactElement } from "react";

import type { PageStageCorePage } from "@/lib/page-stage-page";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import { PageStagePropertiesSection } from "./properties-section";
import type { PageStageController } from "./use-page-stage-controller";
import type { PageStagePropertyControls } from "./use-page-stage-properties";
import type {
  LibraryPageFileInventory,
  LibraryPageFileItem,
} from "../../../../shared/library-files";

const api = vi.hoisted(() => ({
  applyLibraryModule: vi.fn(),
  prepareFileBlob: vi.fn(),
  readFileBytes: vi.fn(),
  saveFile: vi.fn(),
  readLibraryModule: vi.fn(),
}));
const modal = vi.hoisted(() => ({ openModal: vi.fn() }));

vi.mock("@/lib/api", () => api);
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
  can_write: true,
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
    created_by_actor_id: "actor-1",
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
    authorization: null,
    value: {
      kind: "page_file_inventory",
      value: manifest,
    },
  },
});

beforeEach(() => {
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
  reminders: [],
  revision: 1,
  created: new Date("2026-07-15T00:00:00.000Z"),
} satisfies PageStageCorePage;

const emptyPropertyControls: PageStagePropertyControls = {
  pageId: null,
  properties: [],
  primaryProperties: [],
  sectionProperties: [],
  hiddenLayoutProperties: [],
  semanticValues: null,
  hasScheduleCapability: false,
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
    contentAccessContext: { kind: "project", projectId: "project-1" },
    storeEpoch: "store-1",
    hasDatabaseProperties: false,
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
  render(<TestQueryProvider>{element}</TestQueryProvider>);

describe("PageStagePropertiesSection", () => {
  test("keeps empty Files available behind the shared disclosure", async () => {
    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);

    expect(view.getByText("Properties")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Add Page Files" })).toBeNull();
    const more = await view.findByRole("button", { name: "1 more property" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });
    expect(more.getAttribute("aria-expanded")).toBe("true");
    const files = view.getByRole("button", { name: "Add Page Files" });
    await act(async () => {
      fireEvent.click(files);
      await Promise.resolve();
    });
    expect(modal.openModal).toHaveBeenCalledOnce();
    expect(modal.openModal.mock.calls[0]?.[2]).toMatchObject({
      accessContext: { kind: "project", projectId: "project-1" },
      pageId: "nested-page",
    });
  });

  test("keeps empty Files and linked Chats in the same disclosure", async () => {
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
    const more = await view.findByRole("button", { name: "2 more properties" });
    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });

    expect(view.getByText("Properties")).toBeTruthy();
    expect(view.getByText("Linked chats")).toBeTruthy();
    expect(view.getByRole("button", { name: "Add chat" }).textContent).toBe("Empty");
    expect(view.queryByText("Local project")).toBeNull();
    expect(view.queryByText("Project cwd")).toBeNull();

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
    await act(async () => {
      fireEvent.click(view.getByRole("menuitem", { name: "New chat" }));
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
              threadPreview: "",
              threadStatus: null,
              threadArchived: false,
              unread: false,
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

    await view.findByRole("button", { name: "1 more property" });

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

    expect(await view.findByRole("button", { name: "Open brief.txt" })).toBeTruthy();
    expect(view.queryByRole("button", { name: /more propert/u })).toBeNull();
  });

  test("keeps Files represented in the body behind the disclosure without calling them Empty", async () => {
    api.readLibraryModule.mockResolvedValue(
      manifestResponse({
        ...emptyManifest,
        revision: 1,
        body_usage_revision: 1,
        can_write: true,
        files: [pageFile("file-image", "image.png", { kind: "placed", placementCount: 1 })],
        total: 1,
        placed_total: 1,
      }),
    );

    const view = renderProperties(<PageStagePropertiesSection controller={buildController()} />);
    const more = await view.findByRole("button", { name: "1 more property" });
    expect(view.queryByRole("button", { name: "Open 1 File shown in Page" })).toBeNull();

    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });

    expect(view.getByRole("button", { name: "Open 1 File shown in Page" }).textContent).toBe(
      "1 in page",
    );
    expect(view.queryByText("Empty", { exact: true })).toBeNull();
  });
});

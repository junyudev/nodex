import { act, fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ReactNode } from "react";

import type { LibraryPageFileItem } from "../../../../shared/library-files";
import type { PageFilesReadModel } from "@/lib/use-page-files";
import { queryKeys } from "@/lib/query-keys";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type { PageStageController } from "./use-page-stage-controller";

const modal = vi.hoisted(() => ({ openModal: vi.fn() }));
vi.mock("@/lib/modal-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modal-registry")>()),
  openModal: modal.openModal,
}));
vi.mock("@/lib/maitai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/maitai")>()),
  useScopeHandle: () => ({ scope: "test" }),
}));
vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryMetadata: () => ({ data: { storeEpoch: "epoch", libraryId: "library-1" } }),
}));

vi.mock("@/lib/members-runtime", () => ({
  useMembers: () => ({ data: [{ id: "member-local", display_name: "You" }] }),
  useLocalMember: () => ({ data: { id: "member-local" } }),
}));
vi.mock("@/components/board/editor/file-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/board/editor/file-runtime")>()),
  FileReadBoundary: ({ children }: { readonly children: ReactNode }) => children,
  useFilePlacementRuntime: () => ({ save: vi.fn(async () => undefined) }),
  useFileReadSnapshot: (_runtime: unknown, source: string) => ({ objectUrl: `blob:${source}` }),
}));

import { PageFilesRow } from "./page-files-row";

const NOW = "2026-11-01T10:00:00.000Z";
const CHAT = "session-cold-start";

const item = (
  fileId: string,
  logicalPath: string | null,
  attachedBy: NonNullable<LibraryPageFileItem["attachment"]>["attached_by"] | null,
  bodyCount = 0,
): LibraryPageFileItem => ({
  file: {
    file_id: fileId,
    library_id: "library-1",
    default_name: logicalPath?.split("/").at(-1) ?? `${fileId}.png`,
    head_version: 1,
    revision: 1,
    lifecycle: "live",
    mime_type: "text/html",
    byte_length: 14_336,
    blob_etag: "a".repeat(64),
    created_by: { type: "member" as const, member_id: "member-local" },
    created_by_turn_id: null,
    created_at: NOW,
    updated_at: NOW,
  },
  logical_path: logicalPath,
  body_count: bodyCount,
  attachment: attachedBy ? { attached_by: attachedBy, attached_at: NOW } : null,
});

const agent = {
  type: "agent" as const,
  session_id: CHAT,
  run_id: null,
  on_behalf_of: "member-local",
};

const model = (files: readonly LibraryPageFileItem[]): PageFilesReadModel => ({
  inventory: {
    page_id: "page-1",
    revision: 3,
    body_usage_revision: 1,
    files: [...files],
    next_cursor: null,
    has_more: false,
    total: files.length,
    unplaced_total: files.filter((file) => file.body_count === 0).length,
    placed_total: files.filter((file) => file.body_count > 0).length,
  },
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  loadMore: vi.fn(),
  refresh: vi.fn(),
});

const controller = (overrides: Partial<PageStageController> = {}) =>
  ({
    page: { id: "page-1", title: "Dashboard cold start" },
    contentRoutingContext: { kind: "project", projectId: "project-1" },
    openPageFile: vi.fn(),
    onOpenRelatedChat: vi.fn(),
    handleOpenRelatedChat: vi.fn(),
    ...overrides,
  }) as unknown as PageStageController;

const renderRow = (files: readonly LibraryPageFileItem[], stage = controller()) => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.projectSessions.detail(CHAT), {
    id: CHAT,
    displayTitle: "Dashboard cold start",
  });
  renderWithAppMaitai(<PageFilesRow baseFiles={model(files)} controller={stage} />, {
    wrapper: ({ children }) => <TestQueryProvider client={client}>{children}</TestQueryProvider>,
  });
  return stage;
};

const report = item("report", "profile/report.html", agent);
const flamegraph = item("flamegraph", "profile/flamegraph.png", agent);
const image = (fileId: string, logicalPath: string): LibraryPageFileItem => {
  const base = item(fileId, logicalPath, agent);
  return { ...base, file: { ...base.file, mime_type: "image/png" } };
};
const before = image("before", "shots/before.png");
const after = image("after", "shots/after.png");

describe("PageFilesRow", () => {
  beforeEach(() => modal.openModal.mockReset());

  test("opens a File beside its Page: a click previews it, a double click keeps it", async () => {
    const stage = renderRow([report, flamegraph]);

    const row = screen.getByRole("treeitem", { name: "profile/report.html" });
    await act(async () => {
      fireEvent.click(row);
      fireEvent.doubleClick(screen.getByRole("treeitem", { name: "profile/flamegraph.png" }));
      await Promise.resolve();
    });

    expect(stage.openPageFile).toHaveBeenNthCalledWith(1, {
      routingContext: { kind: "project", projectId: "project-1" },
      pageId: "page-1",
      fileId: "report",
      logicalPath: "profile/report.html",
      title: "report.html",
      openMode: "preview",
    });
    expect(stage.openPageFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ fileId: "flamegraph", openMode: "durable" }),
    );
    expect(modal.openModal).not.toHaveBeenCalled();
  });

  test("shows an image over the Page and opens its tab only when asked", async () => {
    const stage = renderRow([report, before, after]);

    await act(async () => {
      fireEvent.click(screen.getByRole("treeitem", { name: "shots/after.png" }));
      await Promise.resolve();
    });
    const preview = within(await screen.findByRole("dialog", { name: "Image preview" }));
    expect(preview.getByText("after.png")).toBeTruthy();
    expect(stage.openPageFile).not.toHaveBeenCalled();

    // The preview steps through the Page's images in tree order, skipping other Files.
    expect(preview.queryByRole("button", { name: "Previous image" })).toBeNull();
    await act(async () => {
      fireEvent.click(preview.getByRole("button", { name: "Next image" }));
      await Promise.resolve();
    });
    expect(preview.getByText("before.png")).toBeTruthy();
    expect(preview.queryByRole("button", { name: "Next image" })).toBeNull();

    await act(async () => {
      fireEvent.click(preview.getByRole("button", { name: "Open in tab" }));
      await Promise.resolve();
    });
    expect(stage.openPageFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fileId: "before", title: "before.png", openMode: "durable" }),
    );
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  test("a Cmd-click opens an image straight in its tab", async () => {
    const stage = renderRow([before]);

    await act(async () => {
      fireEvent.click(screen.getByRole("treeitem", { name: "shots/before.png" }), {
        metaKey: true,
      });
      await Promise.resolve();
    });
    expect(stage.openPageFile).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ fileId: "before", openMode: "durable" }),
    );
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  test("names one shared origin once, beneath the tree, and opens its chat", async () => {
    const stage = renderRow([report, flamegraph]);

    const caption = await screen.findByText("From");
    const chat = await screen.findByRole("button", {
      name: "Dashboard cold start on behalf of You",
    });
    expect(caption.parentElement?.contains(chat)).toBe(true);
    expect(
      screen.getAllByRole("button", { name: "Dashboard cold start on behalf of You" }),
    ).toHaveLength(1);

    await act(async () => {
      fireEvent.click(chat);
      await Promise.resolve();
    });
    expect(stage.handleOpenRelatedChat).toHaveBeenCalledWith(CHAT);
    expect(stage.openPageFile).not.toHaveBeenCalled();
  });

  test("states mixed origins on the narrowest folder or File and lists body-only Files apart", async () => {
    renderRow([
      report,
      item("brief", "brief.md", { type: "member", member_id: "member-local" }),
      item("photo", null, null, 1),
    ]);

    expect(screen.queryByText("From")).toBeNull();
    expect(screen.getByRole("treeitem", { name: "profile" }).textContent).toContain(
      "Dashboard cold start",
    );
    expect(screen.getByRole("treeitem", { name: "brief.md" }).textContent).toContain("You");
    expect(screen.getByText("In page")).toBeTruthy();
    expect(screen.getByRole("treeitem", { name: "photo.png" }).textContent).not.toContain("You");
  });

  test("folds into a summary that keeps the origin, and back", async () => {
    renderRow([report, flamegraph]);
    const summary = screen.getByRole("button", { name: /^2 files/u });

    await act(async () => {
      fireEvent.click(summary);
      await Promise.resolve();
    });
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("tree")).toBeNull();
    expect(summary.parentElement?.textContent).toContain("from");

    await act(async () => {
      fireEvent.click(summary);
      await Promise.resolve();
    });
    expect(screen.getByRole("tree", { name: "Page files" })).toBeTruthy();
  });

  test("moves through the tree with the keyboard", async () => {
    const stage = renderRow([report, flamegraph]);
    const folder = screen.getByRole("treeitem", { name: "profile" });

    await act(async () => {
      folder.focus();
      fireEvent.keyDown(folder, { key: "ArrowLeft" });
      await Promise.resolve();
    });
    expect(screen.queryByRole("treeitem", { name: "profile/report.html" })).toBeNull();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("treeitem", { name: "profile" }), { key: "ArrowRight" });
      await Promise.resolve();
    });
    const tree = screen.getByRole("tree", { name: "Page files" });
    await act(async () => {
      fireEvent.keyDown(tree, { key: "ArrowDown" });
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(
      screen.getByRole("treeitem", { name: "profile/flamegraph.png" }),
    );
    await act(async () => {
      fireEvent.keyDown(tree, { key: "Enter" });
      await Promise.resolve();
    });
    expect(stage.openPageFile).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: "flamegraph", openMode: "preview" }),
    );
  });

  test("opens the manager on a File when the Page has no tab group", async () => {
    renderRow([report], controller({ openPageFile: undefined }));

    await act(async () => {
      fireEvent.click(screen.getByRole("treeitem", { name: "profile/report.html" }));
      await Promise.resolve();
    });
    expect(modal.openModal.mock.calls[0]?.[2]).toMatchObject({
      pageId: "page-1",
      initialFileId: "report",
    });
  });
});

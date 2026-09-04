import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { PageFilesReadModel } from "@/lib/use-page-files";
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

import { PageFilesRow } from "./page-files-row";

const controller = {
  page: { id: "page-1", title: "Files" },
  contentAccessContext: { kind: "project", projectId: "project-1" },
  storeEpoch: "epoch-1",
} as PageStageController;

const file = {
  file_id: "file-1",
  library_id: "library-1",
  default_name: "source.png",
  head_version: 4,
  revision: 6,
  lifecycle: "live" as const,
  mime_type: "image/png",
  byte_length: 12,
  blob_etag: "a".repeat(64),
  created_by_actor_id: "actor-1",
  created_by_turn_id: null,
  created_at: "2026-09-04T00:00:00.000Z",
  updated_at: "2026-09-04T00:00:00.000Z",
};

const model = (logicalPath: string | null, bodyCount: number): PageFilesReadModel => ({
  inventory: {
    page_id: "page-1",
    revision: 8,
    body_usage_revision: 3,
    can_write: true,
    files: [{ file, logical_path: logicalPath, body_count: bodyCount }],
    next_cursor: null,
    has_more: false,
    total: 1,
    unplaced_total: bodyCount === 0 ? 1 : 0,
    placed_total: bodyCount > 0 ? 1 : 0,
  },
  loading: false,
  loadingMore: false,
  hasMore: false,
  error: null,
  loadMore: vi.fn(),
  refresh: vi.fn(),
});

describe("PageFilesRow", () => {
  beforeEach(() => modal.openModal.mockReset());

  test("shows an explicit Page path that is otherwise absent from the body", () => {
    render(<PageFilesRow baseFiles={model("assets/hero.png", 0)} controller={controller} />);

    const chip = screen.getByRole("button", { name: /assets\/hero\.png/i });
    fireEvent.click(chip);

    expect(modal.openModal).toHaveBeenCalledOnce();
    expect(modal.openModal.mock.calls[0]?.[2]).toMatchObject({
      accessContext: controller.contentAccessContext,
      pageId: "page-1",
      initialFileId: "file-1",
    });
  });

  test("summarizes a body-only File without inventing a Page path or duplicate chip", () => {
    render(<PageFilesRow baseFiles={model(null, 1)} controller={controller} />);

    expect(screen.queryByRole("button", { name: /source\.png/i })).toBeNull();
    const summary = screen.getByRole("button", { name: "Open 1 File shown in Page" });
    expect(summary.textContent).toBe("1 in page");
    fireEvent.click(summary);

    expect(screen.queryByText("assets/hero.png")).toBeNull();
    expect(modal.openModal.mock.calls[0]?.[2]).toMatchObject({
      accessContext: controller.contentAccessContext,
      pageId: "page-1",
    });
    expect(modal.openModal.mock.calls[0]?.[2]).not.toHaveProperty("initialFileId");
  });
});

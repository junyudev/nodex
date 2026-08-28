import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { TestQueryProvider } from "@/test/query";
import { usePageFiles } from "@/lib/use-page-files";
import type { PageStageController } from "./use-page-stage-controller";

const api = vi.hoisted(() => ({
  applyLibraryModule: vi.fn(),
  pickAndPreparePageFiles: vi.fn(),
  prepareDroppedPageFiles: vi.fn(),
  preparePageFile: vi.fn(),
  readLibraryModule: vi.fn(),
  readPageFileBytes: vi.fn(),
  savePageFile: vi.fn(),
}));
const toastApi = vi.hoisted(() => ({
  danger: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/ui/toast", () => ({ toast: toastApi }));

import { PageFilesRow } from "./page-files-row";

const emptyManifest = {
  pageId: "page-1",
  revision: 0,
  bodyUsageRevision: 0,
  files: [],
  nextCursor: null,
  hasMore: false,
  total: 0,
  liveTotal: 0,
  unplacedTotal: 0,
  placedTotal: 0,
  deletedTotal: 0,
} as const;

const pageFile = (
  fileId: string,
  logicalPath: string,
  bodyUsage:
    | { readonly kind: "not_in_body" }
    | { readonly kind: "placed"; readonly placementCount: number },
) => ({
  fileId,
  ownerPageId: "page-1",
  logicalPath,
  mimeType: logicalPath.endsWith(".png") ? "image/png" : "text/plain",
  byteLength: 12,
  version: 1,
  blobEtag: `etag-${fileId}`,
  state: "live" as const,
  createdByActorId: "actor-1",
  createdByTurnId: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  bodyUsage,
});

const controller = {
  page: {
    id: "page-1",
    title: "Drop target",
  },
  contentAccessContext: { kind: "project", projectId: "project-1" },
  storeEpoch: "store-1",
} as PageStageController;

function PageFilesRowHarness() {
  const baseFiles = usePageFiles(controller.contentAccessContext, controller.page?.id ?? "", {
    subscribe: true,
  });
  return <PageFilesRow baseFiles={baseFiles} controller={controller} />;
}

const renderPageFilesRow = () => render(<PageFilesRowHarness />, { wrapper: TestQueryProvider });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const fileTransfer = (files: readonly File[], directory = false): DataTransfer =>
  ({
    types: ["Files"],
    files,
    items: files.map((file) => ({
      kind: "file",
      type: file.type,
      getAsFile: () => file,
      webkitGetAsEntry: () => ({ isDirectory: directory }),
    })),
    dropEffect: "none",
  }) as unknown as DataTransfer;

describe("PageFilesRow native file drop", () => {
  beforeEach(() => {
    api.applyLibraryModule.mockReset();
    api.pickAndPreparePageFiles.mockReset();
    api.prepareDroppedPageFiles.mockReset();
    api.preparePageFile.mockReset();
    api.readPageFileBytes.mockReset();
    api.savePageFile.mockReset();
    api.readLibraryModule.mockReset();
    toastApi.danger.mockReset();
    toastApi.success.mockReset();
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: { value: { kind: "page_files", value: emptyManifest } },
    });
  });

  test("keeps the indicator stable across child boundaries and commits dropped files as one batch", async () => {
    api.prepareDroppedPageFiles.mockResolvedValue([
      {
        logicalPath: "brief.md",
        mimeType: "text/markdown",
        receiptId: "receipt-1",
        byteLength: 5,
      },
      {
        logicalPath: "data.json",
        mimeType: "application/json",
        receiptId: "receipt-2",
        byteLength: 2,
      },
    ]);
    api.applyLibraryModule.mockResolvedValue({ ok: true });

    const view = renderPageFilesRow();
    const openFiles = await view.findByRole("button", { name: "Add Page Files" });
    await act(async () => {
      fireEvent.click(openFiles);
      await Promise.resolve();
    });

    const dialog = view.getByRole("dialog", { name: "Files" });
    const surface = dialog.querySelector<HTMLElement>("[data-page-files-drop-surface]");
    const emptyZone = view.getByRole("button", { name: /Drop files or folders here/u });
    if (!surface) throw new Error("Files drop surface is unavailable");

    const transfer = fileTransfer([
      new File(["brief"], "brief.md", { type: "text/markdown" }),
      new File(["{}"], "data.json", { type: "application/json" }),
    ]);

    await act(async () => {
      fireEvent.dragEnter(surface, { dataTransfer: transfer });
      fireEvent.dragEnter(emptyZone, { dataTransfer: transfer });
      fireEvent.dragLeave(emptyZone, { dataTransfer: transfer });
      await Promise.resolve();
    });
    expect(view.getByRole("status", { name: /Drop files and folders to add/u })).toBeTruthy();

    await act(async () => {
      fireEvent.dragOver(emptyZone, { dataTransfer: transfer });
      fireEvent.drop(emptyZone, { dataTransfer: transfer });
      await Promise.resolve();
    });
    expect(transfer.dropEffect).toBe("copy");
    expect(view.queryByRole("status", { name: /Drop files and folders to add/u })).toBeNull();

    await waitFor(() => expect(api.applyLibraryModule).toHaveBeenCalledTimes(1));
    expect(api.prepareDroppedPageFiles).toHaveBeenCalledTimes(1);
    const prepare = api.prepareDroppedPageFiles.mock.calls[0];
    const apply = api.applyLibraryModule.mock.calls[0]?.[1];
    expect(prepare?.[0]).toEqual(controller.contentAccessContext);
    expect(prepare?.[2]).toEqual(Array.from(transfer.files));
    expect(apply?.operationId).toBe(prepare?.[1]);
    expect(apply?.operation).toMatchObject({
      kind: "apply_page_file_changes",
      pageId: "page-1",
      expectedManifestRevision: 0,
      changes: [
        {
          kind: "create",
          logicalPath: "brief.md",
          mimeType: "text/markdown",
          preparedBlobReceiptId: "receipt-1",
        },
        {
          kind: "create",
          logicalPath: "data.json",
          mimeType: "application/json",
          preparedBlobReceiptId: "receipt-2",
        },
      ],
    });
  });

  test("commits a dropped directory with its expanded logical paths", async () => {
    api.prepareDroppedPageFiles.mockResolvedValue([
      {
        logicalPath: "references/api.md",
        mimeType: "text/markdown",
        receiptId: "receipt-directory-1",
        byteLength: 3,
      },
      {
        logicalPath: "references/nested/schema.json",
        mimeType: "application/json",
        receiptId: "receipt-directory-2",
        byteLength: 2,
      },
    ]);
    api.applyLibraryModule.mockResolvedValue({ ok: true });
    const view = renderPageFilesRow();
    const openFiles = await view.findByRole("button", { name: "Add Page Files" });
    await act(async () => {
      fireEvent.click(openFiles);
      await Promise.resolve();
    });

    const dialog = view.getByRole("dialog", { name: "Files" });
    const surface = dialog.querySelector<HTMLElement>("[data-page-files-drop-surface]");
    if (!surface) throw new Error("Files drop surface is unavailable");
    const transfer = fileTransfer([new File([], "references")], true);

    await act(async () => {
      fireEvent.dragEnter(surface, { dataTransfer: transfer });
      fireEvent.drop(surface, { dataTransfer: transfer });
      await Promise.resolve();
    });

    await waitFor(() => expect(api.applyLibraryModule).toHaveBeenCalledTimes(1));
    expect(api.prepareDroppedPageFiles).toHaveBeenCalledWith(
      controller.contentAccessContext,
      expect.any(String),
      Array.from(transfer.files),
    );
    expect(api.applyLibraryModule.mock.calls[0]?.[1]?.operation).toMatchObject({
      kind: "apply_page_file_changes",
      changes: [
        {
          kind: "create",
          logicalPath: "references/api.md",
          preparedBlobReceiptId: "receipt-directory-1",
        },
        {
          kind: "create",
          logicalPath: "references/nested/schema.json",
          preparedBlobReceiptId: "receipt-directory-2",
        },
      ],
    });
    expect(toastApi.danger).not.toHaveBeenCalled();
  });

  test("summarizes fully placed Files and opens their expanded inventory", async () => {
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        value: {
          kind: "page_files",
          value: {
            ...emptyManifest,
            files: [
              pageFile("file-image", "images/diagram.png", {
                kind: "placed",
                placementCount: 2,
              }),
            ],
            total: 1,
            liveTotal: 1,
            placedTotal: 1,
          },
        },
      },
    });

    const view = renderPageFilesRow();
    const summary = await view.findByRole("button", {
      name: "Open 1 File shown in Page",
    });
    expect(view.queryByText("Empty", { exact: true })).toBeNull();
    expect(view.container.querySelector('[data-page-file-chip="true"]')).toBeNull();
    expect(summary.textContent).toBe("1 in page");

    await act(async () => {
      fireEvent.click(summary);
      await Promise.resolve();
    });

    const disclosure = view.getByRole("button", { name: "In page · 1" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(view.getByText("images/diagram.png", { exact: true })).toBeTruthy();
    expect(view.getByText("2 placements", { exact: true })).toBeTruthy();
    const renameAction = view.getByRole("button", { name: "Rename images/diagram.png" });
    expect(renameAction.textContent).toBe("");

    await act(async () => {
      fireEvent.pointerMove(renameAction, { pointerType: "mouse" });
      fireEvent.mouseEnter(renameAction);
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("tooltip").textContent).toBe("Rename"));
  });

  test("ignores an older preview response after a later File is selected", async () => {
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        value: {
          kind: "page_files",
          value: {
            ...emptyManifest,
            files: [
              pageFile("file-a", "a.txt", { kind: "not_in_body" }),
              pageFile("file-b", "b.txt", { kind: "not_in_body" }),
            ],
            total: 2,
            liveTotal: 2,
            unplacedTotal: 2,
          },
        },
      },
    });
    const first = deferred<{ bytes: Uint8Array; mimeType: string; etag: string }>();
    const second = deferred<{ bytes: Uint8Array; mimeType: string; etag: string }>();
    api.readPageFileBytes.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const view = renderPageFilesRow();
    const firstFile = await view.findByRole("button", { name: "Open a.txt" });
    const secondFile = await view.findByRole("button", { name: "Open b.txt" });
    await act(async () => {
      fireEvent.click(firstFile);
      fireEvent.click(secondFile);
      second.resolve({
        bytes: new TextEncoder().encode("second preview"),
        mimeType: "text/plain",
        etag: "etag-b",
      });
      await second.promise;
    });
    expect((view.getByRole("textbox", { name: "Edit b.txt" }) as HTMLTextAreaElement).value).toBe(
      "second preview",
    );

    await act(async () => {
      first.resolve({
        bytes: new TextEncoder().encode("stale preview"),
        mimeType: "text/plain",
        etag: "etag-a",
      });
      await first.promise;
    });
    expect((view.getByRole("textbox", { name: "Edit b.txt" }) as HTMLTextAreaElement).value).toBe(
      "second preview",
    );
    expect(view.queryByDisplayValue("stale preview")).toBeNull();
  });

  test("keeps placed Files collapsed by default and searches across the full inventory", async () => {
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        value: {
          kind: "page_files",
          value: {
            ...emptyManifest,
            files: [
              pageFile("file-a", "a.txt", { kind: "not_in_body" }),
              pageFile("file-b", "b.txt", { kind: "not_in_body" }),
              pageFile("file-c", "c.txt", { kind: "not_in_body" }),
              pageFile("file-image", "images/diagram.png", {
                kind: "placed",
                placementCount: 1,
              }),
            ],
            total: 4,
            liveTotal: 4,
            unplacedTotal: 3,
            placedTotal: 1,
          },
        },
      },
    });

    const view = renderPageFilesRow();
    const more = await view.findByRole("button", { name: "Open 2 more Page Files" });
    expect(more.textContent).toBe("+2");

    await act(async () => {
      fireEvent.click(more);
      await Promise.resolve();
    });
    expect(view.getByRole("button", { name: "In page · 1" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(view.queryByText("images/diagram.png", { exact: true })).toBeNull();

    await act(async () => {
      fireEvent.change(view.getByRole("textbox", { name: "Filter Page Files" }), {
        target: { value: "diagram" },
      });
      await Promise.resolve();
    });
    expect(
      (await view.findByRole("button", { name: "In page · 1" })).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(await view.findByText("images/diagram.png", { exact: true })).toBeTruthy();
  });
});

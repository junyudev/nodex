import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, expect, test, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  file: {
    file_id: "target",
    library_id: "library",
    default_name: "current.png",
    head_version: 2,
    revision: 3,
    lifecycle: "live" as const,
    mime_type: "image/png",
    byte_length: 10,
    blob_etag: "a".repeat(64),
    created_by_actor_id: "actor",
    created_by_turn_id: null,
    created_at: "2026-09-05T00:00:00Z",
    updated_at: "2026-09-05T00:00:00Z",
  },
  denied: false,
  pageWrite: false,
  fork: vi.fn(),
  rename: vi.fn(),
  attach: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock("@/lib/maitai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/maitai")>()),
  useScopeHandle: () => ({}),
}));
vi.mock("@/lib/modal-registry", () => ({ openModal: vi.fn() }));
vi.mock("./library-resource-action-modals", () => ({ LibraryResourceAccessModal: () => null }));
vi.mock("@/lib/file-location-navigation", () => ({ useFileLocationNavigator: () => mocks.open }));
vi.mock("@/lib/use-library-navigation", () => ({
  useLibraryMetadata: () => ({ data: { libraryId: "library", storeEpoch: "epoch" } }),
}));
vi.mock("@/lib/use-library-files", () => ({
  usePageFile: () => ({
    item: { file: mocks.file, logical_path: "images/current.png", body_count: 1 },
    refresh: mocks.refresh,
  }),
  usePageFiles: () => ({
    inventory: { page_id: "page-a", can_write: mocks.pageWrite, revision: 7, files: [] },
    refresh: mocks.refresh,
  }),
  useLibraryFile: (_access: unknown, id: string) => ({
    file: mocks.denied ? null : { ...mocks.file, file_id: id },
    loading: false,
    error: mocks.denied ? new Error("Direct access required") : null,
  }),
  useLibraryFileCatalog: () => ({
    files: [{ ...mocks.file, file_id: "other", default_name: "other.txt" }],
    loading: false,
    hasMore: false,
    refresh: mocks.refresh,
  }),
  useLibraryFileDetail: () => ({
    usages: [
      {
        target: { kind: "page", page_id: "page-a" },
        title: "Release notes",
        lifecycle: "active",
        occurrence_count: 1,
      },
    ],
    versions: [2, 1].map((version) => ({
      version,
      byte_length: 10,
      occurred_at: "2026-09-05T00:00:00Z",
    })),
    canWrite: true,
    canTrash: false,
    loading: false,
    hasMoreUsages: true,
  }),
}));
vi.mock("@/lib/library-file-commands", () => ({
  forkFile: mocks.fork,
  renameFile: mocks.rename,
  attachPageEntry: mocks.attach,
  LibraryFileCommandError: class extends Error {},
}));
vi.mock("@/components/board/editor/file-runtime", () => ({
  FileReadBoundary: ({ children }: { children: React.ReactNode }) => children,
  useFilePlacementRuntime: () => ({}),
  useFileReadSnapshot: (...args: unknown[]) => mocks.snapshot(...args),
}));

import { LibraryFilesDialog, ManagedFilePreview } from "./library-files-dialog";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.denied = false;
  mocks.rename.mockResolvedValue(mocks.file);
  mocks.fork.mockResolvedValue({ ...mocks.file, file_id: "copy" });
  mocks.open.mockResolvedValue(true);
  mocks.attach.mockResolvedValue({ manifest_revision: 8 });
  mocks.refresh.mockResolvedValue(undefined);
  mocks.snapshot.mockReturnValue({
    metadata: {
      ...mocks.file,
      version: 1,
      mime_type: "text/plain",
      default_name: "historical.txt",
    },
    bytes: { bytes: new TextEncoder().encode("historical content") },
  });
});

function mount(props: Partial<React.ComponentProps<typeof LibraryFilesDialog>> = {}) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <LibraryFilesDialog initialFileId="target" onClose={vi.fn()} {...props} />
    </QueryClientProvider>,
  );
}

test("keeps a requested identity even when it is outside the loaded catalog", () => {
  mount();
  expect(screen.getByRole("button", { name: "current.png" })).toBeTruthy();
  expect(screen.getByRole("button", { name: /other.txt/ })).toBeTruthy();
});

test("does not substitute another File for a denied requested identity", () => {
  mocks.denied = true;
  mount();
  expect(screen.getByText(/requires direct File access/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Copy v/ })).toBeNull();
});

test("copies the version selected in the history panel", async () => {
  mount();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /v1 ·/ }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy v1 as independent File" }));
  });
  await waitFor(() =>
    expect(mocks.fork).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ file_id: "target", version: 1 }),
    ),
  );
});

test("selects preview format from exact presentation rather than current File MIME", () => {
  render(<ManagedFilePreview file={mocks.file} />);
  expect(screen.getByText("historical content")).toBeTruthy();
  expect(mocks.snapshot.mock.calls.at(-1)?.[2]).toMatchObject({ content: true, objectUrl: false });
});

test("picker asks for the Page path and hides global mutations", async () => {
  mount({ pageTarget: { pageId: "page-a", manifestRevision: 7 } });
  expect(screen.queryByRole("button", { name: /Update shared/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /Copy v/ })).toBeNull();
  await act(async () => {
    fireEvent.change(screen.getByRole("textbox", { name: "Path in Page" }), {
      target: { value: "images/local.png" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Add to Page" }));
  });
  expect(mocks.attach).toHaveBeenCalledWith(
    expect.anything(),
    "page-a",
    7,
    "target",
    "images/local.png",
    { kind: "direct" },
  );
});

test("opens an authorized titled usage through the Workbench", async () => {
  const close = vi.fn();
  mount({ onClose: close });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Release notes" }));
  });
  expect(mocks.open).toHaveBeenCalledWith({ kind: "page", pageId: "page-a" });
  expect(close).toHaveBeenCalledOnce();
  expect(screen.getByText(/more are available/)).toBeTruthy();
});

test("read-only Page permits saving but exposes no path mutation", async () => {
  const { PageFilesDialog } = await import("../board/page-stage/page-files-row");
  render(
    <PageFilesDialog
      accessContext={{ kind: "project", projectId: "p" }}
      pageId="page-a"
      initialFileId="target"
      onChanged={mocks.refresh}
      onClose={vi.fn()}
    />,
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  expect((screen.getByRole("button", { name: "Add files" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(
    (screen.getByRole("button", { name: "images/current.png" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByRole("button", { name: "Remove Page path" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Replace path entry…" })).toBeNull();
});

test("renaming closes the draft only after a successful command", async () => {
  mount();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "current.png" }));
  });
  const input = screen.getByDisplayValue("current.png");
  await act(async () => {
    fireEvent.change(input, { target: { value: "renamed.png" } });
  });
  await act(async () => {
    fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
  });
  expect(mocks.rename).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ file_id: "target", revision: 3 }),
    "renamed.png",
  );
  expect(screen.queryByDisplayValue("renamed.png")).toBeNull();
});

test("large text keeps its bytes lazy and explains how to read it", () => {
  mocks.snapshot.mockReturnValue({
    metadata: { ...mocks.file, mime_type: "text/plain", byte_length: 3 * 1024 * 1024 },
  });
  render(<ManagedFilePreview file={mocks.file} />);
  expect(mocks.snapshot.mock.calls.at(-1)?.[2]).toMatchObject({ content: false, objectUrl: false });
  expect(screen.getByText(/Text preview is limited/)).toBeTruthy();
});

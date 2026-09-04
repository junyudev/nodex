import { beforeEach, describe, expect, test, vi } from "vite-plus/test";

const api = vi.hoisted(() => ({
  applyLibraryModule: vi.fn(),
  prepareFileBlob: vi.fn(),
}));
const resources = vi.hoisted(() => ({ prepareBrowserFiles: vi.fn() }));
vi.mock("./api", () => api);
vi.mock("./library-file-resources", () => resources);

import {
  LibraryFileCommandError,
  removePageEntry,
  replaceFileContent,
  replacePageEntry,
} from "./library-file-commands";

const authority = {
  contentAccessContext: { kind: "project", projectId: "project-1" },
  storeEpoch: "epoch-1",
} as const;

beforeEach(() => {
  vi.resetAllMocks();
  resources.prepareBrowserFiles.mockResolvedValue([
    {
      logicalPath: "replacement.png",
      mimeType: "image/png",
      receiptId: "prepared-1",
    },
  ]);
});

describe("Library File commands", () => {
  test("local replacement creates a new File and retargets only the Page entry", async () => {
    api.applyLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        pageFileEntries: [
          {
            page_id: "page-1",
            manifest_revision: 9,
            changed_file_ids: ["file-old", "file-new"],
            created_file_ids: ["file-new"],
            consumed_blob_receipt_ids: ["prepared-1"],
            replacements: { "file-old": "file-new" },
          },
        ],
      },
    });

    const receipt = await replacePageEntry(
      authority,
      "page-1",
      8,
      "file-old",
      new File(["image"], "replacement.png", { type: "image/png" }),
    );

    expect(receipt.replacements["file-old"]).toBe("file-new");
    const request = api.applyLibraryModule.mock.calls[0]?.[1];
    expect(request.storeEpoch).toBe("epoch-1");
    expect(request.operation).toMatchObject({
      kind: "apply_page_file_entries",
      page_id: "page-1",
      expected_manifest_revision: 8,
      changes: [
        {
          kind: "replace",
          file_id: "file-old",
          mime_type: "image/png",
          prepared_blob_receipt_id: "prepared-1",
        },
      ],
    });
    expect(request.operation.changes[0].replacement_file_id).not.toBe("file-old");
    expect(request.operation.changes[0].kind).not.toBe("replace_content");
  });

  test("removing a Page path uses the observed manifest fence and does not mutate the File", async () => {
    api.applyLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        pageFileEntries: [
          {
            page_id: "page-1",
            manifest_revision: 13,
            changed_file_ids: ["file-1"],
            created_file_ids: [],
            consumed_blob_receipt_ids: [],
            replacements: {},
          },
        ],
      },
    });

    await removePageEntry(authority, "page-1", 12, "file-1");

    expect(api.applyLibraryModule).toHaveBeenCalledWith(authority.contentAccessContext, {
      operationId: expect.any(String),
      storeEpoch: "epoch-1",
      operation: {
        kind: "apply_page_file_entries",
        page_id: "page-1",
        expected_manifest_revision: 12,
        changes: [{ kind: "remove", file_id: "file-1" }],
      },
    });
  });

  test("global replacement carries both immutable fences and never retries a conflict", async () => {
    api.applyLibraryModule.mockResolvedValue({
      ok: false,
      error: { code: "revision_conflict", message: "stale File" },
    });

    await expect(
      replaceFileContent(
        authority,
        { file_id: "file-1", revision: 7, head_version: 4 },
        new File(["image"], "replacement.png", { type: "image/png" }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<LibraryFileCommandError>>({
        code: "revision_conflict",
      }),
    );

    expect(api.applyLibraryModule).toHaveBeenCalledOnce();
    expect(api.applyLibraryModule.mock.calls[0]?.[1].operation).toMatchObject({
      kind: "apply_file_change",
      change: {
        kind: "replace_content",
        file_id: "file-1",
        expected_revision: 7,
        expected_head_version: 4,
      },
    });
  });
});

test("forks the explicitly selected historical version", async () => {
  api.applyLibraryModule.mockImplementation(async (_context, request) => ({
    ok: true,
    value: { fileMutation: { file: { file_id: request.operation.change.file_id } } },
  }));
  const { forkFile } = await import("./library-file-commands");
  await forkFile(authority, { file_id: "file-1", default_name: "old.txt", version: 1 });
  expect(api.applyLibraryModule.mock.calls[0]?.[1].operation.change).toMatchObject({
    kind: "fork",
    source_file_id: "file-1",
    source_version: 1,
  });
});

test("reports successful imports and each failure without silently retrying", async () => {
  api.applyLibraryModule
    .mockResolvedValueOnce({ ok: true, value: { fileMutation: { file: { file_id: "imported" } } } })
    .mockResolvedValueOnce({ ok: false, error: { code: "invalid_input", message: "Too large" } })
    .mockResolvedValueOnce({ ok: true, value: { fileMutation: { file: { file_id: "third" } } } });
  const { importFiles } = await import("./library-file-commands");
  const result = await importFiles(authority, [
    new File(["a"], "a.txt"),
    new File(["b"], "b.txt"),
    new File(["c"], "c.txt"),
  ]);
  expect(result.imported.map((file) => file.file_id)).toEqual(["imported", "third"]);
  expect(result.failures).toEqual([{ name: "b.txt", message: "Too large" }]);
  expect(api.applyLibraryModule).toHaveBeenCalledTimes(3);
});

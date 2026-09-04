import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { isUuidV7 } from "../../shared/uuid-v7";

const api = vi.hoisted(() => ({
  applyLibraryModule: vi.fn(),
  prepareFileBlob: vi.fn(),
  readLibraryModule: vi.fn(),
  readFileBytes: vi.fn(),
  saveFile: vi.fn(),
  materializeFile: vi.fn(),
}));
vi.mock("./api", () => api);

import {
  importLibraryFile,
  prepareBrowserFiles,
  readPageFileInventoryPage,
  validateBrowserFileBatch,
  readAuthorizedFile,
  readFilePresentation,
  saveAuthorizedFile,
  materializeAuthorizedFile,
} from "./library-file-resources";

const access = { kind: "project", projectId: "project-1" } as const;
beforeEach(() => vi.resetAllMocks());

describe("Library File resources", () => {
  test("body upload creates an independent File without reading or modifying a Page manifest", async () => {
    api.prepareFileBlob.mockResolvedValue({
      receiptId: "prepared",
      logicalPath: "diagram.png",
      mimeType: "image/png",
      byteLength: 7,
    });
    api.applyLibraryModule.mockImplementation(async (_access, input) => ({
      ok: true,
      value: {
        fileMutation: {
          file: {
            file_id: input.operation.change.file_id,
            default_name: "diagram.png",
            head_version: 1,
          },
        },
      },
    }));
    const created = await importLibraryFile(
      { libraryId: "library-1", contentAccessContext: access, storeEpoch: "store-1" },
      { kind: "browser_file", file: new File(["diagram"], "diagram.png", { type: "image/png" }) },
    );
    const prepare = api.prepareFileBlob.mock.calls[0]![1];
    const apply = api.applyLibraryModule.mock.calls[0]![1];
    expect(isUuidV7(prepare.operationId)).toBe(true);
    expect(apply.operationId).toBe(prepare.operationId);
    expect(isUuidV7(apply.operation.change.file_id)).toBe(true);
    expect(apply.operation).toEqual({
      kind: "apply_file_change",
      change: {
        kind: "create",
        file_id: created.file.file_id,
        default_name: "diagram.png",
        mime_type: "image/png",
        prepared_blob_receipt_id: "prepared",
      },
    });
    expect(created.source).toBe(`nodex://files/${created.file.file_id}`);
    expect(api.readLibraryModule).not.toHaveBeenCalled();
  });

  test("rejects oversized browser batches before publication and uses distinct slots", async () => {
    const oversized = { name: "oversized.bin", size: 64 * 1024 * 1024 + 1 } as File;
    expect(() => validateBrowserFileBatch([oversized])).toThrow("64 MiB");
    await expect(prepareBrowserFiles(access, "operation", [oversized])).rejects.toThrow("64 MiB");
    expect(api.prepareFileBlob).not.toHaveBeenCalled();
    api.prepareFileBlob
      .mockResolvedValueOnce({ receiptId: "a" })
      .mockResolvedValueOnce({ receiptId: "b" });
    const files = [new File(["same"], "same.txt"), new File(["same"], "same.txt")];
    expect(
      (await prepareBrowserFiles(access, "operation", files)).map((file) => file.receiptId),
    ).toEqual(["a", "b"]);
    expect(api.prepareFileBlob.mock.calls.map((call) => call[1].idempotencySlot)).toEqual([
      "selection:0",
      "selection:1",
    ]);
  });

  test("preserves exact history authority for metadata, bytes, and saving", async () => {
    const readSource = {
      kind: "document_revision",
      document_id: "doc",
      revision_id: "revision",
    } as const;
    const authority = {
      libraryId: "library-1",
      contentAccessContext: access,
      storeEpoch: "epoch",
      readSource,
    };
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        value: {
          kind: "file_presentation",
          value: { file_id: "file", version: 1, default_name: "old.png" },
        },
      },
    });
    await readAuthorizedFile(authority, "nodex://files/file");
    expect(await readFilePresentation(authority, "nodex://files/file")).toMatchObject({
      version: 1,
      default_name: "old.png",
    });
    await saveAuthorizedFile(authority, "nodex://files/file", "old.png");
    await materializeAuthorizedFile(authority, "nodex://files/file");
    expect(api.readFileBytes).toHaveBeenCalledWith(access, { fileId: "file", source: readSource });
    expect(api.readLibraryModule).toHaveBeenCalledWith(access, {
      read: { mode: "file_presentation", file_id: "file", source: readSource },
    });
    expect(api.saveFile).toHaveBeenCalledWith(access, {
      fileId: "file",
      source: readSource,
      defaultName: "old.png",
    });
    expect(api.materializeFile).toHaveBeenCalledWith(access, {
      fileId: "file",
      source: readSource,
      version: 1,
      defaultName: "old.png",
    });
  });

  test("reads one bounded inventory without hydrating subsequent cursors", async () => {
    api.readLibraryModule.mockResolvedValue({
      ok: true,
      value: {
        value: {
          kind: "page_file_inventory",
          value: { page_id: "page", revision: 3, files: [], next_cursor: "next", has_more: true },
        },
      },
    });
    const page = await readPageFileInventoryPage(access, "page");
    expect(page.has_more).toBe(true);
    expect(api.readLibraryModule).toHaveBeenCalledOnce();
  });
});

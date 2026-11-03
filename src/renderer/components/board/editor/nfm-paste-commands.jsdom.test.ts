import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { toast } from "@/components/ui/toast";
import type { NfmEditorOwner } from "./nfm-editor-owner";
import type { PasteResourceDialogState, PasteResourceTarget } from "./paste-resource";
import { pasteNfmImages, pasteNfmResourceAttachments } from "./nfm-paste-commands";

vi.mock("@/components/ui/toast", () => ({ toast: { danger: vi.fn() } }));
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commandFixture() {
  const insertInlineContent = vi.fn();
  const replaceBlocks = vi.fn();
  const insertBlocks = vi.fn();
  const editor = {
    insertInlineContent,
    replaceBlocks,
    insertBlocks,
  } as unknown as NfmEditorOwner["editor"];
  const handleBlockPaste = vi.fn(() => true);
  const session = { handleBlockPaste } as unknown as NonNullable<
    ReturnType<NfmEditorOwner["getActiveStructuralSession"]>
  >;
  const owner = {
    editor,
    getActiveStructuralSession: vi.fn<NfmEditorOwner["getActiveStructuralSession"]>(() => session),
  };
  const selection = { restore: vi.fn(() => true), release: vi.fn() };
  const target: PasteResourceTarget = {
    selection,
    selectedBlockIds: [],
    currentBlockId: "original-position",
    canInsertInline: true,
    replaceCurrentEmptyParagraph: false,
  };
  const dialog: PasteResourceDialogState = {
    target,
    items: [{ kind: "file", name: "report.txt", path: "/tmp/report.txt", bytes: 12 }],
    allowLink: true,
  };
  const setPending = vi.fn();
  const setError = vi.fn();
  const closeDialog = vi.fn();
  return {
    owner,
    dialog,
    target,
    selection,
    handleBlockPaste,
    insertInlineContent,
    replaceBlocks,
    insertBlocks,
    setPending,
    setError,
    closeDialog,
  };
}

describe("editor paste commands", () => {
  test("keeps the captured paste pending through upload, then restores before inserting and closing", async () => {
    const fixture = commandFixture();
    const uploaded = deferred<string>();
    const upload = vi.fn(() => uploaded.promise);
    const pending = pasteNfmResourceAttachments({
      ...fixture,
      fileRuntime: { upload },
      mode: "materialized",
    });
    expect(upload).toHaveBeenCalledExactlyOnceWith(
      { kind: "local_path", path: "/tmp/report.txt" },
      "report.txt",
    );
    expect(fixture.setPending.mock.calls).toEqual([[true]]);
    expect(fixture.selection.restore).not.toHaveBeenCalled();
    expect(fixture.closeDialog).not.toHaveBeenCalled();

    uploaded.resolve("file:uploaded-report");
    await pending;
    expect(fixture.insertInlineContent).toHaveBeenCalledWith(
      [
        {
          type: "attachment",
          props: {
            kind: "file",
            mode: "materialized",
            source: "file:uploaded-report",
            name: "report.txt",
            mimeType: "application/octet-stream",
            bytes: 12,
            origin: "/tmp/report.txt",
          },
        },
      ],
      { updateSelection: true },
    );
    expect(fixture.selection.restore.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.insertInlineContent.mock.invocationCallOrder[0]!,
    );
    expect(fixture.insertInlineContent.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.closeDialog.mock.invocationCallOrder[0]!,
    );
    expect(fixture.setPending.mock.calls).toEqual([[true], [false]]);
    expect(fixture.selection.release).not.toHaveBeenCalled();
  });

  test("refuses an expired paste position without editing or closing its retry dialog", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = commandFixture();
    fixture.selection.restore.mockReturnValue(false);
    await pasteNfmResourceAttachments({ ...fixture, fileRuntime: null, mode: "link" });
    expect(fixture.setError).toHaveBeenLastCalledWith(
      "The original paste position is no longer available.",
    );
    expect(fixture.setPending.mock.calls).toEqual([[true], [false]]);
    expect(fixture.insertInlineContent).not.toHaveBeenCalled();
    expect(fixture.closeDialog).not.toHaveBeenCalled();
    expect(fixture.selection.release).not.toHaveBeenCalled();
  });

  test("resolves the active structural session after upload and never locally replaces typed owners", async () => {
    const fixture = commandFixture();
    fixture.target.selectedBlockTypes = ["page"];
    const uploaded = deferred<string>();
    const pending = pasteNfmResourceAttachments({
      ...fixture,
      fileRuntime: { upload: () => uploaded.promise },
      mode: "materialized",
    });
    expect(fixture.owner.getActiveStructuralSession).not.toHaveBeenCalled();
    fixture.owner.getActiveStructuralSession.mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    uploaded.resolve("file:uploaded-report");
    await pending;
    expect(fixture.owner.getActiveStructuralSession).toHaveBeenCalledTimes(1);
    expect(fixture.handleBlockPaste).not.toHaveBeenCalled();
    expect(fixture.replaceBlocks).not.toHaveBeenCalled();
    expect(fixture.insertInlineContent).not.toHaveBeenCalled();
    expect(fixture.setError).toHaveBeenLastCalledWith(
      "Could not insert the attachment at the current cursor position.",
    );
    expect(fixture.setPending).toHaveBeenLastCalledWith(false);
  });

  test("releases an image paste lease after upload rejection without restoring or editing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fixture = commandFixture();
    const failure = new Error("Image upload failed");
    await pasteNfmImages({
      ...fixture,
      files: [new File(["image"], "photo.png", { type: "image/png" })],
      uploadFile: async () => {
        throw failure;
      },
    });
    expect(fixture.selection.restore).not.toHaveBeenCalled();
    expect(fixture.selection.release).toHaveBeenCalledTimes(1);
    expect(fixture.insertBlocks).not.toHaveBeenCalled();
    expect(toast.danger).toHaveBeenCalledWith("Image upload failed");
  });
});

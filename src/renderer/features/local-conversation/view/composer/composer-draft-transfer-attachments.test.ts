import { describe, expect, test, vi } from "vite-plus/test";
import {
  createComposerDraftTransfer,
  type ComposerPastedTextAttachment,
} from "./composer-draft-state";
import {
  prepareComposerDraftTransferAttachments,
  type ComposerDraftPastedTextPort,
} from "./composer-draft-transfer-attachments";

function fixture() {
  const contents = new Map([["/source/notes.txt", "Exact source text\n原文"]]);
  let nextId = 0;
  const port = {
    read: vi.fn<ComposerDraftPastedTextPort["read"]>(async ({ file }) => {
      const text = contents.get(file.path);
      if (text === undefined) throw new Error("Source is unavailable");
      return text;
    }),
    create: vi.fn<ComposerDraftPastedTextPort["create"]>(async ({ text, hostId }) => {
      const path = `/copies/${++nextId}/notes.txt`;
      contents.set(path, text);
      return {
        file: { path, fsPath: path, label: "Pasted text", hostId },
        preview: "new preview",
        characterCount: text.length,
      };
    }),
    remove: vi.fn<ComposerDraftPastedTextPort["remove"]>(async ({ file }) => {
      contents.delete(file.path);
    }),
  };
  const pasted: ComposerPastedTextAttachment = {
    id: "pasted",
    status: "ready",
    preview: "Original preview",
    characterCount: 20,
    attachment: {
      file: { path: "/source/notes.txt", fsPath: "/source/notes.txt", label: "Original label" },
      preview: "Original preview",
      characterCount: 20,
    },
  };
  const transfer = createComposerDraftTransfer("target", {
    prompt: "Continue",
    fileAttachments: [],
    addedFiles: [],
    imageAttachments: [],
    appshotContexts: [],
    pastedTextAttachments: [pasted],
    commentAttachments: [],
    goalModeActive: false,
  });
  return { contents, port, pasted, transfer };
}

describe("independent pasted text in draft transfers", () => {
  test.each(["source", "destination"] as const)(
    "removing the %s file cannot invalidate the other draft",
    async (removed) => {
      const { contents, port, pasted, transfer } = fixture();
      const prepared = await prepareComposerDraftTransferAttachments(transfer, port, "local");
      const copied = prepared.transfer.pastedTextAttachments[0];
      if (pasted.status !== "ready" || copied?.status !== "ready")
        throw new Error("Expected ready pasted text");
      expect(copied).toEqual({
        ...pasted,
        attachment: {
          ...pasted.attachment,
          file: expect.objectContaining({ path: "/copies/1/notes.txt" }),
        },
      });
      expect(port.create).toHaveBeenCalledWith({
        text: "Exact source text\n原文",
        hostId: "local",
      });
      const files = { source: pasted.attachment.file, destination: copied.attachment.file };
      await port.remove({ file: files[removed] });
      expect(
        await port.read({ file: files[removed === "source" ? "destination" : "source"] }),
      ).toBe("Exact source text\n原文");
      expect(transfer.pastedTextAttachments).toEqual([pasted]);
      expect(contents.size).toBe(1);
    },
  );

  test("copies on the captured attachment's host and retains its exact preview metadata", async () => {
    const { port, transfer, pasted } = fixture();
    if (pasted.status !== "ready") throw new Error("Expected ready source");
    const remote = {
      ...transfer,
      pastedTextAttachments: [
        { ...pasted, attachment: { ...pasted.attachment, hostId: "remote-host" } },
      ],
    };
    const prepared = await prepareComposerDraftTransferAttachments(remote, port, "local");
    expect(port.read).toHaveBeenCalledWith({
      file: { ...pasted.attachment.file, hostId: "remote-host" },
    });
    expect(port.create).toHaveBeenCalledWith({
      text: "Exact source text\n原文",
      hostId: "remote-host",
    });
    expect(prepared.transfer.pastedTextAttachments[0]).toMatchObject({
      ...pasted,
      attachment: {
        hostId: "remote-host",
        file: {
          path: "/copies/1/notes.txt",
          fsPath: "/copies/1/notes.txt",
          hostId: "remote-host",
          label: "Original label",
        },
      },
    });
  });

  test.each(["read", "create"] as const)(
    "cleans only newly created files when a later %s fails",
    async (operation) => {
      const { contents, port, pasted, transfer } = fixture();
      const failure = new Error("Copy failed");
      // The first entry succeeds; the next invocation fails after allocating that copy.
      if (operation === "read")
        port.read
          .mockImplementationOnce(port.read.getMockImplementation()!)
          .mockRejectedValueOnce(failure);
      else
        port.create
          .mockImplementationOnce(port.create.getMockImplementation()!)
          .mockRejectedValueOnce(failure);
      const multiple = {
        ...transfer,
        pastedTextAttachments: [pasted, { ...pasted, id: "second" }],
      };
      await expect(
        prepareComposerDraftTransferAttachments(multiple, port, "local"),
      ).rejects.toThrow(failure);
      expect([...contents.keys()]).toEqual(["/source/notes.txt"]);
      expect(port.remove).toHaveBeenCalledExactlyOnceWith({
        file: expect.objectContaining({ path: "/copies/1/notes.txt" }),
      });
      expect(transfer.pastedTextAttachments).toEqual([pasted]);
    },
  );

  test("discards unclaimed copies once without ever deleting a source file", async () => {
    const { contents, port, transfer } = fixture();
    const prepared = await prepareComposerDraftTransferAttachments(transfer, port, "local");
    await prepared.discard();
    await prepared.discard();
    expect([...contents.keys()]).toEqual(["/source/notes.txt"]);
    expect(port.remove).toHaveBeenCalledTimes(1);
  });
});

import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/shadcn";
import { act, fireEvent, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import {
  BlockReferenceRuntimeProvider,
  type BlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { FileReadCache } from "@/lib/file-read-cache";
import "../../../globals.css";
import type { AttachmentProps } from "./attachment-chip";
import { nfmSchema } from "./nfm-schema";
import {
  createFilePlacementRuntime,
  FileRuntimeProvider,
  type FilePlacementRuntime,
} from "./file-runtime";

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

type FileMetadata = Awaited<ReturnType<FilePlacementRuntime["metadata"]>>;

const createFileMetadata = (overrides: Partial<FileMetadata> = {}): FileMetadata => ({
  file_id: "file-1",
  default_name: "review.webm",
  mime_type: "video/webm",
  byte_length: 0,
  version: 1,
  blob_etag: "etag-1",
  ...overrides,
});

const createFileRuntime = (overrides: Partial<FilePlacementRuntime> = {}): FilePlacementRuntime => {
  const authority = {
    libraryId: "library-1",
    contentRoutingContext: { kind: "project", projectId: "project-1" },
    readSource: { kind: "page", page_id: "page-1" },
    storeEpoch: "store-1",
  } as const;
  const read =
    overrides.read ??
    (async () => ({
      bytes: new Uint8Array(),
      mimeType: "video/webm",
      etag: "etag-1",
    }));
  const readMetadata = overrides.metadata ?? (async () => createFileMetadata());
  const cache = new FileReadCache({
    readMetadata: (_, fileId) => readMetadata(`nodex://files/${fileId}`),
    readBytes: (_, fileId) => read(`nodex://files/${fileId}`),
    createObjectUrl: (file) => `blob:${file.etag}`,
    revokeObjectUrl: () => undefined,
  });
  return {
    ...createFilePlacementRuntime(authority, cache),
    ...(overrides.upload ? { upload: overrides.upload } : {}),
    ...(overrides.readImageDataUrl ? { readImageDataUrl: overrides.readImageDataUrl } : {}),
    ...(overrides.save ? { save: overrides.save } : {}),
  };
};

const openPageFile = vi.fn();

const hostRuntime: BlockReferenceHostRuntime = {
  contentRoutingContext: { kind: "project", projectId: "project-1" },
  projectName: null,
  projectWorkspacePath: null,
  hostPageId: "page-1",
  ancestorPageIds: ["page-1"],
  ancestorDocumentOwnerBlockIds: ["page-1"],
  isActiveSurface: true,
  openPageFile,
};

const renderAttachment = (
  fileRuntime: FilePlacementRuntime,
  props: AttachmentProps,
  blockId: string,
) => {
  const editor = BlockNoteEditor.create({
    schema: nfmSchema,
    initialContent: [
      {
        id: blockId,
        type: "paragraph",
        content: [{ type: "attachment", props }],
      },
    ],
  });
  const view = renderWithAppMaitai(
    <NodexTooltipProvider>
      <BlockReferenceRuntimeProvider value={hostRuntime}>
        <FileRuntimeProvider value={fileRuntime}>
          <BlockNoteView
            editor={editor}
            formattingToolbar={false}
            linkToolbar={false}
            slashMenu={false}
            sideMenu={false}
            tableHandles={false}
          />
        </FileRuntimeProvider>
      </BlockReferenceRuntimeProvider>
    </NodexTooltipProvider>,
  );
  return { editor, view };
};

describe("attachment chip Library Files", () => {
  test("reads as an inline File reference and opens beside its Page", async () => {
    const { editor, view } = renderAttachment(
      createFileRuntime(),
      {
        kind: "file",
        mode: "materialized",
        source: "nodex://files/file-1",
        name: "stale.bin",
        mimeType: "application/octet-stream",
      },
      "attachment-block",
    );

    try {
      await act(settleEditor);
      const chip = await view.findByRole("button", { name: "Open review.webm" });
      const label = within(chip).getByText("review.webm");
      expect(chip.getAttribute("data-inline-reference-chip")).toBe("true");
      expect(chip.getAttribute("data-attachment-inline-chip")).toBe("true");
      expect(chip.getAttribute("data-mention-inline-chip")).toBeNull();
      expect(getComputedStyle(chip).backgroundColor).toBe("rgba(0, 0, 0, 0)");
      expect(getComputedStyle(label).textDecorationLine).toContain("underline");
      const inlineContent = chip.closest<HTMLElement>(".bn-inline-content-section");
      expect(inlineContent).not.toBeNull();
      if (!inlineContent) throw new Error("Attachment inline-content host was not rendered");
      expect(Number.parseFloat(getComputedStyle(chip).fontSize)).toBeCloseTo(
        Number.parseFloat(getComputedStyle(inlineContent).fontSize),
        3,
      );
      const chipIcon = chip.querySelector<SVGSVGElement>('[data-file-tab-icon="file"]');
      expect(chipIcon).not.toBeNull();
      const chipIconGeometry = chipIcon?.querySelector("path")?.getBBox();
      const chipIconBox = chipIcon?.getBoundingClientRect();
      const opticalHeight =
        ((chipIconGeometry?.height ?? 0) / (chipIcon?.viewBox.baseVal.height ?? 1)) *
        (chipIconBox?.height ?? 0);
      expect(chipIconBox?.height).toBeCloseTo(16, 1);
      expect(opticalHeight).toBeGreaterThan(12);
      expect(opticalHeight).toBeLessThan(13);

      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });
      expect(openPageFile).toHaveBeenLastCalledWith({
        routingContext: { kind: "project", projectId: "project-1" },
        pageId: "page-1",
        fileId: "file-1",
        logicalPath: null,
        title: "review.webm",
        openMode: "preview",
      });
      await act(async () => {
        fireEvent.click(chip, { metaKey: true });
        await settleEditor();
      });
      expect(openPageFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ fileId: "file-1", openMode: "durable" }),
      );
      expect(document.body.querySelector('[data-slot="popover-content"]')).toBeNull();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("offers the File's actions in its context menu", async () => {
    const save = vi.fn(async () => undefined);
    const { editor, view } = renderAttachment(
      createFileRuntime({
        save,
        metadata: async () =>
          createFileMetadata({ default_name: "notes.md", mime_type: "text/markdown" }),
      }),
      {
        kind: "file",
        mode: "materialized",
        source: "nodex://files/file-1",
        name: "notes.md",
        mimeType: "text/markdown",
      },
      "attachment-menu-block",
    );

    try {
      await act(settleEditor);
      const chip = await view.findByRole("button", { name: "Open notes.md" });
      await act(async () => {
        fireEvent.contextMenu(chip, { clientX: 20, clientY: 20 });
        await settleEditor();
      });
      const menu = await view.findByRole("menu");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Open", "Open in new tab", "Save…", "Copy reference"]);
      await act(async () => {
        fireEvent.click(within(menu).getByRole("menuitem", { name: "Open in new tab" }));
        await settleEditor();
      });
      expect(openPageFile).toHaveBeenLastCalledWith(
        expect.objectContaining({ fileId: "file-1", title: "notes.md", openMode: "durable" }),
      );

      await act(async () => {
        fireEvent.contextMenu(chip, { clientX: 20, clientY: 20 });
        await settleEditor();
      });
      await act(async () => {
        fireEvent.click(
          within(await view.findByRole("menu")).getByRole("menuitem", { name: "Save…" }),
        );
        await settleEditor();
      });
      expect(save).toHaveBeenCalledWith("nodex://files/file-1", "notes.md");
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("keeps the current label visible while exact metadata refreshes", async () => {
    let resolveRefresh!: (value: FileMetadata) => void;
    const refresh = new Promise<FileMetadata>((resolve) => {
      resolveRefresh = resolve;
    });
    const metadata = vi
      .fn<() => Promise<FileMetadata>>()
      .mockResolvedValueOnce(createFileMetadata({ default_name: "current.json" }))
      .mockImplementationOnce(() => refresh);
    const runtime = createFileRuntime({ metadata });
    const { editor, view } = renderAttachment(
      runtime,
      {
        kind: "file",
        mode: "materialized",
        source: "nodex://files/file-1",
        name: "stale.json",
        mimeType: "application/json",
      },
      "attachment-metadata-refresh-block",
    );

    try {
      const chip = await view.findByRole("button", { name: "Open current.json" });
      await act(async () => {
        runtime.invalidate({
          mode: "refresh",
          fileIds: ["file-1"],
          metadata: true,
          content: false,
        });
        await Promise.resolve();
      });

      expect(within(chip).getByText("current.json")).toBeVisible();
      expect(metadata).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRefresh(createFileMetadata({ default_name: "renamed.json", version: 2 }));
        await refresh;
      });
      const renamedChip = await view.findByRole("button", { name: "Open renamed.json" });
      expect(within(renamedChip).getByText("renamed.json")).toBeVisible();
      expect(within(renamedChip).queryByText("current.json")).toBeNull();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});

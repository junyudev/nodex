import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/shadcn";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
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
    contentAccessContext: { kind: "project", projectId: "project-1" },
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
  const view = render(
    <NodexTooltipProvider>
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
    </NodexTooltipProvider>,
  );
  return { editor, view };
};

describe("attachment chip Library Files", () => {
  test("uses the same format icon in the chip and its popover", async () => {
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
      const label = await view.findByText("review.webm");
      const chip = label.closest("button");
      expect(chip).not.toBeNull();
      if (!chip) throw new Error("Attachment chip was not rendered");
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
        if (chip) fireEvent.click(chip);
        await settleEditor();
      });

      await waitFor(() => {
        const popover = document.body.querySelector('[data-slot="popover-content"]');
        expect(popover?.querySelector('[data-file-tab-icon="file"]')).not.toBeNull();
      });
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("reuses preview bytes while open and releases them when the popover closes", async () => {
    let resolveMetadata!: (value: Awaited<ReturnType<FilePlacementRuntime["metadata"]>>) => void;
    const metadata = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<FilePlacementRuntime["metadata"]>>>((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    let resolveRead!: (value: Awaited<ReturnType<FilePlacementRuntime["read"]>>) => void;
    const read = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<FilePlacementRuntime["read"]>>>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { editor, view } = renderAttachment(
      createFileRuntime({ read, metadata }),
      {
        kind: "file",
        mode: "materialized",
        source: "nodex://files/file-1",
        name: "result.json",
        mimeType: "application/json",
      },
      "attachment-preview-block",
    );

    try {
      await act(settleEditor);
      const label = await view.findByText("result.json");
      const chip = label.closest("button");
      expect(chip).not.toBeNull();
      if (!chip) throw new Error("Attachment chip was not rendered");

      await act(async () => {
        fireEvent.click(chip);
        await Promise.resolve();
      });

      const firstPopover = await view.findByRole("dialog");
      expect(within(firstPopover).getByText("Loading preview...")).toBeVisible();
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveMetadata(
          createFileMetadata({
            default_name: "renamed-result.json",
            mime_type: "application/json",
            byte_length: 18,
          }),
        );
        await Promise.resolve();
      });
      await waitFor(() => expect(chip).toHaveTextContent("renamed-result.json"));
      expect(within(firstPopover).getByText(/18 B/)).toBeVisible();
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveRead({
          bytes: new TextEncoder().encode('{"status":"passed"}'),
          mimeType: "application/json",
          etag: "etag-1",
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(within(firstPopover).getByText(/"status":"passed"/)).toBeVisible();
      });
      expect(view.getByRole("dialog")).toBe(firstPopover);

      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());

      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });
      const reopenedPopover = await view.findByRole("dialog");
      expect(within(reopenedPopover).getByText("Loading preview...")).toBeVisible();
      expect(read).toHaveBeenCalledTimes(2);
      await act(async () => {
        resolveRead({
          bytes: new TextEncoder().encode('{"status":"passed"}'),
          mimeType: "application/json",
          etag: "etag-1",
        });
        await Promise.resolve();
      });
      await waitFor(() => {
        expect(within(reopenedPopover).getByText(/"status":"passed"/)).toBeVisible();
      });
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
      await view.findByText("current.json");
      await act(async () => {
        runtime.invalidate({
          mode: "refresh",
          fileIds: ["file-1"],
          metadata: true,
          content: false,
        });
        await Promise.resolve();
      });

      expect(view.getByText("current.json")).toBeVisible();
      expect(metadata).toHaveBeenCalledTimes(2);

      await act(async () => {
        resolveRefresh(createFileMetadata({ default_name: "renamed.json", version: 2 }));
        await refresh;
      });
      await view.findByText("renamed.json");
      expect(view.queryByText("current.json")).toBeNull();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("shows a truthful state when a preview read fails", async () => {
    const read = vi.fn(async () => {
      throw new Error("preview unavailable");
    });
    const { editor, view } = renderAttachment(
      createFileRuntime({
        read,
        metadata: async () =>
          createFileMetadata({
            default_name: "result.json",
            mime_type: "application/json",
            byte_length: 18,
          }),
      }),
      {
        kind: "file",
        mode: "materialized",
        source: "nodex://files/file-1",
        name: "result.json",
        mimeType: "application/json",
      },
      "attachment-failed-preview-block",
    );

    try {
      await act(settleEditor);
      const chip = (await view.findByText("result.json")).closest("button");
      expect(chip).not.toBeNull();
      if (!chip) throw new Error("Attachment chip was not rendered");

      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });

      const popover = await view.findByRole("dialog");
      await waitFor(() => {
        expect(within(popover).getByText("Preview unavailable.")).toBeVisible();
      });
      expect(within(popover).queryByText("Loading preview...")).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);

      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });
      await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
      await act(async () => {
        fireEvent.click(chip);
        await settleEditor();
      });
      await view.findByRole("dialog");
      await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});

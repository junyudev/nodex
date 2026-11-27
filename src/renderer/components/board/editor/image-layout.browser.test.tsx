import { BlockNoteEditor, imageParse } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { render, waitFor, type RenderResult, act, fireEvent, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { readImageFileSourceDimensions } from "@/lib/image-source-dimensions";
import { nfmSchema } from "./nfm-schema";
import "@blocknote/shadcn/style.css";
import "../../../globals.css";
import { BlockNoteView } from "@blocknote/shadcn";
import {
  BlockReferenceRuntimeProvider,
  type BlockReferenceHostRuntime,
} from "@/components/block-documents/block-reference-runtime-context";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { FileReadCache } from "@/lib/file-read-cache";
import type { AttachmentProps } from "./attachment-chip";
import {
  createFilePlacementRuntime,
  FileRuntimeProvider,
  type FilePlacementRuntime,
} from "./file-runtime";

describe("image layout", () => {
  const editors: BlockNoteEditor<any, any, any>[] = [];
  const views: RenderResult[] = [];

  function mountImage(props: Record<string, unknown>) {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [{ id: "image-layout", type: "image", props }],
    });
    editors.push(editor);
    const view = render(
      <div className="nfm-editor w-[500px]">
        <BlockNoteViewRaw
          editor={editor}
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </div>,
    );
    views.push(view);
    return { editor, view };
  }

  afterEach(() => {
    for (const view of views.splice(0)) view.unmount();
    for (const editor of editors.splice(0)) editor._tiptapEditor.destroy();
    document.body.replaceChildren();
  });

  describe("NFM image layout in Chromium", () => {
    test("reads intrinsic geometry before an image upload is committed", async () => {
      const file = new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"></svg>'],
        "portrait.svg",
        { type: "image/svg+xml" },
      );

      await expect(readImageFileSourceDimensions(file)).resolves.toEqual({
        sourceWidth: 640,
        sourceHeight: 960,
      });
    });

    test("keeps intrinsic geometry distinct from an authored preview width", () => {
      const image = document.createElement("img");
      image.src = "data:image/png;base64,YQ==";
      image.width = 640;
      image.height = 960;
      image.dataset.sourceWidth = "640";
      image.dataset.sourceHeight = "960";

      expect(imageParse()(image)).toMatchObject({
        sourceWidth: 640,
        sourceHeight: 960,
        previewWidth: undefined,
      });

      image.dataset.previewWidth = "320";
      expect(imageParse()(image)).toMatchObject({ previewWidth: 320 });
    });

    test("reserves the complete image box while the source is unavailable", async () => {
      const { view } = mountImage({
        url: "data:image/png;base64,",
        previewWidth: 160,
        sourceWidth: 400,
        sourceHeight: 800,
      });

      const frame = await waitFor(() => {
        const candidate = view.container.querySelector<HTMLElement>(
          '[data-nfm-image-layout-stable="true"]',
        );
        expect(candidate).not.toBeNull();
        return candidate!;
      });
      const rect = frame.getBoundingClientRect();
      expect(Math.abs(rect.width - 160)).toBeLessThan(1);
      expect(Math.abs(rect.height - 320)).toBeLessThan(1);
    });

    test("displays images without stored geometry without changing their content", async () => {
      const svg = encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="300"></svg>',
      );
      const { editor, view } = mountImage({ url: `data:image/svg+xml,${svg}` });
      const before = structuredClone(editor.document);

      await waitFor(() => {
        const image = view.container.querySelector("img");
        expect(image?.naturalWidth).toBe(120);
        expect(image?.naturalHeight).toBe(300);
      });
      expect(editor.document).toEqual(before);
      const image = view.container.querySelector("img")!;
      expect(image.getBoundingClientRect().width).toBe(120);
      expect(image.getBoundingClientRect().height).toBe(300);
    });
  });
});

describe("attachment chip", () => {
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

  const createFileRuntime = (
    overrides: Partial<FilePlacementRuntime> = {},
  ): FilePlacementRuntime => {
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
        ).toEqual([
          "Open",
          "Open in new tab",
          "Save…",
          "Copy reference",
          // Reveal in Finder, Open in Explorer or Open in File Manager, by platform.
          expect.stringMatching(/^(?:Reveal|Open) in /u),
        ]);
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
});

import { BlockNoteEditor } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/shadcn";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";

import { NodexTooltipProvider } from "@/components/ui/tooltip";
import "../../../globals.css";
import type { AttachmentProps } from "./attachment-chip";
import { nfmSchema } from "./nfm-schema";
import { PageFileRuntimeProvider, type PageFilePlacementRuntime } from "./page-file-runtime";

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

type PageFileMetadata = Awaited<ReturnType<PageFilePlacementRuntime["metadata"]>>;

const createPageFileMetadata = (overrides: Partial<PageFileMetadata> = {}): PageFileMetadata => ({
  fileId: "file-1",
  ownerPageId: "page-1",
  logicalPath: "videos/review.webm",
  mimeType: "video/webm",
  byteLength: 0,
  version: 1,
  blobEtag: "etag-1",
  state: "live",
  createdByActorId: "actor-1",
  createdByTurnId: null,
  createdAt: "2026-08-28T00:00:00.000Z",
  updatedAt: "2026-08-28T00:00:00.000Z",
  bodyUsage: { kind: "placed", placementCount: 1 },
  ...overrides,
});

const createPageFileRuntime = (
  overrides: Partial<PageFilePlacementRuntime> = {},
): PageFilePlacementRuntime => ({
  authority: {
    contentAccessContext: { kind: "project", projectId: "project-1" },
    pageId: "page-1",
    storeEpoch: "store-1",
  },
  readAuthorityEpoch: 1,
  upload: async () => "nodex://files/file-1",
  read: async () => ({
    bytes: new Uint8Array(),
    mimeType: "video/webm",
    etag: "etag-1",
  }),
  metadata: async () => createPageFileMetadata(),
  readImageDataUrl: async () => "data:image/png;base64,",
  save: async () => undefined,
  ...overrides,
});

const renderAttachment = (
  pageFileRuntime: PageFilePlacementRuntime,
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
      <PageFileRuntimeProvider value={pageFileRuntime}>
        <BlockNoteView
          editor={editor}
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </PageFileRuntimeProvider>
    </NodexTooltipProvider>,
  );
  return { editor, view };
};

describe("attachment chip Page Files", () => {
  test("uses the same format icon in the chip and its popover", async () => {
    const { editor, view } = renderAttachment(
      createPageFileRuntime(),
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

  test("reuses one preview read across metadata refresh and reopen", async () => {
    let resolveMetadata!: (
      value: Awaited<ReturnType<PageFilePlacementRuntime["metadata"]>>,
    ) => void;
    const metadata = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PageFilePlacementRuntime["metadata"]>>>((resolve) => {
          resolveMetadata = resolve;
        }),
    );
    let resolveRead!: (value: Awaited<ReturnType<PageFilePlacementRuntime["read"]>>) => void;
    const read = vi.fn(
      () =>
        new Promise<Awaited<ReturnType<PageFilePlacementRuntime["read"]>>>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const { editor, view } = renderAttachment(
      createPageFileRuntime({ read, metadata }),
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
          createPageFileMetadata({
            logicalPath: "reports/renamed-result.json",
            mimeType: "application/json",
            byteLength: 18,
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
      expect(within(reopenedPopover).getByText(/"status":"passed"/)).toBeVisible();
      expect(read).toHaveBeenCalledTimes(1);
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
      createPageFileRuntime({
        read,
        metadata: async () =>
          createPageFileMetadata({
            logicalPath: "result.json",
            mimeType: "application/json",
            byteLength: 18,
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

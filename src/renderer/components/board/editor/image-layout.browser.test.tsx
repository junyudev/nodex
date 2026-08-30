import { BlockNoteEditor, imageParse } from "@blocknote/core";
import { BlockNoteViewRaw } from "@blocknote/react";
import { render, waitFor, type RenderResult } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { readImageFileSourceDimensions } from "@/lib/image-source-dimensions";
import { nfmSchema } from "./nfm-schema";
import "@blocknote/shadcn/style.css";
import "../../../globals.css";

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
    image.src = "https://example.test/image.png";
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

  test("reserves the complete image box before the source loads", async () => {
    const { view } = mountImage({
      url: "https://127.0.0.1:9/delayed-image.png",
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

  test("self-heals legacy image blocks with decoded source dimensions", async () => {
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="300"></svg>',
    );
    const { editor, view } = mountImage({ url: `data:image/svg+xml,${svg}` });

    await waitFor(() => {
      expect(editor.getBlock("image-layout")?.props).toMatchObject({
        sourceWidth: 120,
        sourceHeight: 300,
      });
    });
    expect(view.container.querySelector('[data-nfm-image-layout-stable="true"]')).not.toBeNull();
  });
});

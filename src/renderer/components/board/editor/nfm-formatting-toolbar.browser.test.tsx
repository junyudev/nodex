import { BlockNoteEditor } from "@blocknote/core";
import { FormattingToolbarExtension } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/shadcn";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import "../../../globals.css";
import { renderWithQuery as render } from "@/test/query";
import { installCommandKeymapFixture } from "@/test/command-keymap";
import { NfmFormattingToolbar } from "./nfm-formatting-toolbar";
import { NfmFormattingToolbarController } from "./nfm-formatting-toolbar-controller";
import { NfmSideMenuOpenProvider } from "./nfm-side-menu";
import { nfmSchema } from "./nfm-schema";

installCommandKeymapFixture();

const settleEditor = async (): Promise<void> => {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
};

describe("NFM image formatting toolbar in Chromium", () => {
  test("opens supported image actions and downloads through the app asset path", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "image-1",
          type: "image",
          props: {
            url: "data:image/png;base64,YQ==",
            caption: "",
            name: "diagram.png",
            showPreview: true,
          },
        },
      ],
    });
    const getImageProps = () =>
      editor.getBlock("image-1")?.props as
        | {
            caption?: string;
            url?: string;
          }
        | undefined;
    const view = render(
      <NodexTooltipProvider>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        >
          <NfmSideMenuOpenProvider>
            <NfmFormattingToolbarController formattingToolbar={NfmFormattingToolbar} />
          </NfmSideMenuOpenProvider>
        </BlockNoteView>
      </NodexTooltipProvider>,
    );
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:download");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const anchorClick = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    try {
      await act(settleEditor);
      await act(async () => {
        editor.setTextCursorPosition("image-1");
        editor.getExtension(FormattingToolbarExtension)?.store.setState(true);
        editor.focus();
        await settleEditor();
      });

      const toolbar = await view.findByRole("toolbar");
      expect(toolbar.querySelector('[aria-label="Rename image"]')).toBeNull();

      const captionButton = view.getByRole("button", { name: "Edit caption" });
      fireEvent.pointerDown(captionButton, { button: 0 });
      fireEvent.click(captionButton);
      const captionInput = await view.findByPlaceholderText("Edit caption");
      expect(view.queryByRole("toolbar")).toBeNull();
      expect(view.getByRole("dialog", { name: "Edit caption" })).toBeTruthy();
      fireEvent.change(captionInput, { target: { value: "A diagram" } });
      expect(getImageProps()?.caption).toBe("A diagram");

      fireEvent.keyDown(captionInput, { key: "Enter", code: "Enter" });
      await view.findByRole("toolbar");

      const replaceButton = view.getByRole("button", { name: "Replace image" });
      fireEvent.pointerDown(replaceButton, { button: 0 });
      fireEvent.click(replaceButton);
      await view.findByText("Embed");
      expect(view.queryByRole("toolbar")).toBeNull();
      expect(view.getByRole("dialog", { name: "Replace image" })).toBeTruthy();

      fireEvent.click(view.getByRole("tab", { name: "Embed" }));
      const embedInput = await view.findByPlaceholderText("Enter URL");
      fireEvent.change(embedInput, { target: { value: "data:image/png;base64,YQ==" } });
      fireEvent.click(view.getByRole("button", { name: "Embed image" }));
      expect(getImageProps()?.url).toBe("data:image/png;base64,YQ==");

      fireEvent.click(view.getByRole("button", { name: "Back to image actions" }));
      await view.findByRole("toolbar");

      fireEvent.click(view.getByRole("button", { name: "Download image" }));
      await waitFor(() => {
        expect(createObjectURL).toHaveBeenCalledOnce();
        expect(anchorClick).toHaveBeenCalledOnce();
      });
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
    } finally {
      createObjectURL.mockRestore();
      revokeObjectURL.mockRestore();
      anchorClick.mockRestore();
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("renders a compact file row when image preview is disabled", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      // Keep the compact row unfocused for the visual assertion.
      initialContent: [
        {
          id: "image-compact",
          type: "image",
          props: {
            url: "data:image/png;base64,YQ==",
            caption: "",
            name: "image.png",
            showPreview: false,
          },
        },
        {
          id: "paragraph-compact",
          type: "paragraph",
          content: [],
        },
      ],
    });
    const view = render(
      <NodexTooltipProvider>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        />
      </NodexTooltipProvider>,
    );

    try {
      await act(settleEditor);
      await act(async () => {
        editor.setTextCursorPosition("paragraph-compact");
        editor.focus();
        await settleEditor();
      });
      expect(await view.findByText("image.png")).toBeTruthy();
      expect(await view.findByText("1 B")).toBeTruthy();
      expect(view.container.querySelector('[data-content-type="image"] img')).toBeNull();
    } finally {
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });

  test("does not flash the text formatting toolbar while moving the cursor into text", async () => {
    const editor = BlockNoteEditor.create({
      schema: nfmSchema,
      initialContent: [
        {
          id: "image-transition",
          type: "image",
          props: {
            url: "data:image/png;base64,YQ==",
            caption: "",
            name: "image.png",
            showPreview: true,
          },
        },
        {
          id: "paragraph-transition",
          type: "paragraph",
          content: "Click into this text",
        },
      ],
    });
    const view = render(
      <NodexTooltipProvider>
        <BlockNoteView
          editor={editor}
          className="nfm-editor"
          formattingToolbar={false}
          linkToolbar={false}
          slashMenu={false}
          sideMenu={false}
          tableHandles={false}
        >
          <NfmSideMenuOpenProvider>
            <NfmFormattingToolbarController formattingToolbar={NfmFormattingToolbar} />
          </NfmSideMenuOpenProvider>
        </BlockNoteView>
      </NodexTooltipProvider>,
    );

    let textToolbarShownDuringImageExit = false;
    const observer = new MutationObserver(() => {
      if (document.body.querySelector('[role="toolbar"] [aria-label="Paragraph"]')) {
        textToolbarShownDuringImageExit = true;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    try {
      await act(settleEditor);
      await act(async () => {
        editor.setTextCursorPosition("image-transition");
        editor.getExtension(FormattingToolbarExtension)?.store.setState(true);
        editor.focus();
        await settleEditor();
      });
      expect(await view.findByRole("button", { name: "Edit caption" })).toBeTruthy();
      textToolbarShownDuringImageExit = false;

      await act(async () => {
        editor.setTextCursorPosition("paragraph-transition", "start");
        await Promise.resolve();
      });
      expect(
        document.querySelector('[aria-hidden="true"] [aria-label="Edit caption"]'),
      ).not.toBeNull();
      await act(settleEditor);
      await act(settleEditor);

      expect(textToolbarShownDuringImageExit).toBe(false);
      expect(view.queryByRole("button", { name: "Paragraph" })).toBeNull();
      await waitFor(() => {
        expect(
          document.querySelector('[aria-hidden="true"] [aria-label="Edit caption"]'),
        ).toBeNull();
      });
    } finally {
      observer.disconnect();
      view.unmount();
      editor._tiptapEditor.destroy();
    }
  });
});

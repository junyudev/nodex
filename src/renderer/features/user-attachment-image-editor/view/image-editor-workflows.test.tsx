import { act, useState, useRef, type ComponentProps } from "react";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi, afterEach, beforeEach } from "vite-plus/test";
import { render, settleAsyncRender } from "../../../test/dom";
import type { ImageComment } from "../model/types";
import { ImageCommentSurface } from "./image-comment-surface";
import { TestQueryProvider } from "../../../test/query";
import { ImagePreviewDialog } from "./image-preview-dialog";
import * as resolvedImageAsset from "@/lib/content-image";
import type { EditableImageDescriptor, ImageEditSubmissionIntent } from "@/lib/content-image";
import { ImageRemoveEditor } from "./image-remove-editor";
import { installWindowApi } from "../../../test/browser-globals";
import { renderWithMaitai } from "../../../test/thread-maitai";
import { IMAGE_REMOVE_BACKGROUND_PROMPT } from "../model/image-edit-submission";
import { SingleImageEditor } from "./single-image-editor";

describe("image comment surface", () => {
  const IMAGE_SRC = "data:image/png;base64,AQID";

  function CommentHarness({
    onCommentsChange,
  }: {
    onCommentsChange: (comments: readonly ImageComment[]) => void;
  }) {
    const [comments, setComments] = useState<readonly ImageComment[]>([]);
    const updateComments = (next: readonly ImageComment[]) => {
      setComments(next);
      onCommentsChange(next);
    };
    return (
      <div className="h-[300px] w-[400px]">
        <ImageCommentSurface
          alt="Example"
          comments={comments}
          src={IMAGE_SRC}
          onDeleteComment={(commentId) => {
            updateComments(comments.filter((comment) => comment.id !== commentId));
          }}
          onSubmitComment={(comment) => {
            const existing = comments.some((candidate) => candidate.id === comment.id);
            updateComments(
              existing
                ? comments.map((candidate) => (candidate.id === comment.id ? comment : candidate))
                : [...comments, comment],
            );
          }}
        />
      </div>
    );
  }

  function installSurfaceGeometry(target: HTMLElement): void {
    const surface = target.parentElement;
    const parent = surface?.parentElement;
    if (!surface || !parent) throw new Error("Comment surface geometry is unavailable");
    Object.defineProperties(surface, {
      clientHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 400 },
      offsetLeft: { configurable: true, value: 0 },
      offsetTop: { configurable: true, value: 0 },
    });
    Object.defineProperties(parent, {
      clientHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 400 },
    });
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 400,
      toJSON: () => ({}),
      top: 0,
      width: 400,
      x: 0,
      y: 0,
    });
  }

  describe("ImageCommentSurface", () => {
    test("creates, edits, and deletes normalized positional comments", async () => {
      const onCommentsChange = vi.fn();
      const view = render(<CommentHarness onCommentsChange={onCommentsChange} />);
      const target = view.getByRole("button", { name: "Image comment surface" });
      installSurfaceGeometry(target);

      await act(async () => {
        fireEvent.click(target, { clientX: 100, clientY: 225, detail: 1 });
      });
      const input = view.getByPlaceholderText("Add a comment…");
      await act(async () => {
        fireEvent.change(input, { target: { value: "Remove the label" } });
        fireEvent.keyDown(input, { key: "Enter" });
      });

      await waitFor(() => expect(onCommentsChange).toHaveBeenCalledTimes(1));
      const created = onCommentsChange.mock.calls[0]?.[0]?.[0] as ImageComment;
      expect(created).toMatchObject({ text: "Remove the label", x: 0.25, y: 0.75 });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit comment 1" }));
      });
      const textarea = view.getByRole("textbox");
      await act(async () => {
        fireEvent.change(textarea, { target: { value: "Replace the label" } });
        fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
      });

      await waitFor(() => expect(onCommentsChange).toHaveBeenCalledTimes(2));
      expect(onCommentsChange.mock.calls[1]?.[0]?.[0]).toMatchObject({
        id: created.id,
        text: "Replace the label",
        x: 0.25,
        y: 0.75,
      });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit comment 1" }));
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Delete comment" }));
      });
      await waitFor(() =>
        expect(view.queryByRole("button", { name: "Edit comment 1" })).toBeNull(),
      );
      expect(onCommentsChange.mock.calls[2]?.[0]).toEqual([]);
    });

    test("cancels an unsaved draft with Escape", async () => {
      const view = render(<CommentHarness onCommentsChange={() => undefined} />);
      const target = view.getByRole("button", { name: "Image comment surface" });
      installSurfaceGeometry(target);

      await act(async () => {
        fireEvent.click(target, { clientX: 200, clientY: 150, detail: 1 });
      });
      await act(async () => {
        fireEvent.keyDown(view.getByPlaceholderText("Add a comment…"), { key: "Escape" });
      });

      await waitFor(() => expect(view.queryByPlaceholderText("Add a comment…")).toBeNull());
    });
  });
});

describe("image preview dialog", () => {
  const IMAGE_DATA_URL = "data:image/png;base64,AQID";

  function FocusRestorePreview() {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    return (
      <TestQueryProvider>
        <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
          Open preview
        </button>
        <ImagePreviewDialog
          open={open}
          onOpenChange={setOpen}
          src={IMAGE_DATA_URL}
          finalFocus={() => {
            triggerRef.current?.focus();
            return false;
          }}
        />
      </TestQueryProvider>
    );
  }

  function renderPreview(props: Partial<ComponentProps<typeof ImagePreviewDialog>> = {}) {
    return render(
      <TestQueryProvider>
        <ImagePreviewDialog
          open
          onOpenChange={() => undefined}
          src={IMAGE_DATA_URL}
          alt="Example image"
          {...props}
        />
      </TestQueryProvider>,
    );
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ImagePreviewDialog", () => {
    test("starts a replacement image at the viewport origin", async () => {
      const view = renderPreview();
      const viewport = view.getByTestId("image-preview-dismiss-area");
      viewport.scrollTop = 150;
      viewport.scrollLeft = 90;
      view.rerender(
        <TestQueryProvider>
          <ImagePreviewDialog
            open
            onOpenChange={() => undefined}
            src="data:image/png;base64,BAUG"
          />
        </TestQueryProvider>,
      );
      await waitFor(() => {
        const nextViewport = view.getByTestId("image-preview-dismiss-area");
        expect(nextViewport.scrollTop).toBe(0);
        expect(nextViewport.scrollLeft).toBe(0);
      });
    });

    test("does not download an image whose source retires while materializing it", async () => {
      let current = true;
      const download = vi
        .spyOn(resolvedImageAsset, "downloadImageDataUrl")
        .mockResolvedValue(undefined);
      const view = renderPreview({ isCurrent: () => current });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Download image" }));
        current = false;
        await Promise.resolve();
      });
      expect(download).not.toHaveBeenCalled();
    });

    test("offers the optional edit action and closes after accepting it", async () => {
      const onEditImage = vi.fn();
      const onOpenChange = vi.fn();
      const view = renderPreview({ onEditImage, onOpenChange });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Edit image" }));
      });

      expect(onEditImage).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    test("names the image and leaves for its lasting view when asked", async () => {
      const open = vi.fn();
      const onOpenChange = vi.fn();
      const view = renderPreview({
        title: "flamegraph.png",
        openIn: { label: "Open in tab", open },
        onOpenChange,
      });

      expect(view.getByText("flamegraph.png")).toBeTruthy();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open in tab" }));
      });

      expect(open).toHaveBeenCalledOnce();
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    test("saves through its owner instead of downloading what is displayed", async () => {
      const download = vi
        .spyOn(resolvedImageAsset, "downloadImageDataUrl")
        .mockResolvedValue(undefined);
      const onDownload = vi.fn();
      const view = renderPreview({ onDownload });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Download image" }));
        await Promise.resolve();
      });

      expect(onDownload).toHaveBeenCalledOnce();
      expect(download).not.toHaveBeenCalled();
    });

    test("shows the owner's read state in place of the image", async () => {
      const loading = renderPreview({ src: "", loading: true });
      expect(loading.getByRole("status").textContent).toContain("Loading image");
      expect(loading.queryByRole("img")).toBeNull();
      loading.unmount();

      const unavailable = renderPreview({ src: "", unavailable: true });
      expect(unavailable.getByRole("alert").textContent).toContain("Image unavailable");
      // Only the owner can read the image again, so the preview offers no retry of its own.
      expect(unavailable.queryByRole("button", { name: "Try again" })).toBeNull();
    });

    test("keeps the preview when the double click that opened it lands on the backdrop", async () => {
      const onOpenChange = vi.fn();
      const view = renderPreview({ onOpenChange });
      const backdrop = view.getByTestId("image-preview-dismiss-area");

      await act(async () => {
        fireEvent.click(backdrop, { detail: 2 });
      });
      expect(onOpenChange).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.click(backdrop, { detail: 1 });
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    test("supports adjacent-image keyboard navigation", async () => {
      const onPreviousImage = vi.fn();
      const onNextImage = vi.fn();
      renderPreview({ onPreviousImage, onNextImage });

      await act(async () => {
        fireEvent.keyDown(document, { key: "ArrowLeft" });
        fireEvent.keyDown(document, { key: "ArrowRight" });
      });

      expect(onPreviousImage).toHaveBeenCalledOnce();
      expect(onNextImage).toHaveBeenCalledOnce();
    });

    test("downloads data URLs through an object URL", async () => {
      const createObjectURL = vi.fn(() => "blob:download");
      const revokeObjectURL = vi.fn();
      Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: createObjectURL,
      });
      Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: revokeObjectURL,
      });
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, "click")
        .mockImplementation(() => undefined);
      const view = renderPreview({ downloadFileName: "diagram.png" });

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Download image" }));
        await Promise.resolve();
      });

      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(createObjectURL).toHaveBeenCalledOnce();
      expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("diagram.png");
    });

    test("delegates focus restoration to the owning trigger", async () => {
      const view = render(<FocusRestorePreview />);
      const trigger = view.getByRole("button", { name: "Open preview" });

      await act(async () => {
        fireEvent.click(trigger);
      });
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Close image preview" }));
      });

      await waitFor(() => expect(document.activeElement).toBe(trigger));
    });

    test("preserves the Board space-to-close shortcut without stealing modified space", async () => {
      const onOpenChange = vi.fn();
      renderPreview({ closeOnSpace: true, onOpenChange });

      await act(async () => {
        fireEvent.keyDown(document, { key: " ", code: "Space", metaKey: true });
        fireEvent.keyDown(document, { key: " ", code: "Space" });
      });

      expect(onOpenChange).toHaveBeenCalledTimes(1);
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });
});

describe("image remove editor", () => {
  const IMAGE_SRC = "data:image/png;base64,AQID";
  const MASK_SRC = "data:image/png;base64,bWFzaw==";

  afterEach(() => vi.restoreAllMocks());

  describe("ImageRemoveEditor", () => {
    test("captures a pointer stroke, supports undo/redo, and rasterizes the mask", async () => {
      const context = {
        arc: vi.fn(),
        beginPath: vi.fn(),
        fill: vi.fn(),
        fillRect: vi.fn(),
        fillStyle: "",
        lineCap: "butt",
        lineJoin: "miter",
        lineTo: vi.fn(),
        lineWidth: 1,
        moveTo: vi.fn(),
        stroke: vi.fn(),
        strokeStyle: "",
      } as unknown as CanvasRenderingContext2D;
      vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(MASK_SRC);
      const onSubmit = vi.fn();
      const view = render(
        <div className="h-[600px] w-[700px]">
          <ImageRemoveEditor
            alt="Uploaded image"
            src={IMAGE_SRC}
            onCancel={() => undefined}
            onSubmit={onSubmit}
          />
        </div>,
      );
      const image = view.getByRole("img", { name: "Uploaded image" });
      Object.defineProperties(image, {
        naturalHeight: { configurable: true, value: 500 },
        naturalWidth: { configurable: true, value: 1000 },
      });
      await act(async () => {
        fireEvent.load(image);
      });

      const canvas = view.getByLabelText("Mark areas to remove");
      vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
        bottom: 200,
        height: 200,
        left: 0,
        right: 400,
        toJSON: () => ({}),
        top: 0,
        width: 400,
        x: 0,
        y: 0,
      });
      const setPointerCapture = vi.fn();
      const releasePointerCapture = vi.fn();
      Object.assign(canvas, {
        hasPointerCapture: () => true,
        releasePointerCapture,
        setPointerCapture,
      });

      await act(async () => {
        fireEvent.pointerDown(canvas, {
          button: 0,
          clientX: 100,
          clientY: 50,
          pointerId: 7,
        });
        fireEvent.pointerMove(canvas, {
          clientX: 200,
          clientY: 100,
          pointerId: 7,
        });
        fireEvent.pointerUp(canvas, {
          clientX: 200,
          clientY: 100,
          pointerId: 7,
        });
      });

      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(releasePointerCapture).toHaveBeenCalledWith(7);
      const send = view.getByRole("button", { name: "Send" }) as HTMLButtonElement;
      await waitFor(() => expect(send.disabled).toBe(false));

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Undo" }));
      });
      expect(send.disabled).toBe(true);
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Redo" }));
      });
      expect(send.disabled).toBe(false);

      await act(async () => {
        fireEvent.click(send);
      });
      expect(onSubmit).toHaveBeenCalledWith(MASK_SRC);
      expect(context.fillRect).toHaveBeenCalledWith(0, 0, 1000, 500);
      expect(context.moveTo).toHaveBeenCalled();
      expect(context.lineTo).toHaveBeenCalled();
    });
  });
});

describe("single image editor", () => {
  const IMAGE_SRC = "data:image/png;base64,AQID";
  const invokeCalls: Array<[string, ...unknown[]]> = [];

  function createSubmitIntentSpy() {
    return vi.fn<(intent: ImageEditSubmissionIntent) => Promise<boolean>>(async () => true);
  }

  beforeEach(() => {
    invokeCalls.length = 0;
    installWindowApi({
      invoke: async (channel: string, ...args: unknown[]) => {
        invokeCalls.push([channel, ...args]);
        return true;
      },
      on: () => () => undefined,
    });
  });

  function renderEditor(image: EditableImageDescriptor, onSubmitIntent = createSubmitIntentSpy()) {
    return renderWithMaitai(
      <TestQueryProvider>
        <div className="h-[600px] w-[700px]">
          <SingleImageEditor
            comments={[]}
            entrypoint="image_click"
            image={image}
            onCommentsChange={() => undefined}
            onSubmitIntent={onSubmitIntent}
          />
        </div>
      </TestQueryProvider>,
    );
  }

  describe("SingleImageEditor", () => {
    test("retires a pending image download when the selected image changes", async () => {
      const save = vi
        .spyOn(resolvedImageAsset, "downloadImageDataUrl")
        .mockResolvedValue(undefined);
      const images: EditableImageDescriptor[] = ["one", "two"].map((id) => ({
        id,
        alt: id,
        attachmentSrc: IMAGE_SRC,
        source: "uploaded",
        src: IMAGE_SRC,
      }));
      function Gallery() {
        const [index, setIndex] = useState(0);
        return (
          <>
            <button onClick={() => setIndex(1)}>Next fixture</button>
            <SingleImageEditor
              comments={[]}
              entrypoint="image_click"
              image={images[index]!}
              onCommentsChange={() => undefined}
              onSubmitIntent={createSubmitIntentSpy()}
            />
          </>
        );
      }
      const view = renderWithMaitai(
        <TestQueryProvider>
          <Gallery />
        </TestQueryProvider>,
      );
      try {
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Download" }));
          fireEvent.click(view.getByRole("button", { name: "Next fixture" }));
          await Promise.resolve();
        });
        expect(save).not.toHaveBeenCalled();
        expect((view.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
          false,
        );
      } finally {
        save.mockRestore();
      }
    });
    test("retries a descriptor-level failure against the current source", async () => {
      const view = renderEditor({
        id: "failed-image",
        alt: "Uploaded reference",
        attachmentSrc: IMAGE_SRC,
        error: "Initial resolution failed",
        source: "uploaded",
        src: IMAGE_SRC,
      });
      expect(view.getByText("Image could not be loaded")).toBeTruthy();

      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Retry" }));
      });

      await waitFor(() =>
        expect(view.getByRole("img", { name: "Uploaded reference" })).toBeTruthy(),
      );
    });

    test("offers the five authored aspect ratios and submits the original image", async () => {
      const onSubmitIntent = createSubmitIntentSpy();
      const image: EditableImageDescriptor = {
        id: "uploaded-image",
        alt: "Uploaded reference",
        attachmentSrc: IMAGE_SRC,
        source: "uploaded",
        src: IMAGE_SRC,
      };
      const view = renderEditor(image, onSubmitIntent);
      expect(view.getAllByRole("button", { name: "Download" })).toHaveLength(1);

      const trigger = await view.findByRole("button", { name: "Resize" });
      await act(async () => {
        fireEvent.pointerDown(trigger, {
          button: 0,
          ctrlKey: false,
        });
        fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
        fireEvent.click(trigger);
        await settleAsyncRender();
      });
      expect(view.getByRole("menuitem", { name: /Square.*1:1/u })).toBeTruthy();
      expect(view.getByRole("menuitem", { name: /Portrait.*3:4/u })).toBeTruthy();
      expect(view.getByRole("menuitem", { name: /Story.*9:16/u })).toBeTruthy();
      expect(view.getByRole("menuitem", { name: /Landscape.*4:3/u })).toBeTruthy();
      expect(view.getByRole("menuitem", { name: /Widescreen.*16:9/u })).toBeTruthy();

      await act(async () => {
        fireEvent.click(view.getByRole("menuitem", { name: /Story.*9:16/u }));
      });
      await waitFor(() => expect(onSubmitIntent).toHaveBeenCalledOnce());
      expect(onSubmitIntent.mock.calls[0]?.[0]).toMatchObject({
        attachmentIds: ["uploaded-image"],
        attachments: [{ image, role: "original" }],
        mode: "resize",
        promptRaw: "Make the aspect ratio 9:16",
      });
    });

    test("submits Remove BG immediately with its own pending state and the original image", async () => {
      let resolveSubmission: ((submitted: boolean) => void) | undefined;
      const submission = new Promise<boolean>((resolve) => {
        resolveSubmission = resolve;
      });
      const onSubmitIntent = vi.fn<(intent: ImageEditSubmissionIntent) => Promise<boolean>>(
        () => submission,
      );
      const image: EditableImageDescriptor = {
        id: "uploaded-image",
        alt: "Uploaded reference",
        attachmentSrc: IMAGE_SRC,
        source: "uploaded",
        src: IMAGE_SRC,
      };
      const view = renderEditor(image, onSubmitIntent);
      const removeBackground = await view.findByRole("button", { name: "Remove BG" });
      const erase = view.getByRole("button", { name: "Erase" });
      const resize = view.getByRole("button", { name: "Resize" });
      expect(
        within(view.getByRole("toolbar", { name: "Image tools" }))
          .getAllByRole("button")
          .map((button) => button.getAttribute("aria-label") ?? button.textContent),
      ).toEqual(["Comment", "Remove BG", "Erase", "Resize"]);

      await act(async () => {
        fireEvent.click(removeBackground);
        await Promise.resolve();
      });

      expect(onSubmitIntent).toHaveBeenCalledOnce();
      expect(onSubmitIntent.mock.calls[0]?.[0]).toMatchObject({
        attachmentIds: ["uploaded-image"],
        attachments: [{ image, role: "original" }],
        mode: "remove_background",
        promptRaw: IMAGE_REMOVE_BACKGROUND_PROMPT,
      });
      expect(removeBackground.getAttribute("aria-busy")).toBe("true");
      expect(resize.getAttribute("aria-busy")).toBeNull();
      expect((erase as HTMLButtonElement).disabled).toBe(true);
      expect((resize as HTMLButtonElement).disabled).toBe(true);

      await act(async () => {
        resolveSubmission?.(true);
        await submission;
      });
      await waitFor(() => expect(removeBackground.getAttribute("aria-busy")).toBeNull());
    });

    test("uses the generated-image loading field without exposing zoom", () => {
      const view = renderEditor({
        id: "pending-generated-image",
        alt: "Generating image…",
        attachmentSrc: "",
        loading: true,
        source: "generated",
        src: "",
      });

      expect(view.getByLabelText("Generating image...")).toBeTruthy();
      expect(view.queryByRole("button", { name: /^Zoom/u })).toBeNull();
      expect((view.getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
    });

    test("opens a trusted local image with its default app and groups secondary actions", async () => {
      const view = renderEditor({
        id: "local-image",
        alt: "Local reference",
        attachmentSrc: IMAGE_SRC,
        downloadSrc: "/tmp/local-reference.png",
        previewSrc: IMAGE_SRC,
        source: "uploaded",
        src: IMAGE_SRC,
      });

      expect(view.queryByRole("button", { name: "Download" })).toBeNull();
      await act(async () => {
        fireEvent.click(view.getByRole("button", { name: "Open image" }));
      });
      expect(invokeCalls).toContainEqual(["shell:open-path-default", "/tmp/local-reference.png"]);

      await act(async () => {
        const trigger = view.getByRole("button", { name: "Open options" });
        fireEvent.pointerDown(trigger, {
          button: 0,
          ctrlKey: false,
        });
        fireEvent.mouseDown(trigger, { button: 0, ctrlKey: false });
        fireEvent.click(trigger);
        await settleAsyncRender();
      });
      await act(async () => {
        fireEvent.click(view.getByRole("menuitem", { name: "Open in folder" }));
      });
      expect(invokeCalls).toContainEqual([
        "shell:open-file-link",
        { path: "/tmp/local-reference.png" },
        "fileManager",
      ]);
    });
  });
});

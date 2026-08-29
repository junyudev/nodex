import { act } from "react";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../../../test/browser-globals";
import { renderWithMaitai, settleAsyncRender } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import { IMAGE_REMOVE_BACKGROUND_PROMPT } from "../model/image-edit-submission";
import type { EditableImageDescriptor, ImageEditSubmissionIntent } from "../model/types";
import { SingleImageEditor } from "./single-image-editor";

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

    await waitFor(() => expect(view.getByRole("img", { name: "Uploaded reference" })).toBeTruthy());
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

    await act(async () => {
      const trigger = await view.findByRole("button", { name: "Resize" });
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

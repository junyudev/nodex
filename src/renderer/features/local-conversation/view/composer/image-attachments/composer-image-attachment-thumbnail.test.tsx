import { fireEvent, render } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import type { ComposerImageAttachment } from "./composer-image-attachment-model";
import { ComposerImageAttachmentThumbnail } from "./composer-image-attachment-thumbnail";

const attachment: ComposerImageAttachment = {
  id: "image-1",
  filename: "diagram.png",
  mimeType: "image/png",
  src: "data:image/png;base64,aW1hZ2U=",
  origin: "paste",
  materialization: null,
  materializationStatus: "pending",
  uploadStatus: "idle",
  generation: 1,
};

describe("ComposerImageAttachmentThumbnail", () => {
  test("opens with click, Enter, and Space using the filename as its accessible name", () => {
    const onOpen = vi.fn();
    const view = render(
      <ComposerImageAttachmentThumbnail
        attachment={attachment}
        previewEnabled
        size={80}
        onOpen={onOpen}
        onRemove={vi.fn()}
      />,
    );
    const trigger = view.getByRole("button", { name: "diagram.png" });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(trigger, { key: " " });

    expect(onOpen).toHaveBeenNthCalledWith(1, "image-1");
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(trigger.getAttribute("data-composer-image-attachment-size")).toBe("80");
  });

  test("removes without opening the preview", () => {
    const onOpen = vi.fn();
    const onRemove = vi.fn();
    const view = render(
      <ComposerImageAttachmentThumbnail
        attachment={attachment}
        previewEnabled
        size={54}
        onOpen={onOpen}
        onRemove={onRemove}
      />,
    );
    const remove = view.getByRole("button", { name: "Remove diagram.png" });

    fireEvent.pointerDown(remove);
    fireEvent.click(remove);

    expect(onRemove).toHaveBeenCalledWith("image-1");
    expect(onOpen).not.toHaveBeenCalled();
    expect(remove.parentElement?.getAttribute("data-composer-image-attachment-size")).toBe("54");
  });

  test("exposes upload progress only for real uploading state", () => {
    const view = render(
      <ComposerImageAttachmentThumbnail
        attachment={{
          ...attachment,
          uploadStatus: "uploading",
          uploadProgress: 42,
        }}
        previewEnabled={false}
        size={80}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(view.queryByRole("button", { name: "diagram.png" })).toBeNull();
    expect(
      view
        .getByRole("progressbar", { name: "Uploading diagram.png" })
        .getAttribute("aria-valuenow"),
    ).toBe("42");
  });

  test("renders a restored local source through the trusted file display URL", () => {
    const view = render(
      <ComposerImageAttachmentThumbnail
        attachment={{
          ...attachment,
          src: "/managed/diagram.png",
          origin: "restored",
          materialization: {
            hostId: "local",
            managedSource: null,
            localPath: "/managed/diagram.png",
          },
          materializationStatus: "ready",
        }}
        previewEnabled
        size={80}
        onOpen={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(view.getByAltText("User attachment").getAttribute("src")).toBe(
      "app://fs/@fs/managed/diagram.png",
    );
  });
});

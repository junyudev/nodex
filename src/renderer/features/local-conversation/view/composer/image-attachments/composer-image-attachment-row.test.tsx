import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { render } from "../../../../../test/dom";
import { TestQueryProvider } from "../../../../../test/query";
import {
  registerUserAttachmentImagePreviewOpener,
  type OpenUserAttachmentImagePreviewOptions,
} from "@/features/user-attachment-image-editor";
import type { ComposerImageAttachment } from "./composer-image-attachment-model";
import {
  ComposerImageAttachmentRow,
  openComposerImageAttachment,
} from "./composer-image-attachment-row";

const attachment: ComposerImageAttachment = {
  id: "image-1",
  filename: "diagram.png",
  mimeType: "image/png",
  src: "data:image/png;base64,aW1hZ2U=",
  origin: "paste",
  materialization: null,
  materializationStatus: "failed",
  uploadStatus: "idle",
  generation: 1,
};

let unregisterOpener: (() => void) | null = null;

afterEach(() => {
  unregisterOpener?.();
  unregisterOpener = null;
});

describe("ComposerImageAttachmentRow", () => {
  test("opens a draft image in the editor through the shared image opener contract", async () => {
    const opened: OpenUserAttachmentImagePreviewOptions[] = [];
    unregisterOpener = registerUserAttachmentImagePreviewOpener(async (options) => {
      opened.push(options);
      return true;
    });

    await expect(
      openComposerImageAttachment({
        attachment,
        attachmentCount: 2,
        composerTarget: {
          channelId: "session:session-1::root",
          placement: "root",
        },
        policy: "image_click",
        projectId: "project-1",
        threadId: "thread-1",
      }),
    ).resolves.toBe(true);

    expect(opened).toEqual([
      {
        alt: "User attachment",
        attachmentSrc: attachment.src,
        attachmentId: "image-1",
        availableImageCount: 2,
        downloadSrc: attachment.src,
        entrypoint: "lightbox_edit_button",
        imageSource: "uploaded",
        openInEditor: true,
        policy: "image_click",
        previewSrc: attachment.src,
        projectId: "project-1",
        src: attachment.src,
        threadId: "thread-1",
        title: "User attachment",
        composerTarget: {
          channelId: "session:session-1::root",
          placement: "root",
        },
        dataUrl: attachment.src,
      },
    ]);
  });

  test("a thumbnail opens the preview, which moves across the draft and hands Edit to the editor", async () => {
    const second: ComposerImageAttachment = {
      ...attachment,
      id: "image-2",
      filename: "screen.png",
      src: "data:image/png;base64,c2NyZWVu",
    };
    const onEdit = vi.fn();
    const view = render(
      <TestQueryProvider>
        <ComposerImageAttachmentRow
          attachments={[attachment, second]}
          controller={{ remove: vi.fn() }}
          hasVisibleNonImageAttachments={false}
          onEdit={onEdit}
        />
      </TestQueryProvider>,
    );
    const trigger = view.getByRole("button", { name: "diagram.png" });

    await act(async () => {
      trigger.focus();
      fireEvent.click(trigger);
      await Promise.resolve();
    });
    expect(await view.findByRole("img", { name: "diagram.png" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Previous image" })).toBeNull();
    expect(onEdit).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Next image" }));
      await Promise.resolve();
    });
    expect(await view.findByRole("img", { name: "screen.png" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Edit image" }));
      await Promise.resolve();
    });
    expect(onEdit).toHaveBeenCalledWith(second);
    await waitFor(() => expect(view.queryByRole("dialog", { name: "Image preview" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test("a preview without an editor offers no Edit action", async () => {
    const view = render(
      <TestQueryProvider>
        <ComposerImageAttachmentRow
          attachments={[attachment]}
          controller={{ remove: vi.fn() }}
          hasVisibleNonImageAttachments={false}
        />
      </TestQueryProvider>,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "diagram.png" }));
      await Promise.resolve();
    });
    expect(await view.findByRole("dialog", { name: "Image preview" })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Edit image" })).toBeNull();
  });
});

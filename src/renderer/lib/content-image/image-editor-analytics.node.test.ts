import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { recordProductEvent } from "@/lib/product-analytics";
import {
  trackImageEditorPinOutcome,
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
  trackImageToolOpen,
  trackImageView,
} from "./image-editor-analytics";

vi.mock("@/lib/product-analytics", () => ({
  recordProductEvent: vi.fn(),
}));

beforeEach(() => vi.mocked(recordProductEvent).mockClear());

describe("image editor analytics", () => {
  test("maps view entrypoint and source without including image content", () => {
    trackImageView({
      availableImageCount: 4,
      entrypoint: "canvas_button",
      imageSource: "generated",
      view: "canvas",
    });

    expect(recordProductEvent).toHaveBeenCalledWith({
      name: "image_view",
      properties: {
        available_image_count: 4,
        entrypoint: "canvas_button",
        image_source: "generated",
        view: "canvas",
      },
    });
  });

  test("records tool and submission counts with no prompt or attachment data", () => {
    trackImageToolOpen({
      imageSource: "uploaded",
      mode: "remove",
      view: "single",
    });
    trackImageEditSubmit({
      commentCount: 3,
      hasGeneralInstruction: true,
      imageSource: "generated",
      mode: "comment",
      selectedImageCount: 2,
    });

    expect(recordProductEvent).toHaveBeenNthCalledWith(1, {
      name: "image_edit_entered",
      properties: {
        image_source: "uploaded",
        mode: "remove",
        view: "single",
      },
    });
    expect(recordProductEvent).toHaveBeenNthCalledWith(2, {
      name: "image_edit_submitted",
      properties: {
        comment_count: 3,
        has_general_instruction: true,
        image_source: "generated",
        mode: "comment",
        selected_image_count: 2,
      },
    });
  });

  test("records categorical submit and durable-pin outcomes without private data", () => {
    trackImageEditSubmitOutcome({
      failureReason: "composer-unmounted",
      imageSource: "uploaded",
      mode: "remove",
      outcome: "unavailable",
      route: "new_thread",
    });
    trackImageEditorPinOutcome({
      entrypoint: "lightbox_edit_button",
      imageSource: "generated",
      outcome: "pinned",
    });

    expect(recordProductEvent).toHaveBeenNthCalledWith(1, {
      name: "image_edit_submit_outcome",
      properties: {
        failure_reason: "composer-unmounted",
        image_source: "uploaded",
        mode: "remove",
        outcome: "unavailable",
        route: "new_thread",
      },
    });
    expect(recordProductEvent).toHaveBeenNthCalledWith(2, {
      name: "image_editor_pin_outcome",
      properties: {
        entrypoint: "lightbox_edit_button",
        image_source: "generated",
        outcome: "pinned",
        reason: undefined,
      },
    });
  });
});

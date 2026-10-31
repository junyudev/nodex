import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { logTelemetryEvent } from "@/lib/statsig-telemetry";
import {
  trackImageEditorPinOutcome,
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
  trackImageToolOpen,
  trackImageView,
} from "./image-editor-analytics";

vi.mock("@/lib/statsig-telemetry", () => ({
  logTelemetryEvent: vi.fn(),
}));

beforeEach(() => vi.mocked(logTelemetryEvent).mockClear());

describe("image editor analytics", () => {
  test("maps view entrypoint and source without including image content", () => {
    trackImageView({
      availableImageCount: 4,
      entrypoint: "canvas_button",
      imageSource: "generated",
      view: "canvas",
    });

    expect(logTelemetryEvent).toHaveBeenCalledWith("image_view", undefined, {
      available_image_count: 4,
      entrypoint: "canvas_button",
      image_source: "generated",
      view: "canvas",
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

    expect(logTelemetryEvent).toHaveBeenNthCalledWith(1, "image_edit_entered", undefined, {
      image_source: "uploaded",
      mode: "remove",
      view: "single",
    });
    expect(logTelemetryEvent).toHaveBeenNthCalledWith(2, "image_edit_submitted", undefined, {
      comment_count: 3,
      has_general_instruction: true,
      image_source: "generated",
      mode: "comment",
      selected_image_count: 2,
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

    expect(logTelemetryEvent).toHaveBeenNthCalledWith(1, "image_edit_submit_outcome", undefined, {
      failure_reason: "composer-unmounted",
      image_source: "uploaded",
      mode: "remove",
      outcome: "unavailable",
      route: "new_thread",
    });
    expect(logTelemetryEvent).toHaveBeenNthCalledWith(2, "image_editor_pin_outcome", undefined, {
      entrypoint: "lightbox_edit_button",
      image_source: "generated",
      outcome: "pinned",
      reason: undefined,
    });
  });
});

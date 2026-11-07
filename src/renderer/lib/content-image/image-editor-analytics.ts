import { recordProductEvent } from "@/lib/product-analytics";
import type { ImageEditMode, ImagePreviewEntrypoint, ImageSourceClassification } from "./types";

export type ImageAnalyticsView = "canvas" | "preview_dialog" | "single";

export interface ImageViewAnalytics {
  availableImageCount: number;
  entrypoint: ImagePreviewEntrypoint;
  imageSource: ImageSourceClassification;
}

export function trackImageView(input: ImageViewAnalytics & { view: ImageAnalyticsView }): void {
  recordProductEvent({
    name: "image_view",
    properties: {
      available_image_count: input.availableImageCount,
      entrypoint: input.entrypoint,
      image_source: input.imageSource,
      view: input.view,
    },
  });
}

export function trackImageToolOpen(input: {
  imageSource: ImageSourceClassification;
  mode: ImageEditMode;
  view: Exclude<ImageAnalyticsView, "preview_dialog">;
}): void {
  recordProductEvent({
    name: "image_edit_entered",
    properties: {
      image_source: input.imageSource,
      mode: input.mode,
      view: input.view,
    },
  });
}

export function trackImageEditSubmit(input: {
  commentCount?: number;
  hasGeneralInstruction: boolean;
  imageSource: ImageSourceClassification;
  mode: ImageEditMode;
  selectedImageCount: number;
}): void {
  recordProductEvent({
    name: "image_edit_submitted",
    properties: {
      comment_count: input.commentCount,
      has_general_instruction: input.hasGeneralInstruction,
      image_source: input.imageSource,
      mode: input.mode,
      selected_image_count: input.selectedImageCount,
    },
  });
}

export type ImageEditSubmitRoute = "existing_thread" | "new_thread" | "queued";

export function trackImageEditSubmitOutcome(input: {
  failureReason?:
    | "asset-unresolvable"
    | "composer-unmounted"
    | "image-input-unsupported"
    | "transport";
  imageSource: ImageSourceClassification;
  mode: ImageEditMode;
  outcome: "failed" | "queued" | "submitted" | "unavailable";
  route: ImageEditSubmitRoute;
}): void {
  recordProductEvent({
    name: "image_edit_submit_outcome",
    properties: {
      failure_reason: input.failureReason,
      image_source: input.imageSource,
      mode: input.mode,
      outcome: input.outcome,
      route: input.route,
    },
  });
}

export function trackImageEditorPinOutcome(input: {
  entrypoint: ImagePreviewEntrypoint;
  imageSource: ImageSourceClassification;
  outcome: "failed" | "pinned";
  reason?: "asset-materialization" | "scene-create";
}): void {
  recordProductEvent({
    name: "image_editor_pin_outcome",
    properties: {
      entrypoint: input.entrypoint,
      image_source: input.imageSource,
      outcome: input.outcome,
      reason: input.reason,
    },
  });
}

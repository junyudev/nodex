import { logTelemetryEvent } from "@/lib/statsig-telemetry";
import type { ImageEditMode, ImagePreviewEntrypoint, ImageSourceClassification } from "./types";

export type ImageAnalyticsView = "canvas" | "preview_dialog" | "single";

export interface ImageViewAnalytics {
  availableImageCount: number;
  entrypoint: ImagePreviewEntrypoint;
  imageSource: ImageSourceClassification;
}

export function trackImageView(input: ImageViewAnalytics & { view: ImageAnalyticsView }): void {
  logTelemetryEvent("image_view", undefined, {
    available_image_count: input.availableImageCount,
    entrypoint: input.entrypoint,
    image_source: input.imageSource,
    view: input.view,
  });
}

export function trackImageToolOpen(input: {
  imageSource: ImageSourceClassification;
  mode: ImageEditMode;
  view: Exclude<ImageAnalyticsView, "preview_dialog">;
}): void {
  logTelemetryEvent("image_edit_entered", undefined, {
    image_source: input.imageSource,
    mode: input.mode,
    view: input.view,
  });
}

export function trackImageEditSubmit(input: {
  commentCount?: number;
  hasGeneralInstruction: boolean;
  imageSource: ImageSourceClassification;
  mode: ImageEditMode;
  selectedImageCount: number;
}): void {
  logTelemetryEvent("image_edit_submitted", undefined, {
    comment_count: input.commentCount,
    has_general_instruction: input.hasGeneralInstruction,
    image_source: input.imageSource,
    mode: input.mode,
    selected_image_count: input.selectedImageCount,
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
  logTelemetryEvent("image_edit_submit_outcome", undefined, {
    failure_reason: input.failureReason,
    image_source: input.imageSource,
    mode: input.mode,
    outcome: input.outcome,
    route: input.route,
  });
}

export function trackImageEditorPinOutcome(input: {
  entrypoint: ImagePreviewEntrypoint;
  imageSource: ImageSourceClassification;
  outcome: "failed" | "pinned";
  reason?: "asset-materialization" | "scene-create";
}): void {
  logTelemetryEvent("image_editor_pin_outcome", undefined, {
    entrypoint: input.entrypoint,
    image_source: input.imageSource,
    outcome: input.outcome,
    reason: input.reason,
  });
}

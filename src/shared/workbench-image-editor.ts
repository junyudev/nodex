export type WorkbenchImageEditorEntrypoint =
  | "canvas_button"
  | "gallery_edit_button"
  | "image_click"
  | "lightbox_edit_button"
  | "view_toggle";

export type WorkbenchImageEditorSource = "uploaded" | "generated";
export type WorkbenchImageEditorView = "single" | "playground";
export type WorkbenchImageEditorPlaygroundTool = "navigate" | "comment" | "select";

export type WorkbenchImageEditorReferrerPolicy =
  | ""
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

/** A locator that remains meaningful after renderer and window restarts. */
export type WorkbenchImageAssetLocator =
  | {
      readonly kind: "managed";
      readonly source: string;
    }
  | {
      readonly kind: "local";
      readonly hostId: string;
      readonly path: string;
    }
  | {
      readonly kind: "pointer";
      readonly pointer: string;
    }
  | {
      readonly kind: "remote";
      readonly url: string;
    };

export interface WorkbenchImageEditorComposerTargetConfig {
  readonly channelId: string;
  readonly placement: "root" | "side";
}

export interface WorkbenchImageEditorImageConfig {
  readonly id: string;
  readonly alt: string;
  readonly source: WorkbenchImageEditorSource;
  readonly locator: WorkbenchImageAssetLocator;
  readonly attachmentId?: string;
  readonly generatedOrdinal?: number;
  readonly groupId?: string;
  readonly height?: number;
  readonly referrerPolicy?: WorkbenchImageEditorReferrerPolicy;
  readonly tabTitle?: string;
  readonly turnId?: string;
  readonly turnStartedAtMs?: number;
  readonly width?: number;
}

/** Durable Scene payload. Transient drafts, bitmap masks, and object URLs are excluded. */
export interface WorkbenchImageEditorSurfaceConfig {
  readonly readOnly?: boolean;
  readonly availableImageCount: number;
  readonly composerTarget: WorkbenchImageEditorComposerTargetConfig | null;
  readonly entrypoint: WorkbenchImageEditorEntrypoint;
  readonly imageSource: WorkbenchImageEditorSource;
  readonly images: readonly WorkbenchImageEditorImageConfig[];
  readonly initialImageId: string;
  readonly initialPlaygroundTool: WorkbenchImageEditorPlaygroundTool;
  readonly initialView: WorkbenchImageEditorView;
  readonly projectId: string | null;
  readonly threadId: string | null;
  readonly tooltip: string;
}

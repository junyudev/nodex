export type ImageEditorFeaturePolicy = "disabled" | "image_click" | "edit_button";

export type ImagePreviewEntrypoint =
  | "canvas_button"
  | "gallery_edit_button"
  | "image_click"
  | "lightbox_edit_button"
  | "view_toggle";

export type ImageSourceClassification = "uploaded" | "generated";

export type ImageEditorView = "single" | "playground";

export type PlaygroundTool = "navigate" | "comment" | "select";

export type ImageEditMode = "comment" | "remove" | "remove_background" | "resize" | "select";

/** Stable, serializable identity for the mounted Composer that owns image edits. */
export interface ImageEditComposerTarget {
  readonly channelId: string;
  readonly placement: "root" | "side";
}

export type ImageReferrerPolicy =
  | ""
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

export interface EditableImageDescriptor {
  id: string;
  alt: string;
  src: string;
  attachmentSrc: string;
  source: ImageSourceClassification;
  previewSrc?: string;
  downloadSrc?: string;
  localPath?: string;
  managedSource?: string;
  hostId?: string;
  dataUrl?: string;
  attachmentId?: string;
  assetPointer?: unknown;
  tabTitle?: string;
  width?: number;
  height?: number;
  referrerPolicy?: ImageReferrerPolicy;
  loading?: boolean;
  error?: string | true;
  turnId?: string;
  turnStartedAtMs?: number;
}

export interface GeneratedImageDescriptor extends EditableImageDescriptor {
  source: "generated";
  generatedOrdinal: number;
  groupId: string;
  status: "loading" | "ready" | "failed";
}

export interface OpenUserAttachmentImagePreviewOptions {
  alt: string;
  attachmentSrc: string;
  src: string;
  attachmentId?: string;
  availableImageCount?: number;
  composerTarget?: ImageEditComposerTarget;
  dataUrl?: string;
  downloadSrc?: string;
  entrypoint?: ImagePreviewEntrypoint;
  generatedImages?: readonly GeneratedImageDescriptor[];
  /** Mounted ordinary image collection; it does not imply a generated-image result. */
  images?: readonly EditableImageDescriptor[];
  imageSource?: ImageSourceClassification;
  initialImageId?: string;
  initialPlaygroundTool?: PlaygroundTool;
  initialView?: ImageEditorView;
  openInEditor?: boolean;
  readOnly?: boolean;
  policy?: ImageEditorFeaturePolicy;
  hostId?: string;
  localPath?: string;
  managedSource?: string;
  previewSrc?: string;
  projectId?: string | null;
  referrerPolicy?: ImageReferrerPolicy;
  threadId?: string | null;
  title?: string;
  tooltip?: string;
}

/** Fully serializable state stored by an ephemeral Workbench image tab. */
export interface NormalizedUserAttachmentImageEditorOptions {
  availableImageCount: number;
  composerTarget: ImageEditComposerTarget | null;
  entrypoint: ImagePreviewEntrypoint;
  generatedImages: readonly GeneratedImageDescriptor[] | null;
  imageSource: ImageSourceClassification;
  images: readonly EditableImageDescriptor[];
  initialImageId: string;
  initialPlaygroundTool: PlaygroundTool;
  initialView: ImageEditorView;
  openInEditor: boolean;
  readOnly?: boolean;
  policy: ImageEditorFeaturePolicy;
  projectId: string | null;
  referrerPolicy?: ImageReferrerPolicy;
  threadId: string | null;
  title: string;
  tooltip: string;
}

export interface ImageEditAttachmentInput {
  attachmentId: string;
  image: EditableImageDescriptor;
  role: "original" | "mask" | "selected";
}

export interface ImageEditSubmissionIntent {
  analytics: {
    commentCount?: number;
    hasGeneralInstruction: boolean;
    selectedImageCount: number;
  };
  attachmentIds: readonly string[];
  attachments: readonly ImageEditAttachmentInput[];
  entrypoint: ImagePreviewEntrypoint;
  focusComposerAfterSubmit: true;
  isImageEditFollowUp: true;
  mode: ImageEditMode;
  promptRaw: string;
  queuePolicy: "queue-while-active";
}

export type ComposerImageAttachmentOrigin =
  | "picker"
  | "paste"
  | "drop"
  | "browser"
  | "conversation"
  | "image-editor"
  | "restored";

export interface ResolvedComposerImageInput {
  readonly id?: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly src: string;
  readonly origin: Extract<
    ComposerImageAttachmentOrigin,
    "browser" | "conversation" | "image-editor" | "picker" | "restored"
  >;
  readonly localPath?: string | null;
  readonly managedSource?: string | null;
  readonly hostId?: string | null;
}

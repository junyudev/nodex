export type ImageEditorFeaturePolicy = "disabled" | "image_click" | "edit_button";

export type ImagePreviewEntrypoint =
  | "canvas_button"
  | "gallery_edit_button"
  | "image_click"
  | "lightbox_edit_button"
  | "view_toggle";

export type ImageSourceClassification = "uploaded" | "generated";
export type ImageEditorView = "single" | "playground";
export type SingleImageTool = "navigate" | "comment" | "remove";
export type PlaygroundTool = "navigate" | "comment" | "select";
export type ImageEditMode = "comment" | "remove" | "remove_background" | "resize" | "select";
export type ImageAspectRatio = "1:1" | "3:4" | "9:16" | "4:3" | "16:9";

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

export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageComment extends ImagePoint {
  id: string;
  text: string;
}

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
  imageSource?: ImageSourceClassification;
  initialImageId?: string;
  initialPlaygroundTool?: PlaygroundTool;
  initialView?: ImageEditorView;
  openInEditor?: boolean;
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
  policy: ImageEditorFeaturePolicy;
  projectId: string | null;
  referrerPolicy?: ImageReferrerPolicy;
  threadId: string | null;
  title: string;
  tooltip: string;
}

export interface CommentEditorLayoutMetrics extends ImagePoint {
  editorMaxX: number;
  editorMaxY: number;
  editorMinX: number;
  editorMinY: number;
  surfaceHeight: number;
  surfaceWidth: number;
}

export interface CommentEditorPlacement {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface ImageCommentGroup {
  comments: readonly ImageComment[];
  imageNumber: number;
}

export interface RemoveStroke {
  brushSize: number;
  points: readonly ImagePoint[];
}

export interface RemoveHistory {
  committed: readonly RemoveStroke[];
  redo: readonly RemoveStroke[];
}

export type RemoveMaskDrawingCommand =
  | {
      kind: "circle";
      center: ImagePoint;
      diameter: number;
    }
  | {
      kind: "line";
      from: ImagePoint;
      lineCap: "round";
      lineJoin: "round";
      lineWidth: number;
      to: ImagePoint;
    };

export interface RemoveMaskDrawingPlan {
  background: "black";
  commands: readonly RemoveMaskDrawingCommand[];
  height: number;
  mimeType: "image/png";
  strokeColor: "white";
  suggestedFilename: "image-mask.png";
  width: number;
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

export interface GeneratedImageCollectionState {
  activeImageId: string | null;
  images: readonly GeneratedImageDescriptor[];
  selectedImageIds: readonly string[];
}

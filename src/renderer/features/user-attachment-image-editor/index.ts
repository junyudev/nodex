export { ImageEditorTabIcon } from "@/components/shared/icons";
export {
  trackImageEditorPinOutcome,
  trackImageEditSubmit,
  trackImageEditSubmitOutcome,
  trackImageToolOpen,
  trackImageView,
  type ImageAnalyticsView,
  type ImageViewAnalytics,
} from "./analytics/image-editor-analytics";
export {
  openUserAttachmentImagePreview,
  registerUserAttachmentImagePreviewOpener,
  type UserAttachmentImagePreviewOpener,
} from "./adapters/image-preview-opener-registry";
export {
  blobToDataUrl,
  buildImageDataUrl,
  classifyImageAssetSource,
  createImageDownloadFilename,
  dataUrlToBlob,
  downloadImageDataUrl,
  fetchImageSourceAsDataUrl,
  materializeImageSourceAsDataUrl,
  resolveImageDisplaySource,
  sanitizeImageDownloadFilename,
  type ClassifiedImageAssetSource,
  type ImageAssetMaterializationDependencies,
  type ImageAssetSourceKind,
} from "./adapters/resolved-image-asset";
export {
  useResolvedImageAsset,
  type ResolvedImageAsset,
} from "./adapters/use-resolved-image-asset";
export {
  createWorkbenchImageEditorSurfaceConfig,
  materializeWorkbenchImageEditorSurfaceConfig,
  resolveWorkbenchImageAssetLocator,
  restoreNormalizedImageEditorOptions,
} from "./adapters/durable-image-editor";
export {
  areGeneratedImageLiveGroupsEqual,
  beginOptimisticGeneratedImageEdit,
  clearOptimisticGeneratedImageEdits,
  getGeneratedImageLiveCollectionSnapshot,
  projectGeneratedImageCanonicalGroups,
  replaceGeneratedImageCanonicalGroups,
  replaceGeneratedImageLiveGroup,
  subscribeGeneratedImageLiveCollections,
  type GeneratedImageLiveGroupInput,
} from "./adapters/generated-image-collection-store";
export {
  normalizeUserAttachmentImageEditorOptions,
  resolveImageInputSupport,
  resolveImagePreviewOpenDisposition,
} from "./model/feature-policy";
export {
  formatGeneratedImageGroupTime,
  isGeneratedImageTileEmphasized,
} from "./model/generated-image-canvas-presentation";
export type {
  EditableImageDescriptor,
  GeneratedImageDescriptor,
  ImageAspectRatio,
  ImageComment,
  ImageEditSubmissionIntent,
  ImageEditComposerTarget,
  ImageEditorFeaturePolicy,
  ImageEditorView,
  ImagePreviewEntrypoint,
  ImageSourceClassification,
  NormalizedUserAttachmentImageEditorOptions,
  OpenUserAttachmentImagePreviewOptions,
  PlaygroundTool,
  SingleImageTool,
} from "./model/types";
export {
  UserAttachmentImageEditorSurface,
  type UserAttachmentImageEditorSurfaceProps,
} from "./view/user-attachment-image-editor-surface";
export { ImagePreviewDialog, type ImagePreviewDialogProps } from "./view/image-preview-dialog";
export {
  GeneratedImageDotField,
  GeneratedImagePlaceholder,
} from "./view/generated-image-dot-field";

export { useGeneratedImageCollectionGroups } from "./adapters/use-generated-image-collection-groups";

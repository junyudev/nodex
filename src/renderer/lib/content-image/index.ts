/**
 * Images in content: what a source names, where it reads from inside its `ContentImageScope`, its
 * bytes, its actions, and how it opens in the image viewer or editor. Surfaces render images;
 * this Module owns everything that turns an authored source into one.
 */
export {
  CODEX_IMAGE_ASSET_STALE_TIME_MS,
  type CodexConversationImageAssetData,
  CodexConversationImageAssetError,
  codexConversationImageAssetQueryOptions,
  isCodexImageAssetPointer,
  parseAbsoluteImagePath,
  shouldRetryCodexImageAssetQuery,
} from "./codex-image-pointers";
export {
  CONTENT_IMAGE_GC_TIME_MS,
  readContentImage,
  requiresContentImageRead,
} from "./content-image-read";
export {
  type ContentImageScope,
  ContentImageScopeProvider,
  THIS_COMPUTER_IMAGE_SCOPE,
  useContentImageScope,
} from "./content-image-scope";
export {
  type ConversationImageAction,
  conversationImageWebAddress,
  createConversationImageActions,
} from "./image-actions";
export {
  type ImageAssetMaterializationDependencies,
  ImageAssetResolutionError,
  blobToDataUrl,
  buildImageDataUrl,
  createImageDownloadFilename,
  dataUrlToBlob,
  downloadImageDataUrl,
  fetchImageSourceAsDataUrl,
  materializeImageSourceAsDataUrl,
  sanitizeImageDownloadFilename,
} from "./image-bytes";
export {
  type UserAttachmentImagePreviewOpener,
  openUserAttachmentImagePreview,
  registerUserAttachmentImagePreviewOpener,
} from "./image-preview-opener";
export {
  type ClassifiedImageAssetSource,
  type ImageAssetSourceKind,
  classifyImageAssetSource,
  resolveImageDisplaySource,
} from "./image-source";
export {
  type ConversationMediaKind,
  type ConversationMediaTarget,
  classifyConversationMedia,
  conversationMediaBadge,
  conversationMediaCachePolicy,
  conversationMediaDataUrl,
  conversationMediaFilename,
  conversationMediaMimeType,
  resolveConversationMediaTarget,
} from "./media-target";
export {
  type ComposerImageAttachmentOrigin,
  type EditableImageDescriptor,
  type GeneratedImageDescriptor,
  type ImageEditAttachmentInput,
  type ImageEditComposerTarget,
  type ImageEditMode,
  type ImageEditSubmissionIntent,
  type ImageEditorFeaturePolicy,
  type ImageEditorView,
  type ImagePreviewEntrypoint,
  type ImageReferrerPolicy,
  type ImageSourceClassification,
  type NormalizedUserAttachmentImageEditorOptions,
  type OpenUserAttachmentImagePreviewOptions,
  type PlaygroundTool,
  type ResolvedComposerImageInput,
} from "./types";
export { type ContentImage, useContentImage } from "./use-content-image";
export {
  type ResolvedImageAsset,
  type UseResolvedImageAssetOptions,
  useResolvedImageAsset,
} from "./use-resolved-image-asset";
export {
  resolveWorkbenchImageAssetLocator,
  createWorkbenchImageEditorSurfaceConfig,
  type DurableImageEditorMaterializationAdapters,
  materializeWorkbenchImageEditorSurfaceConfig,
  restoreNormalizedImageEditorOptions,
} from "./image-editor-surface";
export {
  resolveImageInputSupport,
  type ImagePreviewRouteKind,
  type ImagePreviewOpenDisposition,
  normalizeUserAttachmentImageEditorOptions,
  resolveImagePreviewOpenDisposition,
} from "./image-preview-policy";
export {
  type ImageAnalyticsView,
  type ImageViewAnalytics,
  trackImageView,
  trackImageToolOpen,
  trackImageEditSubmit,
  type ImageEditSubmitRoute,
  trackImageEditSubmitOutcome,
  trackImageEditorPinOutcome,
} from "./image-editor-analytics";

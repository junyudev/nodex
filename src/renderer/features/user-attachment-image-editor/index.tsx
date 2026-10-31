import { lazy, type ComponentProps } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";

export { ImageEditorTabIcon } from "@/components/shared/icons";

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
  formatGeneratedImageGroupTime,
  isGeneratedImageTileEmphasized,
} from "./model/generated-image-canvas-presentation";
export type { ImageAspectRatio, ImageComment, SingleImageTool } from "./model/types";
export type { UserAttachmentImageEditorSurfaceProps } from "./view/user-attachment-image-editor-surface";
export { ImagePreviewDialog, type ImagePreviewDialogProps } from "./view/image-preview-dialog";
export {
  GeneratedImageDotField,
  GeneratedImagePlaceholder,
} from "./view/generated-image-dot-field";

export { useGeneratedImageCollectionGroups } from "./adapters/use-generated-image-collection-groups";
const ImageEditorSurface = lazy(async () => ({
  default: (await import("./view/user-attachment-image-editor-surface"))
    .UserAttachmentImageEditorSurface,
}));

export function UserAttachmentImageEditorSurface(props: ComponentProps<typeof ImageEditorSurface>) {
  return (
    <ApplicationSurface>
      <ImageEditorSurface {...props} />
    </ApplicationSurface>
  );
}

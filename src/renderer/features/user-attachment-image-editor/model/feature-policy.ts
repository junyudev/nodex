import type {
  EditableImageDescriptor,
  ImageSourceClassification,
  NormalizedUserAttachmentImageEditorOptions,
  OpenUserAttachmentImagePreviewOptions,
} from "./types";
import type { CodexModelOption } from "../../../../shared/types";

/** Unknown catalogs stay permissive; a known model must advertise image input. */
export function resolveImageInputSupport(args: {
  models: readonly CodexModelOption[];
  selectedModel: string | null;
}): boolean {
  if (!args.selectedModel) return true;
  const model = args.models.find(
    (candidate) => candidate.id === args.selectedModel || candidate.model === args.selectedModel,
  );
  return model?.inputModalities.includes("image") ?? true;
}

export type ImagePreviewRouteKind = "local-thread" | "other";
export type ImagePreviewOpenDisposition = "disabled" | "preview_dialog" | "editor";

const DEFAULT_TITLE = "User attachment";

function resolveImageSource(
  options: OpenUserAttachmentImagePreviewOptions,
): ImageSourceClassification {
  if (options.generatedImages !== undefined) return "generated";
  if (options.attachmentId?.startsWith("image-playground:") === true) return "generated";
  return options.imageSource ?? "uploaded";
}

function createFallbackImage(
  options: OpenUserAttachmentImagePreviewOptions,
  source: ImageSourceClassification,
): EditableImageDescriptor {
  const referrerPolicy =
    options.referrerPolicy ?? (source === "generated" ? "no-referrer" : undefined);

  return {
    id: options.attachmentId ?? options.attachmentSrc,
    alt: options.alt,
    src: options.src,
    attachmentSrc: options.attachmentSrc,
    source,
    attachmentId: options.attachmentId,
    dataUrl: options.dataUrl,
    hostId: options.hostId,
    localPath: options.localPath,
    managedSource: options.managedSource,
    previewSrc: options.previewSrc ?? options.src,
    downloadSrc: options.downloadSrc ?? options.src,
    referrerPolicy,
  };
}

/** Applies opener defaults once before serializing options into a Workbench tab. */
export function normalizeUserAttachmentImageEditorOptions(
  options: OpenUserAttachmentImagePreviewOptions,
): NormalizedUserAttachmentImageEditorOptions {
  const imageSource = resolveImageSource(options);
  const fallbackImage = createFallbackImage(options, imageSource);
  const generatedImages = options.generatedImages ?? null;
  const images =
    generatedImages !== null && generatedImages.length > 0 ? generatedImages : [fallbackImage];
  const initialImageId = options.initialImageId ?? images[0]?.id ?? fallbackImage.id;
  const initialView = generatedImages !== null ? (options.initialView ?? "single") : "single";
  const title =
    options.title ?? images.find((image) => image.id === initialImageId)?.tabTitle ?? DEFAULT_TITLE;

  return {
    availableImageCount: options.availableImageCount ?? 1,
    composerTarget: options.composerTarget ?? null,
    entrypoint: options.entrypoint ?? "image_click",
    generatedImages,
    imageSource,
    images,
    initialImageId,
    initialPlaygroundTool: options.initialPlaygroundTool ?? "navigate",
    initialView,
    openInEditor: options.openInEditor ?? false,
    policy: options.policy ?? "edit_button",
    projectId: options.projectId ?? null,
    referrerPolicy:
      options.referrerPolicy ?? (imageSource === "generated" ? "no-referrer" : undefined),
    threadId: options.threadId ?? null,
    title,
    tooltip: options.tooltip ?? title,
  };
}

/** Decides only the opener surface; Workbench and dialog owners perform the effect. */
export function resolveImagePreviewOpenDisposition(
  options: Pick<NormalizedUserAttachmentImageEditorOptions, "openInEditor" | "policy">,
  routeKind: ImagePreviewRouteKind,
): ImagePreviewOpenDisposition {
  if (options.policy === "disabled") return "disabled";
  if (options.policy !== "edit_button") return "editor";
  if (routeKind !== "local-thread") return "editor";
  if (options.openInEditor) return "editor";
  return "preview_dialog";
}

import { defineMessages, type MessageDescriptor } from "@/lib/i18n";
import { serializeImageCommentGroups } from "./comment-serialization";
import type { ImageCommentLocale } from "./comment-serialization";
import type {
  EditableImageDescriptor,
  ImageEditAttachmentInput,
  ImageEditMode,
  ImageEditSubmissionIntent,
  ImagePreviewEntrypoint,
} from "@/lib/content-image";
import type { ImageAspectRatio, ImageComment } from "./types";

export const IMAGE_REMOVE_PROMPT =
  "Remove the area marked in the second image from the first image";

export const IMAGE_REMOVE_BACKGROUND_PROMPT =
  "Remove the background from this image. Keep all foreground subjects unchanged and fully intact, with clean, smooth edges. Make the background transparent.";

export const IMAGE_ASPECT_RATIO_LABELS = defineMessages({
  "1:1": {
    id: "imageEditor.imageEditSubmission.square",
    defaultMessage: "Square",
  },
  "3:4": {
    id: "imageEditor.imageEditSubmission.portrait",
    defaultMessage: "Portrait",
  },
  "9:16": {
    id: "imageEditor.imageEditSubmission.story",
    defaultMessage: "Story",
  },
  "4:3": {
    id: "imageEditor.imageEditSubmission.landscape",
    defaultMessage: "Landscape",
  },
  "16:9": {
    id: "imageEditor.imageEditSubmission.widescreen",
    defaultMessage: "Widescreen",
  },
} satisfies Record<ImageAspectRatio, MessageDescriptor & { defaultMessage: string }>);

export const IMAGE_ASPECT_RATIO_OPTIONS = (["1:1", "3:4", "9:16", "4:3", "16:9"] as const).map(
  (ratio) => ({ label: IMAGE_ASPECT_RATIO_LABELS[ratio].defaultMessage, ratio }),
);

export interface CommentedImageInput {
  comments: readonly ImageComment[];
  image: EditableImageDescriptor;
}

function resolveAttachmentId(image: EditableImageDescriptor): string {
  return image.attachmentId ?? image.id;
}

function createAttachmentInput(
  image: EditableImageDescriptor,
  role: ImageEditAttachmentInput["role"],
): ImageEditAttachmentInput {
  return {
    attachmentId: resolveAttachmentId(image),
    image,
    role,
  };
}

function createImageEditSubmissionIntent(args: {
  analytics: ImageEditSubmissionIntent["analytics"];
  attachments: readonly ImageEditAttachmentInput[];
  entrypoint: ImagePreviewEntrypoint;
  mode: ImageEditMode;
  promptRaw: string;
}): ImageEditSubmissionIntent {
  return {
    analytics: args.analytics,
    attachmentIds: args.attachments.map((attachment) => attachment.attachmentId),
    attachments: args.attachments,
    entrypoint: args.entrypoint,
    focusComposerAfterSubmit: true,
    isImageEditFollowUp: true,
    mode: args.mode,
    promptRaw: args.promptRaw,
    queuePolicy: "queue-while-active",
  };
}

export function buildImageResizePrompt(aspectRatio: ImageAspectRatio): string {
  return `Make the aspect ratio ${aspectRatio}`;
}

export function buildResizeSubmissionIntent(args: {
  aspectRatio: ImageAspectRatio;
  entrypoint: ImagePreviewEntrypoint;
  image: EditableImageDescriptor;
}): ImageEditSubmissionIntent {
  return createImageEditSubmissionIntent({
    analytics: {
      hasGeneralInstruction: false,
      selectedImageCount: 1,
    },
    attachments: [createAttachmentInput(args.image, "original")],
    entrypoint: args.entrypoint,
    mode: "resize",
    promptRaw: buildImageResizePrompt(args.aspectRatio),
  });
}

export function buildRemoveBackgroundSubmissionIntent(args: {
  entrypoint: ImagePreviewEntrypoint;
  image: EditableImageDescriptor;
}): ImageEditSubmissionIntent {
  return createImageEditSubmissionIntent({
    analytics: {
      hasGeneralInstruction: false,
      selectedImageCount: 1,
    },
    attachments: [createAttachmentInput(args.image, "original")],
    entrypoint: args.entrypoint,
    mode: "remove_background",
    promptRaw: IMAGE_REMOVE_BACKGROUND_PROMPT,
  });
}

export function buildRemoveSubmissionIntent(args: {
  entrypoint: ImagePreviewEntrypoint;
  image: EditableImageDescriptor;
  mask: EditableImageDescriptor;
}): ImageEditSubmissionIntent {
  return createImageEditSubmissionIntent({
    analytics: {
      hasGeneralInstruction: false,
      selectedImageCount: 1,
    },
    attachments: [
      createAttachmentInput(args.image, "original"),
      createAttachmentInput(args.mask, "mask"),
    ],
    entrypoint: args.entrypoint,
    mode: "remove",
    promptRaw: IMAGE_REMOVE_PROMPT,
  });
}

export function buildCommentSubmissionIntent(args: {
  commentedImages: readonly CommentedImageInput[];
  entrypoint: ImagePreviewEntrypoint;
  generalInstructions?: string;
  locales?: ImageCommentLocale;
}): ImageEditSubmissionIntent {
  const promptRaw = serializeImageCommentGroups({
    imageCommentGroups: args.commentedImages.flatMap((item, index) =>
      item.comments.length === 0 ? [] : [{ comments: item.comments, imageNumber: index + 1 }],
    ),
    locales: args.locales,
    prompt: args.generalInstructions ?? "",
  });

  return createImageEditSubmissionIntent({
    analytics: {
      commentCount: args.commentedImages.reduce((count, item) => count + item.comments.length, 0),
      hasGeneralInstruction: (args.generalInstructions ?? "").trim().length > 0,
      selectedImageCount: args.commentedImages.length,
    },
    attachments: args.commentedImages.map((item) => createAttachmentInput(item.image, "selected")),
    entrypoint: args.entrypoint,
    mode: "comment",
    promptRaw,
  });
}

export function buildSelectionSubmissionIntent(args: {
  entrypoint: ImagePreviewEntrypoint;
  images: readonly EditableImageDescriptor[];
  promptRaw?: string;
}): ImageEditSubmissionIntent {
  return createImageEditSubmissionIntent({
    analytics: {
      hasGeneralInstruction: (args.promptRaw ?? "").trim().length > 0,
      selectedImageCount: args.images.length,
    },
    attachments: args.images.map((image) => createAttachmentInput(image, "selected")),
    entrypoint: args.entrypoint,
    mode: "select",
    promptRaw: args.promptRaw ?? "",
  });
}

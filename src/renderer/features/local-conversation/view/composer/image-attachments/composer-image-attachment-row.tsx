import { useState, type ReactNode } from "react";
import {
  ImagePreviewDialog,
  openUserAttachmentImagePreview,
  type ImageEditComposerTarget,
  type ImageEditorFeaturePolicy,
} from "@/features/user-attachment-image-editor";
import type { ComposerImageAttachmentController } from "./use-composer-image-attachments";
import {
  resolveComposerImageAttachmentSize,
  type ComposerImageAttachment,
} from "./composer-image-attachment-model";
import { ComposerImageAttachmentThumbnail } from "./composer-image-attachment-thumbnail";

export interface ComposerImageAttachmentRowProps {
  readonly attachments: readonly ComposerImageAttachment[];
  readonly children?: ReactNode;
  readonly controller: Pick<ComposerImageAttachmentController, "remove">;
  readonly hasVisibleNonImageAttachments: boolean;
  /** Opens the previewed image in the image editor; without it the preview has no Edit action. */
  readonly onEdit?: (attachment: ComposerImageAttachment) => void;
}

function buildPreviewOptions(input: {
  readonly attachment: ComposerImageAttachment;
  readonly attachmentCount: number;
  readonly composerTarget: ImageEditComposerTarget;
  readonly policy: ImageEditorFeaturePolicy;
  readonly projectId: string | null;
  readonly threadId: string | null;
}) {
  return {
    alt: "User attachment",
    attachmentSrc: input.attachment.src,
    attachmentId: input.attachment.id,
    availableImageCount: input.attachmentCount,
    composerTarget: input.composerTarget,
    ...(input.attachment.src.startsWith("data:image/") ? { dataUrl: input.attachment.src } : {}),
    downloadSrc: input.attachment.src,
    entrypoint: "lightbox_edit_button" as const,
    imageSource: "uploaded" as const,
    ...(input.attachment.materialization
      ? {
          hostId: input.attachment.materialization.hostId,
          ...(input.attachment.materialization.localPath
            ? { localPath: input.attachment.materialization.localPath }
            : {}),
          ...(input.attachment.materialization.managedSource
            ? { managedSource: input.attachment.materialization.managedSource }
            : {}),
        }
      : {}),
    openInEditor: true,
    policy: input.policy,
    previewSrc: input.attachment.src,
    projectId: input.projectId,
    src: input.attachment.src,
    threadId: input.threadId,
    title: "User attachment",
  };
}

/** Opens a draft image in the image editor, as the Edit action of its preview does. */
export async function openComposerImageAttachment(input: {
  readonly attachment: ComposerImageAttachment;
  readonly attachmentCount: number;
  readonly composerTarget: ImageEditComposerTarget;
  readonly policy: ImageEditorFeaturePolicy;
  readonly projectId: string | null;
  readonly threadId: string | null;
}): Promise<boolean> {
  return openUserAttachmentImagePreview(buildPreviewOptions(input));
}

export function ComposerImageAttachmentRow({
  attachments,
  children,
  controller,
  hasVisibleNonImageAttachments,
  onEdit,
}: ComposerImageAttachmentRowProps) {
  const size = resolveComposerImageAttachmentSize(hasVisibleNonImageAttachments);
  const previewEnabled = attachments.length > 0;
  const [preview, setPreview] = useState<{
    readonly id: string;
    readonly finalFocus: HTMLElement | null;
  } | null>(null);
  const index = preview ? attachments.findIndex((attachment) => attachment.id === preview.id) : -1;
  const previewed = attachments[index];
  const showAt = (next: number) => {
    const attachment = attachments[next];
    return preview && attachment ? () => setPreview({ ...preview, id: attachment.id }) : undefined;
  };

  return (
    <div className="hide-scrollbar w-full overflow-x-auto p-px">
      <div className="flex min-w-max items-end gap-2">
        {attachments.map((attachment) => (
          <ComposerImageAttachmentThumbnail
            key={attachment.id}
            attachment={attachment}
            previewEnabled={previewEnabled}
            size={size}
            onOpen={(id) =>
              setPreview({
                id,
                finalFocus:
                  document.activeElement instanceof HTMLElement ? document.activeElement : null,
              })
            }
            onRemove={controller.remove}
          />
        ))}
        {children}
      </div>
      {preview && previewed ? (
        <ImagePreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          finalFocus={() => {
            preview.finalFocus?.focus();
            return false;
          }}
          src={previewed.src}
          downloadFileName={previewed.filename}
          alt={previewed.filename}
          allowLocalPath
          analytics={{
            availableImageCount: attachments.length,
            entrypoint: "image_click",
            imageSource: "uploaded",
          }}
          onPreviousImage={showAt(index - 1)}
          onNextImage={showAt(index + 1)}
          onEditImage={onEdit ? () => onEdit(previewed) : undefined}
        />
      ) : null}
    </div>
  );
}

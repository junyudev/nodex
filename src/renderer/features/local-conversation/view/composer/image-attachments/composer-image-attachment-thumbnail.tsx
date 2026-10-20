import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { ActivitySpinnerIcon, CloseIcon } from "@/components/shared/icons";
import { resolveImageDisplaySource } from "@/features/user-attachment-image-editor";
import { cn } from "@/lib/utils";
import type { ComposerImageAttachment } from "./composer-image-attachment-model";

export interface ComposerImageAttachmentThumbnailProps {
  /** Only what a thumbnail shows, so every Composer's attachments use the same one. */
  readonly attachment: Pick<
    ComposerImageAttachment,
    "id" | "filename" | "src" | "uploadStatus" | "uploadProgress"
  >;
  readonly previewEnabled: boolean;
  readonly size: 80 | 54;
  readonly onOpen: (id: string) => void;
  readonly onRemove: (id: string) => void;
}

function stopRemoveEvent(
  event: MouseEvent<HTMLButtonElement> | PointerEvent<HTMLButtonElement>,
): void {
  event.preventDefault();
  event.stopPropagation();
}

export function ComposerImageAttachmentThumbnail({
  attachment,
  previewEnabled,
  size,
  onOpen,
  onRemove,
}: ComposerImageAttachmentThumbnailProps) {
  const handleOpen = () => {
    if (!previewEnabled) return;
    onOpen(attachment.id);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!previewEnabled || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    handleOpen();
  };
  const isUploading = attachment.uploadStatus === "uploading";
  const uploadProgress =
    attachment.uploadProgress === undefined
      ? undefined
      : Math.min(100, Math.max(0, attachment.uploadProgress));
  const displaySrc =
    resolveImageDisplaySource(attachment.src, {
      allowLocalPath: true,
    }) ?? attachment.src;

  return (
    <div
      data-composer-image-attachment-id={attachment.id}
      data-composer-image-attachment-size={size}
      role={previewEnabled ? "button" : undefined}
      aria-label={previewEnabled ? attachment.filename : undefined}
      tabIndex={previewEnabled ? 0 : undefined}
      className={cn(
        "composer-attachment-surface border-token-border-heavy relative inline-flex flex-shrink-0 overflow-visible rounded-lg border focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset",
        size === 80 ? "size-20" : "size-[54px]",
        previewEnabled && "cursor-interaction",
      )}
      onClick={handleOpen}
      onKeyDown={handleKeyDown}
    >
      <span className="composer-attachment-surface absolute inset-0 overflow-hidden rounded-lg">
        {/* An image still on its way has nothing to show yet but its progress. */}
        {displaySrc ? (
          <img
            src={displaySrc}
            alt="User attachment"
            draggable={false}
            referrerPolicy="no-referrer"
            className="size-full object-cover"
          />
        ) : null}
        {isUploading ? (
          <span
            role="progressbar"
            aria-label={`Uploading ${attachment.filename}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={uploadProgress}
            className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/5 text-white backdrop-blur-xs"
          >
            {uploadProgress === undefined ? (
              <ActivitySpinnerIcon className="icon-xs" aria-hidden="true" />
            ) : (
              <span className="text-[10px] font-medium tabular-nums">
                {Math.round(uploadProgress)}%
              </span>
            )}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        data-tab-preview-pin-exempt
        aria-label={`Remove ${attachment.filename}`}
        className="absolute top-1 right-1 flex size-4 cursor-interaction items-center justify-center rounded-full bg-token-foreground text-token-dropdown-background shadow-sm"
        onPointerDown={stopRemoveEvent}
        onClick={(event) => {
          stopRemoveEvent(event);
          onRemove(attachment.id);
        }}
      >
        <CloseIcon className="icon-xxs" aria-hidden="true" />
      </button>
    </div>
  );
}

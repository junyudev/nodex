import { useCallback, useEffect, useState, type Ref } from "react";
import { Sparkles } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon, FileIcon } from "@/components/shared/icons";
import type {
  CodexUnavailableImage,
  CodexUserAttachment,
  CodexUserImageAttachment,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ImagePreviewDialog,
  openUserAttachmentImagePreview,
} from "@/features/user-attachment-image-editor";
import { useConversationImageAssetContext } from "../conversation-image-asset-context";
import { useConversationImageAsset } from "./use-conversation-image-asset";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageChip } from "./unavailable-image";

export function ImageLoadingTile({ label }: { label: string }) {
  return (
    <div
      className="size-16 rounded-lg border border-token-border bg-token-bg-tertiary text-token-description-foreground"
      aria-label={label}
      role="status"
    >
      <div className="flex size-full items-center justify-center">
        <ActivitySpinnerIcon className="size-4" />
      </div>
    </div>
  );
}

export function ImageErrorTile({ onRetry }: { onRetry?: () => void }) {
  const className =
    "size-16 rounded-lg border border-token-border bg-token-bg-tertiary px-1.5 text-center text-[10px] leading-tight text-token-description-foreground";
  if (!onRetry) {
    return (
      <div
        className={cn(className, "flex items-center justify-center")}
        aria-label="Image unavailable"
        role="status"
      >
        Image unavailable
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        className,
        "cursor-interaction focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none",
      )}
      aria-label="Retry image"
      onClick={onRetry}
    >
      Image unavailable
    </button>
  );
}

export function UserImageButton({
  src,
  alt = "User attachment",
  fit,
  bordered,
  onOpenPreview,
  onImageError,
  size = 64,
  previewLabel = "Open image preview",
  buttonRef,
}: {
  src: string;
  alt?: string;
  fit: "cover" | "contain";
  bordered: boolean;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  onImageError?: () => void;
  size?: 64 | 80;
  previewLabel?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-composer-attachment-pill="true"
      aria-label={previewLabel}
      className={cn(
        "cursor-interaction overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none",
        size === 80 ? "size-20" : "size-16",
        bordered && (size === 80 ? "border border-border-strong" : "border border-token-border"),
      )}
      onClick={(event) => onOpenPreview(event.currentTarget)}
    >
      <img
        src={src}
        width={size}
        height={size}
        alt={alt}
        referrerPolicy="no-referrer"
        className={cn(
          "h-full w-full rounded-md",
          fit === "cover" ? "object-cover" : "object-contain",
        )}
        onError={onImageError}
      />
    </button>
  );
}

/** Conversation images keep their loaded bytes while the thumbnail remains mounted. */
export function ConversationImageThumbnail({
  src,
  isLoading,
  isError,
  alt,
  onOpenPreview,
  previewLabel,
  buttonRef,
}: {
  src: string | null;
  isLoading: boolean;
  isError: boolean;
  alt: string;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  previewLabel?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  if (isLoading) {
    return (
      <div
        className="flex size-20 items-center justify-center rounded-lg border border-border-strong"
        aria-label={`Loading ${alt.toLowerCase()}`}
        role="status"
      >
        <ActivitySpinnerIcon className="icon-xs" />
      </div>
    );
  }
  if (isError || !src) {
    return (
      <div
        className="flex size-16 items-center justify-center rounded-lg border border-text-danger/20 bg-background-danger-surface/20 px-1 text-center text-[10px] leading-3 text-danger"
        aria-label="Image failed to load"
        role="img"
      >
        Failed
      </div>
    );
  }
  return (
    <UserImageButton
      src={src}
      alt={alt}
      fit="cover"
      bordered
      onOpenPreview={onOpenPreview}
      size={80}
      previewLabel={previewLabel}
      buttonRef={buttonRef}
    />
  );
}

interface ResolvedUserImagePreview {
  attachmentId: string;
  attachmentSource: string;
  downloadSrc?: string;
  src: string;
}

type RegisterResolvedImagePreview = (preview: ResolvedUserImagePreview) => () => void;

function UserImageAttachment({
  attachment,
  onOpenPreview,
  registerPreview,
}: {
  attachment: CodexUserImageAttachment;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  registerPreview: RegisterResolvedImagePreview;
}) {
  const asset = useConversationImageAsset(attachment.source);
  const { previewSrc: src, downloadSrc, isLoading, isError } = asset;

  useEffect(() => {
    if (isError || isLoading || !src) return;
    return registerPreview({
      attachmentId: attachment.id,
      attachmentSource: attachment.source,
      downloadSrc: downloadSrc ?? undefined,
      src,
    });
  }, [attachment.id, attachment.source, downloadSrc, isError, isLoading, registerPreview, src]);

  return (
    <ConversationImageThumbnail
      src={src}
      isError={isError}
      isLoading={isLoading}
      alt="User attachment"
      onOpenPreview={onOpenPreview}
    />
  );
}

function UserFileAttachmentChip({
  attachment,
}: {
  attachment: Extract<CodexUserAttachment, { type: "file" }>;
}) {
  const Icon = attachment.sourceKind === "skill" ? Sparkles : FileIcon;

  return (
    <div
      data-composer-attachment-pill="true"
      className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg border border-token-border bg-token-foreground/5 px-2 text-xs text-token-foreground"
    >
      <Icon className="size-3 shrink-0 text-token-description-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{attachment.label}</span>
    </div>
  );
}

export function UserAttachmentStrip({
  attachments,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  attachments: CodexUserAttachment[];
  unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const { composerTarget, conversationId } = useConversationImageAssetContext();
  const [resolvedImages, setResolvedImages] = useState<
    ReadonlyMap<string, ResolvedUserImagePreview>
  >(() => new Map());
  const [activePreview, setActivePreview] = useState<{
    attachmentId: string;
    trigger: HTMLButtonElement;
  } | null>(null);

  const registerPreview = useCallback<RegisterResolvedImagePreview>((preview) => {
    setResolvedImages((current) => {
      const next = new Map(current);
      next.set(preview.attachmentId, preview);
      return next;
    });

    return () => {
      setResolvedImages((current) => {
        if (current.get(preview.attachmentId) !== preview) return current;
        const next = new Map(current);
        next.delete(preview.attachmentId);
        return next;
      });
    };
  }, []);

  if (attachments.length === 0 && unavailableImages.length === 0) return null;

  const remoteOnly = attachments.every(
    (attachment) => attachment.type === "image" && attachment.sourceKind === "remote-pointer",
  );
  const availableImageCount = attachments.filter(
    (attachment) => attachment.type === "image",
  ).length;
  const orderedImages = attachments.flatMap((attachment) => {
    if (attachment.type !== "image") return [];
    const image = resolvedImages.get(attachment.id);
    return image ? [image] : [];
  });
  const activeImageIndex =
    activePreview === null
      ? -1
      : orderedImages.findIndex((image) => image.attachmentId === activePreview.attachmentId);
  const activeImage = activeImageIndex < 0 ? null : (orderedImages[activeImageIndex] ?? null);

  const openPreview = (attachmentId: string, trigger: HTMLButtonElement) => {
    setActivePreview({ attachmentId, trigger });
  };

  return (
    <>
      <div
        className={cn(
          remoteOnly
            ? "flex flex-wrap gap-2 self-end"
            : "flex flex-wrap items-end justify-end gap-2 self-end",
        )}
        data-user-attachment-strip="true"
      >
        {attachments.map((attachment) => {
          if (attachment.type === "file") {
            return <UserFileAttachmentChip key={attachment.id} attachment={attachment} />;
          }

          const handleOpenPreview = (trigger: HTMLButtonElement) => {
            openPreview(attachment.id, trigger);
          };

          return (
            <UserImageAttachment
              key={attachment.id}
              attachment={attachment}
              onOpenPreview={handleOpenPreview}
              registerPreview={registerPreview}
            />
          );
        })}
        {unavailableImages.map((image, index) => (
          <UnavailableImageChip key={`${image.sourcePath}:${index}`} image={image} />
        ))}
      </div>
      {activeImage && activePreview ? (
        <ImagePreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setActivePreview(null);
          }}
          finalFocus={() => {
            activePreview.trigger.focus();
            return false;
          }}
          src={activeImage.src}
          downloadSrc={activeImage.downloadSrc}
          alt="User attachment"
          analytics={{
            availableImageCount,
            entrypoint: "image_click",
            imageSource: "uploaded",
          }}
          onPreviousImage={
            activeImageIndex > 0
              ? () =>
                  setActivePreview((current) =>
                    current === null
                      ? null
                      : {
                          ...current,
                          attachmentId:
                            orderedImages[activeImageIndex - 1]?.attachmentId ??
                            current.attachmentId,
                        },
                  )
              : undefined
          }
          onNextImage={
            activeImageIndex < orderedImages.length - 1
              ? () =>
                  setActivePreview((current) =>
                    current === null
                      ? null
                      : {
                          ...current,
                          attachmentId:
                            orderedImages[activeImageIndex + 1]?.attachmentId ??
                            current.attachmentId,
                        },
                  )
              : undefined
          }
          onEditImage={() => {
            void openUserAttachmentImagePreview({
              alt: "User attachment",
              attachmentId: activeImage.attachmentId,
              attachmentSrc: activeImage.attachmentSource,
              composerTarget: composerTarget ?? undefined,
              downloadSrc: activeImage.downloadSrc ?? activeImage.src,
              entrypoint: "lightbox_edit_button",
              imageSource: "uploaded",
              openInEditor: true,
              policy: "edit_button",
              previewSrc: activeImage.src,
              src: activeImage.src,
              threadId: conversationId,
              title: "User attachment",
            });
          }}
        />
      ) : null}
    </>
  );
}

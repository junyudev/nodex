import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon, FileIcon } from "@/components/shared/icons";
import type { CodexUserAttachment, CodexUserImageAttachment } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  ImagePreviewDialog,
  openUserAttachmentImagePreview,
  useResolvedImageAsset,
} from "@/features/user-attachment-image-editor";
import { useConversationImageAssetContext } from "../conversation-image-asset-context";
import { useConversationImageAsset } from "./use-conversation-image-asset";

function ImageLoadingTile({ label }: { label: string }) {
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

function ImageErrorTile({ onRetry }: { onRetry?: () => void }) {
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

function UserImageButton({
  src,
  fit,
  bordered,
  onOpenPreview,
  onImageError,
}: {
  src: string;
  fit: "cover" | "contain";
  bordered: boolean;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  onImageError?: () => void;
}) {
  return (
    <button
      type="button"
      data-composer-attachment-pill="true"
      aria-label="Open image preview"
      className={cn(
        "size-16 cursor-interaction overflow-hidden rounded-lg focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none",
        bordered && "border border-token-border",
      )}
      onClick={(event) => onOpenPreview(event.currentTarget)}
    >
      <img
        src={src}
        width={64}
        height={64}
        alt="User attachment"
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

interface ResolvedUserImagePreview {
  attachmentId: string;
  attachmentSource: string;
  downloadSrc?: string;
  src: string;
}

type RegisterResolvedImagePreview = (preview: ResolvedUserImagePreview) => () => void;

export function InlineOrLocalUserImageAttachment({
  attachment,
  onOpenPreview,
  registerPreview,
}: {
  attachment: CodexUserImageAttachment;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  registerPreview: RegisterResolvedImagePreview;
}) {
  const { hostId } = useConversationImageAssetContext();
  const isLocalImage = attachment.sourceKind === "local-image";
  const asset = useResolvedImageAsset(attachment.source, {
    hostId,
    allowLocalPath: isLocalImage,
    materialize: isLocalImage,
  });
  const { previewSrc: src, downloadSrc, isLoading, isError, error, refetch } = asset;

  useEffect(() => {
    if (!src) return;
    return registerPreview({
      attachmentId: attachment.id,
      attachmentSource: attachment.source,
      downloadSrc: downloadSrc ?? undefined,
      src,
    });
  }, [attachment.id, attachment.source, downloadSrc, registerPreview, src]);

  if (isLoading) return <ImageLoadingTile label="Loading user attachment" />;
  if (!src) {
    return isError ? (
      <ImageErrorTile onRetry={error ? () => void refetch() : undefined} />
    ) : (
      <ImageLoadingTile label="Loading user attachment" />
    );
  }

  return <UserImageButton src={src} fit="cover" bordered onOpenPreview={onOpenPreview} />;
}

export function RemoteUserImageAttachment({
  attachment,
  onOpenPreview,
  registerPreview,
}: {
  attachment: CodexUserImageAttachment;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  registerPreview: RegisterResolvedImagePreview;
}) {
  const asset = useConversationImageAsset(attachment.source, {
    shouldLoadFileDataUrl: false,
  });
  const { previewSrc: src, downloadSrc, isLoading, isError, refetch } = asset;

  useEffect(() => {
    if (!src) return;
    return registerPreview({
      attachmentId: attachment.id,
      attachmentSource: attachment.source,
      downloadSrc: downloadSrc ?? undefined,
      src,
    });
  }, [attachment.id, attachment.source, downloadSrc, registerPreview, src]);

  if (isError) return <ImageErrorTile onRetry={() => void refetch()} />;
  if (isLoading || !src) {
    return (
      <div
        aria-label="Loading user attachment"
        className="size-16 rounded-md border border-token-border bg-token-bg-tertiary text-sm text-token-description-foreground"
      >
        <div className="flex size-full items-center justify-center">...</div>
      </div>
    );
  }

  return (
    <UserImageButton
      src={src}
      fit="contain"
      bordered={false}
      onOpenPreview={onOpenPreview}
      onImageError={refetch}
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

export function UserAttachmentStrip({ attachments }: { attachments: CodexUserAttachment[] }) {
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

  if (attachments.length === 0) return null;

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

          return attachment.sourceKind === "remote-pointer" ? (
            <RemoteUserImageAttachment
              key={attachment.id}
              attachment={attachment}
              onOpenPreview={handleOpenPreview}
              registerPreview={registerPreview}
            />
          ) : (
            <InlineOrLocalUserImageAttachment
              key={attachment.id}
              attachment={attachment}
              onOpenPreview={handleOpenPreview}
              registerPreview={registerPreview}
            />
          );
        })}
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

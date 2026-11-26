import { getIntl, useIntl } from "@/lib/i18n";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { Sparkles } from "@/components/shared/icons/generic-icons";
import { ActivitySpinnerIcon, FileIcon, ImageIcon } from "@/components/shared/icons";
import { InlineReferenceVisual } from "@/components/board/inline-reference-visual";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  openUserAttachmentImagePreview,
  useContentImageScope,
  useContentImage,
} from "@/lib/content-image";

import {
  imagePlaceholderCount,
  type ImagePlaceholderReference,
} from "../../../../../shared/message-agent-input";
import type {
  CodexUnavailableImage,
  CodexUserAttachment,
  CodexUserImageAttachment,
} from "@/lib/types";
import { cn } from "@/lib/utils";

import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { ComposerAttachmentStrip } from "@/components/composer/composer-attachments";

import { ComposerImageAttachmentThumbnail } from "../composer/image-attachments/composer-image-attachment-thumbnail";
import { resolveComposerImageAttachmentSize } from "../composer/image-attachments/composer-image-attachment-model";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageChip } from "./unavailable-image";
import { useContentImageMenu } from "./content-image-viewer";

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
  const intl = useIntl();
  const className =
    "size-16 rounded-lg border border-token-border bg-token-bg-tertiary px-1.5 text-center text-[10px] leading-tight text-token-description-foreground";
  if (!onRetry) {
    return (
      <div
        className={cn(className, "flex items-center justify-center")}
        aria-label={intl.formatMessage({
          id: "conversation.userMessageAttachments.unavailable",
          defaultMessage: "Image unavailable",
        })}
        role="status"
      >
        {intl.formatMessage({
          id: "conversation.userMessageAttachments.unavailable",
          defaultMessage: "Image unavailable",
        })}
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
      aria-label={intl.formatMessage({
        id: "conversation.userMessageAttachments.retry",
        defaultMessage: "Retry image",
      })}
      onClick={onRetry}
    >
      {intl.formatMessage({
        id: "conversation.userMessageAttachments.unavailable",
        defaultMessage: "Image unavailable",
      })}
    </button>
  );
}

export function UserImageButton({
  src,
  alt,
  fit,
  bordered,
  onOpenPreview,
  onImageError,
  size = 64,
  previewLabel,
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
  const intl = useIntl();
  return (
    <button
      ref={buttonRef}
      type="button"
      data-composer-attachment-pill="true"
      aria-label={
        previewLabel ??
        intl.formatMessage({
          id: "conversation.userMessageAttachments.preview",
          defaultMessage: "Open image preview",
        })
      }
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
        alt={
          alt ??
          intl.formatMessage({
            id: "conversation.userMessageAttachments.userAttachment",
            defaultMessage: "User attachment",
          })
        }
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
  onImageError,
  previewLabel,
  buttonRef,
}: {
  src: string | null;
  isLoading: boolean;
  isError: boolean;
  alt: string;
  onOpenPreview: (trigger: HTMLButtonElement) => void;
  onImageError?: () => void;
  previewLabel?: string;
  buttonRef?: Ref<HTMLButtonElement>;
}) {
  const intl = useIntl();
  if (isLoading) {
    return (
      <div
        className="flex size-20 items-center justify-center rounded-lg border border-border-strong"
        aria-label={intl.formatMessage(
          { id: "conversation.userMessageAttachments.loading", defaultMessage: "Loading {alt}" },
          { alt: alt.toLocaleLowerCase(intl.locale) },
        )}
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
        aria-label={intl.formatMessage({
          id: "conversation.userMessageAttachments.loadError",
          defaultMessage: "Image failed to load",
        })}
        role="img"
      >
        {intl.formatMessage({
          id: "conversation.userMessageAttachments.failed",
          defaultMessage: "Failed",
        })}
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
      onImageError={onImageError}
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

interface UserMessageImages {
  /** The message's images in the order the Agent numbered them. */
  readonly images: readonly CodexUserImageAttachment[];
  /** Whether the placeholders in the message's text number exactly these images. */
  readonly numbersImages: boolean;
  readonly register: RegisterResolvedImagePreview;
  readonly open: (attachmentId: string, trigger: HTMLElement) => void;
}

const UserMessageImagesContext = createContext<UserMessageImages | null>(null);

function useUserImageMenu(attachment: CodexUserImageAttachment, url: string | null) {
  return useContentImageMenu(
    attachment.source,
    url,
    getIntl().formatMessage({
      id: "conversation.userMessageAttachments.userAttachment",
      defaultMessage: "User attachment",
    }),
  );
}

/** One of the message's images: read, and in the message's viewer once it has been. */
function useUserMessageImage(attachment: CodexUserImageAttachment) {
  const gallery = useContext(UserMessageImagesContext)!;
  const { previewSrc: src, downloadSrc, isLoading, isError } = useContentImage(attachment.source);
  const register = gallery.register;

  useEffect(() => {
    if (isError || isLoading || !src) return;
    return register({
      attachmentId: attachment.id,
      attachmentSource: attachment.source,
      downloadSrc: downloadSrc ?? undefined,
      src,
    });
  }, [attachment.id, attachment.source, downloadSrc, isError, isLoading, register, src]);

  return { gallery, src, isLoading, isError };
}

function UserImageAttachment({ attachment }: { attachment: CodexUserImageAttachment }) {
  const intl = useIntl();
  const { gallery, src, isLoading, isError } = useUserMessageImage(attachment);
  const showMenu = useUserImageMenu(attachment, isError ? null : src);

  return (
    <span className="contents" onContextMenu={showMenu}>
      <ConversationImageThumbnail
        src={src}
        isError={isError}
        isLoading={isLoading}
        alt={intl.formatMessage({
          id: "conversation.userMessageAttachments.userAttachment",
          defaultMessage: "User attachment",
        })}
        onOpenPreview={(trigger) => gallery.open(attachment.id, trigger)}
      />
    </span>
  );
}

/**
 * Where a sent message's text names one of its images, as the Agent read it: the image, small,
 * that opens in the message's viewer. A placeholder that names no image of the message, as when
 * an image could not be sent, stays a plain reference.
 */
export function UserMessageImageReference({ reference }: { reference: ImagePlaceholderReference }) {
  const intl = useIntl();
  const gallery = useContext(UserMessageImagesContext);
  const attachment = gallery?.numbersImages ? gallery.images[reference.number - 1] : undefined;
  const asset = useContentImage(attachment?.source ?? "");
  const url = attachment && !asset.isError ? asset.previewSrc : null;
  const showMenu = useUserImageMenu(
    attachment ?? { type: "image", id: "", source: "", sourceKind: "inline-image" },
    attachment ? url : null,
  );
  const label = intl.formatMessage(
    { id: "conversation.userMessageAttachments.numberedImage", defaultMessage: "Image #{number}" },
    { number: reference.number },
  );
  const tooltip = [reference.caption, reference.path].filter(Boolean).join(" · ") || null;
  const icon = url ? (
    <img src={url} alt="" className="size-full rounded-[3px] object-cover" draggable={false} />
  ) : (
    <ImageIcon className="size-full" />
  );
  return (
    <NodexTooltip tooltipContent={tooltip}>
      {attachment && url ? (
        <InlineReferenceVisual
          as="button"
          type="button"
          className="max-w-[18rem] cursor-interaction align-baseline"
          label={label}
          icon={icon}
          aria-label={intl.formatMessage(
            { id: "conversation.userMessageAttachments.open", defaultMessage: "Open {label}" },
            { label },
          )}
          onClick={(event) => gallery!.open(attachment.id, event.currentTarget)}
          onContextMenu={showMenu}
        />
      ) : (
        <InlineReferenceVisual className="max-w-[18rem] align-baseline" label={label} icon={icon} />
      )}
    </NodexTooltip>
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

function EditableUserImage({
  attachment,
  name,
  onRemove,
}: {
  attachment: CodexUserImageAttachment;
  name: string;
  onRemove: (attachmentId: string) => void;
}) {
  const { gallery, src, isLoading, isError } = useUserMessageImage(attachment);
  return (
    <ComposerImageAttachmentThumbnail
      attachment={{ id: attachment.id, filename: name, src: src ?? "", uploadStatus: "idle" }}
      availability={isLoading ? "loading" : isError || !src ? "failed" : undefined}
      previewEnabled={!isLoading && !isError && Boolean(src)}
      size={resolveComposerImageAttachmentSize(false)}
      onOpen={(attachmentId) =>
        gallery.open(
          attachmentId,
          document.activeElement instanceof HTMLElement ? document.activeElement : document.body,
        )
      }
      onRemove={onRemove}
    />
  );
}

/**
 * The images of a message being rewritten, shown as a Composer shows a draft's: they open in the
 * message's viewer and can be removed. One that cannot be read says so, and can still go.
 */
export function UserMessageEditImageRow({
  images,
  onRemove,
}: {
  images: readonly CodexUserImageAttachment[];
  onRemove: (attachmentId: string) => void;
}) {
  const intl = useIntl();
  if (images.length === 0) return null;
  return (
    <ComposerAttachmentStrip>
      {images.map((image, index) => (
        <EditableUserImage
          key={image.id}
          attachment={image}
          name={
            image.caption ||
            intl.formatMessage(
              {
                id: "conversation.userMessageAttachments.numberedImage",
                defaultMessage: "Image #{number}",
              },
              { number: index + 1 },
            )
          }
          onRemove={onRemove}
        />
      ))}
    </ComposerAttachmentStrip>
  );
}

/**
 * One image viewer for a sent message: its attached images, and every placeholder in its text
 * that names one, navigate together. `text` is the message's text, whose placeholders number
 * the images it was sent with. A message being rewritten is still a draft: looking at one of its
 * images does not offer to edit it, as that would send the edit somewhere else.
 */
export function UserMessageImageGallery({
  attachments,
  text,
  rewriting = false,
  children,
}: {
  attachments: readonly CodexUserAttachment[];
  text: string;
  rewriting?: boolean;
  children: ReactNode;
}) {
  const intl = useIntl();
  const { composerTarget, conversationId } = useContentImageScope();
  const [resolvedImages, setResolvedImages] = useState<
    ReadonlyMap<string, ResolvedUserImagePreview>
  >(() => new Map());
  const [activePreview, setActivePreview] = useState<{
    attachmentId: string;
    trigger: HTMLElement;
  } | null>(null);

  const register = useCallback<RegisterResolvedImagePreview>((preview) => {
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

  const images = useMemo(
    () =>
      attachments.filter(
        (attachment): attachment is CodexUserImageAttachment => attachment.type === "image",
      ),
    [attachments],
  );
  // A number beyond the images means one could not be sent, so the numbering cannot be trusted.
  const numbersImages = images.length > 0 && imagePlaceholderCount(text) <= images.length;
  const context = useMemo<UserMessageImages>(
    () => ({
      images,
      numbersImages,
      register,
      open: (attachmentId, trigger) => setActivePreview({ attachmentId, trigger }),
    }),
    [images, numbersImages, register],
  );
  const orderedImages = images.flatMap((attachment) => {
    const image = resolvedImages.get(attachment.id);
    return image ? [image] : [];
  });
  const activeImageIndex =
    activePreview === null
      ? -1
      : orderedImages.findIndex((image) => image.attachmentId === activePreview.attachmentId);
  const activeImage = activeImageIndex < 0 ? null : (orderedImages[activeImageIndex] ?? null);
  const showImage = (index: number) => {
    const next = orderedImages[index];
    if (next)
      setActivePreview((current) => current && { ...current, attachmentId: next.attachmentId });
  };

  return (
    <UserMessageImagesContext value={context}>
      {children}
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
          alt={intl.formatMessage({
            id: "conversation.userMessageAttachments.userAttachment",
            defaultMessage: "User attachment",
          })}
          analytics={{
            availableImageCount: images.length,
            entrypoint: "image_click",
            imageSource: "uploaded",
          }}
          onPreviousImage={activeImageIndex > 0 ? () => showImage(activeImageIndex - 1) : undefined}
          onNextImage={
            activeImageIndex < orderedImages.length - 1
              ? () => showImage(activeImageIndex + 1)
              : undefined
          }
          onEditImage={
            rewriting
              ? undefined
              : () => {
                  void openUserAttachmentImagePreview({
                    alt: intl.formatMessage({
                      id: "conversation.userMessageAttachments.userAttachment",
                      defaultMessage: "User attachment",
                    }),
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
                    title: intl.formatMessage({
                      id: "conversation.userMessageAttachments.userAttachment",
                      defaultMessage: "User attachment",
                    }),
                  });
                }
          }
        />
      ) : null}
    </UserMessageImagesContext>
  );
}

/** A sent message's attachments as the Composer showed them, in the message's image viewer. */
export function UserAttachmentStrip({
  attachments,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  attachments: CodexUserAttachment[];
  unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const gallery = useContext(UserMessageImagesContext);
  if (attachments.length === 0 && unavailableImages.length === 0) return null;
  if (!gallery)
    return (
      <UserMessageImageGallery attachments={attachments} text="">
        <UserAttachmentStrip attachments={attachments} unavailableImages={unavailableImages} />
      </UserMessageImageGallery>
    );

  const remoteOnly = attachments.every(
    (attachment) => attachment.type === "image" && attachment.sourceKind === "remote-pointer",
  );

  return (
    <div
      className={cn(
        remoteOnly
          ? "flex flex-wrap gap-2 self-end"
          : "flex flex-wrap items-end justify-end gap-2 self-end",
      )}
      data-user-attachment-strip="true"
    >
      {attachments.map((attachment) =>
        attachment.type === "file" ? (
          <UserFileAttachmentChip key={attachment.id} attachment={attachment} />
        ) : (
          <UserImageAttachment key={attachment.id} attachment={attachment} />
        ),
      )}
      {unavailableImages.map((image, index) => (
        <UnavailableImageChip key={`${image.sourcePath}:${index}`} image={image} />
      ))}
    </div>
  );
}

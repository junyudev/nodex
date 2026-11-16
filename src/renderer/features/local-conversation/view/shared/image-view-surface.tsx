import { useIntl, type IntlShape } from "@/lib/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ImageEditorTabIcon } from "@/components/shared/icons";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import type { CodexUnavailableImage } from "@/lib/types";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageTile } from "./unavailable-image";
import { useContentImage } from "@/lib/content-image";
import { ConversationImageThumbnail } from "./user-message-attachments";

interface InspectedImagePreview {
  readonly source: string;
  readonly src: string;
  readonly downloadSrc?: string;
  readonly trigger: HTMLButtonElement;
}

type RegisterImagePreview = (index: number, preview: InspectedImagePreview) => () => void;

function InspectedImageThumbnail({
  source,
  index,
  onOpenPreview,
  registerPreview,
}: {
  source: string;
  index: number;
  onOpenPreview: () => void;
  registerPreview: RegisterImagePreview;
}) {
  const intl = useIntl();
  const asset = useContentImage(source);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const element = trigger.current;
    if (!asset.previewSrc || !element) return;
    return registerPreview(index, {
      source,
      src: asset.previewSrc,
      downloadSrc: asset.downloadSrc ?? undefined,
      trigger: element,
    });
  }, [asset.downloadSrc, asset.previewSrc, index, registerPreview, source]);

  return (
    <ConversationImageThumbnail
      src={asset.previewSrc}
      isLoading={asset.isLoading}
      isError={asset.isError}
      alt={intl.formatMessage({
        id: "conversation.imageViewSurface.alt",
        defaultMessage: "Inspected image",
      })}
      previewLabel={intl.formatMessage({
        id: "conversation.imageViewSurface.previewLabel",
        defaultMessage: "Inspected image",
      })}
      buttonRef={trigger}
      onOpenPreview={onOpenPreview}
    />
  );
}

function imageViewSummary(intl: IntlShape, viewed: number, missing: number): string {
  const total = viewed + missing;
  const summary = intl.formatMessage(
    {
      id: "conversation.imageViewSurface.viewedImages",
      defaultMessage: "{count, plural, one {Viewed an image} other {Viewed # images}}",
    },
    { count: total },
  );
  if (missing === 0) return summary;
  if (viewed > 0)
    return intl.formatMessage(
      {
        id: "conversation.imageViewSurface.someMissing",
        defaultMessage: "{summary} · {count} missing",
      },
      { summary, count: missing },
    );
  return intl.formatMessage(
    {
      id: "conversation.imageViewSurface.allMissing",
      defaultMessage: "{summary} · {count, plural, one {file missing} other {files missing}}",
    },
    { summary, count: total },
  );
}

export function ImageViewSurface({
  imagePaths,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  imagePaths: readonly string[];
  unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [previews, setPreviews] = useState<ReadonlyMap<number, InspectedImagePreview>>(
    () => new Map(),
  );
  const registerPreview = useCallback<RegisterImagePreview>((index, preview) => {
    setPreviews((current) => new Map(current).set(index, preview));
    return () => {
      setPreviews((current) => {
        if (current.get(index) !== preview) return current;
        const next = new Map(current);
        next.delete(index);
        return next;
      });
    };
  }, []);
  const availablePreviews = imagePaths.flatMap((source, index) => {
    const preview = previews.get(index);
    return preview?.source === source ? [{ ...preview, index }] : [];
  });
  const activeIndex = availablePreviews.findIndex((preview) => preview.index === openIndex);
  const activePreview = availablePreviews[activeIndex];
  const previousPreview = availablePreviews[activeIndex - 1];
  const nextPreview = availablePreviews[activeIndex + 1];
  const canExpand = imagePaths.length + unavailableImages.length > 0;
  const summary = imageViewSummary(intl, imagePaths.length, unavailableImages.length);

  return (
    <ThreadActivityShell
      className="overflow-clip"
      header={
        <ThreadRichActivityHeader
          icon={
            <ImageEditorTabIcon
              aria-hidden="true"
              className="icon-xs shrink-0 text-token-conversation-body"
            />
          }
          summary={
            <span className="block truncate text-token-conversation-summary-trailing">
              {summary}
            </span>
          }
          disclosure={
            canExpand
              ? {
                  expanded,
                  onToggle: () => {
                    setExpanded((current) => !current);
                    setOpenIndex(null);
                  },
                }
              : undefined
          }
        />
      }
      body={
        expanded ? (
          <div className="min-w-0">
            <div className="hide-scrollbar flex max-w-full overflow-x-auto pb-1">
              <div className="flex min-w-max gap-2">
                {imagePaths.map((source, index) => (
                  <InspectedImageThumbnail
                    key={`${source}:${index}`}
                    source={source}
                    index={index}
                    onOpenPreview={() => setOpenIndex(index)}
                    registerPreview={registerPreview}
                  />
                ))}
                {unavailableImages.map((image, index) => (
                  <UnavailableImageTile key={`${image.sourcePath}:${index}`} image={image} />
                ))}
              </div>
            </div>
            {activePreview ? (
              <ImagePreviewDialog
                open
                onOpenChange={(open) => {
                  if (!open) setOpenIndex(null);
                }}
                src={activePreview.src}
                downloadSrc={activePreview.downloadSrc}
                alt={intl.formatMessage({
                  id: "conversation.imageViewSurface.alt",
                  defaultMessage: "Inspected image",
                })}
                onPreviousImage={
                  previousPreview ? () => setOpenIndex(previousPreview.index) : undefined
                }
                onNextImage={nextPreview ? () => setOpenIndex(nextPreview.index) : undefined}
                finalFocus={() =>
                  activePreview.trigger.isConnected ? activePreview.trigger : false
                }
              />
            ) : null}
          </div>
        ) : null
      }
    />
  );
}

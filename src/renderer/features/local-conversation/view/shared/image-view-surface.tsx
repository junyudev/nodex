import { useRef, useState } from "react";
import { ImageEditorTabIcon } from "@/components/shared/icons";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import type { CodexUnavailableImage } from "@/lib/types";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageTile } from "./unavailable-image";
import { useConversationImageAsset } from "./use-conversation-image-asset";
import { ConversationImageThumbnail } from "./user-message-attachments";

function InspectedImageThumbnail({
  source,
  open,
  onOpenChange,
  onPreviousImage,
  onNextImage,
}: {
  source: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPreviousImage?: () => void;
  onNextImage?: () => void;
}) {
  const asset = useConversationImageAsset(source);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <ConversationImageThumbnail
        src={asset.previewSrc}
        isLoading={asset.isLoading}
        isError={asset.isError}
        alt="Inspected image"
        previewLabel="Inspected image"
        buttonRef={trigger}
        onOpenPreview={() => onOpenChange(true)}
      />
      {open && asset.previewSrc ? (
        <ImagePreviewDialog
          open
          onOpenChange={onOpenChange}
          src={asset.previewSrc}
          downloadSrc={asset.downloadSrc ?? undefined}
          alt="Inspected image"
          onPreviousImage={onPreviousImage}
          onNextImage={onNextImage}
          finalFocus={() => {
            trigger.current?.focus();
            return false;
          }}
        />
      ) : null}
    </>
  );
}

function imageViewSummary(viewed: number, missing: number): string {
  const total = viewed + missing;
  const summary = total === 1 ? "Viewed an image" : `Viewed ${total} images`;
  if (missing === 0) return summary;
  if (viewed > 0) return `${summary} · ${missing} missing`;
  return `${summary} · ${total === 1 ? "file" : "files"} missing`;
}

export function ImageViewSurface({
  imagePaths,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  imagePaths: readonly string[];
  unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const canExpand = imagePaths.length + unavailableImages.length > 0;
  const summary = imageViewSummary(imagePaths.length, unavailableImages.length);

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
                    open={openIndex === index}
                    onOpenChange={(open) => setOpenIndex(open ? index : null)}
                    onPreviousImage={index > 0 ? () => setOpenIndex(index - 1) : undefined}
                    onNextImage={
                      index < imagePaths.length - 1 ? () => setOpenIndex(index + 1) : undefined
                    }
                  />
                ))}
                {unavailableImages.map((image, index) => (
                  <UnavailableImageTile key={`${image.sourcePath}:${index}`} image={image} />
                ))}
              </div>
            </div>
          </div>
        ) : null
      }
    />
  );
}

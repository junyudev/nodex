import { useIntl, type IntlShape } from "@/lib/i18n";
import { useState } from "react";
import { ImageEditorTabIcon } from "@/components/shared/icons";
import type { CodexUnavailableImage } from "@/lib/types";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageTile } from "./unavailable-image";
import { ContentImageViewer, useViewableContentImage } from "./content-image-viewer";
import { ConversationImageThumbnail } from "./user-message-attachments";

function InspectedImageThumbnail({ source }: { source: string }) {
  const intl = useIntl();
  const alt = intl.formatMessage({
    id: "conversation.imageViewSurface.alt",
    defaultMessage: "Inspected image",
  });
  const { src, isLoading, isError, bindTrigger, open, onContextMenu, onImageError } =
    useViewableContentImage(source, alt);

  return (
    <span className="contents" onContextMenu={onContextMenu}>
      <ConversationImageThumbnail
        src={src}
        isLoading={isLoading}
        isError={isError}
        alt={alt}
        previewLabel={intl.formatMessage({
          id: "conversation.imageViewSurface.previewLabel",
          defaultMessage: "Inspected image",
        })}
        buttonRef={bindTrigger}
        onOpenPreview={() => open?.()}
        onImageError={onImageError}
      />
    </span>
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
            canExpand ? { expanded, onToggle: () => setExpanded((current) => !current) } : undefined
          }
        />
      }
      body={
        expanded ? (
          <div className="min-w-0">
            <div className="hide-scrollbar flex max-w-full overflow-x-auto pb-1">
              <div className="flex min-w-max gap-2">
                <ContentImageViewer>
                  {imagePaths.map((source, index) => (
                    <InspectedImageThumbnail key={`${source}:${index}`} source={source} />
                  ))}
                </ContentImageViewer>
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

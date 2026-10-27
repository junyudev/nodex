import { useRef, useState, type ReactNode } from "react";
import type { CodexImportedMarkdownImage } from "@/lib/types";
import { ConversationMediaReplacementContext } from "@/lib/conversation-media/conversation-media";
import { decodeConversationText } from "@/lib/markdown/conversation-tokens";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { ImageErrorTile } from "./user-message-attachments";
import { UnavailableImageChip } from "./unavailable-image";
import { useConversationImageAsset } from "./use-conversation-image-asset";

/**
 * Imported destinations are mdast URLs: entities decoded, percent encoding kept. The token
 * renderer passes the authored href, so both sides meet at one decoded, URI-encoded key.
 */
function destinationKey(destination: string): string {
  try {
    return encodeURI(destination).replace(/%25/gu, "%");
  } catch {
    return destination;
  }
}

function ImportedMarkdownImage({ source, alt }: { source: string; alt: string }) {
  const asset = useConversationImageAsset(source);
  const [previewing, setPreviewing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  // Markdown images sit inside paragraphs, so every state stays phrasing content.
  if (asset.isLoading && !asset.previewSrc)
    return (
      <span
        role="status"
        aria-label={`Loading ${alt}`}
        className="my-3 inline-flex size-16 items-center justify-center rounded-lg border border-token-border bg-token-bg-tertiary align-top text-token-description-foreground"
      >
        <ActivitySpinnerIcon className="size-4" />
      </span>
    );
  if (asset.isError || !asset.previewSrc)
    return <ImageErrorTile onRetry={() => void asset.refetch()} />;
  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Open ${alt}`}
        className="my-3 inline-block max-w-full cursor-interaction rounded-md align-top focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
        onClick={() => setPreviewing(true)}
      >
        <img
          src={asset.previewSrc}
          alt={alt}
          referrerPolicy="no-referrer"
          className="max-h-[min(48vh,32rem)] max-w-full rounded-md"
          onError={() => void asset.refetch()}
        />
      </button>
      {previewing ? (
        <ImagePreviewDialog
          open
          onOpenChange={setPreviewing}
          src={asset.previewSrc}
          downloadSrc={asset.downloadSrc ?? undefined}
          alt={alt}
          finalFocus={() => {
            trigger.current?.focus();
            return false;
          }}
        />
      ) : null}
    </>
  );
}

/** Renders an imported reply's pictures from their owned copies, or as missing records. */
export function ImportedMarkdownImagesProvider({
  images,
  children,
}: {
  images: readonly CodexImportedMarkdownImage[] | undefined;
  children: ReactNode;
}) {
  if (!images?.length) return children;
  const byDestination = new Map(images.map((image) => [destinationKey(image.sourcePath), image]));
  const replace = (src: string, alt: string) => {
    const image = byDestination.get(destinationKey(decodeConversationText(src)));
    if (!image) return undefined;
    return image.source === null ? (
      <UnavailableImageChip image={image} className="my-1" />
    ) : (
      <ImportedMarkdownImage source={image.source} alt={alt || image.name} />
    );
  };
  return (
    <ConversationMediaReplacementContext value={replace}>
      {children}
    </ConversationMediaReplacementContext>
  );
}

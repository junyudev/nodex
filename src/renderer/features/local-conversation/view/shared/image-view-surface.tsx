import { useRef, useState } from "react";
import { ImageEditorTabIcon, LoadingIcon } from "@/components/shared/icons";
import {
  ImagePreviewDialog,
  resolveImageDisplaySource,
} from "@/features/user-attachment-image-editor";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";
import { useConversationImageAsset } from "./use-conversation-image-asset";

function InspectedImageButton({
  alt,
  displaySrc,
  onImageError,
  onOpen,
}: {
  alt: string;
  displaySrc: string;
  onImageError: () => void;
  onOpen: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <button
      type="button"
      className="size-20 cursor-interaction rounded-lg border border-token-border-heavy focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
      aria-label={alt}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <img
        src={displaySrc}
        className="h-full w-full rounded-md object-cover"
        referrerPolicy="no-referrer"
        alt={alt}
        onError={onImageError}
      />
    </button>
  );
}

function ResolvedInspectedImageThumbnail({
  alt,
  onOpen,
  source,
}: {
  alt: string;
  onOpen: (trigger: HTMLButtonElement) => void;
  source: string;
}) {
  const asset = useConversationImageAsset(source, { shouldLoadFileDataUrl: true });

  if (asset.isLoading && !asset.dataUrl) {
    return (
      <div
        aria-label={`Loading ${alt.toLowerCase()}`}
        className="flex size-20 items-center justify-center rounded-lg border border-token-border-heavy text-token-description-foreground"
        role="status"
      >
        <LoadingIcon aria-hidden="true" className="icon-xs animate-spin" />
      </div>
    );
  }

  if (asset.isError || !asset.previewSrc) {
    return (
      <button
        aria-label={`Retry ${alt.toLowerCase()}`}
        className="size-20 cursor-interaction rounded-lg border border-token-border-heavy text-sm text-token-description-foreground focus:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
        type="button"
        onClick={() => void asset.refetch()}
      >
        Image unavailable
      </button>
    );
  }

  return (
    <InspectedImageButton
      alt={alt}
      displaySrc={asset.previewSrc}
      onImageError={() => void asset.refetch()}
      onOpen={onOpen}
    />
  );
}

function InspectedImageThumbnail({
  alt,
  onOpen,
  source,
}: {
  alt: string;
  onOpen: (trigger: HTMLButtonElement) => void;
  source: string;
}) {
  const [shouldResolve, setShouldResolve] = useState(false);
  const displaySrc = resolveImageDisplaySource(source, { allowLocalPath: true });

  if (shouldResolve || !displaySrc) {
    return <ResolvedInspectedImageThumbnail alt={alt} onOpen={onOpen} source={source} />;
  }

  return (
    <InspectedImageButton
      alt={alt}
      displaySrc={displaySrc}
      onImageError={() => setShouldResolve(true)}
      onOpen={onOpen}
    />
  );
}

export function ImageViewSurface({ imagePaths }: { imagePaths: readonly string[] }) {
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const previewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sources = imagePaths;
  const canExpand = sources.length > 0;
  const summary = sources.length === 1 ? "Viewed an image" : `Viewed ${sources.length} images`;
  const handleOpenChange = (open: boolean) => {
    if (!open) setOpenIndex(null);
  };
  const activeSource = openIndex === null ? null : (sources[openIndex] ?? null);

  return (
    <>
      <ThreadActivityShell
        className="overflow-clip"
        header={
          <ThreadRichActivityHeader
            status="completed"
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
                  {sources.map((source, index) => (
                    <InspectedImageThumbnail
                      key={`${source}:${index}`}
                      alt="Inspected image"
                      source={source}
                      onOpen={(trigger) => {
                        previewTriggerRef.current = trigger;
                        setOpenIndex(index);
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
          ) : null
        }
      />
      {activeSource ? (
        <ImagePreviewDialog
          open
          onOpenChange={handleOpenChange}
          src={activeSource}
          alt="Inspected image"
          allowLocalPath
          finalFocus={() => {
            previewTriggerRef.current?.focus();
            return false;
          }}
          onPreviousImage={
            openIndex !== null && openIndex > 0
              ? () => {
                  setOpenIndex(openIndex - 1);
                }
              : undefined
          }
          onNextImage={
            openIndex !== null && openIndex < sources.length - 1
              ? () => {
                  setOpenIndex(openIndex + 1);
                }
              : undefined
          }
        />
      ) : null}
    </>
  );
}

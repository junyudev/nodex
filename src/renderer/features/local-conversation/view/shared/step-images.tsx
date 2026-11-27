import { useIntl } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ImageIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { CodexStepImage, CodexUnavailableImage } from "@/lib/types";
import { ContentImageViewer, useViewableContentImage } from "./content-image-viewer";
import { NO_UNAVAILABLE_IMAGES, UnavailableImageGlyph } from "./unavailable-image";

/** Thumbnails a strip shows before the rest collapse into a count. */
const SHOWN_STEP_IMAGES = 3;

export const NO_STEP_IMAGES: readonly CodexStepImage[] = [];

const THUMBNAIL_FRAME_CLASS_NAME =
  "flex h-5 min-w-5 shrink-0 items-center justify-center rounded-[3px]";

/**
 * The pictures a step brought back for its Agent, small, right after the step's summary: whatever
 * the tool, a picture the Agent saw shows without opening the step. Hovering one gives a closer
 * look; any of them opens full size, and the viewer moves between all of the strip's pictures.
 * Past the first few, a count stands for the rest; they load once the strip is pointed at or
 * focused, and the count opens the first of them that reads.
 */
export function StepImageStrip({
  images,
  unavailableImages = NO_UNAVAILABLE_IMAGES,
}: {
  readonly images: readonly CodexStepImage[];
  readonly unavailableImages?: readonly CodexUnavailableImage[];
}) {
  const intl = useIntl();
  const [engaged, setEngaged] = useState(false);
  const countRef = useRef<HTMLButtonElement | null>(null);
  // The overflow pictures that can open, by position, and whether the count waits for one.
  const openers = useRef(new Map<number, () => void>());
  const waitingToOpen = useRef(false);
  if (images.length === 0 && unavailableImages.length === 0) return null;
  // A count stands for two or more pictures; one more picture simply shows.
  const counted = images.length > SHOWN_STEP_IMAGES + 1;
  const shown = counted ? images.slice(0, SHOWN_STEP_IMAGES) : images;
  const overflow = counted ? images.slice(SHOWN_STEP_IMAGES) : NO_STEP_IMAGES;
  const openFirstOverflow = () => {
    const first = [...openers.current].toSorted(([left], [right]) => left - right)[0];
    first?.[1]();
    return first !== undefined;
  };
  const reportOpener = (index: number, open: (() => void) | undefined) => {
    if (!open) {
      openers.current.delete(index);
      return;
    }
    openers.current.set(index, open);
    if (waitingToOpen.current) {
      waitingToOpen.current = false;
      openFirstOverflow();
    }
  };
  const returnFocusToCount = () => countRef.current;
  return (
    <span
      className="flex items-center gap-1"
      data-step-images=""
      onPointerEnter={() => setEngaged(true)}
      onFocus={() => setEngaged(true)}
    >
      <ContentImageViewer>
        {shown.map((image, index) => (
          <StepImageThumbnail key={`${image.source}:${index}`} image={image} />
        ))}
        {engaged
          ? overflow.map((image, index) => (
              <OverflowStepImage
                key={`${image.source}:${index}`}
                image={image}
                index={index}
                returnFocusTo={returnFocusToCount}
                onOpenable={reportOpener}
              />
            ))
          : null}
      </ContentImageViewer>
      {overflow.length > 0 ? (
        <button
          ref={countRef}
          type="button"
          className={`${THUMBNAIL_FRAME_CLASS_NAME} cursor-interaction px-1 text-[11px] leading-none text-token-description-foreground tabular-nums ring-[0.5px] ring-token-border ring-inset hover:text-token-foreground hover:ring-token-border-heavy focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none`}
          aria-label={intl.formatMessage(
            {
              id: "conversation.stepImages.more",
              defaultMessage: "{count, plural, one {# more image} other {# more images}}",
            },
            { count: overflow.length },
          )}
          onClick={() => {
            setEngaged(true);
            waitingToOpen.current = !openFirstOverflow();
          }}
        >
          +{overflow.length}
        </button>
      ) : null}
      {unavailableImages.map((image, index) => (
        <UnavailableImageGlyph key={`${image.sourcePath}:${index}`} image={image} />
      ))}
    </span>
  );
}

function useStepImageAlt(image: CodexStepImage): string {
  const intl = useIntl();
  // A tool's result picture has no file name; it is named for where it came from.
  return (
    image.name ??
    intl.formatMessage({ id: "conversation.stepImages.toolOutput", defaultMessage: "Tool output" })
  );
}

/** A picture past the shown ones, reached through the viewer or the count that stands for it. */
function OverflowStepImage({
  image,
  index,
  returnFocusTo,
  onOpenable,
}: {
  readonly image: CodexStepImage;
  readonly index: number;
  readonly returnFocusTo: () => HTMLElement | null;
  readonly onOpenable: (index: number, open: (() => void) | undefined) => void;
}) {
  const { bindTrigger, open } = useViewableContentImage(image.source, useStepImageAlt(image), {
    returnFocusTo,
  });
  useEffect(() => {
    onOpenable(index, open);
    return () => onOpenable(index, undefined);
  }, [index, onOpenable, open]);
  return <button ref={bindTrigger} type="button" hidden tabIndex={-1} aria-hidden="true" />;
}

function StepImageThumbnail({ image }: { readonly image: CodexStepImage }) {
  const intl = useIntl();
  const alt = useStepImageAlt(image);
  const { src, isLoading, isError, bindTrigger, open, onContextMenu, onImageError } =
    useViewableContentImage(image.source, alt);

  if (isLoading)
    return (
      <span
        role="status"
        aria-label={intl.formatMessage(
          { id: "conversation.stepImages.loading", defaultMessage: "Loading {name}" },
          { name: alt },
        )}
        className={`${THUMBNAIL_FRAME_CLASS_NAME} w-7 bg-token-foreground/5`}
      />
    );
  if (isError || !src)
    return (
      <span
        role="img"
        aria-label={intl.formatMessage({
          id: "conversation.stepImages.failed",
          defaultMessage: "Image failed to load",
        })}
        className={`${THUMBNAIL_FRAME_CLASS_NAME} border border-dashed border-token-border text-token-description-foreground`}
      >
        <ImageIcon className="size-3" aria-hidden="true" />
      </span>
    );
  return (
    <NodexTooltip
      surface="rich"
      side="top"
      delay={300}
      tooltipBodyClassName="p-1"
      tooltipContent={
        <img
          src={src}
          alt=""
          className="block max-h-64 max-w-80 rounded-[5px] object-contain"
          draggable={false}
        />
      }
    >
      <button
        ref={bindTrigger}
        type="button"
        aria-label={
          image.name
            ? intl.formatMessage(
                { id: "conversation.stepImages.open", defaultMessage: "Open {name}" },
                { name: image.name },
              )
            : intl.formatMessage({
                id: "conversation.stepImages.openToolOutput",
                defaultMessage: "Open tool output",
              })
        }
        className="group/step-image relative block h-5 shrink-0 cursor-zoom-in overflow-hidden rounded-[3px] focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none"
        onClick={open}
        onContextMenu={onContextMenu}
      >
        <img
          src={src}
          alt={alt}
          className="block h-full w-auto max-w-9 min-w-5 object-cover"
          draggable={false}
          onError={onImageError}
        />
        <span className="pointer-events-none absolute inset-0 rounded-[3px] ring-[0.5px] ring-token-border ring-inset group-hover/step-image:ring-token-border-heavy" />
      </button>
    </NodexTooltip>
  );
}

import { useIntl, type IntlShape } from "@/lib/i18n";
import { ImageIcon } from "@/components/shared/icons";
import type { CodexUnavailableImage } from "@/lib/types";
import { cn } from "@/lib/utils";

export const NO_UNAVAILABLE_IMAGES: readonly CodexUnavailableImage[] = [];

// Missing imported pictures are records, not attachments: they never get a source to load.
const describe = (intl: IntlShape, image: CodexUnavailableImage) => ({
  "aria-label": intl.formatMessage(
    { id: "conversation.unavailableImage.missingFile", defaultMessage: "{name}, file missing" },
    { name: image.name },
  ),
  title: intl.formatMessage(
    {
      id: "conversation.unavailableImage.missingAtImport",
      defaultMessage: "{path}\nThe file was already missing when this conversation was imported.",
    },
    { path: image.sourcePath },
  ),
});

/** Inline form for message attachments and Markdown images. */
export function UnavailableImageChip({
  image,
  className,
}: {
  image: CodexUnavailableImage;
  className?: string;
}) {
  const intl = useIntl();
  return (
    <span
      role="img"
      {...describe(intl, image)}
      className={cn(
        "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg border border-dashed border-token-border px-2 align-middle text-xs text-token-description-foreground",
        className,
      )}
    >
      <ImageIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate text-token-foreground">{image.name}</span>
      <span className="shrink-0">
        {intl.formatMessage({
          id: "conversation.unavailableImage.missingChip",
          defaultMessage: "missing",
        })}
      </span>
    </span>
  );
}

/** Thumbnail-sized form for inspected-image strips. */
export function UnavailableImageTile({ image }: { image: CodexUnavailableImage }) {
  const intl = useIntl();
  return (
    <div
      role="img"
      {...describe(intl, image)}
      className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-token-border-heavy px-1.5 text-center text-[10px] leading-tight text-token-description-foreground"
    >
      <ImageIcon className="icon-xs shrink-0" aria-hidden="true" />
      <span className="w-full truncate text-token-foreground">{image.name}</span>
      <span>
        {intl.formatMessage({
          id: "conversation.unavailableImage.missing",
          defaultMessage: "Missing",
        })}
      </span>
    </div>
  );
}

/** Glyph-sized form for a step row's pictures. */
export function UnavailableImageGlyph({ image }: { image: CodexUnavailableImage }) {
  const intl = useIntl();
  return (
    <span
      role="img"
      {...describe(intl, image)}
      className="flex size-5 shrink-0 items-center justify-center rounded-[3px] border border-dashed border-token-border-heavy text-token-description-foreground"
    >
      <ImageIcon className="size-3" aria-hidden="true" />
    </span>
  );
}

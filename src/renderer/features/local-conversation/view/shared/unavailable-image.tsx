import { ImageIcon } from "@/components/shared/icons";
import type { CodexUnavailableImage } from "@/lib/types";
import { cn } from "@/lib/utils";

export const NO_UNAVAILABLE_IMAGES: readonly CodexUnavailableImage[] = [];

// Missing imported pictures are records, not attachments: they never get a source to load.
const describe = (image: CodexUnavailableImage) => ({
  "aria-label": `${image.name}, file missing`,
  title: `${image.sourcePath}\nThe file was already missing when this conversation was imported.`,
});

/** Inline form for message attachments and Markdown images. */
export function UnavailableImageChip({
  image,
  className,
}: {
  image: CodexUnavailableImage;
  className?: string;
}) {
  return (
    <span
      role="img"
      {...describe(image)}
      className={cn(
        "inline-flex h-7 max-w-56 items-center gap-1.5 rounded-lg border border-dashed border-token-border px-2 align-middle text-xs text-token-description-foreground",
        className,
      )}
    >
      <ImageIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="min-w-0 truncate text-token-foreground">{image.name}</span>
      <span className="shrink-0">missing</span>
    </span>
  );
}

/** Thumbnail-sized form for inspected-image strips. */
export function UnavailableImageTile({ image }: { image: CodexUnavailableImage }) {
  return (
    <div
      role="img"
      {...describe(image)}
      className="flex size-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-token-border-heavy px-1.5 text-center text-[10px] leading-tight text-token-description-foreground"
    >
      <ImageIcon className="icon-xs shrink-0" aria-hidden="true" />
      <span className="w-full truncate text-token-foreground">{image.name}</span>
      <span>Missing</span>
    </div>
  );
}

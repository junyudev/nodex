import { useState, type ReactNode } from "react";
import { ImageIcon } from "@/components/shared/icons";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { FileLinkAnchor } from "../shared/file-link-anchor";
import { InlineReferenceVisual } from "./inline-reference-visual";
import { useMarkdownImage } from "./markdown-image";

export interface InlineImageProps {
  readonly url: string;
  readonly alt: string;
  readonly width?: number;
  readonly href?: string;
}

export function inlineImageProps(props: Readonly<Record<string, unknown>> | undefined) {
  const url = typeof props?.url === "string" ? props.url.trim() : "";
  const alt = typeof props?.alt === "string" ? props.alt : "";
  const width =
    typeof props?.width === "number" && Number.isFinite(props.width) && props.width >= 1
      ? Math.floor(props.width)
      : undefined;
  const href = typeof props?.href === "string" && props.href.trim() ? props.href.trim() : undefined;
  return { url, alt, width, href } satisfies InlineImageProps;
}

/**
 * An image within text, shown at the height of the text: icons and badges look as they do on
 * GitHub, and a larger image is a thumbnail that opens full size. A linked image opens its link.
 */
export function InlineImage({
  url,
  alt,
  width,
  href,
  projectWorkspacePath,
}: InlineImageProps & { readonly projectWorkspacePath?: string | null }) {
  const source = useMarkdownImage(url);
  const label = alt.trim() || "Image";
  const shown = source.url;

  const visual = shown ? (
    <NodexTooltip tooltipContent={alt.trim() || null}>
      <img
        src={shown}
        alt={alt}
        draggable={false}
        onError={source.onError}
        className="inline-block h-[1.25em] w-auto rounded-[2px] object-contain align-[-0.25em]"
        style={{ maxWidth: width ? `${width}px` : "16em" }}
      />
    </NodexTooltip>
  ) : (
    <InlineReferenceVisual
      className="max-w-[18rem] font-normal text-token-description-foreground"
      label={label}
      icon={<ImageIcon className="size-full" />}
    />
  );

  if (href) {
    return (
      <FileLinkAnchor href={href} projectWorkspacePath={projectWorkspacePath}>
        {visual}
      </FileLinkAnchor>
    );
  }
  if (!shown) return visual;
  return (
    <ImageViewerButton src={shown} label={label} className="inline rounded-[2px] align-baseline">
      {visual}
    </ImageViewerButton>
  );
}

/** An image that opens full size in the image viewer. */
export function ImageViewerButton({
  src,
  label,
  className,
  children,
}: {
  readonly src: string;
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        contentEditable={false}
        aria-label={`Open ${label}`}
        onClick={() => setOpen(true)}
        className={cn(
          "cursor-zoom-in border-0 bg-transparent p-0",
          "focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:outline-none",
          className,
        )}
      >
        {children}
      </button>
      {open ? <ImagePreviewDialog open onOpenChange={setOpen} src={src} alt={label} /> : null}
    </>
  );
}

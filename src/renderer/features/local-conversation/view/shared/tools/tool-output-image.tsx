import { useIntl } from "@/lib/i18n";
import { useViewableContentImage } from "../content-image-viewer";

/**
 * An image a tool returned, at a glance size that opens full size in the tool call's viewer. The
 * owning conversation resolves scoped result images only while this leaf is mounted.
 */
export function ToolOutputImage({ source }: { readonly source: string }) {
  const intl = useIntl();
  const alt = intl.formatMessage({
    id: "conversation.toolOutputImage.output",
    defaultMessage: "Tool output",
  });
  const { src, isError, bindTrigger, open, onContextMenu, onImageError } = useViewableContentImage(
    source,
    alt,
  );
  if (!src) {
    return (
      <p role="status" className="text-token-description-foreground">
        {isError
          ? intl.formatMessage({
              id: "conversation.toolOutputImage.unavailable",
              defaultMessage: "Image unavailable",
            })
          : intl.formatMessage({
              id: "conversation.toolOutputImage.loading",
              defaultMessage: "Loading image…",
            })}
      </p>
    );
  }
  return (
    <button
      ref={bindTrigger}
      type="button"
      className="block w-fit max-w-full cursor-zoom-in overflow-hidden rounded-lg border border-token-border transition-colors hover:border-token-border-heavy focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
      onClick={open}
      onContextMenu={onContextMenu}
    >
      <img
        src={src}
        alt={alt}
        className="block max-h-48 max-w-full object-contain"
        onError={onImageError}
      />
    </button>
  );
}

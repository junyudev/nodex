import { useIntl } from "@/lib/i18n";
import { useContentImage } from "@/lib/content-image";

/** The owning conversation resolves scoped result images only while this leaf is mounted. */
export function ToolOutputImage({ source }: { readonly source: string }) {
  const intl = useIntl();
  const asset = useContentImage(source);
  if (!asset.previewSrc) {
    return (
      <p role="status" className="text-token-description-foreground">
        {asset.isError
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
    <img
      src={asset.previewSrc}
      alt={intl.formatMessage({
        id: "conversation.toolOutputImage.output",
        defaultMessage: "Tool output",
      })}
      className="max-h-48 w-max max-w-full rounded-md object-contain"
    />
  );
}

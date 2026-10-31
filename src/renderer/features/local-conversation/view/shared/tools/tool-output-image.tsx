import { useContentImage } from "@/lib/content-image";

/** The owning conversation resolves scoped result images only while this leaf is mounted. */
export function ToolOutputImage({ source }: { readonly source: string }) {
  const asset = useContentImage(source);
  if (!asset.previewSrc) {
    return (
      <p role="status" className="text-token-description-foreground">
        {asset.isError ? "Image unavailable" : "Loading image…"}
      </p>
    );
  }
  return (
    <img
      src={asset.previewSrc}
      alt="Tool output"
      className="max-h-48 w-max max-w-full rounded-md object-contain"
    />
  );
}

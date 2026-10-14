import { useLayoutEffect, useRef, useState } from "react";
import { DownloadIcon, LoadingIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  useResolvedImageAsset,
  type ResolvedImageAsset,
} from "../adapters/use-resolved-image-asset";
import {
  createImageDownloadFilename,
  downloadImageDataUrl,
} from "../adapters/resolved-image-asset";
import type {
  EditableImageDescriptor,
  NormalizedUserAttachmentImageEditorOptions,
} from "../model/types";
import { ImageZoomViewer } from "./image-zoom-viewer";

async function downloadReadOnlyImage(
  asset: ResolvedImageAsset,
  image: EditableImageDescriptor,
  filename: string,
  isCurrent: () => boolean,
  publish: (pending: boolean) => void,
) {
  publish(true);
  try {
    const data = await asset.materialize();
    if (isCurrent())
      downloadImageDataUrl(data, createImageDownloadFilename(image.attachmentSrc, filename));
  } catch {
    if (isCurrent()) toast.danger("Could not download image");
  } finally {
    if (isCurrent()) publish(false);
  }
}

/** A read-only Scene never mounts editing controls or connects to a Composer draft. */
export function ReadOnlyImageSurface({
  options,
}: {
  readonly options: NormalizedUserAttachmentImageEditorOptions;
}) {
  const image =
    options.images.find((entry) => entry.id === options.initialImageId) ?? options.images[0];
  const asset = useResolvedImageAsset(
    image?.managedSource ?? image?.dataUrl ?? image?.previewSrc ?? image?.src ?? "",
    {
      hostId: image?.hostId,
      materialize: true,
    },
  );
  const [zoom, setZoom] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const lifetime = useRef<EditableImageDescriptor | null>(null);
  useLayoutEffect(() => {
    lifetime.current = image ?? null;
    return () => {
      lifetime.current = null;
    };
  }, [lifetime, image]);
  const download = () => {
    if (downloading || !image) return;
    return downloadReadOnlyImage(
      asset,
      image,
      options.title,
      () => lifetime.current === image,
      setDownloading,
    );
  };
  if (!asset.previewSrc)
    return <div role="status">{asset.isError ? "Image unavailable" : "Loading image"}</div>;
  return (
    <ImageZoomViewer
      alt={image?.alt ?? "Image"}
      src={asset.previewSrc}
      manualZoomPercent={zoom}
      onManualZoomPercentChange={setZoom}
      trailingControls={
        <NodexButton
          variant="ghost"
          size="icon-sm"
          aria-label="Download image"
          disabled={downloading}
          onClick={() => void download()}
        >
          {downloading ? (
            <LoadingIcon className="icon-xs animate-spin" />
          ) : (
            <DownloadIcon className="icon-xs" />
          )}
        </NodexButton>
      }
    />
  );
}

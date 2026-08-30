import { createImageBlockConfig, imageParse } from "@blocknote/core";
import {
  AddFileButton,
  createReactBlockSpec,
  ResizableFileBlockWrapper,
  useResolveUrl,
  useUploadLoading,
  type ReactCustomBlockRenderProps,
} from "@blocknote/react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NfmImageBlockIcon } from "@/components/shared/icons";
import { readManagedImageByteLength } from "@/lib/assets";
import { parseAssetSource } from "../../../../shared/assets";
import { parsePageFileSource } from "../../../../shared/page-files";
import {
  normalizeImageSourceDimensions,
  type ImageSourceDimensions,
} from "../../../../shared/image-layout";
import {
  usePageFilePlacementRuntime,
  usePageFileReadSnapshot,
  type PageFilePlacementRuntime,
} from "./page-file-runtime";

import { resolveAssetSourceToDisplayUrl, type ManagedAssetPathResolver } from "../../../lib/assets";

type ImageBlockRenderProps = ReactCustomBlockRenderProps<typeof createImageBlockConfig>;

function readBlockSourceDimensions(
  block: ImageBlockRenderProps["block"],
): ImageSourceDimensions | null {
  return normalizeImageSourceDimensions(block.props.sourceWidth, block.props.sourceHeight);
}

function ImageLayoutFrame({
  block,
  children,
}: Pick<ImageBlockRenderProps, "block"> & { readonly children: ReactNode }) {
  const dimensions = readBlockSourceDimensions(block);

  return (
    <div
      className="nfm-image-layout-frame relative w-full max-w-full overflow-hidden rounded"
      data-nfm-image-layout-stable={dimensions ? "true" : "false"}
      style={
        dimensions
          ? { aspectRatio: `${dimensions.sourceWidth} / ${dimensions.sourceHeight}` }
          : undefined
      }
    >
      {children}
    </div>
  );
}

function ImageLoadingState({
  block,
  failed,
}: Pick<ImageBlockRenderProps, "block"> & { readonly failed: boolean }) {
  const hasStableLayout = readBlockSourceDimensions(block) !== null;

  return (
    <ImageLayoutFrame block={block}>
      <div
        className={
          hasStableLayout
            ? "bn-file-loading-preview flex h-full min-h-16 items-center justify-center"
            : "bn-file-loading-preview"
        }
      >
        {failed ? "Image unavailable" : "Loading..."}
      </div>
    </ImageLayoutFrame>
  );
}

function usePersistDecodedImageDimensions({
  block,
  editor,
}: Omit<ImageBlockRenderProps, "contentRef">) {
  return useCallback(
    (image: HTMLImageElement) => {
      const dimensions = normalizeImageSourceDimensions(image.naturalWidth, image.naturalHeight);
      if (!dimensions) return;

      const current = readBlockSourceDimensions(block);
      if (
        current?.sourceWidth === dimensions.sourceWidth &&
        current.sourceHeight === dimensions.sourceHeight
      ) {
        return;
      }

      editor.updateBlock(block, { props: dimensions });
    },
    [block, editor],
  );
}

function resolveImageFileName(source: string, name: string): string {
  const explicitName = name.trim();
  if (explicitName.length > 0) return explicitName;
  if (source.startsWith("data:")) return "Image";

  const path = source.split(/[?#]/u, 1)[0] ?? source;
  const candidate = path.slice(path.lastIndexOf("/") + 1);
  if (candidate.length === 0) return "Image";

  try {
    return decodeURIComponent(candidate);
  } catch {
    return candidate;
  }
}

function resolveDataUrlByteLength(source: string): number | null {
  if (!source.startsWith("data:")) return null;

  const separator = source.indexOf(",");
  if (separator < 0) return null;

  const metadata = source.slice(5, separator);
  const payload = source.slice(separator + 1);
  if (metadata.toLowerCase().includes(";base64")) {
    const normalizedPayload = payload.replace(/\s/gu, "");
    const padding = normalizedPayload.endsWith("==") ? 2 : normalizedPayload.endsWith("=") ? 1 : 0;
    return Math.max(0, Math.floor((normalizedPayload.length * 3) / 4) - padding);
  }

  try {
    return new TextEncoder().encode(decodeURIComponent(payload)).byteLength;
  } catch {
    return null;
  }
}

export function formatImageFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;

  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const formattedValue =
    value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/u, "");
  return `${formattedValue} ${units[unitIndex]}`;
}

function useImageFileSize(source: string, pageFileByteLength: number | null): number | null {
  const knownSize = pageFileByteLength ?? resolveDataUrlByteLength(source);
  const [fileSize, setFileSize] = useState<number | null>(knownSize);

  useEffect(() => {
    let mounted = true;
    setFileSize(knownSize);

    if (knownSize !== null || parseAssetSource(source) === null) {
      return () => {
        mounted = false;
      };
    }

    void readManagedImageByteLength(source)
      .then((bytes) => {
        if (mounted) setFileSize(bytes);
      })
      .catch(() => {
        if (mounted) setFileSize(null);
      });

    return () => {
      mounted = false;
    };
  }, [knownSize, source]);

  return fileSize;
}

function ExternalImagePreview(props: Omit<ImageBlockRenderProps, "contentRef">) {
  const { block } = props;
  const resolved = useResolveUrl(block.props.url);
  const persistDecodedDimensions = usePersistDecodedImageDimensions(props);

  if (resolved.loadingState !== "loaded") {
    return <ImageLoadingState block={block} failed={resolved.loadingState === "error"} />;
  }

  return (
    <ImageLayoutFrame block={block}>
      <img
        className="bn-visual-media block h-auto"
        src={resolved.downloadUrl}
        alt={block.props.name || ""}
        width={block.props.sourceWidth}
        height={block.props.sourceHeight}
        onLoad={(event) => persistDecodedDimensions(event.currentTarget)}
        contentEditable={false}
        draggable={false}
      />
    </ImageLayoutFrame>
  );
}

function PageFileImagePreview({
  block,
  editor,
  runtime,
}: Omit<ImageBlockRenderProps, "contentRef"> & {
  readonly runtime: PageFilePlacementRuntime;
}) {
  const snapshot = usePageFileReadSnapshot(runtime, block.props.url, { objectUrl: true });
  const persistDecodedDimensions = usePersistDecodedImageDimensions({ block, editor });
  if (!snapshot.objectUrl) {
    return <ImageLoadingState block={block} failed={Boolean(snapshot.contentError)} />;
  }

  return (
    <ImageLayoutFrame block={block}>
      <img
        className="bn-visual-media block h-auto"
        src={snapshot.objectUrl}
        alt={block.props.name || ""}
        width={block.props.sourceWidth}
        height={block.props.sourceHeight}
        onLoad={(event) => persistDecodedDimensions(event.currentTarget)}
        contentEditable={false}
        draggable={false}
      />
    </ImageLayoutFrame>
  );
}

function ImagePreview(props: Omit<ImageBlockRenderProps, "contentRef">) {
  const { block } = props;
  const pageFileRuntime = usePageFilePlacementRuntime();
  const isPageFile = parsePageFileSource(block.props.url) !== null;

  if (!isPageFile) return <ExternalImagePreview {...props} />;
  if (!pageFileRuntime) return <ImageLoadingState block={block} failed />;
  return <PageFileImagePreview {...props} runtime={pageFileRuntime} />;
}

function NfmImageFileName({ block }: Omit<ImageBlockRenderProps, "contentRef">) {
  const pageFileRuntime = usePageFilePlacementRuntime();
  const snapshot = usePageFileReadSnapshot(pageFileRuntime, block.props.url, { metadata: true });
  const logicalPath = snapshot.metadata?.logicalPath ?? null;
  const name =
    logicalPath?.split("/").at(-1) || resolveImageFileName(block.props.url, block.props.name);
  const fileSize = useImageFileSize(block.props.url, snapshot.metadata?.byteLength ?? null);

  return (
    <div
      className="nfm-image-file-name-with-icon inline-flex w-fit max-w-full items-center gap-2 rounded-md px-1 py-1 text-token-foreground transition-colors hover:bg-token-foreground/5"
      contentEditable={false}
      draggable={false}
    >
      <NfmImageBlockIcon className="size-5 text-token-foreground" />
      <span className="min-w-0 truncate text-[15px] leading-5 text-token-foreground">{name}</span>
      {fileSize !== null ? (
        <span className="shrink-0 text-[15px] leading-5 text-token-text-secondary">
          {formatImageFileSize(fileSize)}
        </span>
      ) : null}
    </div>
  );
}

function NfmImageFileBlock({
  block,
  children,
}: Omit<ImageBlockRenderProps, "contentRef"> & {
  children: ReactNode;
}) {
  const Wrapper = block.props.caption ? "figure" : "div";

  return (
    <Wrapper className="nfm-image-file-block-content-wrapper flex w-fit max-w-full flex-col">
      {children}
      {block.props.caption ? (
        <figcaption className="bn-file-caption text-token-text-secondary">
          {block.props.caption}
        </figcaption>
      ) : null}
    </Wrapper>
  );
}

function NfmImageBlock(props: ImageBlockRenderProps) {
  const showLoader = useUploadLoading(props.block.id);

  if (showLoader) {
    return (
      <div className="nfm-image-file-block-content-wrapper flex w-fit max-w-full flex-col">
        <div className="bn-file-loading-preview">Loading...</div>
      </div>
    );
  }

  if (props.block.props.url === "") {
    return (
      <div className="nfm-image-file-block-content-wrapper flex w-full flex-col">
        <AddFileButton
          {...(props as unknown as Parameters<typeof AddFileButton>[0])}
          buttonIcon={<NfmImageBlockIcon className="size-6" />}
        />
      </div>
    );
  }

  if (props.block.props.showPreview === false) {
    return (
      <NfmImageFileBlock {...props}>
        <NfmImageFileName {...props} />
      </NfmImageFileBlock>
    );
  }

  return (
    <ResizableFileBlockWrapper
      {...(props as unknown as Parameters<typeof ResizableFileBlockWrapper>[0])}
      buttonIcon={<NfmImageBlockIcon className="size-6" />}
    >
      <ImagePreview {...props} />
    </ResizableFileBlockWrapper>
  );
}

function NfmImageExternalHTML({
  block,
}: ImageBlockRenderProps & { context: { nestingLevel: number } }) {
  const source = resolveExternalImageSource(block.props.url);
  if (!source) return <p>Add image</p>;

  const name = resolveImageFileName(block.props.url, block.props.name);
  const dimensions = readBlockSourceDimensions(block);
  const displayWidth = block.props.previewWidth ?? dimensions?.sourceWidth;
  const displayHeight =
    dimensions && displayWidth
      ? Math.round(displayWidth * (dimensions.sourceHeight / dimensions.sourceWidth))
      : undefined;
  const content = block.props.showPreview ? (
    <img
      src={source}
      alt={block.props.name || ""}
      width={displayWidth}
      height={displayHeight}
      data-preview-width={block.props.previewWidth}
      data-source-width={dimensions?.sourceWidth}
      data-source-height={dimensions?.sourceHeight}
    />
  ) : (
    <a href={source}>{name}</a>
  );

  if (!block.props.caption) return content;
  if (block.props.showPreview) {
    return (
      <figure>
        {content}
        <figcaption>{block.props.caption}</figcaption>
      </figure>
    );
  }

  return (
    <div>
      {content}
      <p>{block.props.caption}</p>
    </div>
  );
}

export function resolveExternalImageSource(
  source: string,
  resolveManagedAssetPath?: ManagedAssetPathResolver,
): string | null {
  return resolveAssetSourceToDisplayUrl(source, resolveManagedAssetPath);
}

export const imageBlockSpec = createReactBlockSpec(createImageBlockConfig, {
  meta: {
    fileBlockAccept: ["image/*"],
  },
  parse: imageParse(),
  render: NfmImageBlock,
  toExternalHTML: NfmImageExternalHTML,
  runsBefore: ["file"],
});

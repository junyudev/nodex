import { createImageBlockConfig, imageParse } from "@blocknote/core";
import {
  AddFileButton,
  createReactBlockSpec,
  ResizableFileBlockWrapper,
  useResolveUrl,
  useUploadLoading,
  type ReactCustomBlockRenderProps,
} from "@blocknote/react";
import { useEffect, useState, type ReactNode } from "react";
import { NfmImageBlockIcon } from "@/components/shared/icons";
import { readManagedImageByteLength } from "@/lib/assets";
import { parseAssetSource } from "../../../../shared/assets";
import { parsePageFileSource } from "../../../../shared/page-files";
import { usePageFilePlacementRuntime } from "./page-file-runtime";

import { resolveAssetSourceToDisplayUrl, type ManagedAssetPathResolver } from "../../../lib/assets";

type ImageBlockRenderProps = ReactCustomBlockRenderProps<typeof createImageBlockConfig>;

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

function useImageFileSize(source: string): number | null {
  const knownSize = resolveDataUrlByteLength(source);
  const [fileSize, setFileSize] = useState<number | null>(knownSize);
  const pageFileRuntime = usePageFilePlacementRuntime();

  useEffect(() => {
    let mounted = true;
    setFileSize(knownSize);

    const pageFileId = parsePageFileSource(source);
    if (knownSize !== null || (parseAssetSource(source) === null && !pageFileId)) {
      return () => {
        mounted = false;
      };
    }

    const readSize = pageFileId
      ? pageFileRuntime?.read(source).then((file) => file.bytes.byteLength)
      : readManagedImageByteLength(source);
    if (!readSize) {
      return () => {
        mounted = false;
      };
    }

    void readSize
      .then((bytes) => {
        if (mounted) setFileSize(bytes);
      })
      .catch(() => {
        if (mounted) setFileSize(null);
      });

    return () => {
      mounted = false;
    };
  }, [knownSize, pageFileRuntime, source]);

  return fileSize;
}

function ResolvedImagePreview({ block }: Omit<ImageBlockRenderProps, "contentRef">) {
  const resolved = useResolveUrl(block.props.url);

  if (resolved.loadingState !== "loaded") {
    return (
      <div className="bn-file-loading-preview">
        {resolved.loadingState === "error" ? "Image unavailable" : "Loading..."}
      </div>
    );
  }

  return (
    <img
      className="bn-visual-media"
      src={resolved.downloadUrl}
      alt={block.props.name || ""}
      width={block.props.previewWidth}
      contentEditable={false}
      draggable={false}
    />
  );
}

function ImagePreview(props: Omit<ImageBlockRenderProps, "contentRef">) {
  const { block } = props;
  const pageFileRuntime = usePageFilePlacementRuntime();
  const readAuthorityEpoch = parsePageFileSource(block.props.url)
    ? pageFileRuntime?.readAuthorityEpoch
    : null;

  return <ResolvedImagePreview key={readAuthorityEpoch} {...props} />;
}

function NfmImageFileName({ block }: Omit<ImageBlockRenderProps, "contentRef">) {
  const pageFileRuntime = usePageFilePlacementRuntime();
  const [logicalPath, setLogicalPath] = useState<string | null>(null);
  useEffect(() => {
    if (!parsePageFileSource(block.props.url) || !pageFileRuntime) return;
    let active = true;
    void pageFileRuntime
      .metadata(block.props.url)
      .then((file) => {
        if (active) setLogicalPath(file.logicalPath);
      })
      .catch(() => {
        if (active) setLogicalPath(null);
      });
    return () => {
      active = false;
    };
  }, [block.props.url, pageFileRuntime]);
  const name =
    logicalPath?.split("/").at(-1) || resolveImageFileName(block.props.url, block.props.name);
  const fileSize = useImageFileSize(block.props.url);

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
  const content = block.props.showPreview ? (
    <img src={source} alt={block.props.name || ""} width={block.props.previewWidth} />
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

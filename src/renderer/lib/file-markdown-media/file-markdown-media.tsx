import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Streamdown, type Components, type StreamdownProps } from "streamdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { Element } from "hast";
import {
  FileMarkdownImageFrame,
  useFileMarkdownImagePresentation,
} from "./file-markdown-image-presentation";
import {
  workspaceFileBinaryQueryOptions,
  workspaceFileMetadataQueryOptions,
} from "../query-options";
import {
  FILE_MARKDOWN_IMAGE_MAX_BYTES,
  decodeFileMarkdownImageBytes,
  fileMarkdownImageMimeType,
  parseFileMarkdownImageSrcSet,
  resolveFileMarkdownImageSource,
  type FileMarkdownMediaScope,
} from "./file-markdown-media-model";
import {
  FILE_MARKDOWN_IMAGE_TAG,
  FILE_MARKDOWN_SOURCE_TAG,
  fileMarkdownMediaRehypePlugins,
} from "./file-markdown-media-syntax";

/** A distinct public Adapter prevents Streamdown's memo from retaining another resource policy. */
export function FileMarkdownMediaStreamdown({ components, ...props }: StreamdownProps) {
  const mediaComponents = useMemo(
    () => ({ ...components, ...fileMarkdownMediaComponents }),
    [components],
  );
  return (
    <Streamdown
      {...props}
      components={mediaComponents}
      rehypePlugins={fileMarkdownMediaRehypePlugins}
    />
  );
}

const FileMarkdownMediaContext = createContext<FileMarkdownMediaScope | null>(null);
const EMPTY_IMAGE_NAMES: ReadonlyMap<string, string> = new Map();

export function FileMarkdownMediaProvider({
  scope,
  children,
}: {
  readonly scope: FileMarkdownMediaScope | undefined;
  readonly children: ReactNode;
}) {
  return (
    <FileMarkdownMediaContext.Provider value={scope ?? null}>
      {children}
    </FileMarkdownMediaContext.Provider>
  );
}

interface MediaSnapshot {
  readonly key: string;
  readonly src?: string;
  readonly srcSet?: string;
  readonly failed: boolean;
  readonly names: ReadonlyMap<string, string>;
  readonly settled: boolean;
}

function useFileMarkdownMedia(source: string, sourceSet: string): MediaSnapshot {
  const scope = useContext(FileMarkdownMediaContext);
  const hostId = scope?.hostId;
  const sourceFilePath = scope?.sourceFilePath;
  const revision = scope?.revision;
  const queryClient = useQueryClient();
  const key = JSON.stringify([
    scope?.hostId,
    scope?.sourceFilePath,
    scope?.revision,
    source,
    sourceSet,
  ]);
  const activeKey = useRef<string | null>(key);
  useLayoutEffect(() => {
    activeKey.current = key;
    return () => {
      activeKey.current = null;
    };
  }, [key]);
  const [snapshot, setSnapshot] = useState<MediaSnapshot>({
    key: "",
    failed: false,
    names: EMPTY_IMAGE_NAMES,
    settled: false,
  });
  useEffect(() => {
    if (!hostId || !sourceFilePath) return;
    let cancelled = false;
    const isCurrent = () => !cancelled && activeKey.current === key;
    const urls = new Set<string>();
    const names = new Map<string, string>();
    const resolvedFiles = new Map<string, Promise<string | undefined>>();
    const resolve = async (value: string): Promise<string | undefined> => {
      if (!isCurrent()) return undefined;
      const target = resolveFileMarkdownImageSource(value, { hostId, sourceFilePath });
      if (target.kind === "blocked") return undefined;
      if (target.kind === "url") {
        const format = target.url.match(/^data:image\/([^;,]+)/iu)?.[1];
        const pathname = format
          ? `image.${format === "svg+xml" ? "svg" : format === "jpeg" ? "jpg" : format === "x-icon" ? "ico" : format}`
          : new URL(target.url).pathname.split("/").at(-1) || "image";
        let name = pathname;
        try {
          name = decodeURIComponent(pathname);
        } catch {
          /* The network URL is still valid. */
        }
        names.set(target.url, name);
        return target.url;
      }
      const previous = resolvedFiles.get(target.path);
      if (previous) return previous;
      const pending = (async () => {
        const input = { hostId: target.hostId, path: target.path };
        const metadata = await queryClient.fetchQuery({
          ...workspaceFileMetadataQueryOptions(input),
          staleTime: 0,
        });
        if (!isCurrent()) return undefined;
        if (
          !metadata.isFile ||
          (metadata.sizeBytes !== null && metadata.sizeBytes > FILE_MARKDOWN_IMAGE_MAX_BYTES)
        )
          return undefined;
        const binary = await queryClient.fetchQuery({
          ...workspaceFileBinaryQueryOptions(input),
          staleTime: 0,
        });
        if (!isCurrent() || !binary.contentsBase64) return undefined;
        const mimeType =
          binary.mimeType ?? metadata.mimeType ?? fileMarkdownImageMimeType(target.path);
        if (!mimeType?.startsWith("image/")) return undefined;
        const bytes = decodeFileMarkdownImageBytes(binary.contentsBase64);
        if (!bytes) return undefined;
        const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
        urls.add(url);
        names.set(url, target.path.replaceAll("\\", "/").split("/").at(-1) || "image");
        return url;
      })().catch(() => undefined);
      resolvedFiles.set(target.path, pending);
      return pending;
    };
    void (async () => {
      const src = source ? await resolve(source) : undefined;
      const candidates: string[] = [];
      for (const candidate of parseFileMarkdownImageSrcSet(sourceSet)) {
        if (!isCurrent()) return;
        const url = await resolve(candidate.source);
        if (url) candidates.push(`${url}${candidate.descriptor ? ` ${candidate.descriptor}` : ""}`);
      }
      if (!isCurrent()) return;
      setSnapshot({
        key,
        src,
        srcSet: candidates.join(", ") || undefined,
        failed: !src && candidates.length === 0,
        names,
        settled: true,
      });
    })();
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
  }, [key, queryClient, hostId, sourceFilePath, revision, source, sourceSet]);
  return snapshot.key === key
    ? snapshot
    : { key, failed: false, names: EMPTY_IMAGE_NAMES, settled: false };
}

const textProperty = (value: unknown) => (typeof value === "string" ? value : undefined);
const dimensionProperty = (value: unknown) =>
  typeof value === "number" || typeof value === "string" ? value : undefined;

export const fileMarkdownMediaComponents: Components = {
  [FILE_MARKDOWN_IMAGE_TAG]: function FileMarkdownImage({
    filesrc,
    filesrcset,
    alt,
    title,
    width,
    height,
    sizes,
  }) {
    const media = useFileMarkdownMedia(textProperty(filesrc) ?? "", textProperty(filesrcset) ?? "");
    const parent = useFileMarkdownImagePresentation();
    if (media.failed && !parent)
      return (
        <span className="text-token-description-foreground" role="status">
          {textProperty(alt) || "Image unavailable"}
        </span>
      );
    const image = (
      <FileMarkdownNativeImage
        media={media}
        alt={textProperty(alt) ?? ""}
        width={dimensionProperty(width)}
        height={dimensionProperty(height)}
        sizes={textProperty(sizes)}
        title={textProperty(title)}
      />
    );
    return parent ? (
      image
    ) : (
      <FileMarkdownImageFrame identity={media.key}>{image}</FileMarkdownImageFrame>
    );
  },
  picture: function FileMarkdownPicture({ node, children }) {
    const scope = useContext(FileMarkdownMediaContext);
    const sources = (element: Element): unknown[] =>
      element.children.flatMap((child) =>
        child.type === "element"
          ? [child.properties.filesrc, child.properties.filesrcset, ...sources(child)]
          : [],
      );
    const identity = JSON.stringify([
      scope?.hostId,
      scope?.sourceFilePath,
      scope?.revision,
      node ? sources(node) : [],
    ]);
    const expectedResources =
      node?.children.filter(
        (child) =>
          child.type === "element" &&
          (child.tagName === FILE_MARKDOWN_IMAGE_TAG || child.tagName === FILE_MARKDOWN_SOURCE_TAG),
      ).length || 1;
    return (
      <FileMarkdownImageFrame identity={identity} expectedResources={expectedResources}>
        <picture>{children}</picture>
      </FileMarkdownImageFrame>
    );
  },
  [FILE_MARKDOWN_SOURCE_TAG]: function FileMarkdownSource({
    filesrcset,
    sizes,
    media,
    type,
    width,
    height,
  }) {
    const resource = useFileMarkdownMedia("", textProperty(filesrcset) ?? "");
    const presentation = useFileMarkdownImagePresentation();
    useLayoutEffect(
      () => presentation?.registerResources(resource.names, resource.settled),
      [presentation, resource.names, resource.settled],
    );
    return (
      <source
        srcSet={resource.srcSet}
        sizes={textProperty(sizes)}
        media={textProperty(media)}
        type={textProperty(type)}
        width={dimensionProperty(width)}
        height={dimensionProperty(height)}
      />
    );
  },
};

function FileMarkdownNativeImage({
  media,
  alt,
  width,
  height,
  sizes,
  title,
}: {
  media: MediaSnapshot;
  alt: string;
  width?: string | number;
  height?: string | number;
  sizes?: string;
  title?: string;
}) {
  const presentation = useFileMarkdownImagePresentation();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useLayoutEffect(() => {
    if (!image) return;
    presentation?.attach(image);
    const unregister = presentation?.registerResources(media.names, media.settled);
    if (
      (image.complete && image.naturalWidth > 0) ||
      (!presentation?.failed &&
        (width !== undefined || height !== undefined) &&
        media.names.size > 0)
    )
      presentation?.loaded(image);
    return () => {
      unregister?.();
      presentation?.attach(null);
    };
  }, [image, media.names, media.settled, presentation, width, height]);
  const element = (
    <img
      ref={setImage}
      alt={textProperty(alt) ?? ""}
      width={dimensionProperty(width)}
      height={dimensionProperty(height)}
      sizes={sizes}
      src={media.src}
      srcSet={media.srcSet}
      hidden={presentation?.failed}
      onLoad={(event) => {
        presentation?.loaded(event.currentTarget);
      }}
      onError={(event) => {
        presentation?.errored(event.currentTarget);
      }}
      className="max-w-full rounded-lg"
    />
  );
  return title ? <NodexTooltip tooltipContent={title}>{element}</NodexTooltip> : element;
}

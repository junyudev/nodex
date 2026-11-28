import { useIntl } from "@/lib/i18n";
import {
  Suspense,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQuery, type QueryFunctionContext } from "@tanstack/react-query";
import type { Components } from "streamdown";
import {
  CopyIcon,
  DownloadIcon,
  FolderIcon,
  ImageIcon,
  LoadingIcon,
} from "@/components/shared/icons";
import { EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import { MediaPauseIcon, MediaPlayIcon } from "@/components/shared/icons/file-viewer-icons";
import { ColorfulFileResourceIcon } from "@/components/shared/file-resource-icon";
import { NODEX_BUTTON_COLOR_CLASS } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import {
  createConversationImageActions,
  type ConversationImageAction,
  openUserAttachmentImagePreview,
  type EditableImageDescriptor,
  downloadImageDataUrl,
  fetchImageSourceAsDataUrl,
  classifyConversationMedia,
  conversationMediaBadge,
  conversationMediaCachePolicy,
  conversationMediaDataUrl,
  conversationMediaExtension,
  conversationMediaFilename,
  conversationMediaMimeType,
  resolveConversationMediaTarget,
  type ContentImageScope,
  type ConversationMediaKind,
  type ConversationMediaTarget,
} from "@/lib/content-image";
import { showConversationImageMenu } from "@/components/conversation-media/conversation-image-menu";
import { LazyConversationVideoPlayer } from "@/components/conversation-media/conversation-video-lazy";
import type { ConversationVideoSizing } from "@/components/conversation-media/conversation-video-player";
import { APP_FILESYSTEM_ORIGIN } from "../../../shared/app-protocol";
import { saveWorkspaceFileCopy } from "@/lib/workspace-file-operations";
import {
  MEDIA_PLAYBACK_RATES,
  MediaControlButton,
  MediaTimeline,
} from "@/components/conversation-media/conversation-media-controls";
import {
  bindMediaDataSource,
  claimMediaPlayback,
  displayTime,
  releaseMediaPlayback,
  safeDuration,
  setMediaPlaybackRate,
} from "@/components/conversation-media/conversation-media-playback";
import { writeTextToClipboard } from "@/lib/clipboard";
import { openExternalUrl, openFileLink } from "@/lib/file-system-operations";
import { toastFailure } from "@/lib/failure-toast";
import { cn } from "@/lib/utils";
import { getFileManagerRevealMessage } from "../../../shared/file-link-openers";
import { workspaceFileBinaryQueryOptions } from "@/lib/query-options";

import { ImagePreviewDialog } from "@/features/user-attachment-image-editor/view/image-preview-dialog";

interface PreviewEntry {
  readonly element: HTMLImageElement;
  readonly image: EditableImageDescriptor;
  readonly isCurrent: () => boolean;
  readonly actions: () => readonly ConversationImageAction[];
}

function createImageCollection() {
  const entries = new Map<symbol, PreviewEntry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PreviewEntry[] = [];
  const publish = () => {
    snapshot = [...entries.values()];
    for (const listener of listeners) listener();
  };
  return {
    read: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    register(entry: PreviewEntry) {
      const key = Symbol();
      entries.set(key, entry);
      publish();
      return () => {
        if (entries.delete(key)) publish();
      };
    },
  };
}
function projectImageCollection(
  entries: readonly PreviewEntry[],
): readonly EditableImageDescriptor[] {
  return entries
    .filter(({ element, isCurrent }) => element.isConnected && isCurrent())
    .toSorted((left, right) =>
      left.element.compareDocumentPosition(right.element) & Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    )
    .map(({ image, element }) => ({
      ...image,
      src: element.currentSrc || element.src || image.src,
      previewSrc: element.currentSrc || element.src || image.src,
      downloadSrc: element.currentSrc || element.src || image.src,
    }));
}
interface MediaContext {
  readonly source: ContentImageScope | null;
  readonly register: (entry: PreviewEntry) => () => void;
  readonly images: () => readonly EditableImageDescriptor[];
  readonly openPreview: (id: string, trigger: HTMLButtonElement, isCurrent: () => boolean) => void;
}
interface ImagePreview {
  readonly id: string;
  readonly trigger: HTMLButtonElement;
  readonly isCurrent: () => boolean;
}
const MediaContext = createContext<MediaContext | null>(null);
/**
 * A message may own the media behind some of its Markdown destinations, such as copies made on
 * import. A replacement renders in place of the authored destination, which is then never loaded.
 */
export const ConversationMediaReplacementContext = createContext<
  ((src: string, alt: string) => ReactNode | undefined) | null
>(null);
const WideMediaContext = createContext(false);
const authorityIds = new WeakMap<object, number>();
let nextAuthorityId = 0;
function authorityId(authority: object | null | undefined) {
  if (!authority) return null;
  const previous = authorityIds.get(authority);
  if (previous !== undefined) return previous;
  const id = ++nextAuthorityId;
  authorityIds.set(authority, id);
  return id;
}

/** The collection contains only currently mounted image leaves; file bytes stay in QueryClient. */
export function ConversationMediaProvider({
  source,
  children,
}: {
  readonly source: ContentImageScope | null;
  readonly children: ReactNode;
}) {
  const [collection] = useState(createImageCollection);
  const entries = useSyncExternalStore(collection.subscribe, collection.read);
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  const context = useMemo<MediaContext>(
    () => ({
      source,
      register: collection.register,
      openPreview: (id, trigger, isCurrent) => {
        if (isCurrent()) setPreview({ id, trigger, isCurrent });
      },
      images: () => projectImageCollection(collection.read()),
    }),
    [source, collection],
  );
  const images = preview ? projectImageCollection(entries) : [];
  const index = preview ? images.findIndex((image) => image.id === preview.id) : -1;
  const active = index < 0 ? null : images[index];
  const selected = preview ? entries.find((entry) => entry.image.id === preview.id) : null;
  const isPreviewCurrent = () =>
    Boolean(preview?.isCurrent() && selected?.element.isConnected && selected.isCurrent());
  const navigate = (image: EditableImageDescriptor) => {
    if (preview?.isCurrent()) setPreview({ ...preview, id: image.id });
  };
  return (
    <MediaContext value={context}>
      <div
        className="contents"
        onContextMenuCapture={(event) => {
          const target = event.target;
          if (!(target instanceof Node)) return;
          const entry = collection
            .read()
            .find(({ element }) => element.parentElement?.contains(target));
          if (!entry) return;
          const actions = entry.isCurrent() ? entry.actions() : [];
          const trigger = entry.element.parentElement;
          if (
            !showConversationImageMenu(
              actions,
              { x: event.clientX, y: event.clientY },
              () => entry.isCurrent() && entry.element.isConnected,
              () => trigger?.focus(),
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
      {active && preview && isPreviewCurrent() ? (
        <ImagePreviewDialog
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null);
          }}
          src={active.previewSrc ?? active.src}
          downloadSrc={active.downloadSrc ?? active.src}
          downloadFileName={conversationMediaFilename(active.attachmentSrc)}
          alt={active.alt}
          isCurrent={isPreviewCurrent}
          onPreviousImage={index > 0 ? () => navigate(images[index - 1]!) : undefined}
          onNextImage={index < images.length - 1 ? () => navigate(images[index + 1]!) : undefined}
          finalFocus={() => {
            if (preview.isCurrent() && preview.trigger.isConnected) preview.trigger.focus();
            return false;
          }}
        />
      ) : null}
    </MediaContext>
  );
}

export interface ConversationMediaResource {
  readonly identity: string;
  readonly status: "loading" | "ready" | "error";
  readonly url: string | null;
  readonly path: string | null;
  readonly isCurrent: () => boolean;
  readonly canMount: () => boolean;
}
function useMediaLifetime(raw: string) {
  const source = useContext(MediaContext)?.source ?? null;
  const target = resolveConversationMediaTarget(raw, source);
  const identity = JSON.stringify([
    authorityId(source?.authority),
    source?.sourceIdentity,
    source?.hostId,
    source?.conversationId,
    raw,
  ]);
  const lifetime = useRef<string | null>(null);
  useLayoutEffect(() => {
    lifetime.current = identity;
    return () => {
      lifetime.current = null;
    };
  }, [identity]);
  const isCurrent = () => lifetime.current === identity && (!source || source.isCurrent());
  const isResourceCurrent = () => Boolean(source?.isResourceCurrent());
  const canMount = () => !source || source.isResourceCurrent();
  return { target, identity, isCurrent, isResourceCurrent, canMount };
}

async function readFileMedia(
  base: ReturnType<typeof workspaceFileBinaryQueryOptions>,
  isResourceCurrent: () => boolean,
  context: QueryFunctionContext,
) {
  if (!isResourceCurrent() || typeof base.queryFn !== "function")
    throw new Error("Media source retired");
  // The named reader is not abortable. Keep signal access lazy so QueryClient can
  // share the admitted read when its last mounted consumer temporarily leaves.
  const response = await base.queryFn({
    client: context.client,
    queryKey: base.queryKey,
    meta: context.meta,
    get signal() {
      return context.signal;
    },
  });
  if (!isResourceCurrent()) throw new Error("Media source retired");
  if (response.contentsBase64 === null) throw new Error("Media unavailable");
  return response;
}

function ConversationFileMedia({
  target,
  identity,
  isCurrent,
  isResourceCurrent,
  raw,
  kind,
  alt,
  title,
}: {
  target: Extract<ConversationMediaTarget, { kind: "file" }>;
  identity: string;
  isCurrent: () => boolean;
  isResourceCurrent: () => boolean;
  raw: string;
  kind: ConversationMediaKind;
  alt: string;
  title?: string;
}) {
  const input = { hostId: target.hostId, path: target.path };
  const base = workspaceFileBinaryQueryOptions(input);
  const options = {
    queryKey: [...base.queryKey, "conversation-media", identity] as const,
    ...conversationMediaCachePolicy(kind),
    retry: false,
    queryFn: readFileMedia.bind(null, base, isResourceCurrent),
  };
  const result = useQuery({ ...options, enabled: isResourceCurrent });
  const resource: ConversationMediaResource = {
    identity,
    status: result.isError ? "error" : result.data ? "ready" : "loading",
    url:
      result.data?.contentsBase64 != null
        ? conversationMediaDataUrl(result.data.contentsBase64, result.data.mimeType, target.path)
        : null,
    path: target.path,
    isCurrent,
    canMount: isResourceCurrent,
  };
  return (
    <ConversationMediaContent resource={resource} raw={raw} kind={kind} alt={alt} title={title} />
  );
}

/** Media containers admit player controls; only direct media-only children can widen them. */
export function ConversationMediaParagraph({
  children,
  mediaSources,
  containsMedia: containsMediaOverride,
  className,
}: {
  readonly children: ReactNode;
  readonly mediaSources?: readonly string[];
  readonly containsMedia?: boolean;
  readonly className?: string;
}) {
  const count = mediaSources?.length ?? 0;
  const containsMedia = containsMediaOverride ?? count > 0;
  const allImages =
    count > 0 && mediaSources?.every((source) => classifyConversationMedia(source) === "image");
  const grid = Boolean(allImages && count > 1);
  const wide = Boolean(allImages && count === 1);
  const allowWide = Boolean(allImages);
  const Container = containsMedia ? "div" : "p";
  return (
    <WideMediaContext value={allowWide}>
      <Container
        className={`text-size-chat leading-relaxed my-2 ${grid ? "flex flex-wrap items-start gap-3" : ""} ${className ?? ""}`}
        data-markdown-image-grid={grid ? "true" : undefined}
        data-wide-markdown-block={wide ? "true" : undefined}
        data-wide-markdown-block-kind={wide ? "image" : undefined}
      >
        {children}
      </Container>
    </WideMediaContext>
  );
}

/** A file this computer streams, which its file manager can show and its host can copy. */
function localMediaPath(resource: ConversationMediaResource): string | null {
  return resource.path && resource.url?.startsWith(APP_FILESYSTEM_ORIGIN) ? resource.path : null;
}

async function saveMedia(
  resource: ConversationMediaResource,
  url: string,
  filename: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
  image?: HTMLImageElement,
) {
  if (!isCurrent() || signal.aborted) return;
  // A local stream is copied by the host, so large media never crosses the renderer.
  const localPath = localMediaPath(resource);
  if (localPath) {
    await saveWorkspaceFileCopy({ hostId: "local", path: localPath });
    return;
  }
  const data = await fetchImageSourceAsDataUrl(url, undefined, { signal, isCurrent, image });
  if (!isCurrent() || signal.aborted) return;
  await downloadImageDataUrl(data, filename);
}

export function ConversationMedia({
  src,
  alt = "",
  title,
}: {
  readonly src?: string;
  readonly alt?: string;
  readonly title?: string;
}) {
  const raw = src ?? "";
  const kind = classifyConversationMedia(raw);
  const { target, identity, isCurrent, isResourceCurrent, canMount } = useMediaLifetime(raw);
  const badge = conversationMediaBadge(raw);
  if (!raw) return null;
  if (badge)
    return (
      <span className="rounded-md bg-token-foreground/5 px-1 font-medium tabular-nums">
        {badge}
      </span>
    );
  if (target.kind === "file")
    return (
      <ConversationFileMedia
        target={target}
        identity={identity}
        isCurrent={isCurrent}
        isResourceCurrent={isResourceCurrent}
        raw={raw}
        kind={kind}
        alt={alt}
        title={title}
      />
    );
  const resource: ConversationMediaResource =
    target.kind === "blocked"
      ? { identity, status: "error", url: null, path: null, isCurrent, canMount }
      : {
          identity,
          status: "ready",
          url: target.url,
          path: target.kind === "stream" ? target.path : null,
          isCurrent,
          canMount,
        };
  return (
    <ConversationMediaContent resource={resource} raw={raw} kind={kind} alt={alt} title={title} />
  );
}
function ConversationMediaContent({
  resource,
  raw,
  kind,
  alt,
  title,
}: {
  resource: ConversationMediaResource;
  raw: string;
  kind: ConversationMediaKind;
  alt: string;
  title?: string;
}) {
  const intl = useIntl();
  if (kind === "audio")
    return (
      <ConversationAudio
        key={resource.identity}
        resource={resource}
        raw={raw}
        alt={alt}
        title={title}
      />
    );
  if (resource.status === "loading") return null;
  if (resource.status === "error" || !resource.url)
    return (
      <MediaUnavailable
        resource={resource}
        label={
          alt ||
          (kind === "image"
            ? intl.formatMessage({
                id: "components.conversationMedia.imageUnavailable",
                defaultMessage: "Image unavailable",
              })
            : intl.formatMessage({
                id: "components.conversationMedia.videoUnavailable",
                defaultMessage: "Video unavailable",
              }))
        }
        title={title}
      />
    );
  return kind === "image" ? (
    <ConversationImage resource={resource} raw={raw} alt={alt} title={title} />
  ) : (
    <ConversationVideo
      key={`${resource.identity}:${resource.url}`}
      resource={resource}
      raw={raw}
      alt={alt}
      title={title}
    />
  );
}
function MediaUnavailable({
  resource,
  label,
  title,
  loading = false,
}: {
  resource: ConversationMediaResource;
  label: string;
  title?: string;
  loading?: boolean;
}) {
  const wide = useContext(WideMediaContext);
  const className = `my-3 inline-flex min-h-24 min-w-24 max-w-full items-center justify-center rounded-md bg-token-foreground/5 p-0 text-token-description-foreground ${wide && resource.path ? "max-h-40" : "max-h-[min(48vh,32rem)]"}`;
  const image = loading ? (
    <LoadingIcon className="icon-md animate-spin" aria-hidden="true" />
  ) : (
    <ImageIcon className="icon-md" aria-hidden="true" />
  );
  return (
    <NodexTooltip tooltipContent={title}>
      <span role="status" data-content-search-skip="true">
        {resource.url && /^https?:/iu.test(resource.url) ? (
          <a
            href={resource.url}
            aria-label={label}
            className={className}
            onClick={(event) => {
              event.preventDefault();
              if (resource.isCurrent() && resource.url)
                void openExternalUrl(resource.url).catch(() => false);
            }}
          >
            {image}
          </a>
        ) : (
          <button type="button" disabled aria-label={label} className={className}>
            {image}
          </button>
        )}
      </span>
    </NodexTooltip>
  );
}

function ConversationImage({
  resource,
  raw,
  alt,
  title,
}: {
  resource: ConversationMediaResource;
  raw: string;
  alt: string;
  title?: string;
}) {
  const intl = useIntl();
  const context = useContext(MediaContext);
  const wide = useContext(WideMediaContext);
  const id = useId();
  const { identity, url, path, isCurrent } = resource;
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [state, setState] = useState<{ identity: string; status: "loaded" | "error" } | null>(null);
  const current = state?.identity === resource.identity ? state.status : null;
  const bindImage = useCallback(
    (element: HTMLImageElement | null) => {
      setImage(element);
      if (!element?.complete || element.naturalWidth <= 0) return;
      setState((previous) =>
        previous?.identity === identity && previous.status === "loaded"
          ? previous
          : { identity, status: "loaded" },
      );
    },
    [identity],
  );
  const download = useMediaDownload(resource, conversationMediaFilename(raw), {
    image: image ?? undefined,
  });
  const actionLifetime = useRef<{
    readonly identity: string;
    readonly controller: AbortController;
  } | null>(null);
  useLayoutEffect(() => {
    const lifetime = { identity: resource.identity, controller: new AbortController() };
    actionLifetime.current = lifetime;
    return () => {
      lifetime.controller.abort();
      if (actionLifetime.current === lifetime) actionLifetime.current = null;
    };
  }, [resource.identity]);
  useLayoutEffect(() => {
    if (!image || !url || !context) return;
    return context.register({
      element: image,
      isCurrent: isCurrent,
      actions: () => {
        const lifetime = actionLifetime.current;
        if (current !== "loaded" || !context.source || lifetime?.identity !== identity) return [];
        return createConversationImageActions({
          url: url,
          image,
          raw,
          alt,
          hostId: context.source?.hostId,
          threadId: context.source?.conversationId ?? undefined,
          path: path,
          composerTarget: context.source?.composerTarget ?? undefined,
          isCurrent: () => image.isConnected && !image.closest("[inert]") && isCurrent(),
          signal: lifetime.controller.signal,
          download: download.save,
        });
      },
      image: {
        id,
        src: url,
        previewSrc: url,
        downloadSrc: url,
        alt,
        attachmentSrc: raw,
        source: "uploaded",
        hostId: context.source?.hostId,
        ...(path ? { localPath: path } : {}),
      },
    });
  }, [image, url, path, isCurrent, context, id, alt, raw, current, identity, download.save]);
  const open = async (trigger: HTMLButtonElement) => {
    if (!resource.url || !resource.isCurrent() || current !== "loaded") return;
    const images = context?.images() ?? [];
    const handled = await openUserAttachmentImagePreview({
      src: resource.url,
      alt,
      attachmentSrc: raw,
      hostId: context?.source?.hostId,
      threadId: context?.source?.conversationId ?? undefined,
      initialImageId: id,
      images,
      availableImageCount: Math.max(1, images.length),
      policy: "edit_button",
      title:
        title ||
        alt ||
        intl.formatMessage({ id: "components.conversationMedia.image", defaultMessage: "Image" }),
      ...(resource.path ? { localPath: resource.path } : {}),
    });
    if (!handled && resource.isCurrent()) context?.openPreview(id, trigger, resource.isCurrent);
  };
  if (current === "error")
    return (
      <MediaUnavailable
        resource={resource}
        label={
          alt ||
          intl.formatMessage({
            id: "components.conversationMedia.imageUnavailable",
            defaultMessage: "Image unavailable",
          })
        }
        title={title}
      />
    );
  const previewButton = (
    <button
      type="button"
      aria-label={
        alt ||
        intl.formatMessage({
          id: "components.conversationMedia.openImagePreview",
          defaultMessage: "Open image preview",
        })
      }
      onClick={(event) => {
        void open(event.currentTarget);
      }}
      disabled={current !== "loaded"}
      className="inline-flex max-w-full rounded-lg"
    >
      <img
        ref={bindImage}
        src={resource.url ?? undefined}
        alt={alt}
        loading="lazy"
        className={`my-3 h-auto w-auto rounded-md border border-token-border object-contain shadow-md ${wide && resource.path ? "max-h-40 max-w-full" : "max-h-50 max-w-50"}`}
        onLoad={() => setState({ identity: resource.identity, status: "loaded" })}
        onError={() => setState({ identity: resource.identity, status: "error" })}
      />
    </button>
  );
  const element = (
    <span className="relative inline-flex max-w-full">
      {previewButton}
      {current === "loaded" ? <MediaDownloadButton download={download} kind="image" /> : null}
    </span>
  );
  return <NodexTooltip tooltipContent={title}>{element}</NodexTooltip>;
}

interface DownloadState {
  readonly identity: string;
  readonly pending: boolean;
  readonly failed: boolean;
}
interface PendingDownload {
  readonly identity: string;
  readonly controller: AbortController;
}
async function runMediaDownload(
  resource: ConversationMediaResource,
  filename: string,
  pending: { current: PendingDownload | null },
  publish: (state: DownloadState | null) => void,
  options: MediaDownloadOptions,
) {
  if (!resource.url || !resource.isCurrent() || pending.current) return;
  const controller = new AbortController();
  const attempt = { identity: resource.identity, controller };
  pending.current = attempt;
  publish({ identity: resource.identity, pending: true, failed: false });
  try {
    await saveMedia(
      resource,
      resource.url,
      filename,
      resource.isCurrent,
      controller.signal,
      options.image,
    );
    if (resource.isCurrent() && !controller.signal.aborted) publish(null);
  } catch {
    if (!resource.isCurrent() || controller.signal.aborted) return;
    publish({ identity: resource.identity, pending: false, failed: true });
    options.onFailed?.();
  } finally {
    if (pending.current === attempt) pending.current = null;
  }
}
interface MediaDownloadOptions {
  readonly image?: HTMLImageElement;
  /** Reports a failed save where the player shows failures, instead of its own status line. */
  readonly onFailed?: () => void;
}

function useMediaDownload(
  resource: ConversationMediaResource,
  filename: string,
  options: MediaDownloadOptions = {},
) {
  const pending = useRef<PendingDownload | null>(null);
  const [status, setStatus] = useState<DownloadState | null>(null);
  useLayoutEffect(
    () => () => {
      const attempt = pending.current;
      if (attempt?.identity !== resource.identity) return;
      attempt.controller.abort();
      if (pending.current === attempt) pending.current = null;
    },
    [resource.identity],
  );
  const save = () => runMediaDownload(resource, filename, pending, setStatus, options);
  const current = status?.identity === resource.identity ? status : null;
  return { save, current };
}
function MediaDownloadButton({
  download: { save, current },
  kind,
}: {
  readonly download: ReturnType<typeof useMediaDownload>;
  readonly kind: ConversationMediaKind;
}) {
  const intl = useIntl();
  const label = intl.formatMessage(
    {
      id: "components.conversationMedia.download",
      defaultMessage:
        "{kind, select, image {Download image} video {Download video} other {Download audio}}",
    },
    { kind },
  );
  return (
    <span data-content-search-skip="true" className="absolute bottom-2 right-2">
      <NodexTooltip tooltipContent={label}>
        <button
          type="button"
          aria-label={label}
          disabled={current?.pending}
          onClick={() => {
            void save();
          }}
          className="rounded-md border border-token-border bg-token-background p-1.5"
        >
          <DownloadIcon className="icon-xs" />
        </button>
      </NodexTooltip>
      {current?.failed ? (
        <span role="status">
          {intl.formatMessage(
            {
              id: "components.conversationMedia.downloadError",
              defaultMessage:
                "{kind, select, image {Unable to download image} video {Unable to download video} other {Unable to download audio}}",
            },
            { kind },
          )}
        </span>
      ) : null}
    </span>
  );
}

interface AudioPlayback {
  readonly identity: string;
  readonly playing: boolean;
  readonly time: number;
  readonly duration: number;
  readonly rate: number;
  readonly failed: boolean;
}

function samePlayback(left: AudioPlayback, right: AudioPlayback) {
  return (
    left.identity === right.identity &&
    left.playing === right.playing &&
    left.time === right.time &&
    left.duration === right.duration &&
    left.rate === right.rate &&
    left.failed === right.failed
  );
}

/** Audio named only by its type is saved under the name it shows, with that type's extension. */
function savedAudioName(name: string, extension: string | null) {
  const named = /\.[a-z0-9]+$/iu.test(name) || !extension ? name : `${name}.${extension}`;
  return named.replace(/[<>:"/\\|?*]/gu, "_");
}

/**
 * A playable audio file: what it is on one line, where it is in time on the next. Its decision,
 * play, leads the trailing controls; everything else is in its menu.
 */
export function ConversationAudio({
  resource,
  raw,
  alt,
  title,
  mimeType,
  className,
}: {
  resource: ConversationMediaResource;
  raw: string;
  alt: string;
  title?: string;
  /** The type the source reported, for audio whose name carries none. */
  mimeType?: string;
  className?: string;
}) {
  const intl = useIntl();
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playback, setPlayback] = useState<AudioPlayback | null>(null);
  const current: AudioPlayback =
    playback?.identity === resource.identity
      ? playback
      : {
          identity: resource.identity,
          playing: false,
          time: 0,
          duration: 0,
          rate: 1,
          failed: false,
        };
  const carried = !raw || /^data:/iu.test(raw);
  const name =
    title ||
    (carried
      ? alt ||
        intl.formatMessage({ id: "components.conversationMedia.audio", defaultMessage: "Audio" })
      : conversationMediaFilename(raw));
  const type = mimeType ?? conversationMediaMimeType(raw || (resource.url ?? ""));
  const extension =
    /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toLowerCase() ?? conversationMediaExtension(type);
  const ready = resource.status === "ready" && !current.failed;
  const copyPath = resource.path ?? (carried ? null : raw);
  const revealPath = localMediaPath(resource);
  const { save, current: download } = useMediaDownload(resource, savedAudioName(name, extension), {
    onFailed: () =>
      toastFailure(
        intl.formatMessage({
          id: "components.conversationMedia.saveAudioError",
          defaultMessage: "Couldn’t save audio",
        }),
      ),
  });
  useLayoutEffect(
    () => () => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      releaseMediaPlayback(audio);
    },
    [audio],
  );
  // Native media repeats events whose values have not changed; those keep the same state.
  const update = (patch: Partial<Omit<AudioPlayback, "identity">>) =>
    setPlayback((previous) => {
      const base = previous?.identity === resource.identity ? previous : current;
      const next: AudioPlayback = { ...base, ...patch, identity: resource.identity };
      return previous && samePlayback(previous, next) ? previous : next;
    });
  const sourceFailed = useEffectEvent(() => update({ failed: true }));
  const sourceIsCurrent = useEffectEvent(resource.isCurrent);
  useEffect(() => {
    // Carried bytes play from a decoder-owned Blob, so a long clip never sits in the DOM as text.
    if (!audio || !resource.url || !sourceIsCurrent() || !/^data:/iu.test(resource.url)) return;
    return bindMediaDataSource(audio, resource.url, sourceFailed);
  }, [audio, resource.url]);
  const play = async (element: HTMLMediaElement) => {
    try {
      await element.play();
    } catch {
      if (resource.isCurrent()) update({ playing: false });
    }
  };
  const toggle = () => {
    if (!audio || !ready || !resource.isCurrent()) return;
    if (audio.paused) void play(audio);
    else audio.pause();
  };
  const playbackLabel = intl.formatMessage(
    {
      id: "components.conversationMedia.playback",
      defaultMessage: "{action, select, pause {Pause {name}} other {Play {name}}}",
    },
    { action: current.playing ? "pause" : "play", name },
  );
  const menu = [
    copyPath ? (
      <NodexDropdownItem
        key="copy"
        leftSlot={<CopyIcon />}
        onSelect={() => {
          if (resource.isCurrent()) void writeTextToClipboard(copyPath);
        }}
      >
        {intl.formatMessage({
          id: "components.conversationMedia.copyPath",
          defaultMessage: "Copy path",
        })}
      </NodexDropdownItem>
    ) : null,
    revealPath ? (
      <NodexDropdownItem
        key="reveal"
        leftSlot={<FolderIcon />}
        onSelect={() => {
          if (!resource.isCurrent()) return;
          void openFileLink({ path: revealPath }, "fileManager").then((opened) => {
            if (!opened && resource.isCurrent())
              toastFailure(
                intl.formatMessage({
                  id: "components.conversationMedia.revealAudioFailed",
                  defaultMessage: "Couldn’t reveal audio",
                }),
              );
          });
        }}
      >
        {intl.formatMessage(getFileManagerRevealMessage(navigator.platform))}
      </NodexDropdownItem>
    ) : null,
    ready ? (
      <NodexDropdownItem
        key="save"
        leftSlot={<DownloadIcon />}
        disabled={download?.pending}
        onSelect={() => {
          void save();
        }}
      >
        {intl.formatMessage({
          id: "components.conversationMedia.saveCopy",
          defaultMessage: "Save a copy",
        })}
      </NodexDropdownItem>
    ) : null,
  ].filter(Boolean);
  return (
    <div
      className={cn(
        "my-3 flex w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-lg border-[0.5px] border-token-border",
        className,
      )}
      data-content-search-skip="true"
    >
      <div className="flex min-w-0 items-center gap-3 p-3">
        <ColorfulFileResourceIcon path={name} mimeType={type} className="size-5 shrink-0" />
        <div className="flex min-w-0 flex-1 flex-col">
          <NodexTooltip tooltipContent={name}>
            <span className="truncate font-medium text-token-foreground">{name}</span>
          </NodexTooltip>
          <span
            className="truncate text-sm text-token-description-foreground"
            role={ready ? undefined : "status"}
          >
            {ready
              ? extension
                ? intl.formatMessage(
                    {
                      id: "components.conversationMedia.audioFormat",
                      defaultMessage: "{format} audio",
                    },
                    { format: extension.toUpperCase() },
                  )
                : intl.formatMessage({
                    id: "components.conversationMedia.audio",
                    defaultMessage: "Audio",
                  })
              : resource.status === "loading"
                ? intl.formatMessage({
                    id: "components.conversationMedia.loadingAudio",
                    defaultMessage: "Loading audio…",
                  })
                : intl.formatMessage({
                    id: "components.conversationMedia.audioUnavailable",
                    defaultMessage: "Audio unavailable",
                  })}
          </span>
        </div>
        {resource.status === "loading" ? (
          <LoadingIcon className="icon-sm shrink-0 animate-spin text-token-description-foreground" />
        ) : null}
        {ready ? (
          <NodexTooltip tooltipContent={playbackLabel}>
            <button
              type="button"
              aria-label={playbackLabel}
              onClick={toggle}
              className={cn(
                NODEX_BUTTON_COLOR_CLASS.secondary,
                "flex size-8 shrink-0 cursor-interaction items-center justify-center rounded-full outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border",
              )}
            >
              {current.playing ? <MediaPauseIcon /> : <MediaPlayIcon />}
            </button>
          </NodexTooltip>
        ) : null}
        {menu.length > 0 ? (
          <NodexDropdownMenu
            align="end"
            contentWidth="xs"
            triggerButton={
              <MediaControlButton
                label={intl.formatMessage(
                  {
                    id: "components.conversationMedia.moreOptions",
                    defaultMessage: "More options for {name}",
                  },
                  { name },
                )}
              >
                <EllipsisIcon />
              </MediaControlButton>
            }
          >
            {menu}
            {ready ? (
              <>
                <NodexDropdownSeparator />
                <NodexDropdownSectionLabel>
                  {intl.formatMessage({
                    id: "components.conversationVideoPlayer.speed",
                    defaultMessage: "Playback speed",
                  })}
                </NodexDropdownSectionLabel>
                <NodexDropdownRadioGroup
                  value={String(current.rate)}
                  onValueChange={(rate) => {
                    if (audio && resource.isCurrent()) setMediaPlaybackRate(audio, Number(rate));
                  }}
                >
                  {MEDIA_PLAYBACK_RATES.map((rate) => (
                    <NodexDropdownRadioItem key={rate} value={String(rate)}>
                      {rate}×
                    </NodexDropdownRadioItem>
                  ))}
                </NodexDropdownRadioGroup>
              </>
            ) : null}
          </NodexDropdownMenu>
        ) : null}
      </div>
      {ready ? (
        <>
          <div className="flex min-w-0 items-center gap-3 border-t-[0.5px] border-token-border px-3 py-1">
            <MediaTimeline
              element={audio}
              isCurrent={resource.isCurrent}
              label={intl.formatMessage(
                { id: "components.conversationMedia.seek", defaultMessage: "Seek in {name}" },
                { name },
              )}
              time={current.time}
              duration={current.duration}
              onTimeChange={(time) => update({ time })}
              resume={(element) => void play(element)}
            />
            <span className="shrink-0 text-xs whitespace-nowrap semantic-text-secondary tabular-nums">
              {displayTime(current.time)} / {displayTime(current.duration)}
            </span>
          </div>
          <audio
            ref={setAudio}
            hidden
            src={/^data:/iu.test(resource.url ?? "") ? undefined : (resource.url ?? undefined)}
            aria-label={
              alt ||
              intl.formatMessage({
                id: "components.conversationMedia.audio",
                defaultMessage: "Audio",
              })
            }
            preload="metadata"
            onDurationChange={(event) =>
              update({ duration: safeDuration(event.currentTarget.duration) })
            }
            onTimeUpdate={(event) => update({ time: event.currentTarget.currentTime })}
            onPlay={(event) => {
              claimMediaPlayback(event.currentTarget);
              update({ playing: true });
            }}
            onPause={() => update({ playing: false })}
            onEnded={() => update({ playing: false })}
            onRateChange={(event) => update({ rate: event.currentTarget.playbackRate })}
            onError={() => update({ failed: true })}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * Audio whose bytes come with the content that shows it, such as a tool's result, rather than a
 * file the content names. The player keeps the bytes only while it stays mounted.
 */
export function ConversationCarriedAudio({
  url,
  status = url ? "ready" : "error",
  mimeType,
  label,
  className,
}: {
  readonly url: string | null;
  readonly status?: ConversationMediaResource["status"];
  readonly mimeType?: string;
  readonly label?: string;
  readonly className?: string;
}) {
  const identity = useId();
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const resource: ConversationMediaResource = {
    // The bytes' length and tail tell clips apart without comparing whole payloads on each render.
    identity: `${identity}:${status}:${url ? `${url.length}:${url.slice(-48)}` : ""}`,
    status,
    url,
    path: null,
    isCurrent: () => mounted.current,
    canMount: () => true,
  };
  return (
    <ConversationAudio
      key={resource.identity}
      resource={resource}
      raw={url ?? ""}
      alt={label ?? ""}
      mimeType={mimeType}
      className={className}
    />
  );
}

export function ConversationVideo({
  resource,
  raw,
  alt,
  title,
  sizing,
  allowWide,
}: {
  readonly resource: ConversationMediaResource;
  readonly raw: string;
  readonly alt: string;
  readonly title?: string;
  readonly sizing?: ConversationVideoSizing;
  readonly allowWide?: boolean;
}) {
  const intl = useIntl();
  const { save, current: download } = useMediaDownload(resource, conversationMediaFilename(raw));
  const fallback = (
    <MediaUnavailable
      resource={resource}
      label={
        alt ||
        intl.formatMessage({
          id: "components.conversationMedia.videoUnavailable",
          defaultMessage: "Video unavailable",
        })
      }
      title={title}
    />
  );
  return (
    <Suspense
      fallback={
        <MediaUnavailable
          resource={resource}
          label={
            alt ||
            intl.formatMessage({
              id: "components.conversationMedia.video",
              defaultMessage: "Video",
            })
          }
          title={title}
          loading
        />
      }
    >
      <LazyConversationVideoPlayer
        resource={resource}
        alt={alt}
        title={title}
        sizing={sizing}
        allowWide={allowWide}
        onSaveCopy={save}
        downloadPending={download?.pending ?? false}
        downloadFailed={download?.failed ?? false}
        loadErrorFallback={fallback}
      />
    </Suspense>
  );
}

function paragraphMediaSources(props: object): readonly string[] | undefined {
  const sources = (props as { readonly mediaSources?: unknown }).mediaSources;
  return Array.isArray(sources) && sources.every((value) => typeof value === "string")
    ? sources
    : undefined;
}

function paragraphContainsMedia(props: object): boolean | undefined {
  const value = (props as { readonly containsMedia?: unknown }).containsMedia;
  return typeof value === "boolean" ? value : undefined;
}
function ConversationMarkdownMedia({
  src,
  alt,
  title,
}: {
  readonly src?: string;
  readonly alt?: string;
  readonly title?: string;
}) {
  const replace = useContext(ConversationMediaReplacementContext);
  const replacement = src ? replace?.(src, alt ?? "") : undefined;
  return replacement !== undefined ? (
    replacement
  ) : (
    <ConversationMedia src={src} alt={alt} title={title} />
  );
}
export const conversationMediaComponents: Components = {
  img: ({ src, alt, title }) => (
    <ConversationMarkdownMedia
      src={typeof src === "string" ? src : undefined}
      alt={alt}
      title={title}
    />
  ),
  p: (props) => (
    <ConversationMediaParagraph
      children={props.children}
      className={props.className}
      mediaSources={paragraphMediaSources(props)}
      containsMedia={paragraphContainsMedia(props)}
    />
  ),
  "nodex-media-paragraph": (props) => (
    <ConversationMediaParagraph
      children={props.children as ReactNode}
      mediaSources={paragraphMediaSources(props)}
      containsMedia={paragraphContainsMedia(props)}
    />
  ),
};

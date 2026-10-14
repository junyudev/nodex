import {
  createContext,
  useContext,
  useEffect,
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
  DownloadIcon,
  ImageIcon,
  MoreActionsIcon,
  PauseIcon,
  PlayIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSectionLabel,
} from "@/components/ui/dropdown";
import { writeTextToClipboard } from "../clipboard";
import { openExternalUrl } from "../file-system-operations";
import { workspaceFileBinaryQueryOptions } from "../query-options";
import { openUserAttachmentImagePreview } from "../../features/user-attachment-image-editor/adapters/image-preview-opener-registry";
import { ImagePreviewDialog } from "../../features/user-attachment-image-editor/view/image-preview-dialog";
import type { EditableImageDescriptor } from "../../features/user-attachment-image-editor/model/types";
import {
  downloadImageDataUrl,
  blobToDataUrl,
} from "../../features/user-attachment-image-editor/adapters/resolved-image-asset";
import {
  classifyConversationMedia,
  conversationMediaBadge,
  conversationMediaCachePolicy,
  conversationMediaDataUrl,
  conversationMediaFilename,
  resolveConversationMediaTarget,
  type ConversationMediaKind,
  type ConversationMediaSource,
  type ConversationMediaTarget,
} from "./conversation-media-model";

interface PreviewEntry {
  readonly element: HTMLImageElement;
  readonly image: EditableImageDescriptor;
  readonly isCurrent: () => boolean;
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
  readonly source: ConversationMediaSource | null;
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
  readonly source: ConversationMediaSource | null;
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
      {children}
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

interface MediaResource {
  readonly identity: string;
  readonly status: "loading" | "ready" | "error";
  readonly url: string | null;
  readonly path: string | null;
  readonly isCurrent: () => boolean;
}
function useMediaLifetime(raw: string) {
  const source = useContext(MediaContext)?.source ?? null;
  const target = resolveConversationMediaTarget(raw, source);
  const identity = JSON.stringify([
    authorityId(source?.authority),
    authorityId(source?.nativeConnection),
    source?.sourceIdentity,
    source?.hostId,
    source?.threadId,
    source?.nativeConnection?.sourceEpoch,
    source?.nativeConnection?.generation,
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
  return { target, identity, isCurrent, isResourceCurrent };
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
  const resource: MediaResource = {
    identity,
    status: result.isError ? "error" : result.data ? "ready" : "loading",
    url:
      result.data?.contentsBase64 != null
        ? conversationMediaDataUrl(result.data.contentsBase64, result.data.mimeType, target.path)
        : null,
    path: target.path,
    isCurrent,
  };
  return (
    <ConversationMediaContent resource={resource} raw={raw} kind={kind} alt={alt} title={title} />
  );
}

/** Only an explicit projection of direct media children can widen a paragraph. */
export function ConversationMediaParagraph({
  children,
  mediaSources,
  className,
}: {
  readonly children: ReactNode;
  readonly mediaSources?: readonly string[];
  readonly className?: string;
}) {
  const count = mediaSources?.length ?? 0;
  const allImages =
    count > 0 && mediaSources?.every((source) => classifyConversationMedia(source) === "image");
  const grid = Boolean(allImages && count > 1);
  const wide = Boolean(allImages && count === 1);
  const allowWide = Boolean(allImages);
  return (
    <WideMediaContext value={allowWide}>
      <p
        className={`text-size-chat leading-relaxed my-2 ${grid ? "flex flex-wrap items-start gap-3" : ""} ${className ?? ""}`}
        data-markdown-image-grid={grid ? "true" : undefined}
        data-wide-markdown-block={wide ? "true" : undefined}
        data-wide-markdown-block-kind={wide ? "image" : undefined}
      >
        {children}
      </p>
    </WideMediaContext>
  );
}

async function saveMedia(
  url: string,
  filename: string,
  isCurrent: () => boolean,
  signal: AbortSignal,
) {
  if (!isCurrent() || signal.aborted) return;
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok) throw new Error("Media download failed");
  if (!isCurrent() || signal.aborted) return;
  const blob = await response.blob();
  if (!isCurrent() || signal.aborted) return;
  const data = await blobToDataUrl(blob);
  if (!isCurrent() || signal.aborted) return;
  downloadImageDataUrl(data, filename);
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
  const { target, identity, isCurrent, isResourceCurrent } = useMediaLifetime(raw);
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
  const resource: MediaResource =
    target.kind === "blocked"
      ? { identity, status: "error", url: null, path: null, isCurrent }
      : {
          identity,
          status: "ready",
          url: target.url,
          path: target.kind === "stream" ? target.path : null,
          isCurrent,
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
  resource: MediaResource;
  raw: string;
  kind: ConversationMediaKind;
  alt: string;
  title?: string;
}) {
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
        label={alt || `${kind[0]!.toUpperCase()}${kind.slice(1)} unavailable`}
        title={title}
      />
    );
  return kind === "image" ? (
    <ConversationImage resource={resource} raw={raw} alt={alt} title={title} />
  ) : (
    <ConversationPlayableMedia
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
}: {
  resource: MediaResource;
  label: string;
  title?: string;
}) {
  const wide = useContext(WideMediaContext);
  const className = `my-3 inline-flex min-h-24 min-w-24 max-w-full items-center justify-center rounded-md bg-token-foreground/5 p-0 text-token-description-foreground ${wide && resource.path ? "max-h-40" : "max-h-[min(48vh,32rem)]"}`;
  const image = <ImageIcon className="icon-md" aria-hidden="true" />;
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
  resource: MediaResource;
  raw: string;
  alt: string;
  title?: string;
}) {
  const context = useContext(MediaContext);
  const wide = useContext(WideMediaContext);
  const id = useId();
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [state, setState] = useState<{ identity: string; status: "loaded" | "error" } | null>(null);
  const current = state?.identity === resource.identity ? state.status : null;
  useLayoutEffect(() => {
    if (!image || !resource.url || !context) return;
    return context.register({
      element: image,
      isCurrent: resource.isCurrent,
      image: {
        id,
        src: resource.url,
        previewSrc: resource.url,
        downloadSrc: resource.url,
        alt,
        attachmentSrc: raw,
        source: "uploaded",
        hostId: context.source?.hostId,
        ...(resource.path ? { localPath: resource.path } : {}),
      },
    });
  }, [image, resource.url, resource.path, resource.isCurrent, context, id, alt, raw]);
  const open = async (trigger: HTMLButtonElement) => {
    if (!resource.url || !resource.isCurrent() || current !== "loaded") return;
    const images = context?.images() ?? [];
    const handled = await openUserAttachmentImagePreview({
      src: resource.url,
      alt,
      attachmentSrc: raw,
      hostId: context?.source?.hostId,
      threadId: context?.source?.threadId,
      initialImageId: id,
      images,
      availableImageCount: Math.max(1, images.length),
      policy: "edit_button",
      title: title || alt || "Image",
      ...(resource.path ? { localPath: resource.path } : {}),
    });
    if (!handled && resource.isCurrent()) context?.openPreview(id, trigger, resource.isCurrent);
  };
  if (current === "error")
    return (
      <MediaUnavailable resource={resource} label={alt || "Image unavailable"} title={title} />
    );
  const element = (
    <span className="relative inline-flex max-w-full">
      <button
        type="button"
        aria-label={alt || "Open image preview"}
        onClick={(event) => {
          void open(event.currentTarget);
        }}
        disabled={current !== "loaded"}
        className="inline-flex max-w-full rounded-lg"
      >
        <img
          ref={(element) => {
            setImage(element);
            if (element?.complete && element.naturalWidth > 0)
              setState({ identity: resource.identity, status: "loaded" });
          }}
          src={resource.url ?? undefined}
          alt={alt}
          loading="lazy"
          className={`my-3 h-auto w-auto rounded-md border border-token-border object-contain shadow-md ${wide && resource.path ? "max-h-40 max-w-full" : "max-h-50 max-w-50"}`}
          onLoad={() => setState({ identity: resource.identity, status: "loaded" })}
          onError={() => setState({ identity: resource.identity, status: "error" })}
        />
      </button>
      {current === "loaded" ? <MediaDownload resource={resource} raw={raw} kind="image" /> : null}
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
  resource: MediaResource,
  raw: string,
  pending: { current: PendingDownload | null },
  publish: (state: DownloadState | null) => void,
) {
  if (!resource.url || !resource.isCurrent() || pending.current) return;
  const controller = new AbortController();
  const attempt = { identity: resource.identity, controller };
  pending.current = attempt;
  publish({ identity: resource.identity, pending: true, failed: false });
  try {
    await saveMedia(
      resource.url,
      conversationMediaFilename(raw),
      resource.isCurrent,
      controller.signal,
    );
    if (resource.isCurrent() && !controller.signal.aborted) publish(null);
  } catch {
    if (resource.isCurrent() && !controller.signal.aborted)
      publish({ identity: resource.identity, pending: false, failed: true });
  } finally {
    if (pending.current === attempt) pending.current = null;
  }
}
function useMediaDownload(resource: MediaResource, raw: string) {
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
  const save = () => runMediaDownload(resource, raw, pending, setStatus);
  const current = status?.identity === resource.identity ? status : null;
  return { save, current };
}
function MediaDownload({
  resource,
  raw,
  kind,
}: {
  resource: MediaResource;
  raw: string;
  kind: ConversationMediaKind;
}) {
  const { save, current } = useMediaDownload(resource, raw);
  return (
    <span data-content-search-skip="true" className="absolute bottom-2 right-2">
      <NodexTooltip tooltipContent={`Download ${kind}`}>
        <button
          type="button"
          aria-label={`Download ${kind}`}
          disabled={current?.pending}
          onClick={() => {
            void save();
          }}
          className="rounded-md border border-token-border bg-token-background p-1.5"
        >
          <DownloadIcon className="icon-xs" />
        </button>
      </NodexTooltip>
      {current?.failed ? <span role="status">Unable to download {kind}</span> : null}
    </span>
  );
}

const safeDuration = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
const displayTime = (value: number) => {
  const seconds = Math.floor(safeDuration(value));
  return `${Math.floor(seconds / 60)}:${(seconds % 60).toString().padStart(2, "0")}`;
};

// Native media handles are mutable platform resources, separate from playback snapshots.
function seekMedia(element: HTMLMediaElement, time: number) {
  element.currentTime = time;
  return element.currentTime;
}
function toggleMediaMuted(element: HTMLMediaElement) {
  element.muted = !element.muted;
}
function setMediaVolume(element: HTMLMediaElement, volume: number) {
  element.volume = volume;
  element.muted = false;
}
function setMediaPlaybackRate(element: HTMLMediaElement, rate: number) {
  element.playbackRate = rate;
}
function ConversationAudio({
  resource,
  raw,
  alt,
  title,
}: {
  resource: MediaResource;
  raw: string;
  alt: string;
  title?: string;
}) {
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  const [playback, setPlayback] = useState<{
    identity: string;
    playing: boolean;
    time: number;
    duration: number;
    failed: boolean;
  } | null>(null);
  const current =
    playback?.identity === resource.identity
      ? playback
      : { playing: false, time: 0, duration: 0, failed: false };
  const name = title || (raw.startsWith("data:") ? alt || "Audio" : conversationMediaFilename(raw));
  const ready = resource.status === "ready" && !current.failed;
  const format = /\.([a-z0-9]+)$/iu.exec(name)?.[1]?.toUpperCase();
  const { save, current: download } = useMediaDownload(resource, raw);
  useLayoutEffect(
    () => () => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    },
    [audio],
  );
  const update = (patch: Partial<typeof current>) =>
    setPlayback((previous) => ({
      ...(previous?.identity === resource.identity
        ? previous
        : { playing: false, time: 0, duration: 0, failed: false }),
      ...patch,
      identity: resource.identity,
    }));
  const toggle = async () => {
    if (!audio || !ready || !resource.isCurrent()) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    try {
      await audio.play();
    } catch {
      if (resource.isCurrent()) update({ playing: false });
    }
  };
  return (
    <span
      className="my-3 inline-flex w-full max-w-lg flex-col overflow-hidden rounded-lg border border-token-border"
      data-content-search-skip="true"
    >
      <span className="flex items-center gap-3 px-3 py-2">
        <span className="min-w-0 flex-1">
          <NodexTooltip tooltipContent={name}>
            <span className="block truncate font-medium">{name}</span>
          </NodexTooltip>
          <span
            className="block text-xs text-token-description-foreground"
            role={ready ? undefined : "status"}
          >
            {ready
              ? `${format ? `${format} ` : ""}audio`
              : resource.status === "loading"
                ? "Loading audio…"
                : "Audio unavailable"}
          </span>
        </span>
        {ready ? (
          <button
            type="button"
            aria-label={`${current.playing ? "Pause" : "Play"} ${name}`}
            onClick={() => {
              void toggle();
            }}
            className="rounded-md p-1.5"
          >
            {current.playing ? <PauseIcon className="icon-sm" /> : <PlayIcon className="icon-sm" />}
          </button>
        ) : null}
        <NodexDropdownMenu
          align="end"
          contentWidth="xs"
          triggerButton={
            <button
              type="button"
              aria-label={`More options for ${name}`}
              className="rounded-md p-1.5"
            >
              <MoreActionsIcon className="icon-sm" />
            </button>
          }
        >
          {!raw.startsWith("data:") ? (
            <NodexDropdownItem
              onSelect={() => {
                if (resource.isCurrent()) void writeTextToClipboard(raw);
              }}
            >
              Copy path
            </NodexDropdownItem>
          ) : null}
          {ready ? (
            <NodexDropdownItem
              disabled={download?.pending}
              onSelect={() => {
                void save();
              }}
            >
              Save a copy…
            </NodexDropdownItem>
          ) : null}
        </NodexDropdownMenu>
      </span>
      {ready ? (
        <>
          <span className="flex items-center gap-2 border-t border-token-border px-3 py-2">
            <input
              type="range"
              aria-label={`Seek in ${name}`}
              min={0}
              max={current.duration || 1}
              step={0.1}
              value={Math.min(current.time, current.duration || 1)}
              disabled={current.duration <= 0}
              className="h-5 min-w-0 flex-1"
              onChange={(event) => {
                if (!audio || !resource.isCurrent()) return;
                update({ time: seekMedia(audio, event.currentTarget.valueAsNumber) });
              }}
            />
            <span className="shrink-0 text-xs tabular-nums">
              {displayTime(current.time)} / {displayTime(current.duration)}
            </span>
          </span>
          <audio
            ref={setAudio}
            hidden
            src={resource.url ?? undefined}
            aria-label={alt || "Audio"}
            controls
            preload="metadata"
            onDurationChange={(event) =>
              update({ duration: safeDuration(event.currentTarget.duration) })
            }
            onTimeUpdate={(event) => update({ time: event.currentTarget.currentTime })}
            onPlay={() => update({ playing: true })}
            onPause={() => update({ playing: false })}
            onEnded={() => update({ playing: false })}
            onError={() => update({ failed: true })}
          />
        </>
      ) : null}
      {download?.failed ? <span role="status">Couldn’t save audio</span> : null}
    </span>
  );
}

function ConversationPlayableMedia({
  resource,
  raw,
  alt,
  title,
}: {
  resource: MediaResource;
  raw: string;
  alt: string;
  title?: string;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [container, setContainer] = useState<HTMLSpanElement | null>(null);
  const [playback, setPlayback] = useState({
    playing: false,
    time: 0,
    duration: 0,
    volume: 1,
    muted: false,
    rate: 1,
  });
  const [fullscreen, setFullscreen] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const seeking = useRef<{ readonly pointerId: number; readonly wasPlaying: boolean } | null>(null);
  const { save, current: download } = useMediaDownload(resource, raw);
  useLayoutEffect(
    () => () => {
      // Consumer retirement stops playback and releases a decoder's reference to the old source.
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
      seeking.current = null;
    },
    [element],
  );
  useEffect(() => {
    if (!container) return;
    const changed = () => setFullscreen(container.ownerDocument.fullscreenElement === container);
    container.ownerDocument.addEventListener("fullscreenchange", changed);
    return () => container.ownerDocument.removeEventListener("fullscreenchange", changed);
  }, [container]);
  const update = (patch: Partial<typeof playback>) =>
    setPlayback((current) => ({ ...current, ...patch }));
  const action = async (perform: () => Promise<unknown>) => {
    if (!resource.isCurrent()) return;
    setActionFailed(false);
    try {
      await perform();
    } catch {
      if (resource.isCurrent()) setActionFailed(true);
    }
  };
  const toggle = () => {
    if (!element || !resource.isCurrent()) return;
    if (element.paused) void action(() => element.play());
    else element.pause();
  };
  const finishSeek = (pointerId: number) => {
    const current = seeking.current;
    if (!current || current.pointerId !== pointerId) return;
    seeking.current = null;
    if (current.wasPlaying && element && resource.isCurrent()) void action(() => element.play());
  };
  if (failed === resource.identity)
    return (
      <MediaUnavailable resource={resource} label={alt || "Video unavailable"} title={title} />
    );
  const props = {
    ref: setElement,
    src: resource.url ?? undefined,
    preload: "metadata",
    "aria-label": alt || "Video",
    onError: () => setFailed(resource.identity),
  } as const;
  return (
    <NodexTooltip tooltipContent={title}>
      <span
        ref={setContainer}
        className="my-3 inline-flex max-h-[min(48vh,32rem)] max-w-[min(100%,44rem)] flex-col overflow-hidden rounded-md border border-token-border shadow-md [&:fullscreen]:m-0 [&:fullscreen]:h-full [&:fullscreen]:max-h-none [&:fullscreen]:w-full [&:fullscreen]:max-w-none [&:fullscreen]:rounded-none"
        data-content-search-skip="true"
      >
        <video
          {...props}
          className="block min-h-0 w-full flex-1 object-contain"
          playsInline
          tabIndex={0}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== " " && event.key !== "Enter") return;
            event.preventDefault();
            if (!event.repeat) toggle();
          }}
          onDurationChange={(event) =>
            update({ duration: safeDuration(event.currentTarget.duration) })
          }
          onTimeUpdate={(event) => update({ time: event.currentTarget.currentTime })}
          onPlay={() => update({ playing: true })}
          onPause={() => update({ playing: false })}
          onEnded={() => update({ playing: false })}
          onVolumeChange={(event) =>
            update({ volume: event.currentTarget.volume, muted: event.currentTarget.muted })
          }
          onRateChange={(event) => update({ rate: event.currentTarget.playbackRate })}
        />
        <span className="flex flex-wrap items-center gap-2 border-t border-token-border px-2 py-1">
          <button
            type="button"
            aria-label={playback.playing ? "Pause video" : "Play video"}
            onClick={toggle}
            className="rounded-md p-1.5"
          >
            {playback.playing ? (
              <PauseIcon className="icon-sm" />
            ) : (
              <PlayIcon className="icon-sm" />
            )}
          </button>
          <input
            type="range"
            aria-label="Seek in video"
            aria-valuetext={`${displayTime(playback.time)} / ${displayTime(playback.duration)}`}
            min={0}
            max={playback.duration || 1}
            step={0.1}
            value={Math.min(playback.time, playback.duration || 1)}
            disabled={playback.duration <= 0}
            className="min-w-16 flex-1"
            onPointerDown={(event) => {
              if (
                event.button !== 0 ||
                !element ||
                playback.duration <= 0 ||
                seeking.current ||
                !resource.isCurrent()
              )
                return;
              seeking.current = { pointerId: event.pointerId, wasPlaying: !element.paused };
              element.pause();
            }}
            onPointerUp={(event) => finishSeek(event.pointerId)}
            onPointerCancel={(event) => finishSeek(event.pointerId)}
            onLostPointerCapture={(event) => finishSeek(event.pointerId)}
            onChange={(event) => {
              if (element && resource.isCurrent()) {
                update({ time: seekMedia(element, event.currentTarget.valueAsNumber) });
              }
            }}
          />
          <span className="text-xs tabular-nums">
            {displayTime(playback.time)} / {displayTime(playback.duration)}
          </span>
          <NodexPopover>
            <NodexPopoverTrigger>
              <button type="button" aria-label="Video volume" className="rounded-md px-1.5 text-xs">
                Volume
              </button>
            </NodexPopoverTrigger>
            <NodexPopoverContent
              side="top"
              align="end"
              portalContainer={fullscreen ? container : undefined}
              aria-label="Video volume"
              className="w-44 flex-row items-center gap-2 p-2"
            >
              <button
                type="button"
                aria-label={playback.muted ? "Unmute video" : "Mute video"}
                aria-pressed={playback.muted}
                onClick={() => {
                  if (element && resource.isCurrent()) toggleMediaMuted(element);
                }}
                className="rounded-md px-1.5 text-xs"
              >
                {playback.muted ? "Unmute" : "Mute"}
              </button>
              <input
                type="range"
                aria-label="Volume"
                aria-valuetext={`${Math.round((playback.muted ? 0 : playback.volume) * 100)}%`}
                min={0}
                max={1}
                step={0.01}
                value={playback.muted ? 0 : playback.volume}
                className="min-w-0 flex-1"
                onChange={(event) => {
                  if (element && resource.isCurrent()) {
                    setMediaVolume(element, event.currentTarget.valueAsNumber);
                  }
                }}
              />
            </NodexPopoverContent>
          </NodexPopover>
          <NodexDropdownMenu
            align="end"
            portalContainer={fullscreen ? container : undefined}
            triggerButton={
              <button type="button" aria-label="Video options" className="rounded-md p-1.5">
                <MoreActionsIcon className="icon-sm" />
              </button>
            }
          >
            <NodexDropdownItem
              disabled={download?.pending}
              onSelect={() => {
                void save();
              }}
            >
              Save video as…
            </NodexDropdownItem>
            <NodexDropdownSectionLabel>Playback speed</NodexDropdownSectionLabel>
            <NodexDropdownRadioGroup
              value={String(playback.rate)}
              onValueChange={(rate) => {
                if (element && resource.isCurrent()) setMediaPlaybackRate(element, Number(rate));
              }}
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((rate) => (
                <NodexDropdownRadioItem key={rate} value={String(rate)}>
                  {rate}×
                </NodexDropdownRadioItem>
              ))}
            </NodexDropdownRadioGroup>
            {element?.ownerDocument.pictureInPictureEnabled ? (
              <NodexDropdownItem
                onSelect={() => {
                  if (element)
                    void action(() =>
                      element.ownerDocument.pictureInPictureElement === element
                        ? element.ownerDocument.exitPictureInPicture()
                        : element.requestPictureInPicture(),
                    );
                }}
              >
                Picture in picture
              </NodexDropdownItem>
            ) : null}
          </NodexDropdownMenu>
          {container?.ownerDocument.fullscreenEnabled ? (
            <button
              type="button"
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => {
                void action(() =>
                  container.ownerDocument.fullscreenElement === container
                    ? container.ownerDocument.exitFullscreen()
                    : container.requestFullscreen(),
                );
              }}
              className="rounded-md px-1.5 text-xs"
            >
              {fullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
          ) : null}
        </span>
        {actionFailed || download?.failed ? (
          <span role="status" className="px-2 pb-2 text-xs">
            Video action failed
          </span>
        ) : null}
      </span>
    </NodexTooltip>
  );
}

function paragraphMediaSources(props: object): readonly string[] | undefined {
  const sources = (props as { readonly mediaSources?: unknown }).mediaSources;
  return Array.isArray(sources) && sources.every((value) => typeof value === "string")
    ? sources
    : undefined;
}
export const conversationMediaComponents: Components = {
  img: ({ src, alt, title }) => (
    <ConversationMedia src={typeof src === "string" ? src : undefined} alt={alt} title={title} />
  ),
  p: (props) => (
    <ConversationMediaParagraph
      children={props.children}
      className={props.className}
      mediaSources={paragraphMediaSources(props)}
    />
  ),
  "nodex-media-paragraph": (props) => (
    <ConversationMediaParagraph
      children={props.children as ReactNode}
      mediaSources={paragraphMediaSources(props)}
    />
  ),
};

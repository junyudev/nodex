import {
  forwardRef,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { EllipsisIcon } from "@/components/shared/icons/customize-action-icons";
import {
  MediaExitFullscreenIcon,
  MediaFullscreenIcon,
  MediaPauseIcon,
  MediaPlayIcon,
  MediaVolumeIcon,
  MediaVolumeMutedIcon,
} from "@/components/shared/icons/file-viewer-icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  NodexSlider,
  NodexSliderRange,
  NodexSliderThumb,
  NodexSliderTrack,
} from "@/components/ui/slider";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  attachMediaDataSource,
  displayTime,
  safeDuration,
  seekMedia,
  setMediaPlaybackRate,
  setMediaVolume,
  toggleMediaMuted,
} from "./conversation-media-playback";

/** `content` sizes the player to the video inside Markdown; `container` fills its parent. */
export type ConversationVideoSizing = "content" | "container";

export interface ConversationVideoPlayerProps {
  readonly resource: {
    readonly identity: string;
    readonly url: string | null;
    readonly isCurrent: () => boolean;
    /** Logical resource admission; unlike actions, this does not require a mounted DOM lease. */
    readonly canMount: () => boolean;
  };
  readonly alt: string;
  readonly title?: string;
  readonly sizing?: ConversationVideoSizing;
  /** Lets a content-sized player use the wide Markdown block height. */
  readonly allowWide?: boolean;
  readonly className?: string;
  readonly onSaveCopy: () => Promise<void>;
  readonly downloadPending: boolean;
  readonly downloadFailed: boolean;
  readonly loadErrorFallback: ReactNode;
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

function bindVideoDataSource(element: HTMLVideoElement, source: string, onError: () => void) {
  try {
    return attachMediaDataSource(element, source);
  } catch {
    onError();
    return undefined;
  }
}

const MediaControlButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string }
>(function MediaControlButton({ label, className, ...props }, ref) {
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          "no-drag cursor-interaction flex h-token-button-composer aspect-square shrink-0 items-center justify-center gap-1 rounded-lg border border-transparent !px-0 py-0 text-sm leading-[18px] whitespace-nowrap semantic-text-secondary select-none",
          "focus:outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40",
          "not-disabled:not-aria-disabled:hover:bg-(--color-background-primary-ghost-hover) aria-expanded:bg-(--color-background-primary-ghost-hover)",
          className,
        )}
        {...props}
      />
    </NodexTooltip>
  );
});

function MediaSlider({
  label,
  valueText,
  min,
  max,
  step,
  value,
  disabled,
  onValueChange,
  onPointerDownCapture,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly disabled?: boolean;
  readonly onValueChange: (value: number) => void;
  readonly onPointerDownCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <NodexSlider
      className="relative flex h-6 w-auto min-w-0 flex-1 touch-none items-center data-[disabled]:opacity-40"
      thumbAlignment="edge"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? 0) : next)}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <NodexSliderTrack className="relative h-0.5 grow overflow-visible rounded-full bg-(--color-border) data-[orientation=horizontal]:h-0.5">
        <NodexSliderRange className="absolute h-full rounded-full bg-(--color-text)" />
        <NodexSliderThumb
          aria-label={label}
          getAriaValueText={() => valueText}
          className="block size-4 cursor-interaction rounded-full border border-default bg-surface-tertiary shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border data-[disabled]:cursor-default"
        />
      </NodexSliderTrack>
    </NodexSlider>
  );
}

export function ConversationVideoPlayer({
  resource,
  alt,
  title,
  sizing = "content",
  allowWide = false,
  className,
  onSaveCopy,
  downloadPending,
  downloadFailed,
  loadErrorFallback,
}: ConversationVideoPlayerProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const [element, setElement] = useState<HTMLVideoElement | null>(null);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
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
  useLayoutEffect(() => {
    // Metadata can arrive before this owner observes the element, e.g. from a cached source.
    if (!element) return;
    setPlayback((current) => ({
      ...current,
      duration: safeDuration(element.duration),
      time: element.currentTime,
      playing: !element.paused,
    }));
  }, [element]);
  const sourceFailed = useEffectEvent(() => setFailed(resource.identity));
  const sourceIsCurrent = useEffectEvent(resource.isCurrent);
  useEffect(() => {
    if (!element || !resource.url || !sourceIsCurrent() || !/^data:/iu.test(resource.url)) return;
    return bindVideoDataSource(element, resource.url, sourceFailed);
  }, [element, resource.url]);
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
  const toggleFullscreen = () => {
    if (!container) return;
    void action(() =>
      container.ownerDocument.fullscreenElement === container
        ? container.ownerDocument.exitFullscreen()
        : container.requestFullscreen(),
    );
  };
  const finishSeek = (pointerId: number) => {
    const current = seeking.current;
    if (!current || current.pointerId !== pointerId) return;
    seeking.current = null;
    if (current.wasPlaying && element && resource.isCurrent()) void action(() => element.play());
  };
  if (!resource.canMount()) return null;
  if (failed === resource.identity) return loadErrorFallback;
  const label = alt || "Video";
  const progress = `${displayTime(playback.time)} / ${displayTime(playback.duration)}`;
  const portalContainer = fullscreen ? container : undefined;
  const volumeIcon =
    playback.muted || playback.volume === 0 ? <MediaVolumeMutedIcon /> : <MediaVolumeIcon />;
  const pictureInPictureEnabled = element?.ownerDocument.pictureInPictureEnabled === true;
  return (
    <NodexTooltip tooltipContent={title}>
      <div
        ref={setContainer}
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-hidden bg-surface",
          "[&:fullscreen]:m-0 [&:fullscreen]:h-full [&:fullscreen]:max-h-none [&:fullscreen]:w-full [&:fullscreen]:max-w-none [&:fullscreen]:rounded-none",
          sizing === "container" ? "size-full" : "my-3 w-fit rounded-md shadow-md",
          sizing === "content" &&
            (allowWide
              ? "max-h-[var(--markdown-wide-block-max-height)] max-w-full"
              : "max-h-[min(48vh,32rem)] max-w-[min(100%,44rem)]"),
          className,
        )}
        data-content-search-skip="true"
        data-markdown-copy="exclude"
        onKeyDownCapture={(event) => {
          if (
            event.key !== "Escape" ||
            event.currentTarget.ownerDocument.fullscreenElement !== event.currentTarget
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          toggleFullscreen();
        }}
      >
        <video
          ref={setElement}
          src={/^data:/iu.test(resource.url ?? "") ? undefined : (resource.url ?? undefined)}
          aria-label={label}
          tabIndex={0}
          playsInline
          preload="metadata"
          className="block min-h-0 w-full flex-1 cursor-interaction object-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-token-focus-border"
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
          onPlay={() => {
            update({ playing: true });
            setActionFailed(false);
          }}
          onPause={() => update({ playing: false })}
          onEnded={() => update({ playing: false })}
          onVolumeChange={(event) =>
            update({ volume: event.currentTarget.volume, muted: event.currentTarget.muted })
          }
          onRateChange={(event) => update({ rate: event.currentTarget.playbackRate })}
          onError={() => setFailed(resource.identity)}
        />
        <div className="@container/video-controls shrink-0 border-t border-(--color-border-subtle) select-none">
          <div className="flex h-10 flex-wrap items-center gap-x-2 px-2 @max-xs/video-controls:h-auto @max-xs/video-controls:py-1">
            <MediaControlButton
              label={playback.playing ? "Pause video" : "Play video"}
              onClick={toggle}
            >
              {playback.playing ? <MediaPauseIcon /> : <MediaPlayIcon />}
            </MediaControlButton>
            <div className="flex min-w-0 flex-1 @max-xs/video-controls:order-first @max-xs/video-controls:basis-full">
              <MediaSlider
                label="Seek in video"
                valueText={progress}
                disabled={playback.duration <= 0}
                min={0}
                max={playback.duration || 1}
                step={0.1}
                value={Math.min(playback.time, playback.duration)}
                onPointerDownCapture={(event) => {
                  if (
                    !element ||
                    playback.duration <= 0 ||
                    event.button !== 0 ||
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
                onValueChange={(time) => {
                  if (element && resource.isCurrent()) update({ time: seekMedia(element, time) });
                }}
              />
            </div>
            <span className="shrink-0 text-xs whitespace-nowrap semantic-text-secondary tabular-nums">
              {progress}
            </span>
            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              <NodexPopover>
                <NodexPopoverTrigger>
                  <MediaControlButton label="Video volume">{volumeIcon}</MediaControlButton>
                </NodexPopoverTrigger>
                <NodexPopoverContent
                  side="top"
                  align="end"
                  portalContainer={portalContainer}
                  aria-label="Video volume"
                  className="w-auto px-2"
                >
                  <div className="flex w-40 items-center gap-2">
                    <MediaControlButton
                      label={playback.muted ? "Unmute video" : "Mute video"}
                      aria-pressed={playback.muted}
                      onClick={() => {
                        if (element && resource.isCurrent()) toggleMediaMuted(element);
                      }}
                    >
                      {volumeIcon}
                    </MediaControlButton>
                    <MediaSlider
                      label="Video volume"
                      valueText={`${Math.round((playback.muted ? 0 : playback.volume) * 100)}%`}
                      min={0}
                      max={1}
                      step={0.01}
                      value={playback.muted ? 0 : playback.volume}
                      onValueChange={(volume) => {
                        if (element && resource.isCurrent()) setMediaVolume(element, volume);
                      }}
                    />
                  </div>
                </NodexPopoverContent>
              </NodexPopover>
              <NodexDropdownMenu
                align="end"
                side="top"
                portalContainer={portalContainer}
                triggerButton={
                  <MediaControlButton label="Video options">
                    <EllipsisIcon />
                  </MediaControlButton>
                }
              >
                <NodexDropdownItem
                  disabled={downloadPending}
                  onSelect={() => {
                    setActionFailed(false);
                    void onSaveCopy().catch(() => {
                      if (resource.isCurrent()) setActionFailed(true);
                    });
                  }}
                >
                  Save video as…
                </NodexDropdownItem>
                <NodexDropdownSeparator />
                <NodexDropdownSectionLabel>Playback speed</NodexDropdownSectionLabel>
                <NodexDropdownRadioGroup
                  value={String(playback.rate)}
                  onValueChange={(rate) => {
                    if (element && resource.isCurrent())
                      setMediaPlaybackRate(element, Number(rate));
                  }}
                >
                  {PLAYBACK_RATES.map((rate) => (
                    <NodexDropdownRadioItem key={rate} value={String(rate)}>
                      {rate}×
                    </NodexDropdownRadioItem>
                  ))}
                </NodexDropdownRadioGroup>
                {pictureInPictureEnabled ? (
                  <NodexDropdownItem
                    onSelect={() => {
                      if (!element) return;
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
                <MediaControlButton
                  label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? <MediaExitFullscreenIcon /> : <MediaFullscreenIcon />}
                </MediaControlButton>
              ) : null}
            </div>
          </div>
          {actionFailed || downloadFailed ? (
            <span role="status" className="block px-2 pb-2 text-xs semantic-text-secondary">
              Could not complete this video action. Try again
            </span>
          ) : null}
        </div>
      </div>
    </NodexTooltip>
  );
}

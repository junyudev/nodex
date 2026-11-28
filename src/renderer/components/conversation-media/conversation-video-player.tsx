import { isEventWithinCurrentTarget } from "@/lib/react-event-ownership";
import { useIntl } from "@/lib/i18n";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { DownloadIcon } from "@/components/shared/icons";
import { PictureInPicture2 } from "@/components/shared/icons/generic-icons";
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
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  MEDIA_PLAYBACK_RATES,
  MediaControlButton,
  MediaSlider,
  MediaTimeline,
} from "@/components/conversation-media/conversation-media-controls";
import {
  bindMediaDataSource,
  claimMediaPlayback,
  displayTime,
  releaseMediaPlayback,
  safeDuration,
  setMediaPlaybackRate,
  setMediaVolume,
  toggleMediaMuted,
} from "@/components/conversation-media/conversation-media-playback";

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
  const intl = useIntl();
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
  const [pictureInPictureElement, setPictureInPictureElement] = useState<HTMLVideoElement | null>(
    null,
  );
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  useLayoutEffect(
    () => () => {
      // Consumer retirement stops playback and releases a decoder's reference to the old source.
      if (!element) return;
      element.pause();
      element.removeAttribute("src");
      element.load();
      releaseMediaPlayback(element);
    },
    [element],
  );
  const attachVideo = useCallback((element: HTMLVideoElement | null) => {
    setElement(element);
    if (!element) return;
    // Cached metadata may already exist when this DOM node is attached.
    setPlayback((current) => ({
      ...current,
      duration: safeDuration(element.duration),
      time: element.currentTime,
      playing: !element.paused,
    }));
  }, []);
  const sourceFailed = useEffectEvent(() => setFailed(resource.identity));
  const sourceIsCurrent = useEffectEvent(resource.isCurrent);
  useEffect(() => {
    if (!element || !resource.url || !sourceIsCurrent() || !/^data:/iu.test(resource.url)) return;
    return bindMediaDataSource(element, resource.url, sourceFailed);
  }, [element, resource.url]);
  useEffect(() => {
    if (!container) return;
    const changed = () => setFullscreen(container.ownerDocument.fullscreenElement === container);
    container.ownerDocument.addEventListener("fullscreenchange", changed);
    return () => container.ownerDocument.removeEventListener("fullscreenchange", changed);
  }, [container]);
  useEffect(() => {
    if (!element) return;
    const enter = () => setPictureInPictureElement(element);
    const leave = () => setPictureInPictureElement(null);
    element.addEventListener("enterpictureinpicture", enter);
    element.addEventListener("leavepictureinpicture", leave);
    return () => {
      element.removeEventListener("enterpictureinpicture", enter);
      element.removeEventListener("leavepictureinpicture", leave);
    };
  }, [element]);
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
  if (!resource.canMount()) return null;
  if (failed === resource.identity) return loadErrorFallback;
  const label =
    alt ||
    intl.formatMessage({ id: "components.conversationVideoPlayer.video", defaultMessage: "Video" });
  const progress = `${displayTime(playback.time)} / ${displayTime(playback.duration)}`;
  const portalContainer = fullscreen ? container : undefined;
  const volumeIcon =
    playback.muted || playback.volume === 0 ? <MediaVolumeMutedIcon /> : <MediaVolumeIcon />;
  const pictureInPictureEnabled = element?.ownerDocument.pictureInPictureEnabled === true;
  const pictureInPictureActive =
    pictureInPictureElement !== null && pictureInPictureElement === element;
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
        onKeyDown={(event) => {
          if (
            event.key !== "Escape" ||
            event.defaultPrevented ||
            event.currentTarget.ownerDocument.fullscreenElement !== event.currentTarget ||
            !isEventWithinCurrentTarget(event)
          )
            return;
          // If focus is outside the open popup and trigger, Base UI dismisses at document.
          if (volumeOpen || optionsOpen) return;
          event.preventDefault();
          event.stopPropagation();
          toggleFullscreen();
        }}
      >
        <video
          ref={attachVideo}
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
          onPlay={(event) => {
            claimMediaPlayback(event.currentTarget);
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
              label={
                playback.playing
                  ? intl.formatMessage({
                      id: "components.conversationVideoPlayer.pause",
                      defaultMessage: "Pause video",
                    })
                  : intl.formatMessage({
                      id: "components.conversationVideoPlayer.play",
                      defaultMessage: "Play video",
                    })
              }
              onClick={toggle}
            >
              {playback.playing ? <MediaPauseIcon /> : <MediaPlayIcon />}
            </MediaControlButton>
            <div className="flex min-w-0 flex-1 @max-xs/video-controls:order-first @max-xs/video-controls:basis-full">
              <MediaTimeline
                element={element}
                isCurrent={resource.isCurrent}
                label={intl.formatMessage({
                  id: "components.conversationVideoPlayer.seek",
                  defaultMessage: "Seek in video",
                })}
                time={playback.time}
                duration={playback.duration}
                onTimeChange={(time) => update({ time })}
                resume={(media) => void action(() => media.play())}
              />
            </div>
            <span className="shrink-0 text-xs whitespace-nowrap semantic-text-secondary tabular-nums">
              {progress}
            </span>
            <div className="ms-auto flex shrink-0 items-center gap-1.5">
              <NodexPopover open={volumeOpen} onOpenChange={setVolumeOpen}>
                <NodexPopoverTrigger>
                  <MediaControlButton
                    label={intl.formatMessage({
                      id: "components.conversationVideoPlayer.volume",
                      defaultMessage: "Video volume",
                    })}
                  >
                    {volumeIcon}
                  </MediaControlButton>
                </NodexPopoverTrigger>
                <NodexPopoverContent
                  side="top"
                  align="end"
                  portalContainer={portalContainer}
                  aria-label={intl.formatMessage({
                    id: "components.conversationVideoPlayer.volume",
                    defaultMessage: "Video volume",
                  })}
                  className="w-auto px-2"
                >
                  <div className="flex w-40 items-center gap-2">
                    <MediaControlButton
                      label={
                        playback.muted
                          ? intl.formatMessage({
                              id: "components.conversationVideoPlayer.unmute",
                              defaultMessage: "Unmute video",
                            })
                          : intl.formatMessage({
                              id: "components.conversationVideoPlayer.mute",
                              defaultMessage: "Mute video",
                            })
                      }
                      aria-pressed={playback.muted}
                      onClick={() => {
                        if (element && resource.isCurrent()) toggleMediaMuted(element);
                      }}
                    >
                      {volumeIcon}
                    </MediaControlButton>
                    <MediaSlider
                      label={intl.formatMessage({
                        id: "components.conversationVideoPlayer.volume",
                        defaultMessage: "Video volume",
                      })}
                      valueText={intl.formatNumber(playback.muted ? 0 : playback.volume, {
                        style: "percent",
                      })}
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
                open={optionsOpen}
                onOpenChange={setOptionsOpen}
                align="end"
                side="top"
                portalContainer={portalContainer}
                triggerButton={
                  <MediaControlButton
                    label={intl.formatMessage({
                      id: "components.conversationVideoPlayer.options",
                      defaultMessage: "Video options",
                    })}
                  >
                    <EllipsisIcon />
                  </MediaControlButton>
                }
              >
                <NodexDropdownItem
                  leftSlot={<DownloadIcon />}
                  disabled={downloadPending}
                  onSelect={() => {
                    setActionFailed(false);
                    void onSaveCopy().catch(() => {
                      if (resource.isCurrent()) setActionFailed(true);
                    });
                  }}
                >
                  {intl.formatMessage({
                    id: "components.conversationVideoPlayer.save",
                    defaultMessage: "Save a copy",
                  })}
                </NodexDropdownItem>
                <NodexDropdownSeparator />
                <NodexDropdownSectionLabel>
                  {intl.formatMessage({
                    id: "components.conversationVideoPlayer.speed",
                    defaultMessage: "Playback speed",
                  })}
                </NodexDropdownSectionLabel>
                <NodexDropdownRadioGroup
                  value={String(playback.rate)}
                  onValueChange={(rate) => {
                    if (element && resource.isCurrent())
                      setMediaPlaybackRate(element, Number(rate));
                  }}
                >
                  {MEDIA_PLAYBACK_RATES.map((rate) => (
                    <NodexDropdownRadioItem key={rate} value={String(rate)}>
                      {rate}×
                    </NodexDropdownRadioItem>
                  ))}
                </NodexDropdownRadioGroup>
                {pictureInPictureEnabled ? (
                  <>
                    <NodexDropdownSeparator />
                    <NodexDropdownItem
                      leftSlot={<PictureInPicture2 />}
                      onSelect={() => {
                        if (!element) return;
                        void action(() =>
                          element.ownerDocument.pictureInPictureElement === element
                            ? element.ownerDocument.exitPictureInPicture()
                            : element.requestPictureInPicture(),
                        );
                      }}
                    >
                      {pictureInPictureActive
                        ? intl.formatMessage({
                            id: "components.conversationVideoPlayer.exitPictureInPicture",
                            defaultMessage: "Exit picture in picture",
                          })
                        : intl.formatMessage({
                            id: "components.conversationVideoPlayer.pictureInPicture",
                            defaultMessage: "Picture in picture",
                          })}
                    </NodexDropdownItem>
                  </>
                ) : null}
              </NodexDropdownMenu>
              {container?.ownerDocument.fullscreenEnabled ? (
                <MediaControlButton
                  label={
                    fullscreen
                      ? intl.formatMessage({
                          id: "components.conversationVideoPlayer.exitFullscreen",
                          defaultMessage: "Exit fullscreen",
                        })
                      : intl.formatMessage({
                          id: "components.conversationVideoPlayer.fullscreen",
                          defaultMessage: "Fullscreen",
                        })
                  }
                  onClick={toggleFullscreen}
                >
                  {fullscreen ? <MediaExitFullscreenIcon /> : <MediaFullscreenIcon />}
                </MediaControlButton>
              ) : null}
            </div>
          </div>
          {actionFailed || downloadFailed ? (
            <span role="status" className="block px-2 pb-2 text-xs semantic-text-secondary">
              {intl.formatMessage({
                id: "components.conversationVideoPlayer.actionFailed",
                defaultMessage: "Could not complete this video action. Try again",
              })}
            </span>
          ) : null}
        </div>
      </div>
    </NodexTooltip>
  );
}

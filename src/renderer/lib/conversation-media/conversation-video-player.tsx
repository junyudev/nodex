import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MoreActionsIcon, PauseIcon, PlayIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSectionLabel,
} from "@/components/ui/dropdown";
import {
  attachMediaDataSource,
  displayTime,
  safeDuration,
  seekMedia,
  toggleMediaMuted,
  setMediaVolume,
  setMediaPlaybackRate,
} from "./conversation-media-playback";

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
  readonly onSaveCopy: () => Promise<void>;
  readonly downloadPending: boolean;
  readonly downloadFailed: boolean;
  readonly loadErrorFallback: ReactNode;
}

function bindVideoDataSource(element: HTMLVideoElement, source: string, onError: () => void) {
  try {
    return attachMediaDataSource(element, source);
  } catch {
    onError();
    return undefined;
  }
}

export function ConversationVideoPlayer({
  resource,
  alt,
  title,
  onSaveCopy,
  downloadPending,
  downloadFailed,
  loadErrorFallback,
}: ConversationVideoPlayerProps) {
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
  const finishSeek = (pointerId: number) => {
    const current = seeking.current;
    if (!current || current.pointerId !== pointerId) return;
    seeking.current = null;
    if (current.wasPlaying && element && resource.isCurrent()) void action(() => element.play());
  };
  if (!resource.canMount()) return null;
  if (failed === resource.identity) return loadErrorFallback;
  const props = {
    ref: setElement,
    src: /^data:/iu.test(resource.url ?? "") ? undefined : (resource.url ?? undefined),
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
              disabled={downloadPending}
              onSelect={() => {
                void onSaveCopy();
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
        {actionFailed || downloadFailed ? (
          <span role="status" className="px-2 pb-2 text-xs">
            Video action failed
          </span>
        ) : null}
      </span>
    </NodexTooltip>
  );
}

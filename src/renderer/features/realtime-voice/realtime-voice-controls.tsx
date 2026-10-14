import { ActivitySpinnerIcon, MicIcon, StopIcon } from "../../components/shared/icons";
import { NodexTooltip } from "../../components/ui/tooltip";
import type { useComposerRealtimeVoice } from "./realtime-voice-window";

type VoiceControls = ReturnType<typeof useComposerRealtimeVoice>;
const button =
  "no-drag cursor-interaction flex h-token-button-composer aspect-square items-center justify-center rounded-full text-token-text-tertiary transition-colors duration-100 hover:bg-token-list-hover-background hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40";
export function RealtimeVoiceControls({ voice }: { readonly voice: VoiceControls }) {
  if (!voice.visible) return null;
  const active = voice.phase === "active";
  const starting = voice.phase === "preparing" || voice.phase === "starting";
  const stopping = voice.phase === "stopping";
  const running = active || starting || stopping;
  const label = stopping
    ? "Ending voice"
    : starting
      ? "Cancel voice"
      : active
        ? "End voice"
        : "Start voice";
  return (
    <>
      {active ? (
        <NodexTooltip
          tooltipContent={voice.microphoneMuted ? "Unmute microphone" : "Mute microphone"}
          side="top"
        >
          <button
            type="button"
            className={button}
            aria-label={voice.microphoneMuted ? "Unmute microphone" : "Mute microphone"}
            aria-pressed={voice.microphoneMuted}
            onClick={() => {
              void voice.setMicrophoneMuted(!voice.microphoneMuted).catch(() => undefined);
            }}
          >
            <MicIcon className="icon-xs" />
          </button>
        </NodexTooltip>
      ) : null}
      {active ? (
        <NodexTooltip tooltipContent={voice.outputMuted ? "Unmute voice" : "Mute voice"} side="top">
          <button
            type="button"
            className={button}
            aria-label={voice.outputMuted ? "Unmute voice" : "Mute voice"}
            aria-pressed={voice.outputMuted}
            onClick={() => {
              void voice.setOutputMuted(!voice.outputMuted).catch(() => undefined);
            }}
          >
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              className="icon-xs"
              aria-hidden="true"
            >
              <path d="m4 8 3 0 4-4v12l-4-4H4V8Z" />
              {voice.outputMuted ? <path d="m14 7 4 6m0-6-4 6" /> : <path d="M14 6c3 2 3 6 0 8" />}
            </svg>
          </button>
        </NodexTooltip>
      ) : null}
      <NodexTooltip tooltipContent={label} side="top">
        <button
          type="button"
          className={button}
          aria-label={label}
          aria-busy={starting || stopping}
          disabled={voice.busy || stopping}
          onClick={() => {
            void (starting ? voice.cancelStart() : running ? voice.stop() : voice.start()).catch(
              () => undefined,
            );
          }}
        >
          {starting || stopping ? (
            <ActivitySpinnerIcon className="icon-xs" />
          ) : active ? (
            <StopIcon className="icon-xs" />
          ) : (
            <svg
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="icon-xs"
              aria-hidden="true"
            >
              <path d="M3 8v4m3-7v10m4-13v16m4-13v10m3-7v4" />
            </svg>
          )}
        </button>
      </NodexTooltip>
    </>
  );
}

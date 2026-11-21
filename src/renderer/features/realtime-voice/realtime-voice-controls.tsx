import { NEEDS_CODEX } from "@/features/app-components/app-component-requirement";
import { useIntl } from "@/lib/i18n";
import {
  ActivitySpinnerIcon,
  MicIcon,
  StopIcon,
  VoiceCallIcon,
  VoiceOutputIcon,
} from "../../components/shared/icons";
import { NodexTooltip } from "../../components/ui/tooltip";
import type { useComposerRealtimeVoice } from "./realtime-voice-window";

type VoiceControls = ReturnType<typeof useComposerRealtimeVoice>;
const button =
  "no-drag cursor-interaction flex h-token-button-composer aspect-square items-center justify-center rounded-full text-token-text-tertiary transition-colors duration-100 hover:bg-token-list-hover-background hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40";
export function RealtimeVoiceControls({ voice }: { readonly voice: VoiceControls }) {
  const intl = useIntl();
  if (!voice.visible) return null;
  const active = voice.phase === "active";
  const starting = voice.phase === "preparing" || voice.phase === "starting";
  const stopping = voice.phase === "stopping";
  const running = active || starting || stopping;
  const label = stopping
    ? intl.formatMessage({
        id: "realtimeVoice.realtimeVoiceControls.ending",
        defaultMessage: "Ending voice",
      })
    : starting
      ? intl.formatMessage({
          id: "realtimeVoice.realtimeVoiceControls.cancel",
          defaultMessage: "Cancel voice",
        })
      : active
        ? intl.formatMessage({
            id: "realtimeVoice.realtimeVoiceControls.end",
            defaultMessage: "End voice",
          })
        : intl.formatMessage({
            id: "realtimeVoice.realtimeVoiceControls.start",
            defaultMessage: "Start voice",
          });
  const callButton = (
    <button
      type="button"
      className={button}
      aria-label={label}
      aria-busy={starting || stopping}
      disabled={voice.needsCodex || voice.busy || stopping}
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
        <VoiceCallIcon className="icon-xs" />
      )}
    </button>
  );
  return (
    <>
      {active ? (
        <NodexTooltip
          tooltipContent={
            voice.microphoneMuted
              ? intl.formatMessage({
                  id: "realtimeVoice.realtimeVoiceControls.unmuteMicrophone",
                  defaultMessage: "Unmute microphone",
                })
              : intl.formatMessage({
                  id: "realtimeVoice.realtimeVoiceControls.muteMicrophone",
                  defaultMessage: "Mute microphone",
                })
          }
          side="top"
        >
          <button
            type="button"
            className={button}
            aria-label={
              voice.microphoneMuted
                ? intl.formatMessage({
                    id: "realtimeVoice.realtimeVoiceControls.unmuteMicrophone",
                    defaultMessage: "Unmute microphone",
                  })
                : intl.formatMessage({
                    id: "realtimeVoice.realtimeVoiceControls.muteMicrophone",
                    defaultMessage: "Mute microphone",
                  })
            }
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
        <NodexTooltip
          tooltipContent={
            voice.outputMuted
              ? intl.formatMessage({
                  id: "realtimeVoice.realtimeVoiceControls.unmuteVoice",
                  defaultMessage: "Unmute voice",
                })
              : intl.formatMessage({
                  id: "realtimeVoice.realtimeVoiceControls.muteVoice",
                  defaultMessage: "Mute voice",
                })
          }
          side="top"
        >
          <button
            type="button"
            className={button}
            aria-label={
              voice.outputMuted
                ? intl.formatMessage({
                    id: "realtimeVoice.realtimeVoiceControls.unmuteVoice",
                    defaultMessage: "Unmute voice",
                  })
                : intl.formatMessage({
                    id: "realtimeVoice.realtimeVoiceControls.muteVoice",
                    defaultMessage: "Mute voice",
                  })
            }
            aria-pressed={voice.outputMuted}
            onClick={() => {
              void voice.setOutputMuted(!voice.outputMuted).catch(() => undefined);
            }}
          >
            <VoiceOutputIcon muted={voice.outputMuted} className="icon-xs" />
          </button>
        </NodexTooltip>
      ) : null}
      <NodexTooltip
        tooltipContent={voice.needsCodex ? intl.formatMessage(NEEDS_CODEX) : label}
        side="top"
      >
        {voice.needsCodex ? <span className="inline-flex">{callButton}</span> : callButton}
      </NodexTooltip>
    </>
  );
}

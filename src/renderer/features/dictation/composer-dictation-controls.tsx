import type { MouseEvent } from "react";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ActivitySpinnerIcon,
  CloseIcon,
  MicIcon,
  StopIcon,
  UpArrowIcon,
} from "@/components/shared/icons";
import { COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME } from "@/components/composer/composer-footer-controls";
import { NEEDS_CODEX } from "@/features/app-components/app-component-requirement";
import type { ComposerDictationController } from "../local-conversation/view/composer/use-composer-dictation";

export function ComposerDictateButton({
  dictation,
  supported,
  inlineDictation,
  disabled = false,
  dictationNeedsCodex = false,
  shortcutLabel,
  onStart,
  onMouseDown,
}: {
  readonly dictation: ComposerDictationController;
  readonly supported: boolean;
  readonly inlineDictation: boolean;
  readonly disabled?: boolean;
  readonly dictationNeedsCodex?: boolean;
  readonly shortcutLabel?: string;
  readonly onStart?: () => void;
  readonly onMouseDown?: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const intl = useIntl();
  const {
    isStarting,
    isDictating,
    isTranscribing,
    canRetryDictation,
    transcriptionAction,
    waveformCanvasRef,
    stopDictation,
    cancelDictation,
    retryDictation,
    startDictation,
  } = dictation;
  if ((!supported && !dictationNeedsCodex) || (inlineDictation && transcriptionAction === "send"))
    return null;
  const dictationButton = (
    <button
      type="button"
      className={cn(
        "border-token-border no-drag cursor-interaction flex h-token-button-composer aspect-square items-center justify-center gap-1 rounded-full border border-transparent px-0 py-0 text-sm leading-[18px] whitespace-nowrap text-token-text-tertiary select-none transition-colors duration-100 focus:outline-none enabled:hover:bg-token-list-hover-background enabled:hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40 data-[state=open]:bg-token-list-hover-background",
        inlineDictation && isDictating && "aspect-auto px-2 bg-token-list-hover-background",
      )}
      aria-label={
        isStarting
          ? intl.formatMessage({
              id: "conversation.localConversationThreadComposer.clickToCancelDictationStart",
              defaultMessage: "Starting dictation; click to cancel",
            })
          : inlineDictation && isDictating
            ? intl.formatMessage({
                id: "conversation.localConversationThreadComposer.stopDictation",
                defaultMessage: "Stop dictation",
              })
            : isTranscribing
              ? inlineDictation
                ? intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.finishingDictation",
                    defaultMessage: "Finishing dictation",
                  })
                : intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.cancelDictationTranscription",
                    defaultMessage: "Cancel dictation transcription",
                  })
              : canRetryDictation
                ? intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.retryDictation",
                    defaultMessage: "Retry dictation",
                  })
                : intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.dictate",
                    defaultMessage: "Dictate",
                  })
      }
      onMouseDown={onMouseDown}
      onClick={() => {
        if (inlineDictation && isDictating) {
          stopDictation("insert");
          return;
        }
        if (isStarting || isTranscribing) {
          cancelDictation();
          return;
        }
        if (canRetryDictation) {
          void retryDictation();
          return;
        }
        onStart?.();
        void startDictation();
      }}
      disabled={disabled || dictationNeedsCodex || (inlineDictation && isTranscribing)}
      aria-busy={isStarting || isTranscribing}
    >
      {inlineDictation && isDictating ? (
        <canvas
          ref={waveformCanvasRef}
          className="h-5 w-8 text-token-text-tertiary"
          aria-hidden="true"
        />
      ) : null}
      {isStarting || isTranscribing ? (
        <ActivitySpinnerIcon className="icon-xs" />
      ) : inlineDictation && isDictating ? (
        <StopIcon className="icon-xs" />
      ) : (
        <MicIcon className="icon-xs" />
      )}
    </button>
  );
  return (
    <NodexTooltip
      tooltipContent={
        dictationNeedsCodex
          ? intl.formatMessage(NEEDS_CODEX)
          : isStarting
            ? intl.formatMessage({
                id: "conversation.localConversationThreadComposer.startingDictation",
                defaultMessage: "Starting dictation…",
              })
            : isDictating
              ? intl.formatMessage({
                  id: "conversation.localConversationThreadComposer.stopDictation",
                  defaultMessage: "Stop dictation",
                })
              : isTranscribing
                ? intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.finishingDictation",
                    defaultMessage: "Finishing dictation",
                  })
                : canRetryDictation
                  ? intl.formatMessage({
                      id: "conversation.localConversationThreadComposer.retryDictation",
                      defaultMessage: "Retry dictation",
                    })
                  : intl.formatMessage({
                      id: "conversation.localConversationThreadComposer.dictate",
                      defaultMessage: "Dictate",
                    })
      }
      shortcutLabel={
        dictationNeedsCodex || isStarting || isDictating || isTranscribing || canRetryDictation
          ? undefined
          : shortcutLabel
      }
      side="top"
      sideOffset={4}
    >
      {dictationNeedsCodex ? (
        <span className="inline-flex">{dictationButton}</span>
      ) : (
        dictationButton
      )}
    </NodexTooltip>
  );
}

export function ComposerDictationSendButton({
  dictation: { stopDictation, transcriptionAction },
  label,
  preserveEditorFocus,
  disabled = false,
}: {
  readonly dictation: ComposerDictationController;
  readonly label: string;
  readonly preserveEditorFocus: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly disabled?: boolean;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <button
        type="button"
        className={cn(COMPOSER_PRIMARY_ACTION_BUTTON_CLASS_NAME, "disabled:opacity-50")}
        aria-label={label}
        aria-busy={transcriptionAction === "send"}
        disabled={disabled || transcriptionAction === "send"}
        onMouseDown={preserveEditorFocus}
        onClick={() => stopDictation("send")}
      >
        {transcriptionAction === "send" ? (
          <ActivitySpinnerIcon className="icon-sm" />
        ) : (
          <UpArrowIcon className="icon-sm" />
        )}
      </button>
    </NodexTooltip>
  );
}

export function ComposerBufferedDictationControls({
  dictation: {
    isTranscribing,
    transcriptionAction,
    waveformCanvasRef,
    stopDictation,
    cancelDictation,
  },
  preserveEditorFocus,
  sendDisabled = false,
}: {
  readonly dictation: ComposerDictationController;
  readonly preserveEditorFocus: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly sendDisabled?: boolean;
}) {
  const intl = useIntl();
  return (
    <>
      <NodexTooltip
        tooltipContent={
          isTranscribing
            ? intl.formatMessage({
                id: "conversation.localConversationThreadComposer.cancelTranscription",
                defaultMessage: "Cancel transcription",
              })
            : intl.formatMessage({
                id: "conversation.localConversationThreadComposer.cancelDictation",
                defaultMessage: "Cancel dictation",
              })
        }
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-secondary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
          aria-label={
            isTranscribing
              ? intl.formatMessage({
                  id: "conversation.localConversationThreadComposer.cancelTranscription",
                  defaultMessage: "Cancel transcription",
                })
              : intl.formatMessage({
                  id: "conversation.localConversationThreadComposer.cancelDictation",
                  defaultMessage: "Cancel dictation",
                })
          }
          onClick={cancelDictation}
        >
          <CloseIcon className="size-4" />
        </button>
      </NodexTooltip>
      <div
        className="flex h-token-button-composer min-w-0 flex-1 items-center justify-center text-base text-token-text-tertiary select-none"
        role={isTranscribing ? "status" : undefined}
      >
        {isTranscribing ? (
          intl.formatMessage({
            id: "conversation.localConversationThreadComposer.transcribing",
            defaultMessage: "Transcribing",
          })
        ) : (
          <canvas
            ref={waveformCanvasRef}
            className="h-token-button-composer w-full text-token-foreground"
            aria-hidden="true"
          />
        )}
      </div>
      <NodexTooltip
        tooltipContent={
          <span className="text-token-foreground">
            {intl.formatMessage({
              id: "conversation.localConversationThreadComposer.stopDictation",
              defaultMessage: "Stop dictation",
            })}
          </span>
        }
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-full border border-transparent px-0 text-(--foreground-secondary) transition-colors duration-100 hover:bg-(--background-tertiary) hover:text-(--foreground)"
          aria-label={intl.formatMessage({
            id: "conversation.localConversationThreadComposer.stopDictation",
            defaultMessage: "Stop dictation",
          })}
          onClick={() => stopDictation("insert")}
          disabled={isTranscribing}
          aria-busy={transcriptionAction === "insert"}
        >
          {transcriptionAction === "insert" ? (
            <ActivitySpinnerIcon className="size-4" />
          ) : (
            <StopIcon className="size-4" />
          )}
        </button>
      </NodexTooltip>
      <NodexTooltip
        tooltipContent={
          <span className="text-token-foreground">
            {intl.formatMessage({
              id: "conversation.localConversationThreadComposer.transcribeAndSend",
              defaultMessage: "Transcribe and send",
            })}
          </span>
        }
        side="top"
        sideOffset={4}
      >
        <button
          type="button"
          className={cn(
            "inline-flex size-7 items-center justify-center rounded-full bg-composer-primary p-0.5 text-composer-primary focus-visible:outline-2 focus-visible:outline-background-composer-primary",
            isTranscribing && "opacity-50",
          )}
          aria-label={intl.formatMessage({
            id: "conversation.localConversationThreadComposer.transcribeAndSend",
            defaultMessage: "Transcribe and send",
          })}
          onMouseDown={preserveEditorFocus}
          onClick={() => stopDictation("send")}
          disabled={sendDisabled || transcriptionAction === "send"}
          aria-busy={transcriptionAction === "send"}
        >
          {transcriptionAction === "send" ? (
            <ActivitySpinnerIcon className="size-4" />
          ) : (
            <UpArrowIcon className="size-5" />
          )}
        </button>
      </NodexTooltip>
    </>
  );
}

export function ComposerDictationRecovery({
  dictation: {
    recovery,
    appendRecoveredText,
    retryDictation,
    dismissRecovery: dismissDictationRecovery,
  },
  onOpenVoiceSettings,
}: {
  readonly dictation: ComposerDictationController;
  readonly onOpenVoiceSettings?: (recordingId?: string) => void;
}) {
  const intl = useIntl();
  return recovery ? (
    <div
      role="status"
      aria-live="polite"
      className="mx-3 mb-2 flex flex-wrap items-center gap-2 text-xs text-token-text-tertiary"
    >
      {recovery.phase === "recovering" ? <ActivitySpinnerIcon className="size-4" /> : null}
      <span className="min-w-0 flex-1">
        {recovery.phase === "recovering"
          ? intl.formatMessage({
              id: "conversation.localConversationThreadComposer.recoveringText",
              defaultMessage: "Recovering text…",
            })
          : recovery.phase === "recovered"
            ? intl.formatMessage({
                id: "conversation.localConversationThreadComposer.textRecovered",
                defaultMessage: "Text recovered",
              })
            : intl.formatMessage({
                id: "conversation.localConversationThreadComposer.dictationStopped",
                defaultMessage: "Dictation stopped",
              })}
      </span>
      {recovery.phase === "recovered" && recovery.text ? (
        <button
          type="button"
          className="rounded px-2 py-1 text-token-foreground hover:bg-token-list-hover-background"
          onClick={() => void appendRecoveredText()}
        >
          {intl.formatMessage({
            id: "conversation.localConversationThreadComposer.addToMessage",
            defaultMessage: "Add to message",
          })}
        </button>
      ) : null}
      {recovery.phase === "failed" ? (
        <button
          type="button"
          className="rounded px-2 py-1 text-token-foreground hover:bg-token-list-hover-background"
          onClick={() => void retryDictation()}
        >
          {intl.formatMessage({
            id: "conversation.localConversationThreadComposer.retry",
            defaultMessage: "Retry",
          })}
        </button>
      ) : null}
      {recovery.saveState === "saved" && onOpenVoiceSettings ? (
        <button
          type="button"
          className="rounded px-2 py-1 hover:bg-token-list-hover-background"
          onClick={() => onOpenVoiceSettings?.(recovery.recordingId ?? undefined)}
        >
          {intl.formatMessage({
            id: "conversation.localConversationThreadComposer.viewRecording",
            defaultMessage: "View recording",
          })}
        </button>
      ) : null}
      <button
        type="button"
        aria-label={intl.formatMessage({
          id: "conversation.localConversationThreadComposer.dismissDictationRecovery",
          defaultMessage: "Dismiss dictation recovery",
        })}
        className="rounded p-1 hover:bg-token-list-hover-background"
        onClick={dismissDictationRecovery}
      >
        <CloseIcon className="size-4" />
      </button>
    </div>
  ) : null;
}

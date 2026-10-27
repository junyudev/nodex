import { useId, useRef } from "react";
import { DictationMicrophoneIcon, StopIcon } from "@/components/shared/icons";
import { toast } from "@/components/ui/toast";
import { dictationErrorMessage } from "@/features/dictation/dictation-errors";
import { useComposerDictation } from "./use-composer-dictation";

/** Question dictation uses the same microphone lease and transcription owner as the Composer. */
export function QuestionDictationButton({
  id,
  value,
  onChange,
  disabled = false,
  isSecret = false,
  onInteraction,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly isSecret?: boolean;
  readonly onInteraction?: () => void;
}) {
  const instance = useId();
  const button = useRef<HTMLButtonElement>(null);
  const before = useRef(value);
  const insert = (text: string) => {
    const separator = before.current && !/\s$/.test(before.current) && text ? " " : "";
    onChange(`${before.current}${separator}${text}`);
  };
  const dictation = useComposerDictation({
    enabled: !disabled && !isSecret,
    globalTarget: {
      id: `question:${id}:${instance}`,
      priority: 30,
      admission: () => {
        const surface = button.current?.closest(
          "[data-request-question-key],[data-async-question-panel]",
        );
        return surface?.contains(document.activeElement) ? null : "unavailable";
      },
    },
    transcript: {
      start: () => {
        before.current = value;
        onInteraction?.();
      },
      update: insert,
      preserve: () => {},
      cancel: () => onChange(before.current),
    },
    onTranscriptInsert: insert,
    onTranscriptAppend: insert,
    onTranscriptSend: insert,
    onStartError: (error) => {
      toast.danger(dictationErrorMessage(error));
    },
    onTranscribeError: (error) => {
      toast.danger(dictationErrorMessage(error));
    },
    onUnsupported: () => {
      toast.danger("Dictation is unavailable");
    },
  });
  return (
    <button
      ref={button}
      type="button"
      aria-label={dictation.isDictating ? "Stop dictation" : "Dictate"}
      aria-pressed={dictation.isDictating}
      disabled={disabled || isSecret || dictation.isStarting || dictation.isTranscribing}
      className="flex size-7 shrink-0 items-center justify-center rounded-full text-token-foreground hover:bg-text/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:opacity-40"
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      onClick={() =>
        dictation.isDictating ? dictation.stopDictation("insert") : void dictation.startDictation()
      }
    >
      {dictation.isDictating ? (
        <StopIcon className="icon-xs" />
      ) : (
        <DictationMicrophoneIcon className="icon-xs" />
      )}
    </button>
  );
}

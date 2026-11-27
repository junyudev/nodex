import { useIntl } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { openMicrophoneSettings } from "@/lib/api";
import type { DictationError } from "../../../shared/dictation";
import { dictationErrorMessage } from "./dictation-errors";

export function useComposerDictationNotifications() {
  const intl = useIntl();
  return {
    onStartError: (error: DictationError) => {
      console.error("[composer-dictation:start]", {
        kind: error.kind,
        operation: error.operation,
        status: error.status,
        nativeName: error.nativeName,
      });
      toast.danger(
        intl.formatMessage({
          id: "conversation.localConversationThreadComposer.startDictationFailed",
          defaultMessage: "Unable to start dictation",
        }),
        {
          id: "composer-dictation-start-error",
          description: dictationErrorMessage(error),
          duration: 0,
          action:
            error.kind === "microphone-permission-denied" || error.kind === "microphone-restricted"
              ? {
                  label: intl.formatMessage({
                    id: "conversation.localConversationThreadComposer.microphoneSettings",
                    defaultMessage: "Open microphone settings",
                  }),
                  onClick: () => void openMicrophoneSettings(),
                }
              : undefined,
        },
      );
    },
    onTranscribeError: (error: DictationError) => {
      console.error("[composer-dictation:transcribe]", {
        kind: error.kind,
        retryable: error.retryable,
      });
    },
    onUnsupported: () => {
      toast.danger(
        intl.formatMessage({
          id: "conversation.localConversationThreadComposer.dictationDeviceUnavailable",
          defaultMessage: "Dictation is not available on this device",
        }),
        {
          id: "composer-dictation-unavailable",
        },
      );
    },
  };
}

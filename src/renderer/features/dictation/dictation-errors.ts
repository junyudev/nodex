import { getIntl } from "@/lib/i18n";
import type { DictationError } from "../../../shared/dictation";

const readNativeName = (error: unknown): string | undefined => {
  if (!error || typeof error !== "object" || !("name" in error)) return undefined;
  const name = (error as { readonly name?: unknown }).name;
  return typeof name === "string" && name.length <= 80 ? name : undefined;
};

export const classifyDictationCaptureError = (error: unknown): DictationError => {
  const nativeName = readNativeName(error);
  switch (nativeName) {
    case "NotAllowedError":
    case "SecurityError":
      return {
        kind: "microphone-permission-denied",
        operation: "capture",
        retryable: false,
        nativeName,
      };
    case "NotFoundError":
    case "DevicesNotFoundError":
      return {
        kind: "microphone-not-found",
        operation: "capture",
        retryable: true,
        nativeName,
      };
    case "NotReadableError":
    case "TrackStartError":
      return {
        kind: "microphone-busy",
        operation: "capture",
        retryable: true,
        nativeName,
      };
    case "OverconstrainedError":
    case "ConstraintNotSatisfiedError":
      return {
        kind: "constraint-unsatisfied",
        operation: "capture",
        retryable: true,
        nativeName,
      };
    case "NotSupportedError":
    case "TypeError":
      return {
        kind: "capture-unsupported",
        operation: "capture",
        retryable: false,
        nativeName,
      };
    case "AbortError":
      return {
        kind: "capture-interrupted",
        operation: "capture",
        retryable: true,
        nativeName,
      };
    default:
      return { kind: "unknown", operation: "capture", retryable: true, nativeName };
  }
};

export const classifyDictationTranscriptionError = (error: unknown): DictationError => {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { readonly status?: unknown }).status
      : undefined;
  const safeStatus = typeof status === "number" && Number.isInteger(status) ? status : undefined;
  if (safeStatus === 401 || safeStatus === 403) {
    return {
      kind: "transcription-auth",
      operation: "transcribe",
      retryable: false,
      status: safeStatus,
    };
  }
  if (safeStatus === 429) {
    return {
      kind: "transcription-rate-limited",
      operation: "transcribe",
      retryable: true,
      status: safeStatus,
    };
  }
  if (safeStatus !== undefined) {
    return {
      kind: "transcription-service",
      operation: "transcribe",
      retryable: safeStatus >= 500,
      status: safeStatus,
    };
  }
  if (readNativeName(error) === "AbortError") {
    return { kind: "unknown", operation: "transcribe", retryable: false, nativeName: "AbortError" };
  }
  if (error instanceof TypeError) {
    return { kind: "transcription-network", operation: "transcribe", retryable: true };
  }
  return { kind: "transcription-service", operation: "transcribe", retryable: true };
};

export const dictationErrorMessage = (error: DictationError): string => {
  switch (error.kind) {
    case "microphone-permission-denied":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.microphonePermissionDenied",
        defaultMessage: "Allow microphone access in System Settings to use dictation.",
      });
    case "microphone-restricted":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.microphoneRestricted",
        defaultMessage: "Microphone access is restricted on this Mac.",
      });
    case "microphone-not-found":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.microphoneNotFound",
        defaultMessage: "No microphone was found. Connect one or choose another in Voice settings.",
      });
    case "microphone-busy":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.microphoneBusy",
        defaultMessage: "The microphone is busy. Close the app using it, then try again.",
      });
    case "constraint-unsatisfied":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.microphoneUnavailable",
        defaultMessage: "The selected microphone is unavailable. Choose another in Voice settings.",
      });
    case "capture-unsupported":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.unsupported",
        defaultMessage: "Dictation is not supported on this device.",
      });
    case "capture-interrupted":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.captureInterrupted",
        defaultMessage: "Microphone capture was interrupted.",
      });
    case "transcription-network":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.serviceUnreachable",
        defaultMessage:
          "Dictation could not reach the transcription service. Your recording is ready to retry.",
      });
    case "transcription-rate-limited":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.rateLimited",
        defaultMessage:
          "Dictation is temporarily rate limited. Try the same recording again later.",
      });
    case "transcription-auth":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.authenticationRequired",
        defaultMessage: "Sign in to ChatGPT again to transcribe this recording.",
      });
    case "transcription-service":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.transcriptionFailed",
        defaultMessage: "The transcription service failed. Your recording is ready to retry.",
      });
    case "history-unavailable":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.historySaveFailed",
        defaultMessage: "This recording could not be saved to Voice history.",
      });
    case "accessibility-denied":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.accessibilityDenied",
        defaultMessage: "Allow Accessibility access to paste global dictation.",
      });
    case "paste-failed":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.pasteFailed",
        defaultMessage: "The transcript is saved, but could not be pasted into the target app.",
      });
    case "unknown":
      return getIntl().formatMessage({
        id: "dictation.dictationErrors.genericFailure",
        defaultMessage: "Dictation failed. Try again.",
      });
  }
};

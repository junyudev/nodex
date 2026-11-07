import { invokeRendererControl } from "./renderer-command";

type AssistantStreamingDebugFields = Record<string, unknown>;

const ASSISTANT_STREAMING_DEBUG_MESSAGE = "Assistant streaming debug";
const stateKeys = new Map<string, string>();

function sendAssistantStreamingDebugLog(
  phase: string,
  fields: AssistantStreamingDebugFields,
): void {
  if (typeof window === "undefined" || typeof window.api?.invoke !== "function") {
    return;
  }

  void invokeRendererControl("diagnostics:renderer-log", {
    message: ASSISTANT_STREAMING_DEBUG_MESSAGE,
    fields: {
      phase,
      ...fields,
    },
  }).catch(() => undefined);
}

export function logAssistantStreamingDebugState(
  phase: string,
  key: string,
  stateKey: string,
  fields: AssistantStreamingDebugFields = {},
): void {
  if (stateKeys.get(key) === stateKey) {
    return;
  }

  stateKeys.set(key, stateKey);
  sendAssistantStreamingDebugLog(phase, fields);
}

import { invokeRendererControl } from "./renderer-command";

type AssistantStreamingDebugFields = Record<string, unknown>;

const ASSISTANT_STREAMING_DEBUG_MESSAGE = "Assistant streaming debug";
const sampledCounts = new Map<string, number>();
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

export function logAssistantStreamingDebug(
  phase: string,
  fields: AssistantStreamingDebugFields = {},
): void {
  sendAssistantStreamingDebugLog(phase, fields);
}

export function logAssistantStreamingDebugSampled(
  phase: string,
  key: string,
  fields: AssistantStreamingDebugFields = {},
): void {
  const count = (sampledCounts.get(key) ?? 0) + 1;
  sampledCounts.set(key, count);

  if (count > 5 && count % 20 !== 0) {
    return;
  }

  sendAssistantStreamingDebugLog(phase, {
    ...fields,
    sampleCount: count,
  });
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

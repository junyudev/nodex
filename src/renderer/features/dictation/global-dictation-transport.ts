import type { IpcApi } from "../../../shared/ipc-api";
import {
  defineRendererCommand,
  invokePlainCommandThrough,
  invokeRendererControlThrough,
  invokeRendererQueryThrough,
  type RendererCommandInvokePort,
} from "../../lib/renderer-command";

const globalDictationInvokePort: RendererCommandInvokePort = {
  invoke: async (channel, ...args) => {
    const bridge = window.globalDictation;
    if (!bridge) throw new Error("Global dictation bridge is unavailable");
    const invoke = bridge.invoke as RendererCommandInvokePort["invoke"];
    return await invoke(channel, ...args);
  },
};

const createHistoryCommand = defineRendererCommand({
  key: "global_dictation.history.create",
  channel: "codex:dictation:history:create",
  authority: "main",
  owner: "GlobalDictation",
  protocol: { kind: "returned_value" },
});

const setHistoryTranscriptCommand = defineRendererCommand({
  key: "global_dictation.history.set_transcript",
  channel: "codex:dictation:history:set-transcript",
  authority: "main",
  owner: "GlobalDictation",
  protocol: { kind: "returned_value" },
});

const transcribeCommand = defineRendererCommand({
  key: "global_dictation.transcribe",
  channel: "codex:dictation:transcribe",
  authority: "external",
  owner: "GlobalDictation",
  protocol: { kind: "pending_operation" },
});

const requestMicrophoneAccessCommand = defineRendererCommand({
  key: "global_dictation.request_microphone_access",
  channel: "codex:dictation:microphone-access:request",
  authority: "external",
  owner: "GlobalDictation",
  protocol: { kind: "pending_operation" },
});

const cleanupCommand = defineRendererCommand({
  key: "global_dictation.cleanup",
  channel: "codex:dictation:cleanup",
  authority: "external",
  owner: "GlobalDictation",
  protocol: { kind: "pending_operation" },
});

type FirstArg<Channel extends keyof IpcApi> = IpcApi[Channel]["args"][0];

export const globalDictationTransport = {
  createHistory: (input: FirstArg<"codex:dictation:history:create">) =>
    invokePlainCommandThrough(createHistoryCommand, globalDictationInvokePort, input),
  appendHistory: (input: FirstArg<"codex:dictation:history:append">) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:history:append",
      input,
    ),
  finalizeHistory: (input: FirstArg<"codex:dictation:history:finalize">) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:history:finalize",
      input,
    ),
  setHistoryDiagnostics: (input: FirstArg<"codex:dictation:history:set-diagnostics">) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:history:set-diagnostics",
      input,
    ),
  setHistoryTranscript: (input: FirstArg<"codex:dictation:history:set-transcript">) =>
    invokePlainCommandThrough(setHistoryTranscriptCommand, globalDictationInvokePort, input),
  transcribe: (input: FirstArg<"codex:dictation:transcribe">) =>
    invokePlainCommandThrough(transcribeCommand, globalDictationInvokePort, input),
  cancelTranscription: (requestId: string) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:transcribe:cancel",
      requestId,
    ),
  acquireMicrophoneLease: (input: FirstArg<"codex:dictation:microphone-lease:acquire">) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:microphone-lease:acquire",
      input,
    ),
  releaseMicrophoneLease: (sessionId: string) =>
    invokeRendererControlThrough(
      globalDictationInvokePort,
      "codex:dictation:microphone-lease:release",
      sessionId,
    ),
  requestMicrophoneAccess: () =>
    invokePlainCommandThrough(requestMicrophoneAccessCommand, globalDictationInvokePort),
  readSettings: () =>
    invokeRendererQueryThrough(globalDictationInvokePort, "codex:dictation:settings:read"),
  readMicrophoneRouteHint: () =>
    invokeRendererQueryThrough(
      globalDictationInvokePort,
      "codex:dictation:microphone-route-hint:read",
    ),
  cleanup: (input: FirstArg<"codex:dictation:cleanup">) =>
    invokePlainCommandThrough(cleanupCommand, globalDictationInvokePort, input),
};

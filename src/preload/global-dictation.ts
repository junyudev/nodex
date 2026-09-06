import { contextBridge, ipcRenderer } from "electron";
import type {
  GlobalDictationContextMenuAction,
  GlobalDictationRendererCommand,
  GlobalDictationRendererEvent,
} from "../shared/global-dictation";
import { GLOBAL_DICTATION_COMMAND_CHANNEL } from "../shared/global-dictation";
import type { DictationStreamingPortHandshake } from "../shared/dictation-streaming";

// Sandboxed Electron preloads must stay single-file bundles. Keep this tiny wire
// guard local and type-checked so sharing it cannot create an emitted preload chunk.
const DICTATION_STREAMING_PORT_CHANNEL: typeof import("../shared/dictation-streaming").DICTATION_STREAMING_PORT_CHANNEL =
  "codex:dictation:streaming:port";
const DICTATION_STREAMING_WINDOW_MESSAGE: typeof import("../shared/dictation-streaming").DICTATION_STREAMING_WINDOW_MESSAGE =
  "nodex:dictation:streaming:port";

const isDictationStreamingPortHandshake = (
  input: unknown,
): input is DictationStreamingPortHandshake => {
  if (!input || typeof input !== "object") return false;
  const value = input as Partial<DictationStreamingPortHandshake>;
  return (
    value.type === DICTATION_STREAMING_WINDOW_MESSAGE &&
    typeof value.sessionId === "string" &&
    /^[0-9a-f-]{36}$/iu.test(value.sessionId) &&
    typeof value.sampleRateHz === "number" &&
    Number.isFinite(value.sampleRateHz) &&
    value.sampleRateHz >= 8_000 &&
    value.sampleRateHz <= 192_000
  );
};

const ALLOWED_INVOKE_CHANNELS = new Set([
  "codex:dictation:microphone-access:request",
  "codex:dictation:microphone-lease:acquire",
  "codex:dictation:microphone-lease:release",
  "codex:dictation:microphone-route-hint:read",
  "codex:dictation:settings:read",
  "codex:dictation:history:create",
  "codex:dictation:history:append",
  "codex:dictation:history:finalize",
  "codex:dictation:history:set-diagnostics",
  "codex:dictation:history:set-transcript",
  "codex:dictation:transcribe",
  "codex:dictation:cleanup",
  "codex:dictation:transcribe:cancel",
  "codex:dictation:global-permissions:open-accessibility-settings",
]);

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isDictationStreamingPortHandshake(event.data) || event.ports.length !== 1) return;
  const port = event.ports[0];
  if (!port) return;
  ipcRenderer.postMessage(DICTATION_STREAMING_PORT_CHANNEL, event.data, [port]);
});

contextBridge.exposeInMainWorld("globalDictation", {
  invoke: (channel: string, ...args: unknown[]) => {
    if (!ALLOWED_INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(
        new Error("The global dictation bridge does not expose this operation"),
      );
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  onCommand: (callback: (command: GlobalDictationRendererCommand) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, command: GlobalDictationRendererCommand) =>
      callback(command);
    ipcRenderer.on(GLOBAL_DICTATION_COMMAND_CHANNEL, listener);
    return () => ipcRenderer.removeListener(GLOBAL_DICTATION_COMMAND_CHANNEL, listener);
  },
  sendEvent: (event: GlobalDictationRendererEvent) =>
    ipcRenderer.invoke("global-dictation:event", event) as Promise<boolean>,
  showContextMenu: () =>
    ipcRenderer.invoke(
      "global-dictation:context-menu",
    ) as Promise<GlobalDictationContextMenuAction>,
});

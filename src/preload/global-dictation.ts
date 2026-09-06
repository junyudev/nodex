import { contextBridge, ipcRenderer } from "electron";
import type {
  GlobalDictationContextMenuAction,
  GlobalDictationRendererCommand,
  GlobalDictationRendererEvent,
} from "../shared/global-dictation";
import { GLOBAL_DICTATION_COMMAND_CHANNEL } from "../shared/global-dictation";
const ALLOWED_INVOKE_CHANNELS = new Set([
  "codex:dictation:streaming-connect-info:read",
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

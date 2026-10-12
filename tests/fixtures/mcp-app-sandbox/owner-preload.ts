import { contextBridge, ipcRenderer } from "electron";
import { installStatePreservingWebviewMoves } from "../../../src/preload/state-preserving-webview-moves";

contextBridge.executeInMainWorld({ func: installStatePreservingWebviewMoves });

const HOST_MESSAGE_CHANNEL = "nodex:mcp-app-sandbox-host-message";

ipcRenderer.on(HOST_MESSAGE_CHANNEL, (event, message) => {
  window.postMessage(message, "*", event.ports);
});

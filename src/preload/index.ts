import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { AppInitializationStep } from "../shared/app-startup";
import {
  CORE_AUTHORITY_STATUS_CHANNEL,
  GET_CORE_AUTHORITY_STATUS_CHANNEL,
  RELAUNCH_FOR_CORE_AUTHORITY_CHANNEL,
  RETRY_CORE_AUTHORITY_CHANNEL,
  type CoreAuthorityStatus,
} from "../shared/core-authority-status";
import {
  CLOSE_PANEL_TAB_HOST_CHANNEL,
  CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL,
  CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL,
  NAVIGATE_BACK_HOST_CHANNEL,
  NAVIGATE_FORWARD_HOST_CHANNEL,
  OPEN_CONTENT_SEARCH_HOST_CHANNEL,
  REQUEST_NEW_WINDOW_HOST_CHANNEL,
  RENAME_THREAD_HOST_CHANNEL,
  TOGGLE_SIDEBAR_HOST_CHANNEL,
} from "../shared/window-navigation";
import {
  EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL,
  type WorkbenchCommandInvocation,
} from "../shared/workbench-commands";
import {
  CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL,
  type StructuralClipboardWriteInput,
  type StructuralClipboardWriteResult,
} from "../shared/clipboard-paste";
import type { ClipboardPasteInspectionResult, ClipboardPastePayload } from "../shared/types";
import type { CodexDesktopMessageFromView } from "../shared/remote-hosted-pip";
import {
  FILE_PATH_INSPECT_SYNC_CHANNEL,
  MANAGED_ASSET_RESOLVE_PATH_SYNC_CHANNEL,
  MANAGED_BLOB_RESOLVE_PATH_SYNC_CHANNEL,
} from "../shared/preload-file-access";
import {
  GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL,
  GIT_WORKER_MESSAGE_FROM_VIEW_CHANNEL,
  type GitWorkerMessageForView,
  type GitWorkerMessageFromView,
} from "../shared/git-worker-protocol";
import type { McpAppSandboxHostMessageChannel } from "../shared/mcp-app/mcp-app-sandbox-contract";
import type { DictationStreamingPortHandshake } from "../shared/dictation-streaming";
import type { ContentAccessContext } from "../shared/content-access-context";
import type { PrepareDroppedPageFilesResult } from "../shared/page-files";

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

// Sandboxed Electron preloads cannot require Rollup's local shared chunks.
// Keep the wire literal type-checked without creating a runtime dependency on
// the guest preload's sandbox contract bundle.
const MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL: McpAppSandboxHostMessageChannel =
  "nodex:mcp-app-sandbox-host-message";
const APP_INITIALIZATION_STEP_CHANNEL: typeof import("../shared/app-startup").APP_INITIALIZATION_STEP_CHANNEL =
  "app:init-step";
const APP_RESTART_CHANNEL: typeof import("../shared/app-startup").APP_RESTART_CHANNEL =
  "app:restart";

ipcRenderer.on(MCP_APP_SANDBOX_HOST_MESSAGE_CHANNEL, (event, message) => {
  const targetOrigin = window.location.origin;
  if (targetOrigin === "null") return;
  window.postMessage(message, targetOrigin, event.ports);
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (!isDictationStreamingPortHandshake(event.data) || event.ports.length !== 1) return;
  const port = event.ports[0];
  if (!port) return;
  ipcRenderer.postMessage(DICTATION_STREAMING_PORT_CHANNEL, event.data, [port]);
});

function resolveManagedAssetPath(source: string): string | null {
  return ipcRenderer.sendSync(MANAGED_ASSET_RESOLVE_PATH_SYNC_CHANNEL, source) as string | null;
}

function resolveManagedBlobPath(contentHash: string): string | null {
  return ipcRenderer.sendSync(MANAGED_BLOB_RESOLVE_PATH_SYNC_CHANNEL, contentHash) as string | null;
}

// Multiple editor resource Blocks may each subscribe to
// board-changed via useBoard, easily exceeding the default limit of 10.
ipcRenderer.setMaxListeners(50);

contextBridge.exposeInMainWorld("api", {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),

  on: (event: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => callback(...args);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
  awaitInitialization: () => ipcRenderer.invoke("app:await-initialization"),
  restartApplication: () => ipcRenderer.invoke(APP_RESTART_CHANNEL),
  getCoreAuthorityStatus: () =>
    ipcRenderer.invoke(GET_CORE_AUTHORITY_STATUS_CHANNEL) as Promise<CoreAuthorityStatus>,
  onCoreAuthorityStatus: (callback: (status: CoreAuthorityStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: CoreAuthorityStatus) =>
      callback(status);
    ipcRenderer.on(CORE_AUTHORITY_STATUS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CORE_AUTHORITY_STATUS_CHANNEL, listener);
    };
  },
  retryCoreAuthority: () => ipcRenderer.invoke(RETRY_CORE_AUTHORITY_CHANNEL),
  relaunchForCoreAuthority: () => ipcRenderer.invoke(RELAUNCH_FOR_CORE_AUTHORITY_CHANNEL),
  onInitializationStep: (callback: (step: AppInitializationStep) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, step: AppInitializationStep) =>
      callback(step);
    ipcRenderer.on(APP_INITIALIZATION_STEP_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(APP_INITIALIZATION_STEP_CHANNEL, listener);
    };
  },
  reportInitializationReady: (input: { durationMs: number; outcome: "failed" | "ready" }) => {
    ipcRenderer.send("app:renderer-initialization-finished", input);
  },
  onNavigateBack: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(NAVIGATE_BACK_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(NAVIGATE_BACK_HOST_CHANNEL, listener);
    };
  },
  onNavigateForward: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(NAVIGATE_FORWARD_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(NAVIGATE_FORWARD_HOST_CHANNEL, listener);
    };
  },
  onToggleSidebar: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(TOGGLE_SIDEBAR_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(TOGGLE_SIDEBAR_HOST_CHANNEL, listener);
    };
  },
  onRenameThread: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(RENAME_THREAD_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(RENAME_THREAD_HOST_CHANNEL, listener);
    };
  },
  onOpenContentSearch: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(OPEN_CONTENT_SEARCH_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(OPEN_CONTENT_SEARCH_HOST_CHANNEL, listener);
    };
  },
  onCyclePanelTabPrevious: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CYCLE_PANEL_TAB_PREVIOUS_HOST_CHANNEL, listener);
    };
  },
  onCyclePanelTabNext: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CYCLE_PANEL_TAB_NEXT_HOST_CHANNEL, listener);
    };
  },
  onClosePanelTab: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(CLOSE_PANEL_TAB_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CLOSE_PANEL_TAB_HOST_CHANNEL, listener);
    };
  },
  onRequestNewWindow: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(REQUEST_NEW_WINDOW_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(REQUEST_NEW_WINDOW_HOST_CHANNEL, listener);
    };
  },
  onWorkbenchCommand: (callback: (invocation: WorkbenchCommandInvocation) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, invocation: WorkbenchCommandInvocation) =>
      callback(invocation);
    ipcRenderer.on(EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(EXECUTE_WORKBENCH_COMMAND_HOST_CHANNEL, listener);
    };
  },
  resolveManagedAssetPath,
  resolveManagedBlobPath,
  inspectPasteClipboard: () =>
    ipcRenderer.sendSync(CLIPBOARD_INSPECT_PASTE_SYNC_CHANNEL) as ClipboardPasteInspectionResult,
  readPasteClipboard: () =>
    ipcRenderer.invoke("clipboard:read-paste") as Promise<ClipboardPastePayload>,
  writeStructuralClipboard: (input: StructuralClipboardWriteInput) =>
    ipcRenderer.invoke(
      "clipboard:write-structural",
      input,
    ) as Promise<StructuralClipboardWriteResult>,
  getPathInfoForFile: (file: File) => {
    try {
      const absolutePath = webUtils.getPathForFile(file);
      if (!absolutePath) return null;

      return ipcRenderer.sendSync(FILE_PATH_INSPECT_SYNC_CHANNEL, absolutePath) as
        | ClipboardPasteInspectionResult["items"][number]
        | null;
    } catch {
      return null;
    }
  },
  getPathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  prepareDroppedPageFiles: (
    accessContext: ContentAccessContext,
    operationId: string,
    files: readonly File[],
  ) => {
    try {
      const localPaths = Array.from(files, (file) => webUtils.getPathForFile(file));
      if (localPaths.length === 0 || localPaths.some((localPath) => !localPath)) {
        return Promise.reject(new Error("Dropped files are unavailable to the desktop host"));
      }
      return ipcRenderer.invoke("page-files:prepare-local-drop", accessContext, {
        operationId,
        localPaths,
      }) as Promise<PrepareDroppedPageFilesResult>;
    } catch {
      return Promise.reject(new Error("Dropped files are unavailable to the desktop host"));
    }
  },
  sendGitWorkerMessage: (message: GitWorkerMessageFromView) =>
    ipcRenderer.invoke(GIT_WORKER_MESSAGE_FROM_VIEW_CHANNEL, message).then(() => undefined),
  onGitWorkerMessage: (callback: (message: GitWorkerMessageForView) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: GitWorkerMessageForView) =>
      callback(message);
    ipcRenderer.on(GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(GIT_WORKER_MESSAGE_FOR_VIEW_CHANNEL, listener);
    };
  },
});

contextBridge.exposeInMainWorld("electronBridge", {
  sendMessageFromView: (message: CodexDesktopMessageFromView) =>
    ipcRenderer.invoke("codex-desktop:message-from-view", message).then(() => undefined),
  showContextMenu: (items: unknown[], options?: unknown) =>
    ipcRenderer.invoke("native-context-menu:show", items, options),
});

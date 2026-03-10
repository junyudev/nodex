import { contextBridge, ipcRenderer, webUtils } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AppInitializationStep,
  DatabaseMigrationProgress,
} from "../shared/app-startup";
import { inspectClipboardPasteItems } from "../main/clipboard-paste-inspector";

const SERVER_URL_ARG_PREFIX = "--nodex-server-url=";
const ASSET_PATH_PREFIX_ARG_PREFIX = "--nodex-asset-path-prefix=";

function getServerUrlFromArgv(argv: string[]): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(SERVER_URL_ARG_PREFIX));
  if (!arg) return undefined;

  const raw = arg.slice(SERVER_URL_ARG_PREFIX.length).trim();
  return raw.length > 0 ? raw : undefined;
}

function getAssetPathPrefixFromArgv(argv: string[]): string | undefined {
  const arg = argv.find((entry) => entry.startsWith(ASSET_PATH_PREFIX_ARG_PREFIX));
  if (!arg) return undefined;

  const raw = arg.slice(ASSET_PATH_PREFIX_ARG_PREFIX.length).trim();
  if (raw.length === 0) return undefined;

  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const serverUrl = getServerUrlFromArgv(process.argv);
const assetPathPrefix = getAssetPathPrefixFromArgv(process.argv);

// Multiple editor blocks (toggle-list-inline-view, cardRef) each subscribe to
// board-changed via useKanban, easily exceeding the default limit of 10.
ipcRenderer.setMaxListeners(50);

contextBridge.exposeInMainWorld("api", {
  invoke: (channel: string, ...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args),

  on: (event: string, callback: (...args: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
  awaitInitialization: () => ipcRenderer.invoke("app:await-initialization"),
  onInitializationStep: (callback: (step: AppInitializationStep) => void) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      step: AppInitializationStep,
    ) => callback(step);
    ipcRenderer.on("app:init-step", listener);
    return () => {
      ipcRenderer.removeListener("app:init-step", listener);
    };
  },
  onDatabaseMigrationProgress: (
    callback: (progress: DatabaseMigrationProgress) => void,
  ) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      progress: DatabaseMigrationProgress,
    ) => callback(progress);
    ipcRenderer.on("db:migration-progress", listener);
    return () => {
      ipcRenderer.removeListener("db:migration-progress", listener);
    };
  },
  serverUrl,
  assetPathPrefix,
  inspectPasteClipboard: () => inspectClipboardPasteItems(),
  getPathInfoForFile: (file: File) => {
    try {
      const absolutePath = webUtils.getPathForFile(file);
      if (!absolutePath) return null;

      const stats = fs.statSync(absolutePath);
      const kind = stats.isDirectory() ? "folder" : "file";
      return {
        path: absolutePath,
        kind,
        name: path.basename(absolutePath),
        ...(kind === "file" ? { bytes: stats.size } : {}),
      };
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
});

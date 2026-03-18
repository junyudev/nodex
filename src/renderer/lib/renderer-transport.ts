import { browserRendererTransport } from "./browser-renderer-transport";
import { createElectronRendererTransport, type ElectronRendererBridge } from "./electron-renderer-transport";

export interface RendererTransport {
  kind: "browser" | "electron";
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  subscribeBoardChanges: (projectId: string, callback: () => void) => () => void;
  subscribeCodexEvents: (callback: (event: import("./types").CodexEvent) => void) => () => void;
  subscribeGitBranchChanges: (callback: (event: { cwd: string }) => void) => () => void;
  subscribeAppUpdateStatus: (callback: (status: import("./types").AppUpdateStatus) => void) => () => void;
}

const BROWSER_ONLY_INVOKE_CHANNELS = new Set<string>([
  "asset:resolve-path",
]);

function readElectronBridge(): ElectronRendererBridge | null {
  if (typeof window === "undefined") return null;
  return window.api ?? null;
}

export function resolveRendererTransport(): RendererTransport {
  const bridge = readElectronBridge();
  if (!bridge) return browserRendererTransport;
  return createElectronRendererTransport(bridge);
}

export function resolveInvokeTransport(channel: string): RendererTransport {
  if (BROWSER_ONLY_INVOKE_CHANNELS.has(channel)) {
    return browserRendererTransport;
  }

  return resolveRendererTransport();
}

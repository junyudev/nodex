import { createRequire } from "node:module";
import type { Socket } from "node:net";
import path from "node:path";
import { readSocketFileDescriptor } from "../../browser-use/browser-use-peer-authorizer";
import type { ChromeBrowserPeerIdentity } from "../../browser-use/chrome/ChromeExtensionPipeRegistry";

export function loadMacBrowserPeer(options: {
  readonly isPackaged: boolean;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
}):
  | {
      readonly readBrowserPeer: (socket: Socket) => ChromeBrowserPeerIdentity | null;
      readonly isBrowserRunning: (bundleId: string) => boolean | null;
    }
  | undefined {
  if (process.platform !== "darwin") return undefined;
  const addonPath = options.isPackaged
    ? path.join(options.resourcesPath, "native", "nodex-browser-peer.node")
    : path.join(
        options.projectRootPath,
        ".generated",
        "browser-peer-runtime",
        process.arch,
        "nodex-browser-peer.node",
      );
  try {
    const addon = createRequire(import.meta.url)(addonPath) as {
      readBrowserIdentity(fd: number): ChromeBrowserPeerIdentity | null;
      isBrowserRunning(bundleId: string): boolean | null;
    };
    return {
      readBrowserPeer: (socket) => {
        const fd = readSocketFileDescriptor(socket);
        return fd === null ? null : addon.readBrowserIdentity(fd);
      },
      isBrowserRunning: (bundleId) => addon.isBrowserRunning(bundleId),
    };
  } catch {
    return undefined;
  }
}

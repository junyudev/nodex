import * as Effect from "effect/Effect";
import { win32 } from "node:path";
import type {
  WindowsDesktopToolsService,
  WindowsProcessIdentity,
} from "../platform/node/WindowsDesktopTools";
import { createRequire } from "node:module";
import type { Socket } from "node:net";
import type { BrowserUsePeerAuthorizationMode } from "../../shared/browser-use-host-capability";

export interface BrowserUsePeerAuthorizationResult {
  authorized: boolean;
  reason?: string;
  signingIdentifier?: string;
  teamId?: string;
}

export type BrowserUseSocketPeerAuthorizer = (socket: Socket) => BrowserUsePeerAuthorizationResult;

interface BrowserUsePeerAuthorizationAddon {
  authorizeSocketPeer(
    socketFileDescriptor: number,
    developmentMode: boolean,
  ): BrowserUsePeerAuthorizationResult;
}

export interface CreateBrowserUsePeerAuthorizerOptions {
  addonPath: string | null;
  mode: BrowserUsePeerAuthorizationMode;
  platform?: NodeJS.Platform;
}

type SocketWithFileDescriptor = Socket & {
  _handle?: {
    fd?: unknown;
  };
};

function readSocketFileDescriptor(socket: Socket): number | null {
  const descriptor = (socket as SocketWithFileDescriptor)._handle?.fd;
  return typeof descriptor === "number" && Number.isInteger(descriptor) && descriptor >= 0
    ? descriptor
    : null;
}

function sanitizeAuthorizationResult(
  result: BrowserUsePeerAuthorizationResult,
): BrowserUsePeerAuthorizationResult {
  return {
    authorized: result.authorized === true,
    ...(typeof result.reason === "string" ? { reason: result.reason.slice(0, 256) } : {}),
    ...(typeof result.signingIdentifier === "string"
      ? { signingIdentifier: result.signingIdentifier.slice(0, 256) }
      : {}),
    ...(typeof result.teamId === "string" ? { teamId: result.teamId.slice(0, 128) } : {}),
  };
}

export function createBrowserUsePeerAuthorizer(
  options: CreateBrowserUsePeerAuthorizerOptions,
): BrowserUseSocketPeerAuthorizer {
  const platform = options.platform ?? process.platform;
  if (options.mode === "disabled" && platform !== "win32") return () => ({ authorized: true });
  if (platform !== "darwin") {
    return () => ({
      authorized: false,
      reason: `peer-authorization-unavailable-${platform}`,
    });
  }
  if (!options.addonPath) {
    return () => ({
      authorized: false,
      reason: "peer-authorization-addon-unavailable",
    });
  }

  let addon: BrowserUsePeerAuthorizationAddon;
  try {
    addon = createRequire(import.meta.url)(options.addonPath) as BrowserUsePeerAuthorizationAddon;
  } catch {
    return () => ({
      authorized: false,
      reason: "peer-authorization-addon-load-failed",
    });
  }
  if (typeof addon.authorizeSocketPeer !== "function") {
    return () => ({
      authorized: false,
      reason: "peer-authorization-addon-invalid",
    });
  }

  return (socket) => {
    const socketFileDescriptor = readSocketFileDescriptor(socket);
    if (socketFileDescriptor === null) {
      return {
        authorized: false,
        reason: "missing-socket-file-descriptor",
      };
    }
    try {
      return sanitizeAuthorizationResult(
        addon.authorizeSocketPeer(socketFileDescriptor, options.mode === "development"),
      );
    } catch {
      return {
        authorized: false,
        reason: "peer-authorization-failed",
      };
    }
  };
}

/** Native peers are identified by the process object held by the named-pipe listener. */
export function makeWindowsBrowserPeerAuthorizer(options: {
  readonly repl: string;
  readonly node: string;
  readonly launcher: string;
  readonly host: WindowsProcessIdentity;
  readonly native: Pick<WindowsDesktopToolsService, "ancestors">;
  readonly mode: BrowserUsePeerAuthorizationMode;
}) {
  return (peer: WindowsProcessIdentity): Effect.Effect<BrowserUsePeerAuthorizationResult> => {
    const isRepl = windowsImageEquals(peer.imagePath, options.repl);
    if (!isRepl && !windowsImageEquals(peer.imagePath, options.node))
      return Effect.succeed({ authorized: false, reason: "unverified-peer-image" });

    return options.native.ancestors(peer).pipe(
      Effect.map((ancestors) => {
        const replIndex = isRepl
          ? -1
          : ancestors.findIndex((ancestor) => windowsImageEquals(ancestor.imagePath, options.repl));
        const hasRepl = isRepl || replIndex >= 0;
        const launcher = hasRepl ? ancestors[replIndex + 1] : undefined;
        const ownedLauncher = launcher && windowsImageEquals(launcher.imagePath, options.launcher);
        const owned =
          ownedLauncher &&
          ancestors.some(
            (ancestor) =>
              ancestor.pid === options.host.pid &&
              ancestor.creationTime === options.host.creationTime &&
              windowsImageEquals(ancestor.imagePath, options.host.imagePath),
          );
        if (owned) return { authorized: true };
        if (options.mode === "development" && isRepl && !ownedLauncher)
          return { authorized: true, reason: "development-detached-verified-peer" };
        return { authorized: false, reason: "peer-outside-desktop-tool-launch" };
      }),
      Effect.catch(() =>
        Effect.succeed({ authorized: false, reason: "peer-process-identity-unavailable" }),
      ),
    );
  };
}

export function windowsImageEquals(left: string, right: string): boolean {
  const key = (value: string) =>
    win32
      .normalize(value)
      .replace(/^\\\\\\?\\/u, "")
      .toLowerCase();
  return key(left) === key(right);
}

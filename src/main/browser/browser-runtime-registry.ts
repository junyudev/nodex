import { randomUUID } from "node:crypto";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarHostRouteIdentity,
  type BrowserSidebarPhysicalHostIdentity,
  type BrowserSidebarTabIdentity,
  type BrowserSidebarWebviewHostKind,
} from "../../shared/browser-sidebar";

export type BrowserPagePersistence = "durable" | "browser-use";

export interface BrowserRendererSessionRegistration {
  browserViewScopeId: string;
  ownerWebContentsId: number;
  rendererInstanceId: string;
}

export interface BrowserHostRegistration extends BrowserSidebarTabIdentity {
  browserStorageId: string;
  hostGeneration: number;
  hostKind: BrowserSidebarWebviewHostKind;
  mountGeneration: number;
  pagePersistence: BrowserPagePersistence;
  rendererInstanceId: string;
}

export interface BrowserAttachmentRoute extends BrowserSidebarHostRouteIdentity {
  browserStorageId: string;
}

export interface BrowserAuthorizedAttachment extends BrowserAttachmentRoute {
  attachToken: string;
  ownerWebContentsId: number;
}

export interface BrowserAttachedGuestOwnership extends BrowserAttachmentRoute {
  guestWebContentsId: number;
  ownerWebContentsId: number;
}

export type BrowserHostRegistrationResult =
  | { ok: true; registration: BrowserHostRegistration }
  | {
      ok: false;
      reason:
        | "generation-stale"
        | "owned-by-another-window"
        | "renderer-session-missing"
        | "renderer-session-mismatch";
    };

export type BrowserAttachmentAuthorizationResult =
  | { ok: true; authorization: BrowserAuthorizedAttachment }
  | {
      ok: false;
      reason: "host-missing" | "host-mismatch" | "pending-teardown" | "renderer-session-missing";
    };

export type BrowserHostRouteMatchResult =
  | { ok: true; registration: BrowserHostRegistration }
  | {
      ok: false;
      reason: "host-missing" | "host-mismatch" | "renderer-session-missing";
    };

interface StoredRendererSession extends BrowserRendererSessionRegistration {
  registeredAt: number;
}

interface StoredHostRegistration extends BrowserHostRegistration {
  ownerWebContentsId: number;
  pendingTeardown: boolean;
  registeredAt: number;
}

interface BrowserRuntimeRegistryOptions {
  now?: () => number;
  tokenFactory?: () => string;
}

function isSameHostRoute(
  left: BrowserAttachmentRoute,
  right: BrowserSidebarHostRouteIdentity,
): boolean {
  return (
    left.browserConversationId === right.browserConversationId &&
    left.browserViewScopeId === right.browserViewScopeId &&
    left.browserTabId === right.browserTabId &&
    left.rendererInstanceId === right.rendererInstanceId &&
    left.hostGeneration === right.hostGeneration &&
    left.mountGeneration === right.mountGeneration
  );
}

function isSamePhysicalHost(
  left: BrowserSidebarPhysicalHostIdentity,
  right: BrowserSidebarPhysicalHostIdentity,
): boolean {
  return (
    left.browserConversationId === right.browserConversationId &&
    left.browserViewScopeId === right.browserViewScopeId &&
    left.browserTabId === right.browserTabId &&
    left.rendererInstanceId === right.rendererInstanceId &&
    left.hostGeneration === right.hostGeneration
  );
}

export interface BrowserRuntimeRegistry {
  readonly registerRendererSession: (
    input: BrowserRendererSessionRegistration,
  ) => BrowserRendererSessionRegistration;
  readonly registerHost: (
    ownerWebContentsId: number,
    input: BrowserHostRegistration,
  ) => BrowserHostRegistrationResult;
  readonly matchHost: (
    ownerWebContentsId: number,
    input: BrowserSidebarHostRouteIdentity,
  ) => BrowserHostRouteMatchResult;
  readonly authorizeAttachment: (
    ownerWebContentsId: number,
    input: BrowserSidebarPhysicalHostIdentity,
  ) => BrowserAttachmentAuthorizationResult;
  readonly consumeAuthorizedAttachment: (
    attachToken: string,
    ownerWebContentsId: number,
    guestWebContentsId: number,
  ) => BrowserAttachedGuestOwnership | null;
  readonly revokeAuthorizedAttachment: (attachToken: string) => void;
  readonly getGuestOwnership: (guestWebContentsId: number) => BrowserAttachedGuestOwnership | null;
  readonly markPendingTeardown: (identity: BrowserSidebarTabIdentity, pending: boolean) => void;
  readonly releaseGuest: (guestWebContentsId: number) => void;
  readonly releaseHost: (identity: BrowserSidebarTabIdentity) => void;
  readonly releaseOwner: (ownerWebContentsId: number) => void;
  readonly getDiagnosticSnapshot: () => {
    readonly guests: number;
    readonly hosts: number;
    readonly pendingAttachments: number;
    readonly rendererSessions: number;
  };
}

/**
 * Owns the synchronous Browser host/guest identity state machine.
 *
 * The registry contains no physical resources. Its enclosing Browser Scope owns
 * reachability, while Electron listener resources live in the scoped listener runtime.
 */
export function makeBrowserRuntimeRegistry(
  options: BrowserRuntimeRegistryOptions = {},
): BrowserRuntimeRegistry {
  const rendererSessions = new Map<string, StoredRendererSession>();
  const rendererInstanceIdByOwner = new Map<number, string>();
  const hosts = new Map<string, StoredHostRegistration>();
  const hostKeyByStorageId = new Map<string, string>();
  const pendingAttachments = new Map<string, BrowserAuthorizedAttachment>();
  const guestOwnership = new Map<number, BrowserAttachedGuestOwnership>();
  const now = options.now ?? Date.now;
  const tokenFactory = options.tokenFactory ?? randomUUID;

  const releaseHost = (identity: BrowserSidebarTabIdentity): void => {
    const key = makeBrowserSidebarTabKey(identity);
    const host = hosts.get(key);
    if (!host) return;
    hosts.delete(key);
    if (hostKeyByStorageId.get(host.browserStorageId) === key) {
      hostKeyByStorageId.delete(host.browserStorageId);
    }
    for (const [token, pending] of pendingAttachments) {
      if (makeBrowserSidebarTabKey(pending) === key) {
        pendingAttachments.delete(token);
      }
    }
  };

  const releaseRendererSession = (rendererInstanceId: string): void => {
    const renderer = rendererSessions.get(rendererInstanceId);
    if (!renderer) return;
    rendererSessions.delete(rendererInstanceId);
    if (rendererInstanceIdByOwner.get(renderer.ownerWebContentsId) === rendererInstanceId) {
      rendererInstanceIdByOwner.delete(renderer.ownerWebContentsId);
    }
    for (const host of [...hosts.values()]) {
      if (host.rendererInstanceId === rendererInstanceId) {
        releaseHost(host);
      }
    }
    for (const [token, pending] of pendingAttachments) {
      if (pending.rendererInstanceId === rendererInstanceId) {
        pendingAttachments.delete(token);
      }
    }
  };

  return {
    registerRendererSession(input) {
      const existingById = rendererSessions.get(input.rendererInstanceId);
      if (
        existingById &&
        (existingById.ownerWebContentsId !== input.ownerWebContentsId ||
          existingById.browserViewScopeId !== input.browserViewScopeId)
      ) {
        throw new Error("Renderer instance is already bound to another window");
      }

      const previousRendererId = rendererInstanceIdByOwner.get(input.ownerWebContentsId);
      if (previousRendererId && previousRendererId !== input.rendererInstanceId) {
        releaseRendererSession(previousRendererId);
      }
      rendererSessions.set(input.rendererInstanceId, {
        ...input,
        registeredAt: now(),
      });
      rendererInstanceIdByOwner.set(input.ownerWebContentsId, input.rendererInstanceId);
      return input;
    },

    registerHost(ownerWebContentsId, input) {
      const rendererSession = rendererSessions.get(input.rendererInstanceId);
      if (!rendererSession) {
        return { ok: false, reason: "renderer-session-missing" };
      }
      if (
        rendererSession.ownerWebContentsId !== ownerWebContentsId ||
        rendererSession.browserViewScopeId !== input.browserViewScopeId
      ) {
        return { ok: false, reason: "renderer-session-mismatch" };
      }

      const key = makeBrowserSidebarTabKey(input);
      const storageOwnerKey = hostKeyByStorageId.get(input.browserStorageId);
      if (storageOwnerKey && storageOwnerKey !== key) {
        return { ok: false, reason: "owned-by-another-window" };
      }
      const current = hosts.get(key);
      if (current && input.hostGeneration < current.hostGeneration) {
        return { ok: false, reason: "generation-stale" };
      }
      if (
        current &&
        input.hostGeneration === current.hostGeneration &&
        (input.rendererInstanceId !== current.rendererInstanceId ||
          input.mountGeneration < current.mountGeneration ||
          input.browserStorageId !== current.browserStorageId)
      ) {
        return { ok: false, reason: "generation-stale" };
      }

      const registration: StoredHostRegistration = {
        ...input,
        ownerWebContentsId,
        pendingTeardown: false,
        registeredAt: now(),
      };
      hosts.set(key, registration);
      hostKeyByStorageId.set(input.browserStorageId, key);
      return { ok: true, registration: input };
    },

    matchHost(ownerWebContentsId, input) {
      const rendererSession = rendererSessions.get(input.rendererInstanceId);
      if (!rendererSession || rendererSession.ownerWebContentsId !== ownerWebContentsId) {
        return { ok: false, reason: "renderer-session-missing" };
      }
      const host = hosts.get(makeBrowserSidebarTabKey(input));
      if (!host) return { ok: false, reason: "host-missing" };
      if (host.ownerWebContentsId !== ownerWebContentsId || !isSameHostRoute(host, input)) {
        return { ok: false, reason: "host-mismatch" };
      }
      return { ok: true, registration: host };
    },

    authorizeAttachment(ownerWebContentsId, input) {
      const rendererSession = rendererSessions.get(input.rendererInstanceId);
      if (!rendererSession || rendererSession.ownerWebContentsId !== ownerWebContentsId) {
        return { ok: false, reason: "renderer-session-missing" };
      }
      const host = hosts.get(makeBrowserSidebarTabKey(input));
      if (!host) return { ok: false, reason: "host-missing" };
      if (host.pendingTeardown) {
        return { ok: false, reason: "pending-teardown" };
      }
      if (host.ownerWebContentsId !== ownerWebContentsId || !isSamePhysicalHost(host, input)) {
        return { ok: false, reason: "host-mismatch" };
      }

      const attachToken = tokenFactory();
      const authorization: BrowserAuthorizedAttachment = {
        ...host,
        attachToken,
        ownerWebContentsId,
      };
      pendingAttachments.set(attachToken, authorization);
      return { ok: true, authorization };
    },

    consumeAuthorizedAttachment(attachToken, ownerWebContentsId, guestWebContentsId) {
      const authorization = pendingAttachments.get(attachToken);
      pendingAttachments.delete(attachToken);
      if (!authorization || authorization.ownerWebContentsId !== ownerWebContentsId) {
        return null;
      }
      const ownership: BrowserAttachedGuestOwnership = {
        ...authorization,
        guestWebContentsId,
      };
      guestOwnership.set(guestWebContentsId, ownership);
      return ownership;
    },

    revokeAuthorizedAttachment(attachToken) {
      pendingAttachments.delete(attachToken);
    },

    getGuestOwnership(guestWebContentsId) {
      return guestOwnership.get(guestWebContentsId) ?? null;
    },

    markPendingTeardown(identity, pending) {
      const key = makeBrowserSidebarTabKey(identity);
      const host = hosts.get(key);
      if (!host) return;
      hosts.set(key, { ...host, pendingTeardown: pending });
    },

    releaseGuest(guestWebContentsId) {
      guestOwnership.delete(guestWebContentsId);
    },

    releaseHost,

    releaseOwner(ownerWebContentsId) {
      const rendererInstanceId = rendererInstanceIdByOwner.get(ownerWebContentsId);
      if (rendererInstanceId) releaseRendererSession(rendererInstanceId);
      for (const [guestId, ownership] of guestOwnership) {
        if (ownership.ownerWebContentsId === ownerWebContentsId) {
          guestOwnership.delete(guestId);
        }
      }
    },

    getDiagnosticSnapshot() {
      return {
        guests: guestOwnership.size,
        hosts: hosts.size,
        pendingAttachments: pendingAttachments.size,
        rendererSessions: rendererSessions.size,
      };
    },
  };
}

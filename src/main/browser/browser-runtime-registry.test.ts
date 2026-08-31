import { describe, expect, test } from "vite-plus/test";
import { makeBrowserRuntimeRegistry } from "./browser-runtime-registry";

const identity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-tab-1",
} as const;

function host(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    browserStorageId: "browser-storage-1",
    hostGeneration: 1,
    hostKind: "panel" as const,
    mountGeneration: 1,
    pagePersistence: "durable" as const,
    rendererInstanceId: "renderer-1",
    ...overrides,
  };
}

describe("BrowserRuntimeRegistry", () => {
  test("binds renderer and host generations to one owner window", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    expect(registry.registerHost(7, host()).ok).toBe(true);
    expect(
      registry.registerHost(
        8,
        host({
          hostGeneration: 2,
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "renderer-session-mismatch",
    });
    expect(
      registry.registerHost(
        7,
        host({
          hostGeneration: 0,
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "generation-stale",
    });
  });

  test("prevents one durable storage identity from being owned by two routes", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    expect(registry.registerHost(7, host()).ok).toBe(true);
    expect(
      registry.registerHost(
        7,
        host({
          browserTabId: "browser-tab-2",
          hostGeneration: 2,
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "owned-by-another-window",
    });
  });

  test("uses a single-use attach token instead of attachment order", () => {
    let tokenSequence = 0;
    const registry = makeBrowserRuntimeRegistry({
      tokenFactory: () => `attach-${++tokenSequence}`,
    });
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    registry.registerHost(7, host());
    const authorization = registry.authorizeAttachment(7, host());
    expect(authorization.ok).toBe(true);
    if (!authorization.ok) throw new Error("Expected authorization");

    expect(
      registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 101),
    ).toMatchObject({
      ...identity,
      browserStorageId: "browser-storage-1",
      guestWebContentsId: 101,
      ownerWebContentsId: 7,
    });
    expect(
      registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 102),
    ).toBeNull();
  });

  test("rejects presentation updates from a superseded host generation", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    registry.registerHost(
      7,
      host({
        hostGeneration: 2,
        mountGeneration: 3,
      }),
    );

    expect(
      registry.matchHost(
        7,
        host({
          hostGeneration: 1,
          mountGeneration: 2,
        }),
      ),
    ).toEqual({
      ok: false,
      reason: "host-mismatch",
    });
    expect(
      registry.matchHost(
        7,
        host({
          hostGeneration: 2,
          mountGeneration: 3,
        }),
      ),
    ).toMatchObject({
      ok: true,
      registration: {
        hostGeneration: 2,
        mountGeneration: 3,
      },
    });
  });

  test("authorizes a physical guest independently from the current presentation generation", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    registry.registerHost(7, host({ mountGeneration: 3 }));

    expect(
      registry.authorizeAttachment(7, {
        ...identity,
        rendererInstanceId: "renderer-1",
        hostGeneration: 1,
      }),
    ).toMatchObject({
      ok: true,
      authorization: {
        mountGeneration: 3,
      },
    });
  });

  test("revoked attachment authorization cannot be consumed", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    registry.registerHost(7, host());
    const authorization = registry.authorizeAttachment(7, host());
    expect(authorization.ok).toBe(true);
    if (!authorization.ok) throw new Error("Expected authorization");

    registry.revokeAuthorizedAttachment(authorization.authorization.attachToken);

    expect(
      registry.consumeAuthorizedAttachment(authorization.authorization.attachToken, 7, 101),
    ).toBeNull();
  });

  test("blocks new attachments while generation-safe teardown is pending", () => {
    const registry = makeBrowserRuntimeRegistry();
    registry.registerRendererSession({
      browserViewScopeId: identity.browserViewScopeId,
      ownerWebContentsId: 7,
      rendererInstanceId: "renderer-1",
    });
    registry.registerHost(7, host());
    registry.markPendingTeardown(identity, true);

    expect(registry.authorizeAttachment(7, host())).toEqual({
      ok: false,
      reason: "pending-teardown",
    });
    registry.releaseOwner(7);
    expect(registry.getDiagnosticSnapshot()).toEqual({
      guests: 0,
      hosts: 0,
      pendingAttachments: 0,
      rendererSessions: 0,
    });
  });
});

import { describe, expect, test, vi } from "vite-plus/test";
import {
  makeBrowserSidebarRoutePartition,
  type BrowserSidebarHostRouteIdentity,
} from "../../shared/browser-sidebar";
import type { BrowserAuthorizedAttachment } from "./browser-runtime-registry";
import {
  consumePendingBrowserWebviewAttachment,
  decideBrowserWebviewAttachment,
  registerPendingBrowserWebviewAttachment,
} from "./browser-webview-attachment-policy";

const route: BrowserSidebarHostRouteIdentity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-tab-1",
  rendererInstanceId: "renderer-1",
  hostGeneration: 2,
  mountGeneration: 3,
};
const physicalRoute = {
  browserConversationId: route.browserConversationId,
  browserViewScopeId: route.browserViewScopeId,
  browserTabId: route.browserTabId,
  rendererInstanceId: route.rendererInstanceId,
  hostGeneration: route.hostGeneration,
};

const authorization: BrowserAuthorizedAttachment = {
  ...route,
  attachToken: "attach-1",
  browserStorageId: "browser-storage-1",
  ownerWebContentsId: 7,
};

function decide(overrides: Partial<Parameters<typeof decideBrowserWebviewAttachment>[0]> = {}) {
  return decideBrowserWebviewAttachment({
    authorizeAttachment: () => ({ ok: true, authorization }),
    isRegisteredBrowserStorage: () => true,
    ownerBrowserViewScopeId: route.browserViewScopeId,
    partition: makeBrowserSidebarRoutePartition(route, route),
    revokeAuthorizedAttachment: () => undefined,
    src: "https://www.google.com/",
    ...overrides,
  });
}

describe("Browser webview attachment policy", () => {
  test("authorizes from the registered host without custom webview parameters", () => {
    const authorizeAttachment = vi.fn(() => ({
      ok: true as const,
      authorization,
    }));

    expect(decide({ authorizeAttachment })).toEqual({
      ok: true,
      authorization,
    });
    expect(authorizeAttachment).toHaveBeenCalledWith(physicalRoute);
  });

  test("fails closed before host authorization for a foreign window or URL", () => {
    const authorizeAttachment = vi.fn(() => ({
      ok: true as const,
      authorization,
    }));

    expect(
      decide({
        authorizeAttachment,
        ownerBrowserViewScopeId: "window-session-2",
      }),
    ).toMatchObject({
      ok: false,
      reason: "window-session-mismatch",
    });
    expect(
      decide({
        authorizeAttachment,
        src: "javascript:alert(1)",
      }),
    ).toMatchObject({
      ok: false,
      reason: "navigation-url-blocked",
    });
    expect(authorizeAttachment).not.toHaveBeenCalled();
  });

  test("uses the Main-owned storage identity returned by host authorization", () => {
    const isRegisteredBrowserStorage = vi.fn(() => false);
    const revokeAuthorizedAttachment = vi.fn();

    expect(
      decide({
        isRegisteredBrowserStorage,
        revokeAuthorizedAttachment,
      }),
    ).toMatchObject({
      ok: false,
      reason: "storage-identity-mismatch",
    });
    expect(isRegisteredBrowserStorage).toHaveBeenCalledWith(
      physicalRoute,
      authorization.browserStorageId,
    );
    expect(revokeAuthorizedAttachment).toHaveBeenCalledWith(authorization.attachToken);
  });

  test("preserves the exact registry rejection reason", () => {
    expect(
      decide({
        authorizeAttachment: () => ({
          ok: false,
          reason: "host-mismatch",
        }),
      }),
    ).toMatchObject({
      ok: false,
      reason: "authorization-host-mismatch",
    });
  });

  test("correlates will-attach instanceId with did-attach viewInstanceId", () => {
    const pending = new Map<number, BrowserAuthorizedAttachment>();
    const secondAuthorization = {
      ...authorization,
      attachToken: "attach-2",
    };

    expect(registerPendingBrowserWebviewAttachment(pending, "41", authorization)).toEqual({
      ok: true,
      instanceId: 41,
    });
    expect(registerPendingBrowserWebviewAttachment(pending, 42, secondAuthorization)).toEqual({
      ok: true,
      instanceId: 42,
    });
    expect(consumePendingBrowserWebviewAttachment(pending, 42)).toBe(secondAuthorization);
    expect(consumePendingBrowserWebviewAttachment(pending, 41)).toBe(authorization);
    expect(consumePendingBrowserWebviewAttachment(pending, 41)).toBeNull();
  });

  test("rejects invalid or duplicate Electron instance ids without overwriting", () => {
    const pending = new Map<number, BrowserAuthorizedAttachment>();

    expect(registerPendingBrowserWebviewAttachment(pending, 0, authorization)).toEqual({
      ok: false,
      reason: "invalid-instance-id",
    });
    expect(registerPendingBrowserWebviewAttachment(pending, 7, authorization)).toEqual({
      ok: true,
      instanceId: 7,
    });
    expect(
      registerPendingBrowserWebviewAttachment(pending, 7, {
        ...authorization,
        attachToken: "replacement",
      }),
    ).toEqual({ ok: false, reason: "duplicate-instance-id" });
    expect(consumePendingBrowserWebviewAttachment(pending, 7)).toBe(authorization);
  });
});

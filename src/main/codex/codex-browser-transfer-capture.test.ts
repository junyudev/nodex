import { describe, expect, test } from "vite-plus/test";
import type {
  BrowserSidebarBrowserUseStateSnapshot,
  BrowserSidebarStateSnapshot,
  BrowserSidebarTabSnapshot,
  BrowserUseTabState,
} from "../../shared/browser-sidebar";
import type { ProjectSession } from "../../shared/types";
import { captureCodexOrdinaryBrowserTransfer } from "./codex-browser-transfer-capture";

const SCOPE_ID = "window-session-source";

function makeSession(hasThread = false): ProjectSession {
  return {
    id: "session-source",
    projectId: "project-source",
    noThreadFallbackTitle: "Source",
    displayTitle: "Source",
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: hasThread
      ? {
          sessionId: "session-source",
          projectId: "project-source",
          threadId: "thread-source",
          threadPreview: "",
          backendBinding: { kind: "codex" },
          executionHostId: "local",
          statusType: "idle",
          statusActiveFlags: [],
          archived: false,
          createdAt: 0,
          updatedAt: 0,
          linkedAt: "2026-07-11T00:00:00.000Z",
        }
      : null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}

function makeBrowserSnapshot(browserTabId: string): BrowserSidebarTabSnapshot {
  return {
    browserConversationId: "session-source",
    browserViewScopeId: SCOPE_ID,
    browserTabId,
    projectId: "project-source",
    webContentsId: null,
    mountGeneration: 0,
    url: `https://${browserTabId}.example`,
    title: browserTabId,
    isLoading: false,
    isWaitingForResponse: false,
    canGoBack: false,
    canGoForward: false,
    zoomPercent: 100,
    deviceToolbarVisible: false,
    viewport: { width: 0, height: 0, zoomPercent: 100, presetId: "responsive" },
    deviceToolbarState: {
      responsiveViewportSize: null,
      toolbarState: {
        isEnabled: false,
        presetId: "responsive",
        width: 390,
        height: 844,
      },
    },
    interactionMode: "browse",
    findState: {
      open: false,
      query: "",
      activeMatchOrdinal: null,
      matchCount: null,
      caseSensitive: false,
    },
    hasBrowserPage: true,
    pageActionsDisabled: false,
    updatedAt: 0,
  };
}

function makeBrowserUseTab(browserTabId: string): BrowserUseTabState {
  return {
    browserConversationId: "session-source",
    browserViewScopeId: SCOPE_ID,
    browserTabId,
    codexSessionId: "thread-source",
    projectId: "project-source",
    title: browserTabId,
    url: `https://${browserTabId}.example`,
    webContentsId: null,
    viewport: { width: 0, height: 0, zoomPercent: 100, presetId: "responsive" },
    captureActive: false,
    released: false,
    updatedAt: 0,
  };
}

function capture(input: {
  browserTabs?: BrowserSidebarTabSnapshot[];
  browserUseTabs?: BrowserUseTabState[];
  activeId?: string;
  enabled?: boolean;
  hasThread?: boolean;
}) {
  const browserState: BrowserSidebarStateSnapshot = {
    tabs: input.browserTabs ?? [],
  };
  const browserUseState: BrowserSidebarBrowserUseStateSnapshot = {
    tabs: input.browserUseTabs ?? [],
    activeBrowserTabIdsByConversationScope: input.activeId
      ? { [`session-source\0${SCOPE_ID}`]: input.activeId }
      : {},
    cursors: [],
  };
  return captureCodexOrdinaryBrowserTransfer({
    browserState,
    browserUseState,
    browserViewScopeId: SCOPE_ID,
    enabled: input.enabled ?? true,
    session: makeSession(input.hasThread),
  });
}

describe("captureCodexOrdinaryBrowserTransfer", () => {
  test("fails closed outside a threadless enabled session", () => {
    expect(capture({ enabled: false })).toBe(null);
    expect(capture({ hasThread: true })).toBe(null);
  });

  test("captures only the initiating window scope and preserves runtime order", () => {
    const result = capture({
      browserTabs: [makeBrowserSnapshot("first"), makeBrowserSnapshot("shared")],
      browserUseTabs: [makeBrowserUseTab("shared"), makeBrowserUseTab("last")],
      activeId: "shared",
    });
    expect(result).toEqual({
      browserTransferSourceBrowserTabId: "shared",
      browserTransferSourceBrowserTabIds: ["first", "shared", "last"],
      browserTransferSourceConversationId: "session-source",
      browserTransferSourceViewScopeId: SCOPE_ID,
    });
  });

  test("uses the last eligible runtime tab when no remembered tab exists", () => {
    expect(
      capture({
        browserTabs: [makeBrowserSnapshot("first"), makeBrowserSnapshot("last")],
      })?.browserTransferSourceBrowserTabId,
    ).toBe("last");
  });
});

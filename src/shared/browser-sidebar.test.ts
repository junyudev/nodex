import { describe, expect, test } from "vite-plus/test";
import {
  makeBrowserSidebarRoutePartition,
  matchesBrowserSidebarTabIdentity,
  parseBrowserSidebarHostRoutePartition,
  type BrowserSidebarTabIdentity,
} from "./browser-sidebar";

const identity: BrowserSidebarTabIdentity = {
  browserConversationId: "conversation-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-tab-1",
};

describe("matchesBrowserSidebarTabIdentity", () => {
  test("requires conversation, Window Session scope, and Browser tab to match", () => {
    expect(matchesBrowserSidebarTabIdentity(identity, identity)).toBe(true);
    expect(
      matchesBrowserSidebarTabIdentity(
        {
          ...identity,
          browserConversationId: "conversation-2",
        },
        identity,
      ),
    ).toBe(false);
    expect(
      matchesBrowserSidebarTabIdentity(
        {
          ...identity,
          browserViewScopeId: "window-session-2",
        },
        identity,
      ),
    ).toBe(false);
    expect(
      matchesBrowserSidebarTabIdentity(
        {
          ...identity,
          browserTabId: "browser-tab-2",
        },
        identity,
      ),
    ).toBe(false);
    expect(matchesBrowserSidebarTabIdentity(undefined, identity)).toBe(false);
  });
});

describe("Browser host route partition", () => {
  test("round trips the physical renderer host independently from presentation generations", () => {
    const partition = makeBrowserSidebarRoutePartition(identity, {
      rendererInstanceId: "renderer:one",
      hostGeneration: 3,
    });
    expect(parseBrowserSidebarHostRoutePartition(partition)).toEqual({
      ...identity,
      rendererInstanceId: "renderer:one",
      hostGeneration: 3,
    });
  });

  test("rejects missing or malformed host generations", () => {
    expect(
      parseBrowserSidebarHostRoutePartition(makeBrowserSidebarRoutePartition(identity)),
    ).toBeNull();
    expect(
      parseBrowserSidebarHostRoutePartition(
        `${makeBrowserSidebarRoutePartition(identity)}:host:renderer:0`,
      ),
    ).toBeNull();
  });
});

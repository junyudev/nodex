import { describe, expect, test } from "vite-plus/test";
import {
  BrowserSidebarContextMenuActionEventSchema,
  parseBrowserSidebarCommand,
  parseBrowserSidebarWebviewDestroyed,
  parseBrowserSidebarWebviewHostCreated,
} from "./browser-schemas";

const identity = {
  browserConversationId: "session-1",
  browserViewScopeId: "window-session-1",
  browserTabId: "browser-tab-1",
};

describe("Browser IPC schemas", () => {
  test("accepts a bounded targeted command", () => {
    expect(
      parseBrowserSidebarCommand({
        type: "navigate",
        ...identity,
        url: "https://example.com/",
        source: "manual",
      }),
    ).toEqual({
      type: "navigate",
      ...identity,
      url: "https://example.com/",
      source: "manual",
    });
  });

  test("admits URLs beyond the general transport byte budget while retaining non-URL bounds", () => {
    const url = `data:text/html,${"x".repeat(80_000)}`;
    expect(parseBrowserSidebarCommand({ type: "navigate", ...identity, url })).toMatchObject({
      url,
    });
    expect(
      parseBrowserSidebarWebviewHostCreated({
        ...identity,
        rendererInstanceId: "renderer-1",
        hostGeneration: 1,
        projectId: null,
        hostKind: "panel",
        mountGeneration: 1,
        webContentsId: 42,
        initialUrl: url,
      }),
    ).toMatchObject({ initialUrl: url });
  });

  test("validates generation-bound host presentation and theme sync", () => {
    expect(
      parseBrowserSidebarCommand({
        type: "sync-theme",
        themeVariant: "light",
      }),
    ).toEqual({
      type: "sync-theme",
      themeVariant: "light",
    });
    expect(
      parseBrowserSidebarCommand({
        type: "sync-host",
        ...identity,
        rendererInstanceId: "renderer-1",
        hostGeneration: 2,
        mountGeneration: 3,
        hostKind: "panel",
        presented: true,
        themeVariant: "dark",
        visible: true,
      }),
    ).toMatchObject({
      type: "sync-host",
      themeVariant: "dark",
      visible: true,
    });
    expect(() =>
      parseBrowserSidebarCommand({
        type: "sync-host",
        ...identity,
        rendererInstanceId: "renderer-1",
        hostGeneration: 2,
        mountGeneration: 3,
        hostKind: "panel",
        presented: true,
        themeVariant: "sepia",
        visible: true,
      }),
    ).toThrow();
  });

  test("rejects unknown fields and invalid dimensions", () => {
    expect(() =>
      parseBrowserSidebarCommand({
        type: "set-viewport",
        ...identity,
        viewport: {
          width: Number.POSITIVE_INFINITY,
          height: 844,
          zoomPercent: 100,
          presetId: "responsive",
        },
      }),
    ).toThrow();
    expect(() =>
      parseBrowserSidebarCommand({
        type: "go-back",
        ...identity,
        unexpected: true,
      }),
    ).toThrow();
  });

  test("rejects payloads that exceed the Browser IPC byte budget", () => {
    expect(() =>
      parseBrowserSidebarCommand({
        type: "set-find-query",
        ...identity,
        query: "x".repeat(70_000),
      }),
    ).toThrow("exceeds");
  });

  test("validates host ownership messages", () => {
    expect(
      parseBrowserSidebarWebviewHostCreated({
        ...identity,
        rendererInstanceId: "renderer-1",
        hostGeneration: 1,
        projectId: "project-1",
        hostKind: "panel",
        mountGeneration: 1,
        webContentsId: 42,
        initialUrl: "https://example.com/",
      }).webContentsId,
    ).toBe(42);

    expect(
      parseBrowserSidebarWebviewDestroyed({
        ...identity,
        mountGeneration: 1,
        reason: "closed",
        teardownId: "teardown-1",
        disposition: "destroyed",
        webContentsId: 42,
      }).teardownId,
    ).toBe("teardown-1");
  });

  test("accepts only canonical managed assets for Send to chat images", () => {
    expect(
      BrowserSidebarContextMenuActionEventSchema.safeParse({
        ...identity,
        action: "image-attached",
        attachment: {
          id: "image-1",
          fileName: "image.png",
          source: "nodex://assets/01234567-89ab-cdef-0123-456789abcdef.png",
        },
      }).success,
    ).toBe(true);
    expect(
      BrowserSidebarContextMenuActionEventSchema.safeParse({
        ...identity,
        action: "image-attached",
        attachment: {
          id: "image-1",
          fileName: "image.png",
          source: "nodex://assets/folder/image.png",
        },
      }).success,
    ).toBe(false);
  });
});

test("validates permission responses and origin permission reset commands", () => {
  const response = {
    ...identity,
    type: "respond-permission",
    promptId: "permission-1",
    mountGeneration: 2,
    action: "allow-this-time",
  };
  expect(parseBrowserSidebarCommand(response)).toEqual(response);
  expect(() => parseBrowserSidebarCommand({ ...response, promptId: "" })).toThrow();
  expect(() => parseBrowserSidebarCommand({ ...response, action: "accept" })).toThrow();
  expect(() => parseBrowserSidebarCommand({ ...response, mountGeneration: 0 })).toThrow();
  expect(() =>
    parseBrowserSidebarCommand({ ...response, action: "deny", geolocationAccuracy: "precise" }),
  ).toThrow();
  expect(() =>
    parseBrowserSidebarCommand({ ...response, geolocationAccuracy: "street" }),
  ).toThrow();
  expect(
    parseBrowserSidebarCommand({
      ...identity,
      type: "reset-site-permissions",
      origin: "https://example.com",
      permission: "camera",
    }),
  ).toMatchObject({ permission: "camera" });
  expect(() =>
    parseBrowserSidebarCommand({
      ...identity,
      type: "reset-site-permissions",
      origin: "https://example.com",
      permission: "unknown",
    }),
  ).toThrow();
});

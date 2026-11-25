import { describe, expect, test } from "vite-plus/test";
import {
  BrowserSidebarContextMenuActionEventSchema,
  parseBrowserSidebarCommand,
  parseBrowserSidebarWebviewDestroyed,
  parseBrowserSidebarWebviewHostCreated,
} from "./browser-schemas";
import {
  BROWSER_USE_CAPABILITY_FORMAT_VERSION,
  projectBrowserUseCapabilities,
  type BrowserUseBackendInfo,
  type BrowserUseCompatibleArtifact,
  type BrowserUsePluginPolicy,
} from "./browser-use-capability-projection";

describe("browser schemas", () => {
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

  test("validates page dialog responses", () => {
    const response = {
      ...identity,
      type: "respond-page-dialog",
      dialogId: "dialog-1",
      accept: false,
    };
    expect(parseBrowserSidebarCommand(response)).toEqual(response);
    expect(parseBrowserSidebarCommand({ ...response, suppress: true })).toMatchObject({
      suppress: true,
    });
    expect(() => parseBrowserSidebarCommand({ ...response, dialogId: "" })).toThrow();
    expect(() => parseBrowserSidebarCommand({ ...response, accept: "yes" })).toThrow();
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
});

describe("browser use capability projection", () => {
  const artifact: BrowserUseCompatibleArtifact = {
    status: "compatible",
    contractVersion: BROWSER_USE_CAPABILITY_FORMAT_VERSION,
    apiMembers: [
      {
        id: "Tabs.new",
        unsupportedByDefaultIn: [],
        requiresFullCdpAccess: false,
      },
      {
        id: "BrowserUser.history",
        unsupportedByDefaultIn: ["iab", "cdp"],
        requiresFullCdpAccess: false,
      },
      {
        id: "TabDev.call",
        unsupportedByDefaultIn: [],
        requiresFullCdpAccess: true,
      },
    ],
    browserCapabilities: ["visibility"],
    tabCapabilities: ["webmcp", "viewport"],
  };

  const backend: BrowserUseBackendInfo = {
    id: "iab",
    name: "In-app browser",
    type: "iab",
    apiSupportOverrides: {
      "BrowserUser.history": true,
    },
    capabilities: {
      browser: [{ id: "visibility" }],
      tab: [{ id: "webmcp" }, { id: "viewport" }],
    },
    metadata: {},
    buildFlavor: "production",
    sessionId: "session-1",
  };

  const plugin: BrowserUsePluginPolicy = {
    local: { fullCdpAccess: "allow" },
    enterprise: { fullCdpAccess: "not-configured" },
    environment: {
      fullCdpAccess: "allow",
      availableBackends: ["iab"],
      disabledApiMembers: [],
      disabledBrowserCapabilities: [],
      disabledTabCapabilities: [],
    },
  };

  describe("Browser Use capability projection", () => {
    test("projects artifact defaults, backend overrides, and advertised capabilities", () => {
      const result = projectBrowserUseCapabilities({
        artifact,
        backend,
        plugin,
      });

      expect(result).toMatchObject({
        status: "available",
        backend: {
          id: "iab",
          name: "In-app browser",
          type: "iab",
          metadata: {},
          buildFlavor: "production",
          sessionId: "session-1",
        },
        fullCdpAccess: true,
        apiMembers: ["Tabs.new", "BrowserUser.history", "TabDev.call"],
        browserCapabilities: ["visibility"],
        tabCapabilities: ["webmcp", "viewport"],
        disabledApiMembers: [],
      });
    });

    test("applies backend false overrides and plugin environment disables last", () => {
      const result = projectBrowserUseCapabilities({
        artifact,
        backend: {
          ...backend,
          apiSupportOverrides: {
            "Tabs.new": false,
            "BrowserUser.history": true,
          },
        },
        plugin: {
          ...plugin,
          environment: {
            ...plugin.environment,
            disabledApiMembers: ["BrowserUser.history"],
            disabledBrowserCapabilities: ["visibility"],
            disabledTabCapabilities: ["viewport"],
          },
        },
      });

      expect(result.apiMembers).toEqual(["TabDev.call"]);
      expect(result.disabledApiMembers).toEqual(["Tabs.new", "BrowserUser.history"]);
      expect(result.browserCapabilities).toEqual([]);
      expect(result.tabCapabilities).toEqual(["webmcp"]);
      expect(result.reasons.map(({ code }) => code)).toEqual(
        expect.arrayContaining([
          "backend-api-unsupported",
          "plugin-api-disabled",
          "plugin-capability-disabled",
        ]),
      );
    });

    test("fails closed only for Full CDP members when a policy cannot be verified", () => {
      const result = projectBrowserUseCapabilities({
        artifact,
        backend,
        plugin: {
          ...plugin,
          enterprise: {
            fullCdpAccess: "unverified",
          },
        },
      });

      expect(result.status).toBe("available");
      expect(result.fullCdpAccess).toBe(false);
      expect(result.apiMembers).toEqual(["Tabs.new", "BrowserUser.history"]);
      expect(result.disabledApiMembers).toEqual(["TabDev.call"]);
      expect(result.reasons).toContainEqual(
        expect.objectContaining({
          code: "full-cdp-enterprise-unverified",
        }),
      );
    });

    test("closes the runtime for invalid stages and unavailable backends", () => {
      const invalidBackend = projectBrowserUseCapabilities({
        artifact,
        backend: {
          ...backend,
          apiSupportOverrides: {
            "Tabs.new": "yes",
          },
        },
        plugin,
      });
      const invalidPlugin = projectBrowserUseCapabilities({
        artifact,
        backend,
        plugin: {
          ...plugin,
          local: {
            fullCdpAccess: "unknown",
          },
        },
      });
      const unavailableBackend = projectBrowserUseCapabilities({
        artifact,
        backend,
        plugin: {
          ...plugin,
          environment: {
            ...plugin.environment,
            availableBackends: ["chrome"],
          },
        },
      });

      expect(invalidBackend.status).toBe("unavailable");
      expect(invalidBackend.reasons[0]?.code).toBe("backend-invalid");
      expect(invalidPlugin.status).toBe("unavailable");
      expect(invalidPlugin.reasons[0]?.code).toBe("plugin-invalid");
      expect(unavailableBackend.status).toBe("unavailable");
      expect(unavailableBackend.reasons[0]?.code).toBe("backend-unavailable");
    });

    test("rejects incompatible artifact contracts before backend projection", () => {
      const result = projectBrowserUseCapabilities({
        artifact: {
          ...artifact,
          contractVersion: "999.0.0",
        },
        backend,
        plugin,
      });

      expect(result.status).toBe("unavailable");
      expect(result.backend).toBe(null);
      expect(result.disabledApiMembers).toEqual(["Tabs.new", "BrowserUser.history", "TabDev.call"]);
      expect(result.reasons[0]?.code).toBe("artifact-contract-version-mismatch");
    });

    test("bounds diagnostics when a backend advertises unknown capabilities", () => {
      const result = projectBrowserUseCapabilities({
        artifact,
        backend: {
          ...backend,
          capabilities: {
            ...backend.capabilities,
            tab: Array.from({ length: 100 }, (_, index) => ({
              id: `Unknown.capability${index}`,
            })),
          },
        },
        plugin,
      });

      expect(result.status).toBe("available");
      expect(result.reasons.length).toBeLessThanOrEqual(64);
      expect(result.reasons.at(-1)?.code).toBe("reason-limit-reached");
      expect(result.reasons.every(({ message }) => message.length < 160)).toBe(true);
    });
  });
});

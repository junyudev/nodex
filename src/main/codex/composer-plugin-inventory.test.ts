import { describe, expect, test } from "vite-plus/test";
import type {
  PluginInterface,
  PluginMarketplaceEntry,
  PluginSummary,
} from "@nodex/codex-app-server-protocol/v2";
import {
  buildComposerPluginInventory,
  hydrateComposerPluginInventoryIcons,
  resolveComposerPluginActivation,
} from "../../shared/codex-composer-plugin-inventory";

function createPlugin(
  overrides: Partial<PluginSummary> & Pick<PluginSummary, "id" | "name">,
): PluginSummary {
  const { id, name, interface: interfaceOverrides, ...remainingOverrides } = overrides;
  const pluginInterface: PluginInterface = {
    displayName: null,
    shortDescription: null,
    longDescription: null,
    developerName: null,
    category: null,
    capabilities: [],
    websiteUrl: null,
    privacyPolicyUrl: null,
    termsOfServiceUrl: null,
    defaultPrompt: null,
    brandColor: null,
    composerIcon: null,
    composerIconUrl: null,
    logo: null,
    logoDark: null,
    logoUrl: null,
    logoUrlDark: null,
    screenshots: [],
    screenshotUrls: [],
    ...interfaceOverrides,
  };

  return {
    id,
    name,
    remotePluginId: null,
    version: null,
    localVersion: null,
    shareContext: null,
    source: { type: "remote" },
    installed: true,
    installedAt: null,
    enabled: true,
    installPolicy: "AVAILABLE",
    installPolicySource: null,
    mustShowInstallationInterstitial: null,
    authPolicy: "ON_USE",
    availability: "AVAILABLE",
    disabledReason: null,
    eligiblePlanTypes: null,
    keywords: [],
    ...remainingOverrides,
    interface: pluginInterface,
  };
}

function createMarketplace(name: string, plugins: PluginSummary[]): PluginMarketplaceEntry {
  return {
    name,
    path: null,
    interface: null,
    plugins,
  };
}

describe("composer plugin inventory", () => {
  test("keeps curated order and emits canonical plugin mention metadata", () => {
    const inventory = buildComposerPluginInventory({
      marketplaces: [
        createMarketplace("openai-bundled", [
          createPlugin({
            id: "browser@openai-bundled",
            name: "browser",
            interface: {
              displayName: " Browser ",
              shortDescription: "Control the in-app browser",
              defaultPrompt: [" ", "Browse the current page"],
              composerIconUrl: "https://cdn.example.com/browser.png",
              logoUrlDark: "https://cdn.example.com/browser-dark.png",
              brandColor: "#4b8df8",
            } as PluginInterface,
          }),
          createPlugin({
            id: "disabled@openai-bundled",
            name: "disabled",
            enabled: false,
          }),
        ]),
        createMarketplace("duplicate-market", [
          createPlugin({
            id: "browser@openai-bundled",
            name: "duplicate browser",
          }),
          createPlugin({
            id: "computer-use@openai-bundled",
            name: "Computer",
            interface: {
              composerIconUrl: "file:///private/plugin-icon.png",
              logoUrl: "https://cdn.example.com/computer.png",
            } as PluginInterface,
          }),
        ]),
      ],
    });

    expect(inventory).toEqual([
      {
        id: "browser@openai-bundled",
        name: "Browser",
        displayName: "Browser",
        description: "Control the in-app browser",
        defaultPrompt: "Browse the current page",
        installed: true,
        enabled: true,
        path: "plugin://browser@openai-bundled",
        iconUrl: "https://cdn.example.com/browser.png",
        iconUrlDark: "https://cdn.example.com/browser-dark.png",
        brandColor: "#4b8df8",
      },
      {
        id: "computer-use@openai-bundled",
        name: "Computer",
        displayName: "Computer",
        description: null,
        defaultPrompt: null,
        installed: true,
        enabled: true,
        path: "plugin://computer-use@openai-bundled",
        iconUrl: "https://cdn.example.com/computer.png",
        iconUrlDark: "https://cdn.example.com/computer.png",
        brandColor: null,
      },
    ]);
  });

  test("prefers package-local composer icons while keeping remote fallbacks", async () => {
    const response = {
      marketplaces: [
        createMarketplace("openai-bundled", [
          createPlugin({
            id: "browser@openai-bundled",
            name: "browser",
            interface: {
              composerIcon: "/plugins/browser/icon.svg",
              composerIconUrl: "https://cdn.example.com/browser.png",
              logoDark: "/plugins/browser/icon-dark.png",
              logoUrlDark: "https://cdn.example.com/browser-dark.png",
            } as PluginInterface,
          }),
        ]),
      ],
    };
    const resolvedPaths: string[] = [];

    const inventory = await hydrateComposerPluginInventoryIcons(
      response,
      buildComposerPluginInventory(response),
      (filePath) => {
        resolvedPaths.push(filePath);
        return `app://fs/@fs${filePath}`;
      },
    );

    expect(resolvedPaths).toEqual(["/plugins/browser/icon.svg", "/plugins/browser/icon-dark.png"]);
    expect(inventory[0]).toMatchObject({
      iconUrl: "app://fs/@fs/plugins/browser/icon.svg",
      iconUrlDark: "app://fs/@fs/plugins/browser/icon-dark.png",
    });
  });

  test("exposes requested local install entrypoints without bypassing policy", () => {
    const response = {
      marketplaces: [
        createMarketplace("openai-bundled", [
          createPlugin({
            id: "browser@openai-bundled",
            name: "browser",
            installed: false,
            enabled: false,
          }),
          createPlugin({
            id: "computer-use@openai-bundled",
            name: "computer-use",
            installed: false,
            enabled: false,
            availability: "DISABLED_BY_ADMIN",
          }),
          createPlugin({
            id: "installed-disabled@example",
            name: "installed-disabled",
            installed: true,
            enabled: false,
          }),
          createPlugin({
            id: "record-and-replay@openai-bundled",
            name: "record-and-replay",
            installed: true,
            enabled: false,
          }),
        ]),
      ],
    };

    expect(buildComposerPluginInventory(response)).toEqual([]);
    expect(
      buildComposerPluginInventory(response, {
        installSuggestionPluginNames: [
          "browser",
          "computer-use",
          "installed-disabled",
          "record-and-replay",
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        id: "browser@openai-bundled",
        name: "Browser",
        path: "plugin://browser@openai-bundled",
      }),
      expect.objectContaining({
        id: "record-and-replay@openai-bundled",
        name: "record-and-replay",
        installed: true,
        enabled: false,
      }),
    ]);
  });

  test("resolves activation against local and remote marketplace contracts", () => {
    const response = {
      marketplaces: [
        {
          ...createMarketplace("local-development", [
            createPlugin({
              id: "browser@local",
              name: "browser",
              installed: false,
              enabled: false,
            }),
          ]),
          path: " /tmp/plugins ",
        },
        createMarketplace("openai-bundled", [
          createPlugin({
            id: "computer-use@openai-bundled",
            name: "computer-use",
            installed: false,
            enabled: false,
          }),
          createPlugin({
            id: "pdf@openai-bundled",
            name: "pdf",
          }),
        ]),
      ],
    };

    expect(resolveComposerPluginActivation(response, " browser@local ")).toEqual({
      kind: "install",
      params: {
        marketplacePath: "/tmp/plugins",
        pluginName: "browser",
      },
    });
    expect(resolveComposerPluginActivation(response, "computer-use@openai-bundled")).toEqual({
      kind: "install",
      params: {
        remoteMarketplaceName: "openai-bundled",
        pluginName: "computer-use",
      },
    });
    expect(resolveComposerPluginActivation(response, "pdf@openai-bundled")).toEqual({
      kind: "active",
    });
  });

  test("rejects activation when policy or installed state blocks it", () => {
    const response = {
      marketplaces: [
        createMarketplace("openai-bundled", [
          createPlugin({
            id: "admin-disabled@openai-bundled",
            name: "admin-disabled",
            installed: false,
            enabled: false,
            availability: "DISABLED_BY_ADMIN",
          }),
          createPlugin({
            id: "user-disabled@openai-bundled",
            name: "user-disabled",
            enabled: false,
          }),
          createPlugin({
            id: "record-and-replay@openai-bundled",
            name: "record-and-replay",
            enabled: false,
          }),
        ]),
      ],
    };

    expect(() =>
      resolveComposerPluginActivation(response, "admin-disabled@openai-bundled"),
    ).toThrow("disabled by your administrator");
    expect(() => resolveComposerPluginActivation(response, "user-disabled@openai-bundled")).toThrow(
      "installed but disabled",
    );
    expect(resolveComposerPluginActivation(response, "record-and-replay@openai-bundled")).toEqual({
      kind: "enable",
      params: {
        edits: [
          {
            keyPath: "plugins.record-and-replay@openai-bundled.enabled",
            value: true,
            mergeStrategy: "upsert",
          },
        ],
        filePath: null,
        expectedVersion: null,
        reloadUserConfig: true,
      },
    });
    expect(() => resolveComposerPluginActivation(response, "missing@openai-bundled")).toThrow(
      "no longer available",
    );
  });
});

import { describe, expect, it } from "vitest";
import { pluginRow, pluginSummary } from "../../../../shared/test-fixtures/plugins";
import type {
  MarketplaceRemovalPreview,
  MarketplaceRemovalProgress,
} from "../../../../shared/codex-plugin-management";
import type { ConfiguredMarketplace } from "../../../../shared/codex-plugin-settings";
import {
  manageableMarketplaces,
  marketplaceLabel,
  marketplaceRemovalState,
  marketplaceUpgradeTooltip,
  marketplaceUpgradeToast,
} from "./marketplace-model";

const marketplace = (overrides: Partial<ConfiguredMarketplace> = {}): ConfiguredMarketplace => ({
  name: "team",
  path: "/plugins/team",
  displayName: null,
  sourceType: "git",
  source: "org/plugins",
  refName: null,
  configured: true,
  userConfigured: true,
  builtIn: false,
  canUpgrade: true,
  canRemove: true,
  pluginCount: 2,
  ...overrides,
});

const row = (id: string, name: string) =>
  pluginRow({ nativeId: id, stableIdentity: id, summary: pluginSummary({ id, name }) });

const preview: MarketplaceRemovalPreview = {
  marketplaceName: "team",
  marketplacePath: "/plugins/team",
  plugins: [row("a@team", "Alpha"), row("b@team", "Beta")],
  pluginIds: ["a@team", "b@team"],
  protected: false,
};

const progress = (
  overrides: Partial<MarketplaceRemovalProgress> = {},
): MarketplaceRemovalProgress => ({
  ...preview,
  operationId: "op-1",
  phase: "uninstalling",
  completedPluginIds: [],
  remainingPluginIds: ["a@team", "b@team"],
  removed: false,
  outcome: { status: "success", value: undefined, refreshFailures: [] },
  ...overrides,
});

describe("marketplace list", () => {
  it("lists only marketplaces you added, matching label, name, or path", () => {
    const items = [
      marketplace({ name: "team", displayName: "Team Tools" }),
      marketplace({ name: "openai-curated", builtIn: true }),
      marketplace({ name: "policy", configured: false }),
      marketplace({ name: "local", path: "/Users/me/plugins", sourceType: "local" }),
    ];
    expect(manageableMarketplaces(items, "").map((item) => item.name)).toEqual(["team", "local"]);
    expect(manageableMarketplaces(items, "team tools").map((item) => item.name)).toEqual(["team"]);
    expect(manageableMarketplaces(items, "users/me").map((item) => item.name)).toEqual(["local"]);
  });

  it("labels official marketplaces and falls back to the name", () => {
    expect(marketplaceLabel(marketplace({ name: "openai-curated" }))).toBe("Built by OpenAI");
    expect(marketplaceLabel(marketplace({ displayName: "  " }))).toBe("team");
  });

  it("explains why a marketplace can't be upgraded", () => {
    expect(marketplaceUpgradeTooltip(marketplace())).toBe("Upgrade marketplace");
    expect(marketplaceUpgradeTooltip(marketplace({ canUpgrade: false, sourceType: "local" }))).toBe(
      "Only Git marketplaces can be upgraded",
    );
  });

  it("reports upgrades for one marketplace or all of them", () => {
    expect(marketplaceUpgradeToast("Team", 0).message).toBe("Team marketplace upgraded");
    expect(marketplaceUpgradeToast(null, 1)).toEqual({
      tone: "danger",
      message: "Some marketplaces failed to upgrade",
    });
  });
});

describe("marketplace removal", () => {
  it("waits for the installed plugins before it can remove", () => {
    expect(
      marketplaceRemovalState({ preview: undefined, progress: null, isRemoving: false }),
    ).toMatchObject({ plugins: null, canSubmit: false, confirmLabel: "Remove" });
    expect(
      marketplaceRemovalState({
        preview: { ...preview, plugins: [], pluginIds: [] },
        progress: null,
        isRemoving: false,
      }),
    ).toMatchObject({ plugins: [], canSubmit: true, confirmLabel: "Remove" });
  });

  it("uninstalls the installed plugins first, marking each one's progress", () => {
    const state = marketplaceRemovalState({
      preview,
      progress: progress({ completedPluginIds: ["a@team"], remainingPluginIds: ["b@team"] }),
      isRemoving: true,
    });
    expect(state.plugins?.map((item) => item.status)).toEqual(["uninstalled", "uninstalling"]);
    expect(state.canSubmit).toBe(false);
  });

  it("names the plugin a failed removal stopped at and resumes with Retry", () => {
    const state = marketplaceRemovalState({
      preview,
      progress: progress({
        phase: "failed",
        completedPluginIds: ["a@team"],
        remainingPluginIds: ["b@team"],
      }),
      isRemoving: false,
    });
    expect(state).toMatchObject({
      error: "Unable to uninstall Beta. Retry to continue",
      confirmLabel: "Retry",
      canSubmit: true,
    });
    expect(
      marketplaceRemovalState({
        preview,
        progress: progress({
          phase: "failed",
          completedPluginIds: ["a@team", "b@team"],
          remainingPluginIds: [],
        }),
        isRemoving: false,
      }).error,
    ).toBe("Unable to remove the marketplace. Retry to continue");
  });

  it("can't remove a marketplace whose plugins are required", () => {
    expect(
      marketplaceRemovalState({
        preview: { ...preview, protected: true },
        progress: null,
        isRemoving: false,
      }).canSubmit,
    ).toBe(false);
  });
});

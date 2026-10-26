import { describe, expect, it } from "vitest";
import { pluginSummary } from "../../shared/test-fixtures/plugins";
import { createPluginInventoryPolicy, safeRemoteIcon } from "./PluginInventoryPolicy";
const policy = createPluginInventoryPolicy("/tmp/plugin-policy");
describe("plugin inventory policy", () => {
  it("hides only foreign local desktop copies, retains disabled/admin rows and protects managed tools", () => {
    const id = `browser@${policy.marketplaceName}`;
    const inventory = {
      marketplaces: [
        {
          name: "tools",
          path: "/catalog",
          interface: null,
          plugins: [
            pluginSummary({ id, enabled: false }),
            pluginSummary({ id: "browser@openai-bundled" }),
            pluginSummary({ id: "browser@custom", enabled: false }),
            pluginSummary({ id: "admin@custom", availability: "DISABLED_BY_ADMIN" }),
          ],
        },
      ],
      marketplaceLoadErrors: [],
    };
    const rows = policy.rows(inventory, "local", () => "app://authorized");
    expect(rows.map((row) => row.nativeId)).toEqual([id, "browser@custom", "admin@custom"]);
    expect(rows[0]).toMatchObject({
      managed: true,
      canUninstall: false,
      canSetEnabled: false,
      summary: { enabled: true },
    });
    expect(rows[1]?.summary.enabled).toBe(false);
    expect(policy.rows(inventory, "remote", () => null)).toHaveLength(4);
    expect(policy.managed(id, "remote")).toBe(false);
  });
  it("authorizes local icons, rejects unsafe remote URLs and keeps remote selectors opaque", () => {
    const summary = pluginSummary({ remotePluginId: "opaque-id", source: { type: "remote" } });
    const rows = policy.rows(
      {
        marketplaces: [{ name: "remote", path: null, interface: null, plugins: [summary] }],
        marketplaceLoadErrors: [],
      },
      "local",
      () => null,
    );
    expect(safeRemoteIcon("file:///private/logo.png")).toBeNull();
    expect(safeRemoteIcon("javascript:alert(1)")).toBeNull();
    expect(safeRemoteIcon("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(rows[0]?.selector).toEqual({ remoteMarketplaceName: "remote", pluginName: "opaque-id" });
    expect(policy.iconResolver("remote", () => "app://host-image")("/some/path")).toBe(
      "app://host-image",
    );
  });
});

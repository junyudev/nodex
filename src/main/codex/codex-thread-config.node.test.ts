import { describe, expect, test } from "vite-plus/test";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import { selectAppToolCatalog } from "../../shared/nodex-app-tools/catalog-selection";
import { buildCodexThreadConfig } from "./codex-thread-config";

describe("Codex native app-tool visibility", () => {
  test.each(["session", "automation"] as const)(
    "%s uses the same catalog as native discovery while explicit config remains authoritative",
    (purpose) => {
      const config = buildCodexThreadConfig({
        nativeAppTools: true,
        purpose,
        overrides: {
          "mcp_servers.nodex_app.enabled_tools": ["removed_tool"],
          model_reasoning_effort: "high",
        },
      });
      expect(config["mcp_servers.nodex_app.enabled_tools"]).toEqual(["removed_tool"]);
      expect(selectAppToolCatalog({ nativeMcp: true, purpose })).toEqual(appToolCatalog);
      expect(config.model_reasoning_effort).toBe("high");
    },
  );

  test("system work disables inherited app tools without changing its other capabilities", () => {
    expect(
      buildCodexThreadConfig({
        nativeAppTools: true,
        purpose: "system",
        overrides: { "features.thread_tools": false },
      }),
    ).toEqual({
      "features.thread_tools": false,
      "mcp_servers.nodex_app.enabled_tools": [],
    });
  });

  test("an endpoint without the native bridge has no app tools or partial server definition", () => {
    expect(selectAppToolCatalog({ nativeMcp: false, purpose: "session" })).toEqual([]);
    expect(buildCodexThreadConfig({ nativeAppTools: false })).not.toHaveProperty(
      "mcp_servers.nodex_app.enabled_tools",
    );
  });

  test("normalizes optional nested configuration values at the request boundary", () => {
    const config = buildCodexThreadConfig({
      nativeAppTools: true,
      overrides: {
        provider: { optional: undefined, timeout: 0, fallback: null },
        omitted: undefined,
      },
    });
    expect(config.provider).toEqual({ timeout: 0, fallback: null });
    expect(config).not.toHaveProperty("omitted");
    expect(() =>
      buildCodexThreadConfig({ nativeAppTools: true, overrides: { invalid: () => undefined } }),
    ).toThrow("JSON values");
  });
});

import { describe, expect, test } from "vite-plus/test";
import {
  buildBrowserSettingsPath,
  buildSettingsPath,
  OPEN_SOURCE_LICENSES_SETTINGS_PATH,
  parseSettingsPath,
  resolveSettingsShellState,
} from "./workbench-settings-routes";

describe("workbench settings routes", () => {
  test("builds canonical top-level and Browser detail paths", () => {
    expect(buildSettingsPath("general-settings")).toBe("/settings/general-settings");
    expect(buildSettingsPath("keyboard-shortcuts")).toBe("/settings/keyboard-shortcuts");
    expect(buildSettingsPath("local-environments")).toBe("/settings/local-environments");
    expect(buildSettingsPath("computer-use")).toBe("/settings/computer-use");
    expect(buildBrowserSettingsPath()).toBe("/settings/browser");
    expect(buildBrowserSettingsPath("passwords")).toBe("/settings/browser/passwords");
    expect(buildBrowserSettingsPath(undefined, "autofill-and-passwords")).toBe(
      "/settings/browser#autofill-and-passwords",
    );
  });

  test("parses canonical settings paths without validating unknown slugs as sections", () => {
    expect(parseSettingsPath("/settings/general-settings")).toBe("general-settings");
    expect(parseSettingsPath("/settings/keyboard-shortcuts")).toBe("keyboard-shortcuts");
    expect(parseSettingsPath("/settings/local-environments")).toBe("local-environments");
    expect(parseSettingsPath("/settings/computer-use")).toBe("computer-use");
    expect(parseSettingsPath("/settings/browser/passwords")).toBe("browser/passwords");
    expect(parseSettingsPath("/settings/not-real")).toBe("not-real");
    expect(parseSettingsPath("/settings")).toBe(null);
    expect(parseSettingsPath("/not-settings")).toBe(null);
  });

  test("preserves canonical query/hash parsing for owner state", () => {
    expect(parseSettingsPath("/settings/general-settings?panel=updates")).toBe("general-settings");
    expect(parseSettingsPath("/settings/local-environments#project-alpha")).toBe(
      "local-environments",
    );
    expect(
      resolveSettingsShellState("/settings/backups?restore=latest#snapshots").activeSectionId,
    ).toBe("backups");

    const browser = resolveSettingsShellState("/settings/browser#permissions");
    expect(browser.activeSectionId).toBe("browser");
    expect(browser.browserAnchor).toBe("permissions");
    expect(browser.settingsAnchor).toBe("permissions");
    expect(browser.browserDetail).toBe(null);

    const general = resolveSettingsShellState("/settings/general-settings#composer");
    expect(general.settingsAnchor).toBe("composer");
  });

  test("resolves the settings root to General without rewriting the path", () => {
    const resolved = resolveSettingsShellState("/settings");
    expect(resolved.activeSectionId).toBe("general-settings");
    expect(resolved.browserDetail).toBe(null);
  });

  test("keeps unknown paths out of the canonical section contract", () => {
    const resolved = resolveSettingsShellState("/settings/not-real");
    expect(resolved.activeSectionId).toBe("general-settings");
    expect(resolved.browserDetail).toBe(null);
    expect(resolved.detailPageId).toBe(null);
    expect(resolved.settingsAnchor).toBe(null);
  });

  test("resolves Browser details with Browser as the active top-level page", () => {
    const resolved = resolveSettingsShellState("/settings/browser/contact-info");

    expect(resolved.activeSectionId).toBe("browser");
    expect(resolved.browserDetail).toBe("contact-info");
    expect(resolved.browserAnchor).toBe(null);
  });

  test("keeps a plugin's settings page under Plugins", () => {
    const resolved = resolveSettingsShellState(
      "/settings/plugins-settings/plugins/figma%40openai-curated?pluginName=figma",
    );

    expect(resolved.activeSectionId).toBe("plugins-settings");
    expect(resolved.detailPageId).toBe(null);
  });

  test("keeps the licenses detail page nested under General", () => {
    const resolved = resolveSettingsShellState(OPEN_SOURCE_LICENSES_SETTINGS_PATH);

    expect(resolved.activeSectionId).toBe("general-settings");
    expect(resolved.detailPageId).toBe("open-source-licenses");
    expect(resolved.browserDetail).toBe(null);
  });
});

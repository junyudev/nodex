import { describe, expect, test } from "vite-plus/test";
import {
  resolveSettingsCommandTarget,
  SETTINGS_SECTION_GROUP_ORDER,
  SETTINGS_SECTIONS,
  settingsCommandId,
} from "./workbench-settings-sections";

describe("settings section catalog", () => {
  test("keeps one page owner per visible top-level entry", () => {
    const pageKeys = SETTINGS_SECTIONS.map((section) => section.pageKey);

    expect(SETTINGS_SECTIONS).toHaveLength(18);
    expect(new Set(pageKeys).size).toBe(SETTINGS_SECTIONS.length);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "voice")?.pageKey).toBe("voice");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "browser")?.pageKey).toBe("browser");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "plugins-settings")?.pageKey).toBe(
      "plugins",
    );
    expect(SETTINGS_SECTIONS.find((section) => section.id === "inbox-settings")?.pageKey).toBe(
      "inbox",
    );
    expect(SETTINGS_SECTIONS.find((section) => section.id === "agent-import")?.pageKey).toBe(
      "import",
    );
    expect(SETTINGS_SECTIONS.find((section) => section.id === "hooks-settings")?.pageKey).toBe(
      "hooks",
    );
    expect(SETTINGS_SECTIONS.some((section) => section.label === "Editor")).toBe(false);
  });

  test("orders the rail by product area", () => {
    expect(SETTINGS_SECTION_GROUP_ORDER).toEqual([
      "personal",
      "agents",
      "integrations",
      "coding",
      "workspace",
      "data",
    ]);
  });

  test("opens a Command K Settings command where Settings search would land", () => {
    expect(resolveSettingsCommandTarget(settingsCommandId("agent"), "Fast mode")).toEqual({
      sectionId: "agent",
      anchor: "codex",
    });
    expect(resolveSettingsCommandTarget(settingsCommandId("agent"), "Gemini")).toEqual({
      sectionId: "agent",
      anchor: "acp",
    });
    expect(
      resolveSettingsCommandTarget(settingsCommandId("general-settings"), "Spellcheck"),
    ).toEqual({ sectionId: "general-settings", anchor: "writing" });
    expect(resolveSettingsCommandTarget(settingsCommandId("appearance"), "Code font size")).toEqual(
      { sectionId: "appearance", anchor: "advanced" },
    );
    // Naming the page, or browsing without a query, opens it at the top.
    expect(resolveSettingsCommandTarget(settingsCommandId("agent"), "Agents")).toEqual({
      sectionId: "agent",
    });
    expect(resolveSettingsCommandTarget(settingsCommandId("account"), "")).toEqual({
      sectionId: "account",
    });
    expect(resolveSettingsCommandTarget("settings:retired", "Fast mode")).toBeNull();
    expect(resolveSettingsCommandTarget("settings", "Fast mode")).toBeNull();
  });
});

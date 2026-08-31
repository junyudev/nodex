import { describe, expect, test } from "vite-plus/test";
import { SETTINGS_SECTION_GROUP_ORDER, SETTINGS_SECTIONS } from "./workbench-settings-sections";

describe("settings section catalog", () => {
  test("keeps one page owner per visible top-level entry", () => {
    const pageKeys = SETTINGS_SECTIONS.map((section) => section.pageKey);

    expect(SETTINGS_SECTIONS).toHaveLength(15);
    expect(new Set(pageKeys).size).toBe(SETTINGS_SECTIONS.length);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "voice")?.pageKey).toBe("voice");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "browser")?.pageKey).toBe("browser");
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
      "integrations",
      "coding",
      "workspace",
      "data",
    ]);
  });
});

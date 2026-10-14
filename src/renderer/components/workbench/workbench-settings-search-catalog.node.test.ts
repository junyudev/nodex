import { describe, expect, test } from "vite-plus/test";
import {
  buildSettingsSearchResults,
  buildSettingsSearchTargets,
  type SettingsSearchContext,
} from "@/lib/settings-search";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./workbench-settings-sections";
import { shouldExpandAppearanceAdvanced } from "./workbench-settings-search-catalog";

const SEARCH_CONTEXT: SettingsSearchContext = {
  activeProjectName: "Nodex Workspace",
  projectNames: ["Nodex Workspace", "Docs Space"],
};

const VISIBLE_SECTION_IDS = SETTINGS_SECTIONS.map((section) => section.id);

function searchCatalog(query: string, context: SettingsSearchContext = SEARCH_CONTEXT) {
  return buildSettingsSearchResults({
    query,
    targets: buildSettingsSearchTargets(SETTINGS_SECTIONS, context),
    visibleSectionIds: VISIBLE_SECTION_IDS,
  });
}

function hasSectionResult(query: string, sectionId: SettingsSectionId): boolean {
  return searchCatalog(query).some((result) => result.sectionId === sectionId);
}

describe("workbench settings search catalog", () => {
  test("every visible settings section has a populated search catalog", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(section.searchMessages.length > 0).toBe(true);
    }
  });

  test("indexes setting row descriptions and option labels across panels", () => {
    expect(hasSectionResult("masked session replays", "general-settings")).toBe(true);
    expect(hasSectionResult("third-party notices", "general-settings")).toBe(true);
    expect(hasSectionResult("password manager", "browser")).toBe(true);
    expect(hasSectionResult("contact info", "browser")).toBe(true);
    expect(hasSectionResult("browsing history", "browser")).toBe(true);
    expect(hasSectionResult("force fixed theme", "appearance")).toBe(true);
    expect(hasSectionResult("custom hex color", "appearance")).toBe(true);
    expect(hasSectionResult("danger-full-access", "agent")).toBe(true);
    expect(hasSectionResult("OpenCode", "agent")).toBe(true);
    expect(hasSectionResult("Kimi", "agent")).toBe(true);
    expect(hasSectionResult("Agent Client Protocol", "agent")).toBe(true);
    expect(hasSectionResult("materialize inflating note", "general-settings")).toBe(true);
    expect(hasSectionResult("task shorthand", "page")).toBe(true);
    expect(hasSectionResult("auto-create branch detached", "worktrees")).toBe(true);
    expect(hasSectionResult("CODEX_SOURCE_TREE_PATH", "local-environments")).toBe(true);
    expect(hasSectionResult("locked computer", "computer-use")).toBe(true);
    expect(hasSectionResult("collect unreferenced tombstone", "backups")).toBe(true);
  });

  test("uses runtime project names as hidden local-environment terms", () => {
    const results = searchCatalog("Docs Space");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("local-environments");
    expect(results[0]?.label).toBe("Environments");
  });

  test("routes typography to Appearance and expands Advanced only for its own settings", () => {
    for (const query of [
      "UI font size",
      "Content font size",
      "Page font size",
      "Code font size",
      "Separate light/dark modes",
      "Content font",
    ]) {
      expect(searchCatalog(query)[0]?.sectionId).toBe("appearance");
      expect(shouldExpandAppearanceAdvanced(query)).toBe(true);
    }
    for (const query of [undefined, "", "Appearance", "Accent color", "Mode"]) {
      expect(shouldExpandAppearanceAdvanced(query)).toBe(false);
    }
  });

  test("does not index the retired sidebar section preferences", () => {
    expect(searchCatalog("Sidebar sections")).toEqual([]);
  });

  test("does not index retired global Page presentation preferences", () => {
    expect(searchCatalog("Board card properties")).toEqual([]);
    expect(searchCatalog("more-properties toggle")).toEqual([]);
  });
});

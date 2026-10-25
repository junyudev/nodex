import { describe, expect, test } from "vite-plus/test";
import {
  buildSettingsSearchResults,
  buildSettingsSearchTargets,
  type SettingsSearchContext,
} from "@/lib/settings-search";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./workbench-settings-sections";
import {
  settingsSearchAnchor,
  shouldExpandAppearanceAdvanced,
} from "./workbench-settings-search-catalog";

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

  test("finds conversation import under Conversations and setup copying under Agents", () => {
    expect(hasSectionResult("codex://threads", "agent-import")).toBe(true);
    expect(hasSectionResult("Import conversations", "agent-import")).toBe(true);
    expect(hasSectionResult("MCP servers", "agent")).toBe(true);
    expect(hasSectionResult("MCP servers", "agent-import")).toBe(false);
    expect(hasSectionResult("AGENTS.md", "agent")).toBe(true);
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

  test("opens the Agent a search names, and only the page when the query names Agents", () => {
    const anchors = {
      CODEX_HOME: "codex",
      "Service tier": "codex",
      "Fast mode": "codex",
      "MCP servers": "codex",
      "Claude Code": "claude",
      ANTHROPIC_BASE_URL: "claude",
      "Config directory": "claude",
      Kimi: "opencode",
      "Server URL": "opencode",
      "Agent Client Protocol": "acp",
      "ACP Registry": "acp",
      Gemini: "acp",
    };
    for (const [query, anchor] of Object.entries(anchors)) {
      expect(hasSectionResult(query, "agent")).toBe(true);
      expect(settingsSearchAnchor("agent", query)).toBe(anchor);
    }
    for (const query of [undefined, "", "Agents", "agent"]) {
      expect(settingsSearchAnchor("agent", query)).toBeNull();
    }
    // A shared setting opens the first Agent that has it, in page order.
    expect(settingsSearchAnchor("agent", "Environment variables")).toBe("claude");
    // Panels without anchored groups always open at the top.
    expect(settingsSearchAnchor("git", "Commit instructions")).toBeNull();
  });

  test("lands on the General section a search names", () => {
    const anchors = {
      "Update channel": "app",
      "Restart to update": "app",
      "Queue follow-ups": "chats",
      Spellcheck: "writing",
      "Markdown file links": "files-and-links",
      "Turn completion notifications": "notifications",
      "Share crash reports": "privacy",
      Statsig: "privacy",
      "App server requests": "app-server-diagnostics",
    };
    for (const [query, anchor] of Object.entries(anchors)) {
      expect(hasSectionResult(query, "general-settings")).toBe(true);
      expect(settingsSearchAnchor("general-settings", query)).toBe(anchor);
    }
    expect(settingsSearchAnchor("general-settings", "General")).toBeNull();
  });

  test("does not index the retired raw Codex config and agent permission controls", () => {
    for (const query of [
      "Approval policy",
      "danger-full-access",
      "network_access",
      "permission mode",
    ]) {
      expect(hasSectionResult(query, "agent")).toBe(false);
    }
    expect(hasSectionResult("Default permissions mode", "general-settings")).toBe(false);
  });

  test("does not index the retired sidebar section preferences", () => {
    expect(searchCatalog("Sidebar sections")).toEqual([]);
  });

  test("does not index retired global Page presentation preferences", () => {
    expect(searchCatalog("Board card properties")).toEqual([]);
    expect(searchCatalog("more-properties toggle")).toEqual([]);
  });
});

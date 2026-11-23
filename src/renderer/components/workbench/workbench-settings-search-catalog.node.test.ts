import { describe, expect, test } from "vite-plus/test";
import { createIntl, ReactIntlErrorCode } from "react-intl";
import { getIntl } from "@/lib/i18n";
import type { SettingsSearchContext } from "@/lib/settings-search";
import zhCN from "../../../shared/i18n/catalogs/zh-CN.json";
import {
  searchWorkbenchSettings,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "./workbench-settings-sections";
import {
  settingsSearchAnchor,
  shouldExpandAppearanceAdvanced,
} from "./workbench-settings-search-catalog";

const SEARCH_CONTEXT: SettingsSearchContext = {
  activeProjectName: "Nodex Workspace",
  projectNames: ["Nodex Workspace", "Docs Space"],
};

function searchCatalog(query: string, context: SettingsSearchContext = SEARCH_CONTEXT) {
  return searchWorkbenchSettings(SETTINGS_SECTIONS, context, query, getIntl());
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
    expect(hasSectionResult("pasted text own file", "editor")).toBe(true);
    expect(hasSectionResult("task shorthand", "editor")).toBe(true);
    expect(hasSectionResult("auto-create branch detached", "worktrees")).toBe(true);
    expect(hasSectionResult("CODEX_SOURCE_TREE_PATH", "worktrees")).toBe(true);
    expect(hasSectionResult("Your instructions", "chats")).toBe(true);
    expect(hasSectionResult("Default permissions", "chats")).toBe(true);
    expect(hasSectionResult("Usage meters", "appearance")).toBe(true);
    expect(hasSectionResult("Remote access", "remote")).toBe(true);
    expect(hasSectionResult("Trust", "plugins-settings")).toBe(true);
    expect(hasSectionResult("locked computer", "computer-use")).toBe(true);
    expect(hasSectionResult("deleted blocks restored", "backups")).toBe(true);
  });

  test("finds settings details by their Chinese labels and English aliases", () => {
    const intl = createIntl({
      locale: "zh-CN",
      defaultLocale: "en-US",
      messages: {
        ...zhCN,
        "settings.search.account.modelPrices": "模型价格",
        "settings.search.voice.dictionary": "听写词典",
        "settings.search.models.turnOff": "关闭模型",
        "settings.search.inbox.routingPreferences": "分派偏好",
        "settings.search.browser.passwordManager": "密码管理器",
        "settings.search.plugins.addMarketplace": "添加插件市场",
      },
    });
    for (const [english, chinese, sectionId] of [
      ["Model prices", "模型价格", "account"],
      ["Dictation dictionary", "听写词典", "voice"],
      ["Turn models off", "关闭模型", "agent"],
      ["Routing preferences", "分派偏好", "inbox-settings"],
      ["Password manager", "密码管理器", "browser"],
      ["Add a marketplace", "添加插件市场", "plugins-settings"],
    ] as const) {
      for (const query of [english, chinese]) {
        expect(
          searchWorkbenchSettings(SETTINGS_SECTIONS, SEARCH_CONTEXT, query, intl).find(
            (result) => result.sectionId === sectionId,
          )?.label,
        ).toBe(chinese);
      }
    }
  });

  test("finds conversation import under Import and setup copying under Agents", () => {
    expect(hasSectionResult("codex://threads", "import")).toBe(true);
    expect(hasSectionResult("Import conversations", "import")).toBe(true);
    expect(hasSectionResult("MCP servers", "agent")).toBe(true);
    expect(hasSectionResult("MCP servers", "import")).toBe(false);
    expect(hasSectionResult("AGENTS.md", "agent")).toBe(true);
  });

  test("uses runtime project names as hidden Worktrees terms", () => {
    const results = searchCatalog("Docs Space");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("worktrees");
    expect(results[0]?.label).toBe("Worktrees");
  });

  test("routes typography to Appearance and expands Advanced only for its own settings", () => {
    for (const query of [
      "UI font size",
      "Content font size",
      "Page font size",
      "Code font size",
      "Font smoothing",
      "macOS anti-aliasing",
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
      Kimi: "keys",
      DeepSeek: "keys",
      "Add API key": "keys",
      "Server URL": "opencode",
      "Agent Client Protocol": "acp",
      "ACP Registry": "acp",
      Gemini: "antigravity",
      Antigravity: "antigravity",
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

  test("lands on the group a search names", () => {
    const anchors = [
      ["Restore windows", "general-settings", "app"],
      ["Update channel", "general-settings", "about"],
      ["Restart to update", "general-settings", "about"],
      ["Turn completion notifications", "general-settings", "notifications"],
      ["Share crash reports", "general-settings", "privacy"],
      ["Statsig", "general-settings", "privacy"],
      ["App server requests", "general-settings", "app-server-diagnostics"],
      ["Queue follow-ups", "chats", "in-a-chat"],
      ["Spellcheck", "editor", "typing"],
      ["Markdown file links", "editor", "files-and-links"],
    ] as const;
    for (const [query, sectionId, anchor] of anchors) {
      expect(hasSectionResult(query, sectionId)).toBe(true);
      expect(settingsSearchAnchor(sectionId, query)).toBe(anchor);
    }
    expect(settingsSearchAnchor("general-settings", "General")).toBeNull();
  });

  test("finds localized settings by Chinese and English and displays their Chinese labels", () => {
    const intl = createIntl({
      locale: "zh-CN",
      defaultLocale: "en-US",
      messages: zhCN,
      onError: (error) => {
        if (error.code !== ReactIntlErrorCode.MISSING_TRANSLATION) throw error;
      },
    });
    for (const query of ["拼写检查", "spellcheck"]) {
      const [result] = searchWorkbenchSettings(SETTINGS_SECTIONS, SEARCH_CONTEXT, query, intl);
      expect(result).toEqual({
        sectionId: "editor",
        panelLabel: "编辑器",
        label: "拼写检查",
      });
      expect(settingsSearchAnchor("editor", query, intl)).toBe("typing");
    }
    for (const query of ["语言", "locale", "简体中文"]) {
      expect(settingsSearchAnchor("general-settings", query, intl)).toBe("app");
    }
  });

  test("leads sign-in searches with the Nodex Account and still offers Agent sign-in", () => {
    for (const query of ["Sign in", "sign out"]) {
      const results = searchCatalog(query);
      expect(results[0]?.sectionId).toBe("account");
      expect(results[1]?.sectionId).toBe("agent");
      expect(settingsSearchAnchor("agent", query)).toBe("antigravity");
    }
  });

  test("finds default permissions on the Chats page without raw Codex config", () => {
    for (const query of [
      "Default permissions",
      "Full access",
      "Ask for approval",
      "Let subagents delegate",
      "nested delegation",
    ]) {
      expect(hasSectionResult(query, "chats")).toBe(true);
      expect(settingsSearchAnchor("chats", query)).toBe("permissions");
    }
    for (const query of ["Approval policy", "danger-full-access", "network_access"]) {
      expect(hasSectionResult(query, "chats")).toBe(false);
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

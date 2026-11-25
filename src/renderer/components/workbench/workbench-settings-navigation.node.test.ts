import { describe, expect, test } from "vite-plus/test";
import {
  buildBrowserSettingsPath,
  buildSettingsPath,
  ENVIRONMENTS_SETTINGS_PATH,
  OPEN_SOURCE_LICENSES_SETTINGS_PATH,
  parseSettingsPath,
  resolveSettingsShellState,
} from "./workbench-settings-routes";
import { createIntl, ReactIntlErrorCode } from "react-intl";
import { getIntl } from "@/lib/i18n";
import type { SettingsSearchContext } from "@/lib/settings-search";
import zhCN from "../../../shared/i18n/catalogs/zh-CN.json";
import {
  searchWorkbenchSettings,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
  resolveSettingsCommandTarget,
  SETTINGS_SECTION_GROUP_ORDER,
  settingsCommandId,
} from "./workbench-settings-sections";
import {
  settingsSearchAnchor,
  shouldExpandAppearanceAdvanced,
} from "./workbench-settings-search-catalog";

describe("workbench settings routes", () => {
  test("builds canonical top-level and Browser detail paths", () => {
    expect(buildSettingsPath("general-settings")).toBe("/settings/general-settings");
    expect(buildSettingsPath("keyboard-shortcuts")).toBe("/settings/keyboard-shortcuts");
    expect(buildSettingsPath("archived-chats")).toBe("/settings/archived-chats");
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
    expect(parseSettingsPath("/settings/archived-chats")).toBe("archived-chats");
    expect(parseSettingsPath("/settings/computer-use")).toBe("computer-use");
    expect(parseSettingsPath("/settings/browser/passwords")).toBe("browser/passwords");
    expect(parseSettingsPath("/settings/not-real")).toBe("not-real");
    expect(parseSettingsPath("/settings")).toBe(null);
    expect(parseSettingsPath("/not-settings")).toBe(null);
  });

  test("preserves canonical query/hash parsing for owner state", () => {
    expect(parseSettingsPath("/settings/general-settings?panel=updates")).toBe("general-settings");
    expect(parseSettingsPath("/settings/worktrees#project-alpha")).toBe("worktrees");
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

  test("keeps a plugin's settings page and the Hooks tab under Plugins", () => {
    const resolved = resolveSettingsShellState(
      "/settings/plugins-settings/plugins/figma%40openai-curated?pluginName=figma",
    );

    expect(resolved.activeSectionId).toBe("plugins-settings");
    expect(resolved.detailPageId).toBe(null);
    expect(
      resolveSettingsShellState("/settings/plugins-settings/hooks?hostId=local&source=user")
        .activeSectionId,
    ).toBe("plugins-settings");
  });

  test("lands on Worktrees' Environments tab through its anchor", () => {
    const resolved = resolveSettingsShellState(ENVIRONMENTS_SETTINGS_PATH);

    expect(resolved.activeSectionId).toBe("worktrees");
    expect(resolved.settingsAnchor).toBe("environments");
  });

  test("keeps the licenses detail page nested under General", () => {
    const resolved = resolveSettingsShellState(OPEN_SOURCE_LICENSES_SETTINGS_PATH);

    expect(resolved.activeSectionId).toBe("general-settings");
    expect(resolved.detailPageId).toBe("open-source-licenses");
    expect(resolved.browserDetail).toBe(null);
  });
});

describe("workbench settings search catalog", () => {
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
});

describe("settings section catalog", () => {
  test("keeps one page owner per visible top-level entry", () => {
    const pageKeys = SETTINGS_SECTIONS.map((section) => section.pageKey);

    expect(SETTINGS_SECTIONS.find((section) => section.id === "github")?.pageKey).toBe("github");
    expect(new Set(pageKeys).size).toBe(SETTINGS_SECTIONS.length);
    expect(SETTINGS_SECTIONS.find((section) => section.id === "voice")?.pageKey).toBe("voice");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "browser")?.pageKey).toBe("browser");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "plugins-settings")?.pageKey).toBe(
      "plugins",
    );
    expect(SETTINGS_SECTIONS.find((section) => section.id === "inbox-settings")?.pageKey).toBe(
      "inbox",
    );
    expect(SETTINGS_SECTIONS.find((section) => section.id === "import")?.pageKey).toBe("import");
    expect(SETTINGS_SECTIONS.find((section) => section.id === "remote")?.pageKey).toBe("remote");
  });

  test("gives every rail entry an icon of its own", () => {
    expect(new Set(SETTINGS_SECTIONS.map((section) => section.icon)).size).toBe(
      SETTINGS_SECTIONS.length,
    );
  });

  test("orders the rail by the question each group answers", () => {
    expect(SETTINGS_SECTION_GROUP_ORDER).toEqual([
      "account",
      "app",
      "agents",
      "integrations",
      "coding",
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
      anchor: "antigravity",
    });
    expect(resolveSettingsCommandTarget(settingsCommandId("editor"), "Spellcheck")).toEqual({
      sectionId: "editor",
      anchor: "typing",
    });
    expect(resolveSettingsCommandTarget(settingsCommandId("chats"), "Artifact")).toEqual({
      sectionId: "chats",
      anchor: "instructions",
    });
    expect(resolveSettingsCommandTarget(settingsCommandId("worktrees"), "Setup script")).toEqual({
      sectionId: "worktrees",
      anchor: "environments",
    });
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

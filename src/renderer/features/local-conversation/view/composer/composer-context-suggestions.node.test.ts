import { describe, expect, test } from "vite-plus/test";
import {
  buildComposerContextSuggestionSections,
  rankComposerContextSuggestionCandidates,
  shouldDismissComposerSuggestionMenu,
  type ComposerContextSuggestionCandidate,
} from "./composer-context-suggestions";
import { calculateComposerHomeMenuMaxHeight } from "./composer-suggestion-surface";
import { getIntl } from "@/lib/i18n";
import type { CodexComposerPlugin, CodexComposerSkill } from "@/lib/types";
import {
  formatComposerSkillScopeLabel,
  resolveComposerSkillNames,
} from "./composer-skill-presentation";

describe("composer context suggestions", () => {
  function candidate(
    input: Partial<ComposerContextSuggestionCandidate<string>> & {
      id: string;
      label: string;
      section: ComposerContextSuggestionCandidate["section"];
    },
  ): ComposerContextSuggestionCandidate<string> {
    return {
      description: null,
      searchTerms: [],
      value: input.id,
      ...input,
    };
  }

  describe("composer context suggestions", () => {
    test("reserves composer chrome and viewport space at every window zoom", () => {
      expect(
        calculateComposerHomeMenuMaxHeight({
          anchorBottomPx: 1_146,
          windowZoom: 1,
        }),
      ).toBe(1_092);
      expect(
        calculateComposerHomeMenuMaxHeight({
          anchorBottomPx: 600,
          windowZoom: 2,
        }),
      ).toBe(246);
      expect(
        calculateComposerHomeMenuMaxHeight({
          anchorBottomPx: 40,
          windowZoom: 1,
        }),
      ).toBe(0);
    });

    test("uses Codex section caps for an empty synthetic query", () => {
      const sections = buildComposerContextSuggestionSections({
        query: "",
        candidates: [
          candidate({ id: "add", label: "Files", section: "Add" }),
          ...Array.from({ length: 4 }, (_, index) =>
            candidate({
              id: `app-${index}`,
              label: `App ${index}`,
              section: "Apps",
            }),
          ),
          ...Array.from({ length: 3 }, (_, index) =>
            candidate({
              id: `skill-${index}`,
              label: `Skill ${index}`,
              section: "Skills",
            }),
          ),
          ...Array.from({ length: 3 }, (_, index) =>
            candidate({
              id: `site-${index}`,
              label: `Site ${index}`,
              section: "Sites",
            }),
          ),
          ...Array.from({ length: 6 }, (_, index) =>
            candidate({
              id: `chatgpt-${index}`,
              label: `Conversation ${index}`,
              section: "ChatGPT conversations",
            }),
          ),
        ],
      });

      expect(sections.find((section) => section.id === "Apps")?.items).toHaveLength(3);
      expect(sections.find((section) => section.id === "Sites")?.items).toHaveLength(2);
      expect(
        sections.find((section) => section.id === "ChatGPT conversations")?.items,
      ).toHaveLength(5);
      expect(sections.find((section) => section.id === "Skills")?.items).toHaveLength(2);
      expect(sections.map((section) => section.id)).toEqual([
        "Add",
        "Apps",
        "Sites",
        "ChatGPT conversations",
        "Skills",
        "Files and chats",
      ]);
      expect(sections.find((section) => section.id === "Files and chats")?.emptyMessage).toBe(
        "Type to search files or chats",
      );
    });

    test("retains provider sections while their first page is loading", () => {
      const sections = buildComposerContextSuggestionSections({
        query: "",
        candidates: [],
        loadingSectionMessages: {
          Sites: "Loading sites…",
          "ChatGPT conversations": "Loading ChatGPT conversations…",
        },
      });

      expect(sections).toMatchObject([
        {
          id: "Sites",
          items: [],
          emptyMessage: "Loading sites…",
        },
        {
          id: "ChatGPT conversations",
          items: [],
          emptyMessage: "Loading ChatGPT conversations…",
        },
        {
          id: "Files and chats",
          items: [],
        },
      ]);
    });

    test("globally ranks all providers and returns at most eight rows", () => {
      const candidates = [
        candidate({
          id: "browser-plugin",
          label: "Browser",
          section: "Plugins",
        }),
        candidate({
          id: "agent-browser-skill",
          label: "Agent Browser",
          section: "Skills",
        }),
        ...Array.from({ length: 10 }, (_, index) =>
          candidate({
            id: `browser-file-${index}`,
            label: `browser-${index}.ts`,
            section: "Files and chats",
            sourceRanked: true,
          }),
        ),
      ];

      const sections = buildComposerContextSuggestionSections({
        query: "bro",
        candidates,
      });

      expect(sections).toHaveLength(1);
      expect(sections[0]?.label).toBeNull();
      expect(sections[0]?.items).toHaveLength(8);
      expect(sections[0]?.items[0]?.id).toBe("browser-plugin");
      expect(sections[0]?.items.some((item) => item.id === "agent-browser-skill")).toBe(true);
    });

    test("uses the provider prefix-priority contract", () => {
      const sections = buildComposerContextSuggestionSections({
        query: "plugin",
        candidates: [
          candidate({
            id: "plugin-management",
            label: "Plugin Management",
            section: "Apps",
          }),
          candidate({
            id: "plain-plugin",
            label: "Plugins",
            section: "Add",
          }),
        ],
      });

      expect(sections[0]?.items.map((item) => item.id)).toEqual([
        "plugin-management",
        "plain-plugin",
      ]);
    });

    test("uses the shared Codex word-start fuzzy scorer", () => {
      const sections = buildComposerContextSuggestionSections({
        query: "pman",
        candidates: [
          candidate({
            id: "plugin-management",
            label: "Plugin Management",
            section: "Apps",
          }),
        ],
      });

      expect(sections[0]?.items[0]?.id).toBe("plugin-management");
    });

    test("keeps source-ranked provider order instead of rescoring remote results", () => {
      const sections = buildComposerContextSuggestionSections({
        query: "browser",
        candidates: [
          candidate({
            id: "remote-second-score",
            label: "unrelated",
            section: "Files and chats",
            sourceRanked: true,
          }),
          candidate({
            id: "remote-first-score",
            label: "browser.ts",
            section: "Files and chats",
            sourceRanked: true,
          }),
        ],
      });

      expect(sections[0]?.items.map((item) => item.id)).toEqual([
        "remote-second-score",
        "remote-first-score",
      ]);
    });

    test("uses the exact generic empty state for a completed search", () => {
      const [section] = buildComposerContextSuggestionSections({
        query: "missing",
        candidates: [candidate({ id: "browser", label: "Browser", section: "Plugins" })],
      });

      expect(section).toMatchObject({
        id: "search-results",
        label: null,
        items: [],
        emptyMessage: "No results",
      });
    });

    test("dismisses only settled whitespace queries with no results", () => {
      expect(
        shouldDismissComposerSuggestionMenu({
          loading: false,
          query: "no result",
          resultCount: 0,
        }),
      ).toBe(true);
      expect(
        shouldDismissComposerSuggestionMenu({
          loading: true,
          query: "no result",
          resultCount: 0,
        }),
      ).toBe(false);
      expect(
        shouldDismissComposerSuggestionMenu({
          loading: false,
          query: "no-result",
          resultCount: 0,
        }),
      ).toBe(false);
      expect(
        shouldDismissComposerSuggestionMenu({
          loading: false,
          query: "has result",
          resultCount: 1,
        }),
      ).toBe(false);
    });
  });

  test("bounded search considers late candidates and preserves the full picker order", () => {
    const candidates = Array.from({ length: 800 }, (_, index) =>
      candidate({
        id: String(index),
        label: index === 799 ? "abc" : `abc tool ${index % 10}`,
        section: "Skills",
      }),
    );
    const full = rankComposerContextSuggestionCandidates({ candidates, query: "abc" });
    expect(full).toHaveLength(800);
    expect(full[0]?.id).toBe("799");
    for (const maxResults of [0, 1, 8, 24, 800]) {
      expect(
        rankComposerContextSuggestionCandidates({ candidates, query: "abc", maxResults }),
      ).toEqual(full.slice(0, maxResults));
    }
    expect(full.filter((item) => item.label === "abc tool 0").map((item) => item.id)).toEqual(
      candidates.filter((item) => item.label === "abc tool 0").map((item) => item.id),
    );
  });
});

describe("composer skill presentation", () => {
  const intl = getIntl();

  function skill(overrides: Partial<CodexComposerSkill>): CodexComposerSkill {
    return {
      name: "review",
      displayName: "Review",
      description: "",
      iconUrl: null,
      brandColor: null,
      path: "/skills/review/SKILL.md",
      scope: "user",
      ...overrides,
    };
  }

  const spotify = {
    id: "app-68de829b@openai-curated",
    name: "app-68de829b",
    displayName: "Spotify",
  } as CodexComposerPlugin;

  describe("composer skill names", () => {
    test("names a plugin's skill after the plugin as listed, not its ID", () => {
      expect(
        resolveComposerSkillNames(
          intl,
          skill({
            name: "app-68de829b:browse-collections",
            displayName: "App 68de829b: Browse Collections",
            pluginId: spotify.id,
          }),
          [spotify],
        ),
      ).toEqual({ title: "Spotify: Browse Collections", pluginLabel: "From Spotify" });
    });

    test("keeps a title the skill declares and formats an unlisted plugin's ID", () => {
      expect(
        resolveComposerSkillNames(
          intl,
          skill({
            name: "app-68de829b:browse-collections",
            displayName: "Browse your library",
            pluginId: spotify.id,
          }),
          [spotify],
        ),
      ).toEqual({ title: "Browse your library", pluginLabel: "From Spotify" });
      expect(
        resolveComposerSkillNames(
          intl,
          skill({ name: "github-pr", displayName: "GitHub PR", pluginId: "github@openai-curated" }),
          [],
        ),
      ).toEqual({ title: "GitHub PR", pluginLabel: "From GitHub" });
      expect(resolveComposerSkillNames(intl, skill({}), [spotify])).toEqual({
        title: "Review",
        pluginLabel: null,
      });
    });

    test("names a repository skill after the longest root that holds it", () => {
      const label = (skillPath: string, roots: readonly string[]) =>
        formatComposerSkillScopeLabel(intl, { scope: "repo", skillPath, roots });

      expect(
        label("/work/app/web/.agents/skills/x/SKILL.md", ["/work/app/", "/work/app/web"]),
      ).toBe("web");
      expect(label("/elsewhere/skills/x/SKILL.md", ["/work/app"])).toBe("Team");
      expect(
        formatComposerSkillScopeLabel(intl, { scope: "system", skillPath: "", roots: [] }),
      ).toBe("System");
    });
  });
});

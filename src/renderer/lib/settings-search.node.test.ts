import { describe, expect, test } from "vite-plus/test";
import {
  buildSettingsSearchResults,
  buildSettingsSearchTargets,
  settingsQueryRendersResultsMode,
  type SettingsSearchContext,
  type SettingsSearchSection,
} from "./settings-search";

type TestSectionId =
  | "general"
  | "keyboard"
  | "agent"
  | "worktrees"
  | "local-environments"
  | "appearance"
  | "disabled"
  | "external"
  | "markup";

const SEARCH_CONTEXT: SettingsSearchContext = {
  activeProjectName: "Alpha",
  projectNames: ["Alpha", "Beta"],
};

const TEST_SECTIONS: SettingsSearchSection<TestSectionId>[] = [
  {
    id: "general",
    label: "General",
    searchMessages: ["Keep awake", "Keyboard shortcuts", "Turn completion notifications"],
  },
  {
    id: "keyboard",
    label: "Keyboard shortcuts",
    searchMessages: ["Search commands", "Command keybindings", "Capture shortcut"],
  },
  {
    id: "agent",
    label: "Agent",
    searchMessages: ["Configuration", "config.toml", "Default permissions mode"],
  },
  {
    id: "worktrees",
    label: "Worktrees",
    searchMessages: ["Git branch", "Auto branch prefix"],
  },
  {
    id: "local-environments",
    label: "Local environments",
    searchMessages: ["Environment settings"],
    searchTerms: ({ projectNames }) => projectNames,
  },
  {
    id: "appearance",
    label: "Appearance",
    searchMessages: ["Theme"],
  },
  {
    id: "disabled",
    label: "Disabled",
    disabled: true,
    searchMessages: ["Hidden disabled result"],
  },
  {
    id: "external",
    label: "External",
    externalUrl: "https://example.com",
    searchMessages: ["Hidden external result"],
  },
  {
    id: "markup",
    label: "Markup Panel",
    searchMessages: ["Use <b>markup</b> values"],
  },
];

const VISIBLE_IDS = TEST_SECTIONS.map((section) => section.id);

function resultsFor(query: string) {
  return buildSettingsSearchResults({
    query,
    targets: buildSettingsSearchTargets(TEST_SECTIONS, SEARCH_CONTEXT),
    visibleSectionIds: VISIBLE_IDS,
  });
}

describe("settings search", () => {
  test("empty query returns no results mode", () => {
    expect(settingsQueryRendersResultsMode("")).toBe(false);
    expect(settingsQueryRendersResultsMode("   ")).toBe(false);
    expect(resultsFor("").length).toBe(0);
  });

  test("direct section label matches rank before message matches", () => {
    const results = resultsFor("keyboard shortcuts");

    expect(results[0]?.sectionId).toBe("keyboard");
    expect(results[0]?.label).toBe("Keyboard shortcuts");
    expect(results[1]?.sectionId).toBe("general");
  });

  test("multi-token queries require every token", () => {
    const results = resultsFor("keep awake");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("general");
    expect(resultsFor("keep missing").length).toBe(0);
  });

  test("disabled and external sections are excluded", () => {
    const results = resultsFor("hidden");

    expect(results.length).toBe(0);
  });

  test("tie-breaking follows visible section order", () => {
    const results = resultsFor("theme");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("appearance");

    const tiedResults = buildSettingsSearchResults({
      query: "same",
      targets: buildSettingsSearchTargets(
        [
          { id: "agent", label: "Agent", searchMessages: ["Same match"] },
          { id: "general", label: "General", searchMessages: ["Same match"] },
        ],
        SEARCH_CONTEXT,
      ),
      visibleSectionIds: ["general", "agent"],
    });

    expect(tiedResults[0]?.sectionId).toBe("general");
    expect(tiedResults[1]?.sectionId).toBe("agent");
  });

  test("a setting holding the whole query outranks a panel that only mentions each word", () => {
    const results = buildSettingsSearchResults({
      query: "sign in",
      targets: buildSettingsSearchTargets(
        [
          { id: "general", label: "Account", searchMessages: ["Sign in", "Sign out"] },
          {
            id: "agent",
            label: "Agents",
            searchMessages: ["Sign in", "Install agents", "Signature"],
          },
          { id: "keyboard", label: "Keyboard", searchMessages: ["Signature", "Install"] },
        ],
        SEARCH_CONTEXT,
      ),
      visibleSectionIds: ["general", "agent", "keyboard"],
    });

    expect(results.map((result) => [result.sectionId, result.label])).toEqual([
      ["general", "Sign in"],
      ["agent", "Sign in"],
      ["keyboard", "Keyboard"],
    ]);
  });

  test("markup-like messages fall back to the panel label", () => {
    const results = resultsFor("markup");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("markup");
    expect(results[0]?.label).toBe("Markup Panel");
  });

  test("dynamic terms can match sections without becoming visible labels", () => {
    const results = resultsFor("alpha");

    expect(results.length).toBe(1);
    expect(results[0]?.sectionId).toBe("local-environments");
    expect(results[0]?.label).toBe("Local environments");

    const mixedTermResults = buildSettingsSearchResults({
      query: "alpha command",
      targets: buildSettingsSearchTargets(
        [
          {
            id: "local-environments",
            label: "Local environments",
            searchMessages: ["Command runner"],
            searchTerms: ({ activeProjectName }) => (activeProjectName ? [activeProjectName] : []),
          },
        ],
        SEARCH_CONTEXT,
      ),
      visibleSectionIds: ["local-environments"],
    });

    expect(mixedTermResults.length).toBe(1);
    expect(mixedTermResults[0]?.label).toBe("Local environments");
  });

  test("baseline queries match expected settings", () => {
    expect(resultsFor("git")[0]?.sectionId).toBe("worktrees");
    expect(resultsFor("keyboard shortcuts")[0]?.sectionId).toBe("keyboard");
    expect(resultsFor("keep awake")[0]?.sectionId).toBe("general");
    expect(resultsFor("zzzzzz-unknown").length).toBe(0);
  });
});

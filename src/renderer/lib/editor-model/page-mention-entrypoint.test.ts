import { describe, expect, test } from "vite-plus/test";

import type { MentionSuggestionFamily, MentionSuggestionMatch } from "./mention-suggestion-model";
import {
  getNfmPageMentionEntryProfile,
  selectNfmPageMentionSections,
} from "./page-mention-entrypoint";

function candidate(
  value: string,
  family: MentionSuggestionFamily,
  match: MentionSuggestionMatch,
  sourceOrder: number,
) {
  return {
    value,
    rank: { family, match, sourceOrder, activeContext: false },
  } as const;
}

describe("NFM Page mention entry profiles", () => {
  test("owns the complete entry grammar", () => {
    expect(getNfmPageMentionEntryProfile("@")).toEqual({
      entry: "broad",
      trigger: "@",
      providers: ["page", "chat", "temporal", "create_page"],
      createPlacement: "after_broad_results",
      emptyQueryPopup: "show",
      temporaryInput: true,
    });
    expect(getNfmPageMentionEntryProfile("+")).toEqual({
      entry: "create_first",
      trigger: "+",
      providers: ["create_page", "page"],
      createPlacement: "before_page_results",
      emptyQueryPopup: "defer",
      temporaryInput: true,
    });
    expect(getNfmPageMentionEntryProfile("[[")).toEqual({
      entry: "wiki_link",
      trigger: "[[",
      providers: ["page", "create_page"],
      createPlacement: "after_page_results",
      emptyQueryPopup: "show",
      temporaryInput: true,
    });
  });

  test("keeps broad relevance sections ahead of Page creation", () => {
    const sections = selectNfmPageMentionSections({
      profile: getNfmPageMentionEntryProfile("@"),
      query: "today",
      rankedResults: [
        candidate("page", "page", "title", 0),
        candidate("chat", "chat", "exact_title", 0),
        candidate("today", "temporal", "temporal_intent", 0),
      ],
      createItems: ["create-current", "create-in"],
    });

    expect(sections.map(({ family }) => family)).toEqual([
      "temporal",
      "chat",
      "page",
      "create_page",
    ]);
    expect(sections.at(-1)).toEqual({
      family: "create_page",
      label: "New page",
      items: ["create-current", "create-in"],
      hiddenItemCount: 0,
    });
  });

  test("keeps create-first placement stable as Page results arrive", () => {
    const profile = getNfmPageMentionEntryProfile("+");
    const beforeResults = selectNfmPageMentionSections({
      profile,
      query: "roadmap",
      rankedResults: [],
      createItems: ["create-current", "create-in"],
    });
    const afterResults = selectNfmPageMentionSections({
      profile,
      query: "roadmap",
      rankedResults: [
        candidate("page-1", "page", "exact_title", 0),
        candidate("chat-must-not-leak", "chat", "exact_title", 0),
      ],
      createItems: ["create-current", "create-in"],
    });

    expect(beforeResults.map(({ family }) => family)).toEqual(["create_page"]);
    expect(afterResults.map(({ family }) => family)).toEqual(["create_page", "page"]);
    expect(afterResults[0]?.label).toBeNull();
  });

  test("keeps wiki-link Page results ahead of creation", () => {
    const sections = selectNfmPageMentionSections({
      profile: getNfmPageMentionEntryProfile("[["),
      query: "roadmap",
      rankedResults: [
        candidate("page-1", "page", "exact_title", 0),
        candidate("temporal-must-not-leak", "temporal", "temporal_intent", 0),
      ],
      createItems: ["create-current", "create-in"],
    });

    expect(sections.map(({ family }) => family)).toEqual(["page", "create_page"]);
    expect(sections.at(-1)?.label).toBeNull();
  });
});

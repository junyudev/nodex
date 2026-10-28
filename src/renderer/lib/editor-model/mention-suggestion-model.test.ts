import { describe, expect, test } from "vite-plus/test";

import {
  selectMentionSuggestionSections,
  type MentionSuggestionFamily,
  type MentionSuggestionMatch,
} from "./mention-suggestion-model";

function candidate(
  value: string,
  family: MentionSuggestionFamily,
  match: MentionSuggestionMatch,
  sourceOrder: number,
  activeContext = false,
) {
  return {
    value,
    rank: { family, match, sourceOrder, activeContext },
  } as const;
}

describe("mention suggestion model", () => {
  test("puts Date first for an empty query and keeps each section bounded", () => {
    const candidates = [
      ...Array.from({ length: 12 }, (_, index) =>
        candidate(`page-${index}`, "page", "recent", index),
      ),
      ...Array.from({ length: 8 }, (_, index) =>
        candidate(`chat-${index}`, "chat", "recent", index, true),
      ),
      candidate("today", "temporal", "temporal_intent", 0),
      candidate("now", "temporal", "temporal_intent", 1),
    ];

    const sections = selectMentionSuggestionSections({ query: "", candidates });

    expect(sections.map(({ label }) => label)).toEqual([
      "Date",
      "Mention a page",
      "Mention a chat",
    ]);
    expect(sections[0]).toMatchObject({
      items: ["today", "now"],
      hiddenItemCount: 0,
    });
    expect(sections[1]).toMatchObject({
      items: ["page-0", "page-1", "page-2", "page-3", "page-4"],
      hiddenItemCount: 7,
    });
    expect(sections[2]).toMatchObject({
      items: ["chat-0", "chat-1", "chat-2"],
      hiddenItemCount: 5,
    });
  });

  test("orders queried sections by their strongest result", () => {
    const sections = selectMentionSuggestionSections({
      query: "today",
      candidates: [
        candidate("page-content", "page", "content", 0),
        candidate("page-title", "page", "title", 1),
        candidate("chat-exact", "chat", "exact_title", 0, true),
        candidate("today", "temporal", "temporal_intent", 0),
      ],
    });

    expect(sections.map(({ label }) => label)).toEqual([
      "Date",
      "Mention a chat",
      "Mention a page",
    ]);
    expect(sections[2]?.items).toEqual(["page-content", "page-title"]);
  });

  test("reports hidden results instead of letting one section dominate", () => {
    const sections = selectMentionSuggestionSections({
      query: "projection",
      candidates: Array.from({ length: 20 }, (_, index) =>
        candidate(`page-${index}`, "page", "title", index),
      ),
    });

    expect(sections).toHaveLength(1);
    expect(sections[0]?.items).toHaveLength(5);
    expect(sections[0]?.hiddenItemCount).toBe(15);
  });

  test("expands only the requested section", () => {
    const candidates = [
      ...Array.from({ length: 7 }, (_, index) =>
        candidate(`page-${index}`, "page", "title", index),
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        candidate(`chat-${index}`, "chat", "title", index),
      ),
    ];

    const sections = selectMentionSuggestionSections({
      query: "result",
      candidates,
      expandedFamilies: new Set(["page"]),
    });

    expect(sections[0]).toMatchObject({
      family: "page",
      items: candidates.slice(0, 7).map(({ value }) => value),
      hiddenItemCount: 0,
    });
    expect(sections[1]).toMatchObject({
      family: "chat",
      items: ["chat-0", "chat-1", "chat-2", "chat-3"],
      hiddenItemCount: 2,
    });
  });

  test("preserves provider order and uses Page before Chat for a relevance tie", () => {
    const sections = selectMentionSuggestionSections({
      query: "weekly",
      candidates: [
        candidate("chat-later", "chat", "title", 8, true),
        candidate("page-first", "page", "title", 0, true),
        candidate("chat-first", "chat", "title", 0, true),
        candidate("page-later", "page", "title", 4, true),
      ],
    });

    expect(sections.map(({ family }) => family)).toEqual(["page", "chat"]);
    expect(sections[0]?.items).toEqual(["page-first", "page-later"]);
    expect(sections[1]?.items).toEqual(["chat-first", "chat-later"]);
  });
});

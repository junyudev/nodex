import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HistoryPanelEntry } from "../../../shared/ipc-api";

mock.module("@/lib/layout", () => ({
  TAB_BAR_HEIGHT: 48,
}));

mock.module("@/lib/kanban-options", () => ({
  KANBAN_STATUS_LABELS: {
    "1-ideas": "Ideas",
    "6-in-progress": "In progress",
  },
}));

mock.module("@/lib/utils", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
}));

mock.module("@/lib/api", () => ({
  invoke: async () => ({ entries: [] }),
}));

describe("history panel", () => {
  test("renders block-level description deltas in the details view", async () => {
    const { HistoryEntryDetails } = await import("./history-panel");
    const entry: HistoryPanelEntry = {
      id: 11,
      projectId: "default",
      operation: "update",
      cardId: "card-1",
      columnId: "1-ideas",
      timestamp: "2026-03-12T12:00:00.000Z",
      sessionId: null,
      groupId: null,
      isUndone: false,
      undoOf: null,
      summary: "Description + 1 field",
      fieldChanges: [
        {
          field: "tags",
          before: [],
          after: ["delta"],
        },
      ],
      move: null,
      descriptionChange: {
        beforeBlockCount: 2,
        afterBlockCount: 3,
        beforeFullText: "# Heading\n\nAlpha paragraph",
        afterFullText: "# Heading\n\nBeta paragraph\n\nGamma paragraph",
        blocks: [
          {
            changeType: "replaced",
            blockType: "paragraph",
            beforeOrdinal: 1,
            afterOrdinal: 1,
            beforePreview: "Alpha paragraph",
            afterPreview: "Beta paragraph",
            beforeNfm: "Alpha paragraph",
            afterNfm: "Beta paragraph",
          },
          {
            changeType: "added",
            blockType: "paragraph",
            beforeOrdinal: null,
            afterOrdinal: 2,
            beforePreview: null,
            afterPreview: "Gamma paragraph",
            beforeNfm: null,
            afterNfm: "Gamma paragraph",
          },
        ],
      },
      snapshot: null,
    };

    const markup = renderToStaticMarkup(
      createElement(HistoryEntryDetails, {
        entry,
        selectedIndex: 0,
        totalCount: 1,
        onNavigate: () => undefined,
        onRevert: () => undefined,
        onRestore: () => undefined,
        actionInFlight: null,
        confirmingAction: null,
        onRequestConfirm: () => undefined,
        onCancelConfirm: () => undefined,
        actionError: null,
      }),
    );

    expect(markup.includes("Description delta")).toBe(true);
    expect(markup.includes("Alpha paragraph")).toBe(true);
    expect(markup.includes("Gamma paragraph")).toBe(true);
    expect(markup.includes("Show block source")).toBe(true);
    expect(markup.includes("Show full description before/after")).toBe(true);
    expect(markup.includes("Tags")).toBe(true);
  });
});

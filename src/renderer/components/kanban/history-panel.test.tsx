import { describe, expect, mock, test } from "bun:test";
import * as DiffReact from "@pierre/diffs/react";
import { createElement } from "react";
import * as KanbanOptions from "@/lib/kanban-options";
import type { HistoryPanelEntry } from "../../../shared/ipc-api";
import { render, textContent } from "../../test/dom";

mock.module("@/lib/layout", () => ({
  TAB_BAR_HEIGHT: 48,
}));

mock.module("@/lib/kanban-options", () => ({
  ...KanbanOptions,
  ARCHIVED_CARD_OPTION_ID: "archived",
  ARCHIVED_CARD_OPTION_NAME: "Archived",
  EMPTY_PRIORITY_OPTION_VALUE: "none",
  KANBAN_STATUS_OPTIONS: [
    { id: "draft", name: "Draft" },
    { id: "in_progress", name: "In progress" },
  ],
  KANBAN_STATUS_LABELS: {
    draft: "Draft",
    in_progress: "In progress",
  },
}));

mock.module("@/lib/api", () => ({
  invoke: async () => ({ entries: [] }),
  subscribeGitBranchChanges: () => () => undefined,
}));

mock.module("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "light" as const }),
}));

mock.module("@pierre/diffs/react", () => ({
  ...DiffReact,
  FileDiff: ({ className }: { className?: string }) => createElement("div", { className, "data-file-diff": "true" }),
  MultiFileDiff: ({
    oldFile,
    newFile,
    className,
  }: {
    oldFile: { contents: string };
    newFile: { contents: string };
    className?: string;
  }) => createElement("div", { className, "data-diff": "true" }, `${oldFile.contents} => ${newFile.contents}`),
  PatchDiff: ({ className }: { className?: string }) => createElement("div", { className, "data-patch-diff": "true" }),
}));

describe("history panel", () => {
  test("renders block-level description deltas in the details view", async () => {
    const { HistoryEntryDetails } = await import("./history-panel");
    const entry: HistoryPanelEntry = {
      id: 11,
      projectId: "default",
      operation: "update",
      cardId: "card-1",
      status: "draft",
      archived: false,
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

    const { container, getByText } = render(
      <HistoryEntryDetails
        entry={entry}
        selectedIndex={0}
        totalCount={1}
        onNavigate={() => undefined}
        onRevert={() => undefined}
        onRestore={() => undefined}
        actionInFlight={null}
        confirmingAction={null}
        onRequestConfirm={() => undefined}
        onCancelConfirm={() => undefined}
        actionError={null}
      />,
    );

    expect(getByText("Description").textContent).toBe("Description");
    expect(textContent(container).includes("Alpha paragraph")).toBeTrue();
    expect(textContent(container).includes("Gamma paragraph")).toBeTrue();
    expect(container.querySelectorAll("summary").length > 0).toBeTrue();
    expect(getByText("Full description diff").textContent).toBe("Full description diff");
    expect(getByText("Tags").textContent).toBe("Tags");
  });

  test("renders the shared diff viewer when the full description diff is expanded", async () => {
    const { DescriptionFullDiffDisclosure } = await import("./history-panel");

    const { container } = render(
      <DescriptionFullDiffDisclosure
        beforeText="Alpha paragraph"
        afterText="Beta paragraph"
        defaultOpen
      />,
    );

    expect(container.querySelector('[data-diff="true"]')).not.toBeNull();
    expect(textContent(container).includes("Alpha paragraph => Beta paragraph")).toBeTrue();
    expect(container.innerHTML.includes("nodex-inline-diff")).toBeTrue();
  });
});

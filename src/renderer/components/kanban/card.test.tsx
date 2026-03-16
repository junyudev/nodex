import { describe, expect, mock, test } from "bun:test";
import * as DndKitSortable from "@dnd-kit/sortable";
import * as DndKitUtilities from "@dnd-kit/utilities";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resetCardDraftStoreForTest, setCardDraftOverlay } from "../../lib/card-draft-store";
import type { CardPropertyPosition } from "@/lib/card-property-position";

let lastUseSortableInput: Record<string, unknown> | null = null;

mock.module("@dnd-kit/sortable", () => ({
  ...DndKitSortable,
  useSortable: (input: Record<string, unknown>) => {
    lastUseSortableInput = input;
    return {
      attributes: {},
      listeners: {},
      setNodeRef: () => undefined,
      transform: null,
      transition: undefined,
      isDragging: false,
    };
  },
}));

mock.module("@dnd-kit/utilities", () => ({
  ...DndKitUtilities,
  CSS: {
    Transform: {
      toString: () => undefined,
    },
  },
}));

let mockCardPropertyPosition: CardPropertyPosition = "inline";

mock.module("@/lib/use-card-property-position", () => ({
  useCardPropertyPosition: () => ({ position: mockCardPropertyPosition }),
}));

mock.module("@/lib/terminal-sessions", () => ({
  useActiveTerminals: () => new Set<string>(),
}));

mock.module("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "light" as const }),
}));

mock.module("@/lib/nfm/extract-text", () => ({
  extractPlainText: (value: string) => value,
}));

mock.module("./editor/chip-property-editor", () => ({
  ChipPropertyEditor: () => null,
}));

mock.module("./card-context-menu", () => ({
  CardContextMenu: ({ children }: { children: unknown }) => children,
}));

describe("kanban card", () => {
  test("renders live draft overlay content for the matching project card", async () => {
    resetCardDraftStoreForTest();
    setCardDraftOverlay("default", "card-1", { description: "Draft body" });
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        projectId: "default",
        card: {
          id: "card-1",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Persisted body",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
      }),
    );

    expect(markup.includes("Draft body")).toBe(true);
  });

  test("keeps live draft overlays out of the interactive card shell", async () => {
    resetCardDraftStoreForTest();
    lastUseSortableInput = null;
    setCardDraftOverlay("default", "card-1", { description: "Draft body" });
    const { Card } = await import("./card");

    renderToStaticMarkup(
      createElement(Card, {
        projectId: "default",
        card: {
          id: "card-1",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Persisted body",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
      }),
    );

    const sortableData = (lastUseSortableInput as { data?: { card?: { description?: string } } } | null)?.data;
    expect(sortableData?.card?.description).toBe("Persisted body");
  });

  test("suppresses browser text selection on the card surface", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-1",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Body",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
      }),
    );

    expect(markup.includes("select-none")).toBe(true);
  });

  test("renders property chips as buttons when inline editing is enabled", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-2",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Body",
          priority: "p2-medium",
          estimate: "m",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
        onUpdateProperty: () => undefined,
      }),
    );

    expect(markup.includes('aria-label="Edit priority"')).toBe(true);
    expect(markup.includes('aria-label="Edit estimate"')).toBe(true);
  });

  test("renders property chips inline inside the title when inline layout is selected", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-inline",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Body",
          priority: "p2-medium",
          estimate: "m",
          tags: ["UI"],
          assignee: "alex",
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
        onUpdateProperty: () => undefined,
      }),
    );

    const headingStart = markup.indexOf("<h3");
    const headingEnd = markup.indexOf("</h3>");
    const headingMarkup = markup.slice(headingStart, headingEnd);
    const priorityIndex = headingMarkup.indexOf('aria-label="Edit priority"');
    const titleIndex = headingMarkup.indexOf("Task");

    expect(headingMarkup.includes('aria-label="Edit priority"')).toBe(true);
    expect(headingMarkup.includes('aria-label="Edit estimate"')).toBe(true);
    expect(headingMarkup.includes("@alex")).toBe(true);
    expect(priorityIndex < titleIndex).toBe(true);
  });

  test("respects kanban display prefs for property order and visibility", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-display",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "Body",
          priority: "p2-medium",
          estimate: "m",
          tags: ["UI"],
          assignee: "alex",
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        displayPrefs: {
          propertyOrder: ["assignee", "tags", "estimate", "priority"],
          hiddenProperties: ["priority"],
          showEmptyEstimate: false,
          showEmptyPriority: false,
        },
        onClick: () => undefined,
        onUpdateProperty: () => undefined,
      }),
    );

    const headingStart = markup.indexOf("<h3");
    const headingEnd = markup.indexOf("</h3>");
    const headingMarkup = markup.slice(headingStart, headingEnd);
    const assigneeIndex = headingMarkup.indexOf("@alex");
    const tagIndex = headingMarkup.indexOf("UI");

    expect(headingMarkup.includes("@alex")).toBe(true);
    expect(headingMarkup.includes("UI")).toBe(true);
    expect(headingMarkup.includes('aria-label="Edit estimate"')).toBe(true);
    expect(headingMarkup.includes('aria-label="Edit priority"')).toBe(false);
    expect(assigneeIndex < tagIndex).toBe(true);
  });

  test("shows editable empty kanban priority and estimate placeholders when display prefs enable them", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-empty-display",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        displayPrefs: {
          propertyOrder: ["priority", "estimate", "tags", "assignee"],
          hiddenProperties: [],
          showEmptyEstimate: true,
          showEmptyPriority: true,
        },
        onClick: () => undefined,
        onUpdateProperty: () => undefined,
      }),
    );

    expect((markup.match(/>-\<\/button>/g) ?? []).length).toBe(2);
    expect(markup.includes('aria-label="Edit priority"')).toBe(true);
    expect(markup.includes('aria-label="Edit estimate"')).toBe(true);
  });

  test("marks the card surface as a context-menu trigger when card actions are enabled", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-3",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "",
          priority: "p2-medium",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
        contextMenu: {
          currentColumnId: "in_progress",
          currentProjectId: "default",
          currentProjectName: "Default",
          projects: [
            { id: "default", name: "Default" },
            { id: "ops", name: "Ops" },
          ],
          onMoveToProject: () => undefined,
          onDelete: () => undefined,
          onCopyLink: () => undefined,
        },
      }),
    );

    expect(markup.includes('data-card-context-menu-trigger="true"')).toBe(true);
  });

  test("omits the priority chip when the card has no priority", async () => {
    mockCardPropertyPosition = "inline";
    const { Card } = await import("./card");

    const markup = renderToStaticMarkup(
      createElement(Card, {
        card: {
          id: "card-no-priority",
          status: "in_progress",
          archived: false,
          title: "Task",
          description: "",
          tags: [],
          agentBlocked: false,
          created: new Date("2026-03-01T00:00:00.000Z"),
          order: 0,
        },
        columnId: "in_progress",
        onClick: () => undefined,
        onUpdateProperty: () => undefined,
      }),
    );

    expect(markup.includes('aria-label="Edit priority"')).toBe(false);
  });
});

import { describe, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CardPropertyPosition } from "@/lib/card-property-position";

mock.module("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

mock.module("@dnd-kit/utilities", () => ({
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

mock.module("@/lib/types", () => ({
  estimateStyles: {
    xs: { label: "XS", className: "estimate-xs" },
    s: { label: "S", className: "estimate-s" },
    m: { label: "M", className: "estimate-m" },
    l: { label: "L", className: "estimate-l" },
    xl: { label: "XL", className: "estimate-xl" },
  },
}));

mock.module("@/lib/terminal-sessions", () => ({
  useActiveTerminals: () => new Set<string>(),
}));

mock.module("@/lib/use-theme", () => ({
  useTheme: () => ({ resolved: "light" as const }),
}));

mock.module("@/lib/utils", () => ({
  cn: (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" "),
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

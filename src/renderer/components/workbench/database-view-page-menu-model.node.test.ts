import { describe, expect, test } from "vite-plus/test";

import {
  buildDatabaseViewPageMenuEntries,
  databaseViewPageReorderDirection,
  filterDatabaseViewPageMenuEntries,
} from "./database-view-page-menu-model";

const capabilities = {
  hasPageKey: true,
  canMoveUp: false,
  canMoveDown: true,
  showReorder: true,
  canCopyMarkdown: true,
  canOpenInNewChat: true,
  canSendToChat: true,
  canDelete: true,
};

describe("Database View Page menu model", () => {
  test("builds the shared Page hierarchy in product order", () => {
    const actions = buildDatabaseViewPageMenuEntries(capabilities);

    expect(actions.map((action) => action.label)).toEqual([
      "Open in",
      "Copy",
      "Move to",
      "Reorder",
      "Delete",
    ]);
    expect(
      actions
        .find((action) => action.id === "reorder")
        ?.children?.map((action) => [action.label, action.disabled]),
    ).toEqual([
      ["Reorder to top", true],
      ["Reorder up", true],
      ["Reorder down", false],
      ["Reorder to bottom", false],
    ]);
    expect(
      actions.find((action) => action.id === "copy")?.children?.map((action) => action.label),
    ).toEqual(["Copy ID", "Copy deeplink", "Copy title", "Copy content as Markdown"]);
    expect(
      actions.find((action) => action.id === "open-in")?.children?.map((action) => action.label),
    ).toEqual(["Open in new chat", "Send to chat…"]);
  });

  test("hides rank controls when the startup capability is disabled", () => {
    const actions = buildDatabaseViewPageMenuEntries({ ...capabilities, showReorder: false });

    expect(actions.map((action) => action.id)).toEqual(["open-in", "copy", "move-to", "delete"]);
  });

  test("does not invent an ID when a Page has no current key", () => {
    const actions = buildDatabaseViewPageMenuEntries({
      ...capabilities,
      hasPageKey: false,
    });

    expect(
      actions
        .find((action) => action.id === "copy")
        ?.children?.some((action) => action.id === "copy-id"),
    ).toBe(false);
  });

  test("keeps a parent trigger and only matching descendants during search", () => {
    const actions = filterDatabaseViewPageMenuEntries(
      buildDatabaseViewPageMenuEntries(capabilities),
      "markdown",
    );

    expect(actions).toHaveLength(1);
    expect(actions[0]?.id).toBe("copy");
    expect(actions[0]?.children?.map((action) => action.id)).toEqual(["copy-markdown"]);
  });

  test("matching a parent keeps its complete submenu", () => {
    const actions = filterDatabaseViewPageMenuEntries(
      buildDatabaseViewPageMenuEntries(capabilities),
      "reorder",
    );

    expect(actions.map((action) => action.id)).toEqual(["reorder"]);
    expect(actions[0]?.children).toHaveLength(4);
    expect(databaseViewPageReorderDirection("reorder-bottom")).toBe("bottom");
    expect(databaseViewPageReorderDirection("copy-title")).toBeNull();
  });
});

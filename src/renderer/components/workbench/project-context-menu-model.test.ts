import { describe, expect, test } from "vite-plus/test";

import {
  PROJECT_CONTEXT_MENU_ACTION_IDS,
  buildProjectContextMenuItems,
  projectMoveToSectionActionId,
  readProjectMoveToSectionActionId,
} from "./project-context-menu-model";

function flattenIds(items: ReturnType<typeof buildProjectContextMenuItems>): string[] {
  return items.flatMap((item) => {
    if (item.type === "separator") return ["separator"];
    if (item.type === "submenu") return [item.id, ...flattenIds(item.submenu)];
    return [item.id];
  });
}

describe("project context menu model", () => {
  test("matches the native Project action groups and labels", () => {
    const sectionAction = projectMoveToSectionActionId("section-1");
    const items = buildProjectContextMenuItems({
      pinned: false,
      showPinAction: true,
      sectionItems: [{ id: sectionAction, label: "✓ Planning" }],
      revealLabel: "Reveal in Finder",
      canCreateStableWorktree: true,
      canMarkAllRead: false,
      canArchiveChats: true,
    });

    expect(flattenIds(items)).toEqual([
      PROJECT_CONTEXT_MENU_ACTION_IDS.togglePin,
      PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
      "separator",
      "project.section",
      sectionAction,
      PROJECT_CONTEXT_MENU_ACTION_IDS.reveal,
      PROJECT_CONTEXT_MENU_ACTION_IDS.createStableWorktree,
      "separator",
      PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
      "separator",
      PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
    ]);
    expect(readProjectMoveToSectionActionId(sectionAction)).toBe("section-1");
  });

  test("keeps unavailable archive visible and omits unsupported optional rows", () => {
    const items = buildProjectContextMenuItems({
      pinned: true,
      showPinAction: false,
      canCreateStableWorktree: false,
      canMarkAllRead: true,
      canArchiveChats: false,
    });
    const archive = items.find(
      (item) =>
        item.type !== "separator" && item.id === PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
    );

    expect(flattenIds(items)).toEqual([
      PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
      "separator",
      PROJECT_CONTEXT_MENU_ACTION_IDS.markAllRead,
      PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
      "separator",
      PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
    ]);
    expect(archive?.type === "separator" ? null : archive?.enabled).toBe(false);
  });
});

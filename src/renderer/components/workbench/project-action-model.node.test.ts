import { describe, expect, test, it } from "vite-plus/test";
import {
  PROJECT_CONTEXT_MENU_ACTION_IDS,
  buildProjectContextMenuItems,
  projectMoveToSectionActionId,
  readProjectMoveToSectionActionId,
} from "./project-context-menu-model";
import {
  buildProjectHoverCardMetadataRows,
  formatProjectActivitySummary,
} from "./project-hover-card-model";

describe("project context menu model", () => {
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
        PROJECT_CONTEXT_MENU_ACTION_IDS.reveal,
        "separator",
        PROJECT_CONTEXT_MENU_ACTION_IDS.togglePause,
        PROJECT_CONTEXT_MENU_ACTION_IDS.togglePin,
        PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
        "project.section",
        sectionAction,
        PROJECT_CONTEXT_MENU_ACTION_IDS.createStableWorktree,
        "separator",
        PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
        "separator",
        PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
      ]);
      expect(readProjectMoveToSectionActionId(sectionAction)).toBe("section-1");
    });

    test("omits unavailable archive and unsupported optional rows", () => {
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
        PROJECT_CONTEXT_MENU_ACTION_IDS.togglePause,
        PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
        "separator",
        PROJECT_CONTEXT_MENU_ACTION_IDS.markAllRead,
        "separator",
        PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
      ]);
      expect(archive).toBeUndefined();
    });
  });
});

describe("project hover card model", () => {
  it("formats total and nonzero attention counts in stable precedence order", () => {
    expect(
      formatProjectActivitySummary({
        projectId: "project-1",
        taskCount: 66,
        waitingCount: 2,
        unreadCount: 3,
        activeCount: 1,
      }),
    ).toBe("66 tasks · 2 waiting · 3 unread · 1 active");
    expect(
      formatProjectActivitySummary({
        projectId: "project-1",
        taskCount: 1,
        waitingCount: 0,
        unreadCount: 0,
        activeCount: 0,
      }),
    ).toBe("1 task");
  });

  it("does not present unknown activity as an exact zero", () => {
    expect(formatProjectActivitySummary(undefined)).toBe("Loading task activity…");
    expect(formatProjectActivitySummary(null)).toBe("Task activity unavailable");
  });

  it("keeps repository identity informational and source paths actionable", () => {
    expect(
      buildProjectHoverCardMetadataRows({
        projectName: "nodex",
        repositoryIdentity: {
          repositoryRoot: "/Users/asc/repo/nodex",
          ownerRepo: { owner: "acme", repo: "nodex" },
        },
        sources: [
          { kind: "directory" as const, path: "/Users/asc/repo/nodex", order: 0 },
          { kind: "directory" as const, path: "/Users/asc/repo/docs", order: 1 },
          { kind: "directory" as const, path: "/Users/asc/repo/nodex", order: 2 },
        ],
        pathContext: { homeDirectory: "/Users/asc", separator: "/" },
      }),
    ).toEqual([
      { kind: "repository", label: "acme/nodex", path: null },
      { kind: "source", label: "~/repo/nodex", path: "/Users/asc/repo/nodex" },
      { kind: "source", label: "~/repo/docs", path: "/Users/asc/repo/docs" },
    ]);
  });

  it("falls back to the repository folder and raw paths", () => {
    expect(
      buildProjectHoverCardMetadataRows({
        projectName: "nested",
        repositoryIdentity: {
          repositoryRoot: "C:\\work\\nested",
          ownerRepo: null,
        },
        sources: [{ kind: "directory" as const, path: "C:\\work\\nested", order: 0 }],
        pathContext: null,
      }),
    ).toEqual([{ kind: "source", label: "C:\\work\\nested", path: "C:\\work\\nested" }]);
  });
});

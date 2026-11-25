import { describe, expect, test } from "vite-plus/test";
import { resolveSidebarLibraryDropDecision } from "./sidebar-library-dnd";
import {
  moveSidebarGroupBefore,
  replaceVisibleOrder,
  resolveSidebarGroupDropTarget,
} from "./sidebar-project-group-dnd";
import type { SidebarSectionItem } from "../../../shared/sidebar-sections";
import {
  isSidebarSectionSessionDragDisabled,
  resolveSidebarSectionItemPlacement,
  sidebarSectionItemRef,
} from "./sidebar-section-item-dnd";
import {
  getSidebarSectionRootDndId,
  parseSidebarSectionRootDndId,
  readSidebarSectionRootDndPayload,
} from "./sidebar-section-root-dnd";

describe("sidebar library dnd", () => {
  const resource = {
    kind: "sidebar-library-resource",
    target: { kind: "page", pageId: "page-1" },
    title: "Research",
    expectedLocationRevision: 3,
    dragOverlay: null,
  } as const;

  describe("Sidebar Library drop semantics", () => {
    test("moves resources to their ownership targets", () => {
      expect(
        resolveSidebarLibraryDropDecision(resource, {
          kind: "sidebar-library-ownership-target",
          parent: { kind: "library" },
        }),
      ).toMatchObject({ kind: "move", parent: { kind: "library" } });

      expect(resolveSidebarLibraryDropDecision(resource, undefined)).toMatchObject({
        kind: "reject",
      });
    });

    test("rejects self-parenting and unrelated targets", () => {
      expect(
        resolveSidebarLibraryDropDecision(
          resource,
          {
            kind: "sidebar-library-ownership-target",
            parent: {
              kind: "page",
              pageId: "page-1",
              expectedDocumentGeneration: 1,
              expectedDocumentHeadSeq: 2,
            },
          },
          true,
        ),
      ).toEqual({ kind: "reject" });
      expect(resolveSidebarLibraryDropDecision(undefined, undefined)).toEqual({
        kind: "reject",
      });
    });
  });
});

describe("sidebar project group dnd", () => {
  const SOURCE_RECT = { top: 60, bottom: 90 };
  const TARGET_RECT = { top: 0, bottom: 30 };

  describe("project group insertion targeting", () => {
    test("places the insertion target before the hovered row above its midpoint", () => {
      const target = resolveSidebarGroupDropTarget({
        groupIds: ["alpha", "beta", "gamma"],
        activeGroupId: "gamma",
        overGroupId: "alpha",
        activeRect: SOURCE_RECT,
        overRect: TARGET_RECT,
        pointerY: 4,
      });

      expect(target?.beforeGroupId).toBe("alpha");
      expect(
        JSON.stringify(
          moveSidebarGroupBefore(
            ["alpha", "beta", "gamma"],
            "gamma",
            target?.beforeGroupId ?? null,
          ),
        ),
      ).toBe(JSON.stringify(["gamma", "alpha", "beta"]));
    });

    test("places the insertion target after the hovered row below its midpoint", () => {
      const target = resolveSidebarGroupDropTarget({
        groupIds: ["alpha", "beta", "gamma"],
        activeGroupId: "gamma",
        overGroupId: "alpha",
        activeRect: SOURCE_RECT,
        overRect: TARGET_RECT,
        pointerY: 26,
      });

      expect(target?.beforeGroupId).toBe("beta");
    });

    test("uses the translated active midpoint for keyboard sorting", () => {
      const target = resolveSidebarGroupDropTarget({
        groupIds: ["alpha", "beta", "gamma"],
        activeGroupId: "gamma",
        overGroupId: "alpha",
        activeRect: { top: 2, bottom: 28 },
        overRect: TARGET_RECT,
        pointerY: null,
      });

      expect(target?.beforeGroupId).toBe("beta");
    });

    test("suppresses an indicator and write when the resolved order is unchanged", () => {
      const target = resolveSidebarGroupDropTarget({
        groupIds: ["alpha", "beta", "gamma"],
        activeGroupId: "gamma",
        overGroupId: "beta",
        activeRect: SOURCE_RECT,
        overRect: { top: 30, bottom: 60 },
        pointerY: 58,
      });

      expect(target).toBe(null);
    });
  });

  describe("replaceVisibleOrder", () => {
    test("replaces only visible project ids inside the full order", () => {
      const result = replaceVisibleOrder(
        ["pinned-a", "alpha", "pinned-b", "beta", "gamma"],
        ["alpha", "beta"],
        ["beta", "alpha"],
      );

      expect(JSON.stringify(result)).toBe(
        JSON.stringify(["pinned-a", "beta", "pinned-b", "alpha", "gamma"]),
      );
    });

    test("keeps the current order when the visible id set changes", () => {
      const current = ["alpha", "beta", "gamma"];
      const result = replaceVisibleOrder(current, ["alpha", "beta"], ["beta", "delta"]);

      expect(JSON.stringify(result)).toBe(JSON.stringify(current));
    });
  });
});

describe("sidebar section item dnd", () => {
  const projectItem = {
    placementId: "placement-project",
    rankKey: 1,
    revision: 1,
    kind: "project",
    project: {
      projectId: "project-alpha",
      name: "Alpha",
      lifecycle: "active",
      appearance: { color: "blue", marker: { kind: "icon", icon: "folder" } },
      pinned: false,
    },
  } satisfies SidebarSectionItem;

  const sessionItem = {
    placementId: "placement-session",
    rankKey: 2,
    revision: 1,
    kind: "session",
    session: {
      id: "session-alpha",
      projectId: null,
      noThreadFallbackTitle: "Alpha chat",
      displayTitle: "Alpha chat",
      activityAt: Date.parse("2026-08-31T00:00:00.000Z"),
      managed: false,
      pinned: false,
      pinnedOrder: null,
      archived: false,
      archivedAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      wokeAt: null,
      pageTurn: null,
      canManage: true,
      canStop: true,
      unread: false,
      thread: null,
      createdAt: "2026-08-31T00:00:00.000Z",
      updatedAt: "2026-08-31T00:00:00.000Z",
    },
  } satisfies SidebarSectionItem;

  describe("sidebar Section item DnD placement", () => {
    test("uses the exact mixed Project or Chat placement as the insertion anchor", () => {
      expect(
        resolveSidebarSectionItemPlacement([projectItem, sessionItem], "placement-project"),
      ).toEqual({ kind: "before", item: { kind: "project", projectId: "project-alpha" } });
      expect(
        resolveSidebarSectionItemPlacement([projectItem, sessionItem], "placement-session"),
      ).toEqual({ kind: "before", item: { kind: "session", sessionId: "session-alpha" } });
    });

    test("starts at the first mixed item for a container drop and preserves explicit end boundaries", () => {
      expect(resolveSidebarSectionItemPlacement([projectItem, sessionItem], undefined)).toEqual({
        kind: "before",
        item: { kind: "project", projectId: "project-alpha" },
      });
      expect(resolveSidebarSectionItemPlacement([], undefined)).toEqual({ kind: "end" });
      expect(resolveSidebarSectionItemPlacement([projectItem], null)).toEqual({ kind: "end" });
      expect(resolveSidebarSectionItemPlacement([projectItem], "missing")).toEqual({ kind: "end" });
    });

    test("converts both item kinds to the Core identity contract", () => {
      expect(sidebarSectionItemRef(projectItem)).toEqual({
        kind: "project",
        projectId: "project-alpha",
      });
      expect(sidebarSectionItemRef(sessionItem)).toEqual({
        kind: "session",
        sessionId: "session-alpha",
      });
    });

    test("keeps a direct threadless Session available as a mixed-list insertion boundary", () => {
      expect(
        isSidebarSectionSessionDragDisabled({
          placementId: "placement-session",
          threadId: null,
        }),
      ).toBe(false);
      expect(isSidebarSectionSessionDragDisabled({ threadId: null })).toBe(true);
    });
  });
});

describe("sidebar Section root DnD identity", () => {
  test("round-trips Section ids without colliding with project ids", () => {
    const id = getSidebarSectionRootDndId("section-alpha");

    expect(parseSidebarSectionRootDndId(id)).toBe("section-alpha");
    expect(parseSidebarSectionRootDndId("sidebar-group:section-alpha")).toBe(null);
  });

  test("accepts only the Section root payload kind", () => {
    const controller = { handleDragEnd: () => undefined };
    const payload = {
      kind: "sidebar-section-root" as const,
      controller,
      dragOverlay: null,
      sectionId: "section-alpha",
    };

    expect(readSidebarSectionRootDndPayload(payload)).toBe(payload);
    expect(readSidebarSectionRootDndPayload({ ...payload, kind: "sidebar-group" })).toBe(null);
  });
});

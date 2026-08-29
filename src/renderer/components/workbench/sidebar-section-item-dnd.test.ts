import { describe, expect, test } from "vite-plus/test";
import type { SidebarSectionItem } from "../../../shared/sidebar-sections";
import {
  isSidebarSectionSessionDragDisabled,
  resolveSidebarSectionItemPlacement,
  sidebarSectionItemRef,
} from "./sidebar-section-item-dnd";

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
    sessionId: "session-alpha",
    projectId: null,
    displayTitle: "Alpha chat",
    pinned: false,
    archived: false,
    unread: false,
    threadId: "thread-alpha",
    status: null,
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

  test("falls back to the end when the target is the container or a stale placement", () => {
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

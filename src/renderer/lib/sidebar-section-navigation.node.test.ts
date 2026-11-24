import { describe, expect, it } from "vitest";
import type { SidebarSectionItem } from "../../shared/sidebar-sections";
import type { ProjectSessionSummary } from "../../shared/types";
import { sidebarSectionChatIds } from "./sidebar-section-navigation";

function chat(
  id: string,
  projectId: string | null,
  settledAt: number | null = null,
): SidebarSectionItem {
  return {
    placementId: `placement:${id}`,
    rankKey: 0,
    revision: 1,
    kind: "session",
    session: { id, projectId, settledAt } as ProjectSessionSummary,
  };
}

function project(projectId: string): SidebarSectionItem {
  return {
    placementId: `placement:${projectId}`,
    rankKey: 0,
    revision: 1,
    kind: "project",
    project: {
      projectId,
      name: projectId,
      lifecycle: "active",
      appearance: {} as never,
      pinned: false,
    },
  };
}

describe("sidebarSectionChatIds", () => {
  const itemsBySectionId = new Map<string, readonly SidebarSectionItem[]>([
    ["release", [chat("rollback", "core"), chat("shipped", "nodex", 5), project("web")]],
    ["later", [chat("notes", null)]],
  ]);
  const base = {
    sectionIds: ["release", "later"],
    itemsBySectionId,
    collapsed: () => false,
    projectChatIds: (projectId: string) => (projectId === "web" ? ["web-a", "web-b"] : []),
  };

  it("walks each Section's open chats in order, with a placed Project's chats beneath it", () => {
    // A chat waiting on the reader inside a Section is reachable where it sits.
    expect(sidebarSectionChatIds(base)).toEqual(["rollback", "web-a", "web-b", "notes"]);
  });

  it("skips a folded Section", () => {
    expect(
      sidebarSectionChatIds({ ...base, collapsed: (sectionId) => sectionId === "later" }),
    ).toEqual(["rollback", "web-a", "web-b"]);
  });
});

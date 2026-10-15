import { describe, expect, test } from "vite-plus/test";

import { resolveSidebarLibraryDropDecision } from "./sidebar-library-dnd";

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

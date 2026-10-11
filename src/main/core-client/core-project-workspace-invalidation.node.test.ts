import { describe, expect, test } from "vite-plus/test";
import {
  allProjectSessionInvalidation,
  planCoreWorkspaceNotifications,
} from "./core-project-workspace-invalidation";

describe("Core Workspace notification planning", () => {
  test("preserves every old and new Session scope across a move", () => {
    const plan = planCoreWorkspaceNotifications({
      inboxChanged: false,
      projectIds: ["project:a", "project:b"],
      sessionIds: ["session:one"],
      threadIds: ["thread:one"],
      sessionSummaryScopes: [
        { kind: "project", projectId: "project:a" },
        { kind: "project", projectId: "project:b" },
      ],
      sessionDetailIds: ["session:one"],
    });
    expect(plan.sessions).toEqual({
      summaryScopes: [
        { kind: "project", projectId: "project:a" },
        { kind: "project", projectId: "project:b" },
      ],
      detailInvalidation: {
        kind: "sessions",
        sessionIds: ["session:one"],
      },
      changeType: "update",
    });
    expect(plan.invalidateStandaloneRoots).toBe(false);
  });

  test("maps catalog semantics without collapsing them to a generic update", () => {
    const plan = planCoreWorkspaceNotifications({
      projectCatalogChange: "sources_updated",
      inboxChanged: false,
      projectIds: ["project:a"],
      sessionIds: [],
      threadIds: [],
      sessionSummaryScopes: [],
      sessionDetailIds: [],
    });
    expect(plan.project).toEqual({
      projectId: "project:a",
      changeType: "sources",
    });
    expect(plan.invalidateStandaloneRoots).toBe(false);
  });

  test.each(["created", "lifecycle_updated"] as const)(
    "invalidates standalone roots for %s Project catalog changes",
    (projectCatalogChange) => {
      const plan = planCoreWorkspaceNotifications({
        projectCatalogChange,
        inboxChanged: false,
        projectIds: ["project:a"],
        sessionIds: [],
        threadIds: [],
        sessionSummaryScopes: [],
        sessionDetailIds: [],
      });

      expect(plan.invalidateStandaloneRoots).toBe(true);
    },
  );

  test("uses a global summary scope when durable history must be resynced", () => {
    expect(allProjectSessionInvalidation()).toEqual({
      summaryScopes: [{ kind: "all" }],
      detailInvalidation: { kind: "all" },
      changeType: "update",
    });
  });
});

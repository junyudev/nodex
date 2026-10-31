import { describe, expect, it } from "vite-plus/test";
import {
  buildProjectHoverCardMetadataRows,
  formatProjectActivitySummary,
} from "./project-hover-card-model";

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
          { root: "/Users/asc/repo/nodex", order: 0 },
          { root: "/Users/asc/repo/docs", order: 1 },
          { root: "/Users/asc/repo/nodex", order: 2 },
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
        sources: [{ root: "C:\\work\\nested", order: 0 }],
        pathContext: null,
      }),
    ).toEqual([{ kind: "source", label: "C:\\work\\nested", path: "C:\\work\\nested" }]);
  });
});

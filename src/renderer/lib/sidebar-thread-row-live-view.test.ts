import { describe, expect, test } from "vite-plus/test";
import type { CodexSidebarThreadItem } from "../../shared/types";
import { projectSidebarThreadRowLiveView } from "./sidebar-thread-row-live-view";

const item: CodexSidebarThreadItem = {
  key: "local:session:session-1",
  kind: "local",
  backendBinding: { kind: "codex" },
  runLocation: { kind: "local-checkout" },
  hostId: "local",
  threadId: "session-1",
  parentThreadId: null,
  sessionId: "session-1",
  projectId: "project-1",
  title: "Delegate review",
  preview: "",
  cwd: null,
  updatedAt: 1,
  createdAt: 1,
  pinned: false,
  pinnedOrder: null,
  unread: false,
  archived: false,
  statusType: "notLoaded",
  statusActiveFlags: [],
  projectless: false,
  disabled: false,
};

describe("projectSidebarThreadRowLiveView", () => {
  test("keeps native rows on their Core thread status", () => {
    expect(projectSidebarThreadRowLiveView({ ...item, statusType: "active" }, null)).toEqual({
      item: { ...item, statusType: "active" },
      running: true,
      background: false,
      needsAttention: false,
      status: "running",
    });
  });

  test("shows Runtime running, waiting and background states from Session activity", () => {
    const states = (["running", "waiting", "background", null] as const).map((indicator) => {
      const view = projectSidebarThreadRowLiveView(item, { indicator, location: null });
      return [view.running, view.needsAttention, view.background];
    });
    expect(states).toEqual([
      [true, false, false],
      [false, true, false],
      [false, false, true],
      [false, false, false],
    ]);
  });

  test("applies the Runtime location so worktree rows show their glyph and working directory", () => {
    const worktree = projectSidebarThreadRowLiveView(item, {
      indicator: null,
      location: {
        hostId: "local",
        cwd: "/managed/feature/app",
        managedWorktreePath: "/managed/feature",
      },
    });
    expect(worktree.item.cwd).toBe("/managed/feature/app");
    expect(worktree.item.runLocation).toEqual({
      kind: "local-worktree",
      path: "/managed/feature",
      phase: "ready",
    });
    const checkout = projectSidebarThreadRowLiveView(
      { ...item, runLocation: { kind: "local-worktree", path: "/stale", phase: "ready" } },
      { indicator: null, location: { hostId: "local", cwd: "/repo", managedWorktreePath: null } },
    );
    expect(checkout.item.runLocation).toEqual({ kind: "local-checkout" });
  });
});

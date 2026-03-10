import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { WorkbenchResumeState, workbenchResumeStateTestHelpers } from "./workbench-resume-state";
import type { WorkbenchResumeSnapshot } from "../shared/workbench-resume";

function makeSnapshot(): WorkbenchResumeSnapshot {
  return {
    version: 1,
    dbProjectId: "default",
    threadsProjectId: "default",
    viewsByProject: { default: "calendar" },
    focusedStage: "threads",
    stageNavDirection: "left",
    activeCardsTabId: "session:recent-1",
    activeRecentSessionId: "recent-1",
    activeThreadsTabId: "thread-1",
    recentCardSessions: [
      {
        id: "recent-1",
        projectId: "default",
        cardId: "card-1",
        titleSnapshot: "Card 1",
        lastOpenedAt: "2026-03-09T00:00:00.000Z",
      },
    ],
    cardStage: {
      open: true,
      projectId: "default",
      cardId: "card-1",
    },
  };
}

describe("WorkbenchResumeState", () => {
  test("saves and reads a normalized snapshot", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "nodex-workbench-resume-"));
    try {
      const state = new WorkbenchResumeState(userDataPath);
      const saved = state.saveSnapshotForWindow(1, 1, 1, makeSnapshot());

      expect(saved).toBeTrue();
      expect(JSON.stringify(state.readSnapshot())).toBe(JSON.stringify(makeSnapshot()));
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test("consume only works for restore-eligible windows", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "nodex-workbench-resume-"));
    try {
      const state = new WorkbenchResumeState(userDataPath);
      state.saveSnapshotForWindow(1, 1, 1, makeSnapshot());

      expect(state.consumeSnapshotForWindow(99)).toBe(null);

      state.markWindowEligible(7);
      expect(JSON.stringify(state.consumeSnapshotForWindow(7))).toBe(JSON.stringify(makeSnapshot()));
      expect(state.consumeSnapshotForWindow(7)).toBe(null);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test("ignores save attempts from non-focused windows when multiple windows are open", () => {
    const userDataPath = mkdtempSync(join(tmpdir(), "nodex-workbench-resume-"));
    try {
      const state = new WorkbenchResumeState(userDataPath);
      const saved = state.saveSnapshotForWindow(2, 1, 2, makeSnapshot());

      expect(saved).toBeFalse();
      expect(state.readSnapshot()).toBe(null);
    } finally {
      rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  test("drops invalid snapshot payloads", () => {
    const normalized = workbenchResumeStateTestHelpers.normalizeWorkbenchResumeSnapshot({
      version: 1,
      dbProjectId: "default",
      threadsProjectId: "default",
      viewsByProject: { default: "kanban", other: "invalid" },
      focusedStage: "db",
      stageNavDirection: "right",
      activeCardsTabId: "",
      activeRecentSessionId: null,
      activeThreadsTabId: "thread:new",
      recentCardSessions: [{ id: 1 }],
      cardStage: {
        open: false,
        projectId: "",
        cardId: null,
      },
    });

    expect(JSON.stringify(normalized)).toBe(JSON.stringify({
      version: 1,
      dbProjectId: "default",
      threadsProjectId: "default",
      viewsByProject: { default: "kanban" },
      focusedStage: "db",
      stageNavDirection: "right",
      activeCardsTabId: "",
      activeRecentSessionId: null,
      activeThreadsTabId: "thread:new",
      recentCardSessions: [],
      cardStage: {
        open: false,
        projectId: "",
        cardId: null,
      },
    }));
  });
});

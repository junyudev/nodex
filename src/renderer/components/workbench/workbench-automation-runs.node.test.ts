import { describe, expect, test } from "vite-plus/test";
import type { CodexAutomationInboxItem } from "@/lib/types";
import {
  buildWorkbenchAutomationPreviousRunRowModel,
  buildWorkbenchAutomationPreviousRunRows,
  formatWorkbenchAutomationRunSourceLabel,
} from "./workbench-automation-runs";

function inboxItem(overrides: Partial<CodexAutomationInboxItem> = {}): CodexAutomationInboxItem {
  return {
    id: "thread-run-alpha",
    automationId: "automation-alpha",
    automationName: "Daily report",
    title: "Daily report run",
    description: "Review the run.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/Users/asc/repo/nodex",
    runId: "thread-run-alpha",
    sessionId: "session-alpha",
    readAt: null,
    createdAt: 100,
    status: "PENDING_REVIEW",
    ...overrides,
  };
}

describe("workbench automation previous runs", () => {
  test("filters by automation and sorts newest first", () => {
    const rows = buildWorkbenchAutomationPreviousRunRows({
      automationId: "automation-alpha",
      items: [
        inboxItem({ id: "old", runId: "old", createdAt: 100 }),
        inboxItem({
          id: "other",
          runId: "other",
          automationId: "automation-other",
          createdAt: 300,
        }),
        inboxItem({ id: "new", runId: "new", createdAt: 200 }),
      ],
      now: 200,
    });

    expect(rows.length).toBe(2);
    expect(rows[0]?.runId).toBe("new");
    expect(rows[1]?.runId).toBe("old");
  });

  test("builds action state from run lifecycle fields", () => {
    const active = buildWorkbenchAutomationPreviousRunRowModel({
      item: inboxItem({ status: "PENDING_REVIEW", readAt: null }),
      now: 1_000,
    });
    expect(active.isUnread).toBe(true);
    expect(active.canArchive).toBe(true);
    expect(active.canUnarchive).toBe(false);
    expect(active.canOpen).toBe(true);

    const running = buildWorkbenchAutomationPreviousRunRowModel({
      item: inboxItem({ status: "IN_PROGRESS" }),
      now: 1_000,
    });
    expect(running.isInProgress).toBe(true);
    expect(running.canArchive).toBe(false);

    const archived = buildWorkbenchAutomationPreviousRunRowModel({
      item: inboxItem({ status: "ARCHIVED", readAt: 500 }),
      now: 1_000,
    });
    expect(archived.isArchived).toBe(true);
    expect(archived.canArchive).toBe(false);
    expect(archived.canUnarchive).toBe(true);
    expect(archived.canOpen).toBe(false);
  });

  test("keeps distinct Runs in one Session actionable and permits review before a Session is bound", () => {
    const rows = buildWorkbenchAutomationPreviousRunRows({
      automationId: "automation-alpha",
      items: [
        inboxItem({ id: "run:one", runId: "run:one", sessionId: "session:one" }),
        inboxItem({ id: "run:two", runId: "run:two", sessionId: "session:one" }),
        inboxItem({ id: "run:unbound", runId: "run:unbound", sessionId: null }),
      ],
    });
    expect(rows.map((row) => row.runId)).toEqual(["run:one", "run:two", "run:unbound"]);
    expect(rows[0]?.sessionId).toBe(rows[1]?.sessionId);
    expect(rows[2]).toMatchObject({ canArchive: true, canOpen: false });
  });

  test("formats the run source label", () => {
    expect(formatWorkbenchAutomationRunSourceLabel("/Users/asc/repo/nodex/")).toBe("nodex");
  });
});

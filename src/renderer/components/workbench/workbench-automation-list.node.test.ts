import { describe, expect, test } from "vite-plus/test";
import type { CodexScheduledAutomation } from "@/lib/types";
import {
  buildWorkbenchAutomationListModel,
  buildWorkbenchAutomationRowModel,
  formatWorkbenchAutomationWorkspaceLabel,
  normalizeAutomationListSearchText,
  workbenchAutomationRowMatchesSearch,
} from "./workbench-automation-list";

function automation(overrides: Partial<CodexScheduledAutomation> = {}): CodexScheduledAutomation {
  return {
    id: "automation-alpha",
    definitionRevision: 1,
    kind: "cron",
    status: "ACTIVE",
    targetThreadId: null,
    name: "Daily report",
    prompt: "Summarize repository status.",
    rrule: "FREQ=DAILY",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: ["/Users/asc/repo/nodex"],
    executionEnvironment: "worktree",
    localEnvironmentConfigPath: null,
    nextRunAt: new Date("2026-07-08T09:00:00.000Z").getTime(),
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("workbench automation list model", () => {
  test("builds row labels for running unread active tasks", () => {
    const row = buildWorkbenchAutomationRowModel({
      automation: automation(),
      runningAutomationIds: new Set(["automation-alpha"]),
      unreadAutomationIds: new Set(["automation-alpha"]),
      now: new Date("2026-07-08T08:00:00.000Z"),
    });

    expect(row.displayName).toBe("Daily report");
    expect(row.workspaceLabel).toBe("nodex");
    expect(row.scheduleLabel).toBe("Daily");
    expect(row.secondaryStatusLabel).toBe("In progress");
    expect(row.hasUnreadRuns).toBe(true);
    expect(row.isInProgress).toBe(true);
    expect(row.isPaused).toBe(false);
  });

  test("groups current and paused rows after search", () => {
    const list = buildWorkbenchAutomationListModel({
      automations: [
        automation({
          id: "automation-current",
          name: "Project summary",
          prompt: "Summarize project.",
        }),
        automation({
          id: "automation-paused",
          name: "Inbox triage",
          prompt: "Triage inbox.",
          status: "PAUSED",
        }),
      ],
      runningAutomationIds: new Set(),
      unreadAutomationIds: new Set(),
      searchQuery: "triage",
    });

    expect(list.current.length).toBe(0);
    expect(list.paused.length).toBe(1);
    expect(list.paused[0]?.automation.id).toBe("automation-paused");
  });

  test("matches search against workspace and schedule labels", () => {
    const row = buildWorkbenchAutomationRowModel({
      automation: automation({ rrule: "FREQ=WEEKLY", cwds: ["/tmp/customer-api"] }),
      runningAutomationIds: new Set(),
      unreadAutomationIds: new Set(),
    });

    expect(
      workbenchAutomationRowMatchesSearch(row, normalizeAutomationListSearchText("customer")),
    ).toBe(true);
    expect(
      workbenchAutomationRowMatchesSearch(row, normalizeAutomationListSearchText("weekly")),
    ).toBe(true);
    expect(
      workbenchAutomationRowMatchesSearch(row, normalizeAutomationListSearchText("missing")),
    ).toBe(false);
  });

  test("formats multi-cwd and heartbeat workspace labels", () => {
    expect(
      formatWorkbenchAutomationWorkspaceLabel(
        automation({
          cwds: ["/tmp/alpha", "/tmp/beta", "/tmp/gamma"],
        }),
      ),
    ).toBe("alpha + 2 more");
    expect(
      formatWorkbenchAutomationWorkspaceLabel(
        automation({
          kind: "heartbeat",
          targetThreadId: "thread-alpha",
          cwds: [],
        }),
      ),
    ).toBe("Chat");
  });
});

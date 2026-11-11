import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import type {
  AutomationInboxItem,
  AutomationRunsUpdatedEvent,
  CodexSidebarSnapshot,
  Automation,
} from "./types";
import { useSidebarThreadSyncModel } from "./use-sidebar-thread-sync-model";
import { useAutomationRunsInbox } from "./use-automation-runs";
import { useAutomationsQuery } from "./use-automations-query";

function makeAutomation(id: string): Automation {
  return {
    id,
    automationRevision: 1,
    scope: { kind: "space" },
    ownerMemberId: "member-owner",
    conditionText: "Every day",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    projectId: null,
    notificationPolicy: null,
    mode: "run",
    runbookPageId: null,
    runbookTitle: null,
    heldDecision: null,
    kind: "cron",
    status: "ACTIVE",
    targetSessionId: null,
    name: id,
    prompt: "Run.",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    model: null,
    reasoningEffort: null,
    serviceTier: null,
    backendBinding: { kind: "codex" },
    cwds: ["/tmp/codex"],
    executionEnvironment: "local",
    localEnvironmentConfigPath: null,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeInboxItem(runId: string): AutomationInboxItem {
  return {
    id: runId,
    automationId: "daily-report",
    automationName: "Daily report",
    title: "Daily report",
    description: "Review the latest run.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/tmp/codex",
    runId,
    sessionId: "session:shared",
    quiet: false,
    readAt: null,
    createdAt: 1,
    status: "PENDING_REVIEW",
  };
}

function ScheduledAutomationRunUpdateHarness() {
  const automations = useAutomationsQuery();
  const inbox = useAutomationRunsInbox(50);
  const sidebar = useSidebarThreadSyncModel({ projects: [] });

  return (
    <div data-testid="counts">
      {automations.data?.length ?? -1}:{inbox.data?.items.length ?? -1}:
      {sidebar.snapshot.revision ?? 0}
    </div>
  );
}

function makeSidebarSnapshot(revision: number): CodexSidebarSnapshot {
  return {
    items: [],
    pinnedThreadIds: [],
    projectAssignments: {},
    projectlessThreadIds: [],
    revision,
    generatedAt: revision,
  };
}

describe("clock Automation run update invalidation", () => {
  let scheduledItems: Automation[];
  let inboxItems: AutomationInboxItem[];
  let sidebarRevision = 1;
  let scheduledListCalls = 0;
  let inboxListCalls = 0;
  let sidebarSnapshotCalls = 0;
  let sidebarSyncCalls = 0;
  let runUpdateListeners: Array<(event: AutomationRunsUpdatedEvent) => void> = [];

  beforeEach(() => {
    scheduledItems = [makeAutomation("daily-report")];
    inboxItems = [makeInboxItem("thread-run-1")];
    sidebarRevision = 1;
    scheduledListCalls = 0;
    inboxListCalls = 0;
    sidebarSnapshotCalls = 0;
    sidebarSyncCalls = 0;
    runUpdateListeners = [];

    installWindowApi({
      invoke: async (channel: string) => {
        if (channel === "automations:list") {
          scheduledListCalls += 1;
          return { items: scheduledItems };
        }

        if (channel === "automations:runs:inbox-items") {
          inboxListCalls += 1;
          return {
            items: inboxItems,
            unreadRunCounts: {
              total: inboxItems.length,
              automationIds: ["daily-report"],
              unreadRuns: inboxItems.map((item) => ({
                automationId: item.automationId,
                runId: item.runId,
              })),
            },
          };
        }

        if (channel === "codex:sidebar:snapshot") {
          sidebarSnapshotCalls += 1;
          return makeSidebarSnapshot(sidebarRevision);
        }

        if (channel === "codex:sidebar:sync") {
          sidebarSyncCalls += 1;
          return {
            snapshot: makeSidebarSnapshot(sidebarRevision),
            source: "app-server",
            refreshed: true,
            refreshedAt: sidebarRevision,
            changedProjectIds: [],
            projectlessChanged: false,
            materializedSessionIds: [],
            failedThreadIds: [],
          };
        }

        throw new Error(`Unexpected channel: ${channel}`);
      },
      on: (channel: string, listener: (event: AutomationRunsUpdatedEvent) => void) => {
        if (channel !== "automations:runs:updated") return () => undefined;

        runUpdateListeners.push(listener);
        return () => {
          runUpdateListeners = runUpdateListeners.filter((current) => current !== listener);
        };
      },
    });
  });

  test("refetches scheduled list and inbox queries after an automation run update", async () => {
    const view = render(
      <TestQueryProvider>
        <ScheduledAutomationRunUpdateHarness />
      </TestQueryProvider>,
    );

    await waitFor(() => {
      expect(view.getByTestId("counts").textContent).toBe("1:1:1");
    });
    await waitFor(() => {
      expect(runUpdateListeners.length).toBe(3);
    });
    expect(scheduledListCalls).toBe(1);
    expect(inboxListCalls).toBe(1);
    expect(sidebarSnapshotCalls).toBe(1);
    expect(sidebarSyncCalls).toBe(0);

    scheduledItems = [makeAutomation("daily-report"), makeAutomation("weekly-report")];
    inboxItems = [makeInboxItem("thread-run-1"), makeInboxItem("thread-run-2")];
    sidebarRevision = 2;

    await act(async () => {
      for (const listener of [...runUpdateListeners]) {
        listener({
          automationId: "daily-report",
          runId: "thread-run-2",
          sessionId: "session:shared",
          reason: "turn-completed",
        });
      }
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(view.getByTestId("counts").textContent).toBe("2:2:2");
    });
    expect(scheduledListCalls).toBe(2);
    expect(inboxListCalls).toBe(2);
    expect(sidebarSyncCalls).toBe(1);
  });
});

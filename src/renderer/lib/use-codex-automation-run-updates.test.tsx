import { act, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { render } from "@/test/dom";
import { installWindowApi } from "@/test/browser-globals";
import { TestQueryProvider } from "@/test/query";
import type {
  CodexAutomationInboxItem,
  CodexAutomationRunsUpdatedEvent,
  CodexSidebarSnapshot,
  CodexScheduledAutomation,
} from "./types";
import { useSidebarThreadSyncModel } from "./use-sidebar-thread-sync-model";
import { useCodexAutomationRunsInbox } from "./use-codex-automation-runs-inbox";
import { useCodexScheduledAutomations } from "./use-codex-scheduled-automations";

function makeAutomation(id: string): CodexScheduledAutomation {
  return {
    id,
    definitionRevision: 1,
    kind: "cron",
    status: "ACTIVE",
    targetThreadId: null,
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

function makeInboxItem(threadId: string): CodexAutomationInboxItem {
  return {
    id: threadId,
    automationId: "daily-report",
    automationName: "Daily report",
    title: "Daily report",
    description: "Review the latest run.",
    archivedAssistantMessage: null,
    archivedUserMessage: null,
    archivedReason: null,
    sourceCwd: "/tmp/codex",
    threadId,
    readAt: null,
    createdAt: 1,
    status: "PENDING_REVIEW",
  };
}

function ScheduledAutomationRunUpdateHarness() {
  const automations = useCodexScheduledAutomations();
  const inbox = useCodexAutomationRunsInbox(50);
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

describe("scheduled automation run update invalidation", () => {
  let scheduledItems: CodexScheduledAutomation[];
  let inboxItems: CodexAutomationInboxItem[];
  let sidebarRevision = 1;
  let scheduledListCalls = 0;
  let inboxListCalls = 0;
  let sidebarSnapshotCalls = 0;
  let sidebarSyncCalls = 0;
  let runUpdateListeners: Array<(event: CodexAutomationRunsUpdatedEvent) => void> = [];

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
        if (channel === "codex:scheduled-automations:list") {
          scheduledListCalls += 1;
          return { items: scheduledItems };
        }

        if (channel === "codex:automation-runs:inbox-items") {
          inboxListCalls += 1;
          return {
            items: inboxItems,
            unreadRunCounts: {
              total: inboxItems.length,
              automationIds: ["daily-report"],
              unreadRuns: inboxItems.map((item) => ({
                automationId: item.automationId,
                threadId: item.threadId,
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
      on: (channel: string, listener: (event: CodexAutomationRunsUpdatedEvent) => void) => {
        if (channel !== "codex:automation-runs:updated") return () => undefined;

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
          threadId: "thread-run-2",
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

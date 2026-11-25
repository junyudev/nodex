import { describe, expect, test } from "vite-plus/test";
import type { Automation } from "@/lib/types";
import { buildThreadSummaryPanelAutomationRow } from "./thread-summary-panel-automation-model";
import {
  buildThreadSummaryPanelBrowserRow,
  buildThreadSummaryPanelBrowserRows,
  isThreadSummaryBrowserRowAgentWorking,
} from "./thread-summary-panel-browser-row-model";
import type {
  CodexConversationItem,
  CodexConversationTurn,
  CodexConversationSnapshot,
} from "../../../lib/types";
import { buildThreadSummaryPanelPlanRow } from "./thread-summary-panel-plan-model";
import {
  buildThreadSummaryPanelSectionModel,
  hasThreadSummaryPanelSection,
  type ThreadSummaryPanelSectionKind,
} from "./thread-summary-panel-section-model";
import {
  buildThreadSummaryPanelSessionSideChatRows,
  buildThreadSummaryPanelSideChatRow,
  isThreadSummarySideChatResponseInProgress,
} from "./thread-summary-panel-side-chat-row-model";

describe("thread summary panel automation model", () => {
  const clockTrigger = {
    kind: "clock",
    rrule: "FREQ=DAILY",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    nextRunAt: new Date(2026, 6, 8, 9, 30).getTime(),
  } satisfies Automation["trigger"];

  function automation(overrides: Partial<Automation> = {}): Automation {
    return {
      id: "automation-1",
      automationRevision: 1,
      scope: { kind: "space" },
      ownerMemberId: "member-owner",
      conditionText: "Every day",
      trigger: clockTrigger,
      projectId: null,
      notificationPolicy: null,
      mode: "run",
      runbookPageId: null,
      runbookTitle: null,
      heldDecision: null,
      kind: "heartbeat",
      status: "ACTIVE",
      targetSessionId: "thread-1",
      name: "Daily standup",
      prompt: "Check the daily standup thread.",
      model: null,
      reasoningEffort: null,
      serviceTier: null,
      backendBinding: { driver: "codex", instanceId: "codex" },
      cwds: [],
      executionEnvironment: "worktree",
      localEnvironmentConfigPath: null,
      lastRunAt: null,
      createdAt: 10,
      updatedAt: 10,
      ...overrides,
    };
  }

  describe("thread summary clock Automation projection", () => {
    test("selects the first active heartbeat automation for the current thread", () => {
      const row = buildThreadSummaryPanelAutomationRow({
        automations: [
          automation({ id: "paused", status: "PAUSED" }),
          automation({ id: "cron", kind: "cron" }),
          automation({ id: "wrong-thread", targetSessionId: "thread-2" }),
          automation({ id: "first-match", name: "First match" }),
          automation({ id: "second-match", name: "Second match" }),
        ],
        sessionId: "thread-1",
        now: new Date(2026, 6, 8, 8, 0),
      });

      expect(row?.id).toBe("first-match");
      expect(row?.name).toBe("First match");
      expect(row?.scheduleSummary).toBe("Daily");
      expect(row?.nextRunLabel).toBe("today at 9:30 AM");
    });

    test("returns null when the current thread has no active heartbeat automation", () => {
      const row = buildThreadSummaryPanelAutomationRow({
        automations: [
          automation({ id: "paused", status: "PAUSED" }),
          automation({ id: "cron", kind: "cron" }),
          automation({ id: "wrong-thread", targetSessionId: "thread-2" }),
        ],
        sessionId: "thread-1",
        now: new Date(2026, 6, 8, 8, 0),
      });

      expect(row).toBe(null);
    });

    test("summarizes common heartbeat schedules and falls back for custom rules", () => {
      const weekday = buildThreadSummaryPanelAutomationRow({
        automations: [
          automation({
            trigger: { ...clockTrigger, rrule: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
          }),
        ],
        sessionId: "thread-1",
        now: new Date(2026, 6, 7, 8, 0),
      });
      const custom = buildThreadSummaryPanelAutomationRow({
        automations: [
          automation({
            id: "custom",
            trigger: { ...clockTrigger, rrule: "FREQ=HOURLY", nextRunAt: null },
          }),
        ],
        sessionId: "thread-1",
        now: new Date(2026, 6, 7, 8, 0),
      });

      expect(weekday?.scheduleSummary).toBe("Every weekday");
      expect(weekday?.nextRunLabel).toBe("tomorrow at 9:30 AM");
      expect(custom?.scheduleSummary).toBe("Custom schedule");
      expect(custom?.nextRunLabel).toBe("No upcoming run");
    });
  });
});

describe("buildThreadSummaryPanelBrowserRow", () => {
  test("normalizes URL metadata to the Browser summary display model", () => {
    const row = buildThreadSummaryPanelBrowserRow({
      id: "browser-1",
      browserTabId: "runtime-browser-1",
      workbenchTabId: "browser-1",
      tabTitle: "New tab",
      configTitle: "Release notes",
      url: "https://www.example.com/docs/page",
      faviconUrl: " https://example.com/favicon.ico ",
      panelId: "right",
      leafId: "leaf-a",
      isAgentWorking: true,
    });

    expect(row.title).toBe("Release notes");
    expect(row.displayUrl).toBe("example.com");
    expect(row.url).toBe("https://www.example.com/docs/page");
    expect(row.faviconUrl).toBe("https://example.com/favicon.ico");
    expect(row.isAgentWorking).toBe(true);
    expect(row.panelId).toBe("right");
    expect(row.leafId).toBe("leaf-a");
  });

  test("uses display URL when the browser title is blank or a new-tab placeholder", () => {
    const row = buildThreadSummaryPanelBrowserRow({
      id: "browser-1",
      browserTabId: "runtime-browser-1",
      tabTitle: "New tab",
      url: "https://openai.com/",
    });

    expect(row.title).toBe("openai.com");
    expect(row.displayUrl).toBe("openai.com");
  });

  test("hides blank and attach-token URLs from the row contract", () => {
    const row = buildThreadSummaryPanelBrowserRow({
      id: "browser-1",
      browserTabId: "runtime-browser-1",
      tabTitle: "about:blank#codex-browser-sidebar-attach-token=abc",
      url: "about:blank#codex-browser-sidebar-attach-token=abc",
    });

    expect(row.title).toBe("Browser");
    expect(row.displayUrl === null).toBe(true);
    expect(row.url).toBe("");
  });
});

describe("isThreadSummaryBrowserRowAgentWorking", () => {
  test("marks only the conversation-active BrowserUse identity as working", () => {
    expect(isThreadSummaryBrowserRowAgentWorking("browser-1", "browser-1")).toBe(true);
    expect(isThreadSummaryBrowserRowAgentWorking("browser-2", "browser-1")).toBe(false);
    expect(isThreadSummaryBrowserRowAgentWorking(null, "browser-1")).toBe(false);
  });
});

describe("buildThreadSummaryPanelBrowserRows", () => {
  test("unions Workbench and runtime-only Browser pages by logical identity", () => {
    const runtimeBase = {
      browserConversationId: "session-1",
      browserViewScopeId: "window-1",
      codexSessionId: "thread-1",
      projectId: "project-1",
      webContentsId: null,
      viewport: {
        width: 1_280,
        height: 720,
        presetId: "browser-use",
        zoomPercent: 100,
      },
      captureActive: true,
      released: false,
      updatedAt: 1,
    };
    const rows = buildThreadSummaryPanelBrowserRows({
      rightTabs: [
        {
          browserTabId: "browser-one",
          workbenchTabId: "tab-one",
          tabTitle: "Stale",
          panelId: "right",
          leafId: "leaf-right",
        },
      ],
      bottomTabs: [],
      pendingTabs: [
        {
          browserTabId: "browser-one",
          workbenchTabId: "preview-one",
          tabTitle: "Duplicate",
          panelId: "bottom",
        },
      ],
      runtimeTabs: [
        {
          ...runtimeBase,
          browserTabId: "browser-one",
          title: "Live One",
          url: "https://one.example",
        },
        {
          ...runtimeBase,
          browserTabId: "browser-two",
          title: "Live Two",
          url: "https://two.example",
        },
      ],
      snapshots: [],
      activeBrowserUseTabId: "browser-two",
    });

    expect(
      rows.map((row) => ({
        browserTabId: row.browserTabId,
        id: row.id,
        isAgentWorking: row.isAgentWorking,
        isMaterialized: row.isMaterialized,
      })),
    ).toEqual([
      {
        browserTabId: "browser-one",
        id: "tab-one",
        isAgentWorking: false,
        isMaterialized: true,
      },
      {
        browserTabId: "browser-two",
        id: "browser-use:browser-two",
        isAgentWorking: true,
        isMaterialized: false,
      },
    ]);
  });
});

describe("thread summary panel plan model", () => {
  function buildPlanItem(
    itemId: string,
    markdownText: string,
    semanticKind: CodexConversationItem["semanticKind"] = "proposedPlan",
  ): CodexConversationItem {
    return {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId,
      entryId: itemId,
      type: "plan",
      kind: "plan",
      semanticKind,
      status: "completed",
      role: "assistant",
      markdownText,
      createdAt: 1,
      updatedAt: 1,
    };
  }

  function buildTurn(
    turnId: string,
    status: CodexConversationTurn["status"],
    items: CodexConversationItem[],
  ): CodexConversationTurn {
    return {
      threadId: "thread-1",
      turnId,
      status,
      itemIds: items.map((item) => item.itemId),
      items: items.map((item) => ({ ...item, turnId })),
    };
  }

  describe("buildThreadSummaryPanelPlanRow", () => {
    test("builds the latest completed proposed-plan row", () => {
      const row = buildThreadSummaryPanelPlanRow({
        activeThreadId: "thread-1",
        cwd: "/repo/project",
        turns: [
          buildTurn("turn-old", "completed", [buildPlanItem("old-plan", "# Old plan\n\n- First")]),
          buildTurn("turn-new", "completed", [
            buildPlanItem("new-plan", "# Summary panel parity\n\n- Compare reference"),
          ]),
        ],
      });

      expect(row?.label ?? "").toBe("Summary panel parity");
      expect(row?.target.planKey ?? "").toBe("turn-new");
      expect(row?.target.itemId ?? "").toBe("new-plan");
      expect(row?.target.cwd ?? "").toBe("/repo/project");
    });

    test("ignores in-progress turns and todo-list plan updates", () => {
      const row = buildThreadSummaryPanelPlanRow({
        activeThreadId: "thread-1",
        cwd: null,
        turns: [
          buildTurn("turn-todo", "completed", [
            buildPlanItem("todo-plan", "- [ ] Inspect\n- [ ] Implement", "todoList"),
          ]),
          buildTurn("turn-live", "inProgress", [
            buildPlanItem("live-plan", "# Live plan\n\nStill streaming"),
          ]),
        ],
      });

      expect(row === null).toBe(true);
    });

    test("falls back to the section title when the plan has no h1", () => {
      const row = buildThreadSummaryPanelPlanRow({
        activeThreadId: "thread-1",
        cwd: null,
        turns: [
          buildTurn("turn-plan", "completed", [buildPlanItem("plan", "1. Inspect\n2. Implement")]),
        ],
      });

      expect(row?.label ?? "").toBe("Plan");
    });
  });
});

describe("thread summary panel section model", () => {
  function sectionKinds(
    input: Parameters<typeof buildThreadSummaryPanelSectionModel>[0],
  ): ThreadSummaryPanelSectionKind[] {
    return buildThreadSummaryPanelSectionModel(input).map((section) => section.kind);
  }

  describe("buildThreadSummaryPanelSectionModel", () => {
    test("keeps the Codex summary section order and gates empty optional sections", () => {
      const kinds = sectionKinds({
        activeThreadId: "thread-1",
        hasAutomation: true,
        hasEnvironment: true,
        hasPlan: true,
        outputCount: 2,
        sideChatCount: 1,
        backgroundSubagentRows: [
          { displayName: "Scout", showInlineActivity: false, status: "active" },
        ],
        taskCount: 1,
        hasComputerUsePip: true,
        browserCount: 1,
        sourceCount: 3,
      });

      expect(kinds.join(",")).toBe(
        "automations,environment,plan,outputs,sideChats,subagents,tasks,computerUsePip,browser,sources",
      );
    });

    test("shows deliverables alongside the Git environment summary", () => {
      const sections = buildThreadSummaryPanelSectionModel({
        activeThreadId: "thread-1",
        hasAutomation: false,
        hasEnvironment: true,
        hasPlan: false,
        outputCount: 1,
        sideChatCount: 0,
        backgroundSubagentRows: [],
        taskCount: 0,
        hasComputerUsePip: false,
        browserCount: 0,
        sourceCount: 0,
      });

      expect(hasThreadSummaryPanelSection(sections, "outputs")).toBe(true);
      expect(sections.map((section) => section.kind).join(",")).toBe("environment,outputs,sources");
    });

    test("hides the Environment section when no git environment summary is available", () => {
      const sections = buildThreadSummaryPanelSectionModel({
        activeThreadId: "thread-1",
        hasAutomation: false,
        hasEnvironment: false,
        hasPlan: false,
        outputCount: 1,
        sideChatCount: 0,
        backgroundSubagentRows: [],
        taskCount: 0,
        hasComputerUsePip: false,
        browserCount: 0,
        sourceCount: 0,
      });

      expect(hasThreadSummaryPanelSection(sections, "environment")).toBe(false);
      expect(sections.map((section) => section.kind).join(",")).toBe("outputs,sources");
    });

    test("marks completed non-inline subagents for auto-collapse", () => {
      const sections = buildThreadSummaryPanelSectionModel({
        activeThreadId: "thread-1",
        hasAutomation: false,
        hasEnvironment: false,
        hasPlan: false,
        outputCount: 0,
        sideChatCount: 0,
        backgroundSubagentRows: [
          { displayName: "Scout", showInlineActivity: false, status: "done" },
          { displayName: "Scout", showInlineActivity: false, status: "done" },
        ],
        taskCount: 0,
        hasComputerUsePip: false,
        browserCount: 0,
        sourceCount: 0,
      });

      const subagents = sections.find((section) => section.kind === "subagents");
      expect(subagents?.count).toBe(2);
      expect(subagents?.autoCollapse).toBe(true);
    });

    test("hides the Subagents header count when inline activity owns the compact summary", () => {
      const sections = buildThreadSummaryPanelSectionModel({
        activeThreadId: "thread-1",
        hasAutomation: false,
        hasEnvironment: false,
        hasPlan: false,
        outputCount: 0,
        sideChatCount: 0,
        backgroundSubagentRows: [
          { displayName: "Scout", showInlineActivity: true, status: "done" },
          { displayName: "Scout", showInlineActivity: false, status: "done" },
        ],
        taskCount: 0,
        hasComputerUsePip: false,
        browserCount: 0,
        sourceCount: 0,
      });

      const subagents = sections.find((section) => section.kind === "subagents");
      expect(subagents?.count ?? "null").toBe("null");
      expect(subagents?.autoCollapse).toBe(false);
    });

    test("keeps Sources and blank-thread hint as explicit model entries", () => {
      const sections = buildThreadSummaryPanelSectionModel({
        activeThreadId: null,
        hasAutomation: false,
        hasEnvironment: false,
        hasPlan: false,
        outputCount: 0,
        sideChatCount: 0,
        backgroundSubagentRows: [],
        taskCount: 0,
        hasComputerUsePip: false,
        browserCount: 0,
        sourceCount: 0,
      });

      expect(sections.map((section) => section.kind).join(",")).toBe("sources,emptyHint");
      expect(sections.find((section) => section.kind === "sources")?.count).toBe(0);
      expect(sections.find((section) => section.kind === "emptyHint")?.mode).toBe("headerless");
    });
  });
});

describe("thread summary panel side chat row model", () => {
  function makeConversation(
    overrides: Partial<
      Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">
    > = {},
  ): Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns"> {
    return {
      statusType: "idle",
      statusActiveFlags: [],
      turns: [],
      ...overrides,
    } as Pick<CodexConversationSnapshot, "statusType" | "statusActiveFlags" | "turns">;
  }

  describe("buildThreadSummaryPanelSideChatRow", () => {
    test("projects the side-chat row identity and conversation response state", () => {
      const row = buildThreadSummaryPanelSideChatRow(
        {
          id: "sidechat:thread-side",
          title: "Investigate layout",
          threadId: "thread-side",
          panelId: "right",
          leafId: "leaf-a",
        },
        makeConversation({ statusType: "active" }),
      );

      expect(row.id).toBe("sidechat:thread-side");
      expect(row.title).toBe("Investigate layout");
      expect(row.isResponseInProgress).toBe(true);
      expect(row.panelId).toBe("right");
      expect(row.leafId).toBe("leaf-a");
    });

    test("does not treat a tab without a loaded conversation as response-in-progress", () => {
      const row = buildThreadSummaryPanelSideChatRow(
        {
          id: "sidechat-loading:thread-main:1",
          title: "Side chat",
          threadId: null,
          panelId: "bottom",
        },
        null,
      );

      expect(row.isResponseInProgress).toBe(false);
      expect(row.leafId).toBe(null);
    });
  });

  describe("isThreadSummarySideChatResponseInProgress", () => {
    test("uses conversation activity instead of panel-tab loading state", () => {
      const inProgressTurn = [
        {
          turnId: "turn-live",
          status: "inProgress",
          items: [],
        },
      ] as unknown as CodexConversationTurn[];

      expect(isThreadSummarySideChatResponseInProgress(null)).toBe(false);
      expect(isThreadSummarySideChatResponseInProgress(makeConversation())).toBe(false);
      expect(
        isThreadSummarySideChatResponseInProgress(makeConversation({ statusType: "active" })),
      ).toBe(true);
      expect(
        isThreadSummarySideChatResponseInProgress(
          makeConversation({ statusActiveFlags: ["waitingOnUserInput"] }),
        ),
      ).toBe(true);
      expect(
        isThreadSummarySideChatResponseInProgress(makeConversation({ turns: inProgressTurn })),
      ).toBe(true);
    });
  });

  describe("buildThreadSummaryPanelSessionSideChatRows", () => {
    test("lists every side chat newest first, placing the open ones in their tabs", () => {
      const rows = buildThreadSummaryPanelSessionSideChatRows({
        open: [
          { sessionId: "older", title: "Renamed by its request", panelId: "bottom", leafId: "b" },
          { sessionId: "new", title: "Side chat 2", panelId: "right", leafId: "a" },
        ],
        listed: [
          { sessionId: "older", title: "Side chat" },
          { sessionId: "closed", title: "Closed question" },
        ],
        listComplete: true,
        isResponding: (sessionId) => sessionId === "closed",
      });
      expect(rows).toEqual([
        {
          id: "sidechat-session:new",
          title: "Side chat 2",
          isResponseInProgress: false,
          panelId: "right",
          leafId: "a",
        },
        {
          id: "sidechat-session:older",
          title: "Renamed by its request",
          isResponseInProgress: false,
          panelId: "bottom",
          leafId: "b",
        },
        {
          id: "sidechat-session:closed",
          title: "Closed question",
          isResponseInProgress: true,
          panelId: undefined,
          leafId: null,
        },
      ]);
    });

    test("keeps an open side chat the read has not reached after the listed ones", () => {
      const rows = buildThreadSummaryPanelSessionSideChatRows({
        open: [{ sessionId: "old-open", title: "Old question", panelId: "right", leafId: "a" }],
        listed: [{ sessionId: "newest", title: "Newest question" }],
        listComplete: false,
        isResponding: () => false,
      });
      expect(rows.map((row) => row.id)).toEqual([
        "sidechat-session:newest",
        "sidechat-session:old-open",
      ]);
    });
  });
});

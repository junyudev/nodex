import { describe, expect, test } from "vite-plus/test";
import {
  hasCodexPendingContinuation,
  isCodexConversationDesktopNotificationEligible,
  parseCodexHeartbeatAssistantMessage,
} from "./codex-turn-notification";
import type { CodexConversationSnapshot } from "./types";

function baseConversation(
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    source: null,
    ephemeral: false,
    threadSource: null,
    threadName: null,
    threadPreview: "",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: new Date(0).toISOString(),
    latestCollaborationMode: {
      mode: "default",
      settings: {
        model: "",
        reasoning_effort: null,
        developer_instructions: null,
      },
    },
    latestThreadSettings: null,
    latestTokenUsageInfo: null,
    threadGoal: null,
    completedThreadGoal: null,
    threadGoalResumeConfirmation: null,
    resumeState: "resumed",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
    hasUnreadTurn: overrides.hasUnreadTurn ?? false,
  };
}

describe("codex-turn-notification helpers", () => {
  test("parses heartbeat notification decisions and removes heartbeat from visible text", () => {
    const heartbeat = parseCodexHeartbeatAssistantMessage(
      [
        "Visible summary.",
        "<heartbeat>",
        "<decision>NOTIFY</decision>",
        "<message>Review this now</message>",
        "</heartbeat>",
      ].join("\n"),
    );

    expect(heartbeat?.decision).toBe("NOTIFY");
    expect(heartbeat?.notificationMessage).toBe("Review this now");
    expect(heartbeat?.visibleText).toBe("Visible summary.");

    const suppressed = parseCodexHeartbeatAssistantMessage(
      ["No user-visible alert.", "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>"].join(
        "\n",
      ),
    );
    expect(suppressed?.decision).toBe("DONT_NOTIFY");
  });

  test("only excludes conversations with real parent provenance", () => {
    expect(isCodexConversationDesktopNotificationEligible(baseConversation())).toBe(true);
    expect(
      isCodexConversationDesktopNotificationEligible(baseConversation({ ephemeral: true })),
    ).toBe(true);
    expect(
      isCodexConversationDesktopNotificationEligible(baseConversation({ threadSource: "system" })),
    ).toBe(true);
    expect(
      isCodexConversationDesktopNotificationEligible(
        baseConversation({
          source: { parentThreadId: "parent", sideConversation: true },
        }),
      ),
    ).toBe(false);
    expect(
      isCodexConversationDesktopNotificationEligible(
        baseConversation({
          source: { parentThreadId: null, sideConversation: true },
        }),
      ),
    ).toBe(true);
  });

  test("matches exact terminal continuation semantics", () => {
    const facts = {
      terminalStatus: "completed" as const,
      queuedResourceLoading: false,
      queuedHeadPausedReason: undefined,
      threadGoalStatus: null,
      latestMergedTurnStatus: "completed" as const,
      hasRunningCollabAgent: false,
      hasActiveDescendant: false,
    };
    expect(hasCodexPendingContinuation(facts)).toBe(false);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        queuedHeadPausedReason: null,
      }),
    ).toBe(true);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        terminalStatus: "interrupted",
        queuedHeadPausedReason: null,
      }),
    ).toBe(false);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        threadGoalStatus: "active",
      }),
    ).toBe(true);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        terminalStatus: "failed",
        threadGoalStatus: "active",
      }),
    ).toBe(false);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        terminalStatus: "interrupted",
        latestMergedTurnStatus: "inProgress",
      }),
    ).toBe(true);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        hasRunningCollabAgent: true,
      }),
    ).toBe(true);
    expect(
      hasCodexPendingContinuation({
        ...facts,
        hasActiveDescendant: true,
      }),
    ).toBe(true);
  });
});

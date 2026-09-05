import { describe, expect, test } from "vite-plus/test";
import type { Thread, ThreadSettings } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import {
  reduceCodexConversationThreadGoalCleared,
  reduceCodexConversationThreadGoalResumeConfirmationDismissed,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
  reduceCodexConversationThreadSettings,
  reduceCodexConversationThreadStarted,
  reduceCodexConversationThreadStatus,
  reduceCodexConversationThreadTokenUsage,
} from "./codex-thread-metadata";

const usage = {
  total: {
    totalTokens: 100,
    inputTokens: 60,
    cachedInputTokens: 10,
    cacheWriteInputTokens: 0,
    outputTokens: 40,
    reasoningOutputTokens: 15,
  },
  last: {
    totalTokens: 20,
    inputTokens: 12,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 0,
    outputTokens: 8,
    reasoningOutputTokens: 3,
  },
  modelContextWindow: 128_000,
};

function buildState(): CodexCanonicalConversationState {
  return {
    protocol: buildThread("Existing title"),
    turns: [],
    requests: [],
    sidecar: { hasUnreadTurn: true, hydrationContext: null },
  };
}

function buildThread(name: string | null): CodexCanonicalConversationState["protocol"] {
  return {
    model: null,
    reasoningEffort: null,
    id: "thread-token",
    extra: null,
    sessionId: "session-1",
    forkedFromId: null,
    parentThreadId: null,
    preview: "Old preview",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 2,
    recencyAt: 2,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/old",
    cliVersion: "test",
    source: "appServer",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name,
  };
}

const settings: ThreadSettings = {
  cwd: "/new",
  approvalPolicy: "on-request",
  approvalsReviewer: "user",
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: ["/new"],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  activePermissionProfile: null,
  model: "gpt-new",
  modelProvider: "openai-new",
  serviceTier: "fast",
  effort: "high",
  summary: "concise",
  collaborationMode: {
    mode: "default",
    settings: {
      model: "gpt-new",
      reasoning_effort: "high",
      developer_instructions: null,
    },
  },
  multiAgentMode: "explicitRequestOnly",
  personality: "pragmatic",
};

describe("Codex 30751 thread metadata", () => {
  test("replaces conversation token usage without touching requests or unread", () => {
    const before = buildState();
    const after = reduceCodexConversationThreadTokenUsage(before, {
      conversationId: "thread-token",
      tokenUsage: usage,
    });

    expect(after.sidecar.latestTokenUsageInfo === usage).toBe(true);
    expect(after.sidecar.hasUnreadTurn).toBe(true);
    expect(after.turns === before.turns).toBe(true);
    expect(after.requests === before.requests).toBe(true);
  });

  test("ignores token usage for another thread", () => {
    const before = buildState();
    expect(
      reduceCodexConversationThreadTokenUsage(before, {
        conversationId: "other-thread",
        tokenUsage: usage,
      }) === before,
    ).toBe(true);
  });

  test("merges thread metadata without replacing turns or an existing title", () => {
    const before = buildState();
    const incoming: Thread = {
      ...buildThread("Incoming title"),
      preview: "Fresh preview",
      cwd: "/new",
      updatedAt: 9,
      turns: [],
    };
    const after = reduceCodexConversationThreadStarted(before, incoming);

    expect(after.protocol.name).toBe("Existing title");
    expect(after.protocol.preview).toBe("Fresh preview");
    expect(after.protocol.updatedAt).toBe(9);
    expect(after.turns === before.turns).toBe(true);
    expect(
      reduceCodexConversationThreadName(after, "thread-token", "  Renamed  ").protocol.name,
    ).toBe("Renamed");
    expect(reduceCodexConversationThreadName(after, "thread-token", "   ") === after).toBe(true);
  });

  test("stores complete settings and emits status/goal effects after canonical mutation", () => {
    const configured = reduceCodexConversationThreadSettings(
      buildState(),
      "thread-token",
      settings,
    );
    expect(configured.sidecar.latestThreadSettings).toEqual(settings);
    expect(configured.protocol.cwd).toBe("/new");
    expect(configured.protocol.modelProvider).toBe("openai-new");
    expect(configured.protocol.model).toBe("gpt-new");
    expect(configured.protocol.reasoningEffort).toBe("high");

    const idle = reduceCodexConversationThreadStatus(configured, "thread-token", { type: "idle" });
    expect(idle.state.protocol.status.type).toBe("idle");
    expect(idle.effects[0]?.type).toBe("continueGoalIfIdle");

    const goal = {
      threadId: "thread-token",
      objective: "Ship parity",
      status: "complete" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 4,
    };
    const completed = reduceCodexConversationThreadGoalUpdated(idle.state, "thread-token", goal);
    expect(completed.state.sidecar.completedThreadGoal === goal).toBe(true);
    expect(completed.effects[0]?.type).toBe("clearCompletedGoal");
    const cleared = reduceCodexConversationThreadGoalCleared(completed.state, "thread-token");
    expect(cleared.sidecar.threadGoal).toBe(null);
    expect(cleared.sidecar.completedThreadGoal === goal).toBe(true);
  });

  test("canonicalizes the app-server Standard sentinel in live and hydrated settings", () => {
    const before = buildState();
    const state: CodexCanonicalConversationState = {
      ...before,
      sidecar: {
        ...before.sidecar,
        hydrationContext: {
          model: "gpt-old",
          reasoningEffort: "high",
          latestModel: "gpt-old",
          latestReasoningEffort: "high",
          cwd: "/old",
          latestThreadSettings: settings,
          currentPermissions: {
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/old"],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: settings.sandboxPolicy,
          },
        },
      },
    };

    const configured = reduceCodexConversationThreadSettings(state, "thread-token", {
      ...settings,
      serviceTier: "default",
    });

    expect(configured.sidecar.latestThreadSettings?.serviceTier).toBe(null);
    expect(configured.sidecar.hydrationContext?.latestThreadSettings?.serviceTier).toBe(null);
  });

  test("dismisses a resume confirmation without changing the canonical goal", () => {
    const goal = {
      threadId: "thread-token",
      objective: "Ship parity",
      status: "paused" as const,
      tokenBudget: null,
      tokensUsed: 10,
      timeUsedSeconds: 2,
      createdAt: 1,
      updatedAt: 4,
    };
    const before = buildState();
    const state: CodexCanonicalConversationState = {
      ...before,
      sidecar: {
        ...before.sidecar,
        threadGoal: goal,
        threadGoalResumeConfirmation: goal,
      },
    };
    const dismissed = reduceCodexConversationThreadGoalResumeConfirmationDismissed(
      state,
      "thread-token",
    );

    expect(dismissed.sidecar.threadGoal === goal).toBe(true);
    expect(dismissed.sidecar.threadGoalResumeConfirmation).toBe(null);
    expect(
      reduceCodexConversationThreadGoalResumeConfirmationDismissed(dismissed, "other-thread") ===
        dismissed,
    ).toBe(true);
  });
});

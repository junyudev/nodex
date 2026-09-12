import { createCodexCanonicalConversationMetadata } from "./codex-conversation-state";
import { describe, expect, test } from "vite-plus/test";
import type { Thread, ThreadSettings } from "@nodex/codex-app-server-protocol/v2";
import { produce } from "immer";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import {
  mutateCodexConversationThreadName,
  reduceCodexConversationThreadGoalCleared,
  reduceCodexConversationThreadGoalResumeConfirmationDismissed,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
  reconcileCodexResumedConversationState,
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
    ...createCodexCanonicalConversationMetadata(buildThread("Existing title"), "local"),
    turns: [],
    requests: [],
    hasUnreadTurn: true,
    hydrationContext: null,
  };
}

function buildThread(name: string | null): Omit<Thread, "turns"> {
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

    expect(after.latestTokenUsageInfo === usage).toBe(true);
    expect(after.hasUnreadTurn).toBe(true);
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

    expect(after.title).toBe("Existing title");
    expect(after.updatedAt).toBe(9000);
    expect(after.turns === before.turns).toBe(true);
    expect(reduceCodexConversationThreadName(after, "thread-token", "  Renamed  ").title).toBe(
      "Renamed",
    );
    expect(reduceCodexConversationThreadName(after, "thread-token", "   ") === after).toBe(true);
  });

  test("projects protocol thread names while preserving literal nonblank fallbacks", () => {
    expect(
      createCodexCanonicalConversationMetadata(
        buildThread("  **Stored** [title](https://example.com)  "),
        "local",
      ).title,
    ).toBe("Stored title");
    expect(createCodexCanonicalConversationMetadata(buildThread("---"), "local").title).toBe("---");

    const renamed = reduceCodexConversationThreadName(
      buildState(),
      "thread-token",
      "**Renamed** [thread](https://example.com)",
    );
    expect(renamed.title).toBe("Renamed thread");
  });

  test("tracks generated title ownership and clears it on a manual rename", () => {
    const generated = produce(buildState(), (draft) =>
      mutateCodexConversationThreadName(draft, "thread-token", "Generated title", true),
    );
    expect(generated.title).toBe("Generated title");
    expect(generated.generatedTitle).toBe("Generated title");

    const manual = produce(generated, (draft) =>
      mutateCodexConversationThreadName(draft, "thread-token", "Manual title", false),
    );
    expect(manual.title).toBe("Manual title");
    expect(manual.generatedTitle).toBeNull();

    const sameTitleManual = produce(generated, (draft) =>
      mutateCodexConversationThreadName(draft, "thread-token", "Generated title", false),
    );
    expect(sameTitleManual.generatedTitle).toBeNull();
  });

  test("keeps explicit model settings when fresh raw metadata arrives", () => {
    const before = reduceCodexConversationThreadSettings(buildState(), "thread-token", settings);
    const after = reduceCodexConversationThreadStarted(before, {
      ...buildThread("Stored name"),
      model: "stored-model",
      reasoningEffort: "low",
      turns: [],
    });
    expect(after.latestModel).toBe(settings.model);
    expect(after.latestReasoningEffort).toBe(settings.effort);
    expect(after.title).toBe(before.title);
    expect(after.createdAt).toBe(before.createdAt);
  });

  test("resume reconciliation preserves concurrent app metadata and applies accepted settings", () => {
    const configured = reduceCodexConversationThreadSettings(
      buildState(),
      "thread-token",
      settings,
    );
    const existing: CodexCanonicalConversationState = {
      ...configured,
      title: "Catalog title",
      generatedTitle: "Generated title",
      createdAt: 1_000,
      updatedAt: 8_000,
      recencyAt: 7_000,
      previousTurnModel: "gpt-before-resume",
      latestTokenUsageInfo: usage,
      threadSource: "user",
      gitInfo: { sha: "abc", branch: "main", originUrl: null },
    };
    const resumedThread: Thread = {
      ...buildThread("Native title"),
      updatedAt: 9,
      recencyAt: null,
      threadSource: null,
      gitInfo: null,
      model: "gpt-resumed",
      reasoningEffort: "medium",
      turns: [],
    };
    const resumed: CodexCanonicalConversationState = {
      ...createCodexCanonicalConversationMetadata(resumedThread, "local"),
      turns: [],
      requests: [],
      hasUnreadTurn: false,
      hydrationContext: null,
    };

    const reconciled = reconcileCodexResumedConversationState({
      existing,
      resumed,
      thread: resumedThread,
      catalogTitle: "Catalog title",
      settingsPatch: {
        cwd: "/resumed",
        model: "gpt-resumed",
        effort: "medium",
      },
    });

    expect(reconciled.title).toBe("Native title");
    expect(reconciled.generatedTitle).toBe("Generated title");
    expect(reconciled.createdAt).toBe(1_000);
    expect(reconciled.updatedAt).toBe(9_000);
    expect(reconciled.recencyAt).toBe(7_000);
    expect(reconciled.threadSource).toBe("user");
    expect(reconciled.gitInfo).toEqual(existing.gitInfo);
    expect(reconciled.latestTokenUsageInfo).toBe(usage);
    expect(reconciled.previousTurnModel).toBe("gpt-before-resume");
    expect(reconciled.latestThreadSettings?.summary).toBe(settings.summary);
    expect(reconciled.latestThreadSettings?.personality).toBe(settings.personality);
    expect(reconciled.latestModel).toBe("gpt-resumed");
    expect(reconciled.latestReasoningEffort).toBe("medium");
    expect(reconciled.latestCollaborationMode.settings.model).toBe("gpt-resumed");
    expect(reconciled.latestCollaborationMode.settings.reasoning_effort).toBe("medium");
  });

  test("resume reconciliation does not replace a locally edited title", () => {
    const existing = { ...buildState(), title: "Local edit" };
    const resumedThread: Thread = {
      ...buildThread("Native title"),
      updatedAt: 3,
      turns: [],
    };
    const resumed: CodexCanonicalConversationState = {
      ...createCodexCanonicalConversationMetadata(resumedThread, "local"),
      turns: [],
      requests: [],
      hasUnreadTurn: false,
      hydrationContext: null,
    };

    expect(
      reconcileCodexResumedConversationState({
        existing,
        resumed,
        thread: resumedThread,
        catalogTitle: "Catalog title",
      }).title,
    ).toBe("Local edit");
  });

  test("stores status observations and clears a completed goal after canonical mutation", () => {
    const configured = reduceCodexConversationThreadSettings(
      buildState(),
      "thread-token",
      settings,
    );
    expect(configured.latestThreadSettings).toEqual(settings);
    expect(configured.cwd).toBe("/new");
    expect(configured.modelProvider).toBe("openai-new");
    expect(configured.latestModel).toBe("gpt-new");
    expect(configured.latestReasoningEffort).toBe("high");

    const idle = reduceCodexConversationThreadStatus(configured, "thread-token", { type: "idle" });
    expect(idle.state.threadRuntimeStatus.type).toBe("idle");
    expect(idle.effects).toEqual([]);

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
    expect(completed.state.completedThreadGoal === goal).toBe(true);
    expect(completed.effects[0]?.type).toBe("clearCompletedGoal");
    const cleared = reduceCodexConversationThreadGoalCleared(completed.state, "thread-token");
    expect(cleared.threadGoal).toBe(null);
    expect(cleared.completedThreadGoal === goal).toBe(true);
  });

  test.each(["paused", "blocked", "usageLimited"] as const)(
    "preserves an absent resume confirmation when the goal becomes %s",
    (status) => {
      const { threadGoalResumeConfirmation: _confirmation, ...before } = buildState();
      const goal = {
        threadId: "thread-token",
        objective: "Finish work",
        status,
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 4,
      };
      const after = reduceCodexConversationThreadGoalUpdated(before, "thread-token", goal);
      expect(Object.hasOwn(after.state, "threadGoalResumeConfirmation")).toBe(false);
      expect(after.effects).toEqual([]);
    },
  );

  test("canonicalizes the app-server Standard sentinel in live and hydrated settings", () => {
    const before = buildState();
    const state: CodexCanonicalConversationState = {
      ...before,
      hydrationContext: {
        model: "gpt-old",
        reasoningEffort: "high",
        latestModel: "gpt-old",
        latestReasoningEffort: "high",
        cwd: "/old",
        latestThreadSettings: settings,
      },
      currentPermissions: {
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/old"],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: settings.sandboxPolicy,
      },
    };

    const configured = reduceCodexConversationThreadSettings(state, "thread-token", {
      ...settings,
      serviceTier: "default",
    });

    expect(configured.latestThreadSettings?.serviceTier).toBe(null);
    expect(configured.hydrationContext?.latestThreadSettings?.serviceTier).toBe(null);
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
      threadGoal: goal,
      threadGoalResumeConfirmation: goal,
    };
    const dismissed = reduceCodexConversationThreadGoalResumeConfirmationDismissed(
      state,
      "thread-token",
    );

    expect(dismissed.threadGoal === goal).toBe(true);
    expect(dismissed.threadGoalResumeConfirmation).toBe(null);
    expect(
      reduceCodexConversationThreadGoalResumeConfirmationDismissed(dismissed, "other-thread") ===
        dismissed,
    ).toBe(true);
  });
});

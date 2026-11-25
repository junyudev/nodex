import {
  createCodexCanonicalConversationMetadata,
  type CodexCanonicalConversationState,
  createCodexCanonicalTurnState,
  createCodexCanonicalHydratedConversationState,
} from "./codex-conversation-state";
import { describe, expect, test } from "vite-plus/test";
import type { ThreadGoal } from "@nodex/codex-app-server-protocol/v2/ThreadGoal";
import {
  appendCodexCanonicalThreadGoalTranscriptTurn,
  buildCodexThreadGoalTranscriptProjection,
} from "./codex-thread-goal-transcript";
import { applyCodexLifecycleProjectionDiff } from "./codex-lifecycle-projection-diff";
import type { Thread, ThreadSettings, HookRunSummary } from "@nodex/codex-app-server-protocol/v2";
import {
  reduceCodexConversationThreadGoalCleared,
  reduceCodexConversationThreadGoalResumeConfirmationDismissed,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
  reconcileCodexResumedConversationState,
  reduceCodexConversationThreadSettings,
  reduceCodexConversationThreadStarted,
  reduceCodexConversationThreadStatus,
  reduceCodexConversationThreadTokenUsage,
  refreshCodexConversationThreadMetadata,
} from "./codex-thread-metadata";
import { produce } from "immer";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { mutateCanonicalThreadSettingsPatch } from "./codex-thread-settings-update";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import {
  reduceCodexConversationAutomaticApprovalReview,
  reduceCodexConversationError,
  reduceCodexConversationGuardianWarning,
  reduceCodexConversationHookRun,
  reduceCodexConversationModelRerouted,
  reduceCodexConversationSafetyBuffering,
  reduceCodexConversationTurnDiff,
  reduceCodexConversationTurnPlan,
} from "./codex-turn-metadata";

describe("codex thread goal transcript", () => {
  const goal: ThreadGoal = {
    threadId: "thread-goal",
    objective: "Ship parity",
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 2,
  };

  function buildState(): CodexCanonicalConversationState {
    return {
      ...createCodexCanonicalConversationMetadata(
        {
          model: null,
          reasoningEffort: null,
          id: "thread-goal",
          environments: null,
          extra: null,
          sessionId: "session-goal",
          forkedFromId: null,
          attachedToThreadId: null,
          parentThreadId: null,
          preview: "",
          ephemeral: false,
          section: null,
          sectionEnteredAt: null,
          projectId: null,
          historyMode: "paginated",
          modelProvider: "openai",
          createdAt: 1,
          updatedAt: 1,
          recencyAt: 1,
          status: { type: "idle" },
          path: null,
          cwd: "/workspace",
          cliVersion: "test",
          originator: null,
          source: "appServer",
          canAcceptDirectInput: true,
          threadSource: null,
          agentNickname: null,
          agentRole: null,
          gitInfo: null,
          name: null,
          daybreakEnabled: null,
        },
        "local",
      ),
      turns: [],
      requests: [],
      hasUnreadTurn: false,
      hydrationContext: null,
      latestThreadSettings: {
        cwd: "/workspace",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        model: "gpt-test",
        modelProvider: "openai",
        serviceTier: null,
        effort: "high",
        summary: null,
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-test",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
      },
    };
  }

  describe("Codex 30751 thread goal transcript", () => {
    test("stores the slash command only in canonical turn params", () => {
      const state = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal);
      const turn = state.turns[0];
      const input = turn?.params.input[0];
      expect(String(state.turns.length)).toBe("1");
      expect(turn?.turnId).toBe(null);
      expect(turn?.status).toBe("completed");
      expect(String(turn?.items.length ?? -1)).toBe("0");
      expect(turn?.turnStartedAtMs).toBe(2000);
      expect(input?.type).toBe("text");
      expect(input?.type === "text" ? input.text : "").toBe("/goal Ship parity");
      expect(input?.type === "text" ? String(input.text_elements.length) : "-1").toBe("0");
      expect(turn?.params.approvalPolicy).toBe("never");
      expect(turn?.params.model).toBe(null);
      expect(turn?.params.effort).toBe("minimal");
    });

    test("deduplicates the exact latest local turn and exposes a slash-free view projection", () => {
      const appended = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal);
      const duplicate = appendCodexCanonicalThreadGoalTranscriptTurn(appended, goal);
      const projection = buildCodexThreadGoalTranscriptProjection(goal);

      expect(duplicate === appended).toBe(true);
      expect(projection.promptText).toBe("/goal Ship parity");
      expect(projection.message).toBe("Ship parity");
      expect(projection.sentAtMs).toBe(2000);
      expect(
        appendCodexCanonicalThreadGoalTranscriptTurn({ ...buildState(), id: "other" }, goal).turns
          .length,
      ).toBe(0);
    });

    test("projects the local params turn without fabricating a protocol user item", () => {
      const turn = appendCodexCanonicalThreadGoalTranscriptTurn(buildState(), goal).turns[0];
      if (!turn) throw new Error("Missing goal turn");

      const projected = applyCodexLifecycleProjectionDiff({
        threadId: goal.threadId,
        turnKey: "turn-index-0",
        beforeTurn: null,
        afterTurn: turn,
        currentViews: [],
        currentTranscript: [],
        observedAtMs: 2000,
      });

      expect(projected.views).toHaveLength(1);
      expect(projected.views[0]).toMatchObject({
        turnId: null,
        itemId: "turn-index-0:input",
        markdownText: "Ship parity",
        goal: true,
      });
      expect(projected.views[0]?.rawItem).toBeUndefined();
    });
  });
});

describe("codex thread metadata", () => {
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
      environments: null,
      id: "thread-token",
      extra: null,
      sessionId: "session-1",
      forkedFromId: null,
      attachedToThreadId: null,
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
      originator: null,
      cliVersion: "test",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      daybreakEnabled: null,
      name,
    };
  }

  const settings: ThreadSettings = {
    disabledPluginIds: [],
    cwd: "/new",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    environments: null,
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
    test.each([
      { version: "0.150.0-alpha.8", mode: "paginated" as const, fork: null, enabled: false },
      { version: "0.150.0-alpha.9", mode: "paginated" as const, fork: null, enabled: true },
      { version: "0.162.0-alpha.17.2", mode: "paginated" as const, fork: null, enabled: true },
      { version: "0.0.0", mode: "paginated" as const, fork: null, enabled: false },
      { version: "unknown", mode: "paginated" as const, fork: null, enabled: false },
      { version: "0.162.0-alpha.17.2", mode: "legacy" as const, fork: null, enabled: false },
      { version: "0.162.0-alpha.17.2", mode: "paginated" as const, fork: "parent", enabled: false },
    ])(
      "canonical mixed history qualification: $version / $mode / fork=$fork",
      ({ version, mode, fork, enabled }) => {
        const thread = {
          ...buildThread("Mixed"),
          cliVersion: version,
          historyMode: mode,
          forkedFromId: fork,
        };
        expect(
          createCodexCanonicalConversationMetadata(thread, "local").canonicalVoiceHistory,
        ).toBe(enabled);
      },
    );

    test("native start, metadata refresh and resume keep mixed-history qualification current", () => {
      const native: Thread = {
        ...buildThread("Mixed"),
        cliVersion: "0.162.0-alpha.17.2",
        historyMode: "paginated",
        forkedFromId: null,
        turns: [],
      };
      const started = reduceCodexConversationThreadStarted(buildState(), native);
      expect(started.canonicalVoiceHistory).toBe(true);
      const refreshed = refreshCodexConversationThreadMetadata(
        buildState(),
        native.id,
        () => native,
      );
      expect(refreshed.canonicalVoiceHistory).toBe(true);
      const forked = { ...native, forkedFromId: "parent" };
      expect(
        refreshCodexConversationThreadMetadata(refreshed, native.id, () => forked)
          .canonicalVoiceHistory,
      ).toBe(false);
      const resumed = {
        ...buildState(),
        ...createCodexCanonicalConversationMetadata(native, "local"),
      };
      expect(
        reconcileCodexResumedConversationState({ existing: buildState(), resumed, thread: native })
          .canonicalVoiceHistory,
      ).toBe(true);
      expect(
        reconcileCodexResumedConversationState({
          existing: resumed,
          resumed: { ...resumed, ...createCodexCanonicalConversationMetadata(forked, "local") },
          thread: forked,
        }).canonicalVoiceHistory,
      ).toBe(false);
    });
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
      expect(createCodexCanonicalConversationMetadata(buildThread("---"), "local").title).toBe(
        "---",
      );

      const renamed = reduceCodexConversationThreadName(
        buildState(),
        "thread-token",
        "**Renamed** [thread](https://example.com)",
      );
      expect(renamed.title).toBe("Renamed thread");
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
        createdAt: 1_000,
        updatedAt: 8_000,
        recencyAt: 7_000,
        previousTurnModel: "gpt-before-resume",
        latestTokenUsageInfo: usage,
        threadSource: "user",
        gitInfo: { sha: "abc", branch: "main", originUrl: null },
        lastInjectedPassiveContextKey: "confirmed-passive-context",
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
      expect(reconciled.createdAt).toBe(1_000);
      expect(reconciled.updatedAt).toBe(9_000);
      expect(reconciled.recencyAt).toBe(7_000);
      expect(reconciled.threadSource).toBe("user");
      expect(reconciled.gitInfo).toEqual(existing.gitInfo);
      expect(reconciled.latestTokenUsageInfo).toBe(usage);
      expect(reconciled.previousTurnModel).toBe("gpt-before-resume");
      expect(reconciled.lastInjectedPassiveContextKey).toBe("confirmed-passive-context");
      expect(reconciled.latestThreadSettings?.summary).toBe(settings.summary);
      expect(reconciled.latestThreadSettings?.personality).toBe(settings.personality);
      expect(reconciled.latestModel).toBe("gpt-resumed");
      expect(reconciled.latestReasoningEffort).toBe("medium");
      expect(reconciled.latestCollaborationMode.settings.model).toBe("gpt-resumed");
      expect(reconciled.latestCollaborationMode.settings.reasoning_effort).toBe("medium");
    });

    test("resume preserves an existing cleanup-only native queue receipt", () => {
      const raw = {
        id: "native",
        clientUserMessageId: "client",
        responsesapiClientMetadata: null,
        input: [{ type: "text" as const, text: "Accepted input", text_elements: [] }],
      };
      const existing = { ...buildState(), unconfirmedServerQueueMessages: [raw] };
      const resumed = { ...buildState(), unconfirmedServerQueueMessages: undefined };
      const after = reconcileCodexResumedConversationState({
        existing,
        resumed,
        thread: { ...buildThread("Resumed"), turns: [] },
      });
      expect(after.unconfirmedServerQueueMessages).toEqual([raw]);
    });

    test.each([false, true])(
      "merged resume records completed native queue cleanup only with owner admission: %s",
      (recordNativeQueueAcceptance) => {
        const raw = {
          id: "native",
          clientUserMessageId: "client",
          responsesapiClientMetadata: null,
          input: [{ type: "text" as const, text: "Accepted input", text_elements: [] }],
        };
        const turn = createCodexCanonicalTurnState(
          {
            rootTurnId: null,
            id: "restored",
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
          {
            threadId: "thread-token",
            input: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            environments: null,
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            model: "test",
            cwd: "/work",
            attachments: [],
            effort: null,
            summary: "none",
            personality: null,
            outputSchema: null,
            collaborationMode: null,
          },
        );
        const resumed: CodexCanonicalConversationState = {
          ...buildState(),
          turns: [
            {
              ...turn,
              items: [
                {
                  type: "steeringUserMessage",
                  id: "pending",
                  targetTurnId: "restored",
                  targetTurnStartedAtMs: 1000,
                  status: "accepted",
                  serverUserMessageId: "actual-echo",
                  clientUserMessageId: raw.clientUserMessageId,
                  input: raw.input,
                  acceptedInput: raw.input,
                  serverQueuedSubmission: raw,
                  attachments: [],
                  restoreMessage: { context: { commentAttachments: [] } },
                  compareKey: { rawText: "Accepted input", imageCount: 0 },
                },
              ],
              completedItemIds: { "actual-echo": true },
            },
          ],
        };
        const result = reconcileCodexResumedConversationState({
          existing: buildState(),
          resumed,
          thread: { ...buildThread("Resumed"), turns: [] },
          recordNativeQueueAcceptance,
        });
        expect(result.unconfirmedServerQueueMessages).toEqual(
          recordNativeQueueAcceptance ? [raw] : undefined,
        );
      },
    );

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

      const idle = reduceCodexConversationThreadStatus(configured, "thread-token", {
        type: "idle",
      });
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

    test("keeps goal completion attached to its original turn after later prompts and duplicate notifications", () => {
      const makeTurn = (id: string) =>
        createCodexCanonicalTurnState(
          {
            rootTurnId: null,
            id,
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
          {
            threadId: "thread-token",
            input: [],
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            environments: null,
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            model: "test",
            cwd: "/work",
            attachments: [],
            effort: null,
            summary: "none",
            personality: null,
            outputSchema: null,
            collaborationMode: null,
          },
        );
      const before = { ...buildState(), turns: [makeTurn("completed-turn")] };
      const goal = {
        threadId: "thread-token",
        objective: "Finish",
        status: "complete" as const,
        tokenBudget: null,
        tokensUsed: 10,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 4,
      };
      const completed = reduceCodexConversationThreadGoalUpdated(
        before,
        "thread-token",
        goal,
      ).state;
      expect(completed.completedThreadGoalTurnId).toBe("completed-turn");
      const cleared = reduceCodexConversationThreadGoalCleared(completed, "thread-token");
      const later = { ...cleared, turns: [...cleared.turns, makeTurn("later-turn")] };
      const duplicate = reduceCodexConversationThreadGoalUpdated(later, "thread-token", goal).state;
      expect(duplicate.completedThreadGoalTurnId).toBe("completed-turn");
      const resumed = reduceCodexConversationThreadGoalUpdated(duplicate, "thread-token", {
        ...goal,
        status: "active",
        updatedAt: 5,
      }).state;
      expect(resumed.completedThreadGoalTurnId).toBeNull();
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
});

describe("codex thread settings update", () => {
  const initial = () =>
    createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread([]), {
      hostId: "local",
      model: "first",
      reasoningEffort: "high",
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    });

  describe("partial conversation settings", () => {
    test("preserves explicit null effort and leaves unrelated settings absent", () => {
      const state = initial();
      const next = produce(state, (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, { effort: null }),
      );
      expect(next.latestReasoningEffort).toBeNull();
      expect(next.latestCollaborationMode.settings.reasoning_effort).toBeNull();
      expect(next.latestThreadSettings?.model).toBe(state.latestModel);
      expect(next.latestThreadSettings).not.toHaveProperty("approvalPolicy");
      expect(next.hydrationContext).toBe(state.hydrationContext);
    });
    test("named permissions and sandbox overrides clear the previous profile independently", () => {
      const named = produce(initial(), (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, { permissions: "workspace" }),
      );
      expect(named.latestThreadSettings?.activePermissionProfile).toEqual({
        id: "workspace",
        extends: null,
      });
      const sandbox = produce(named, (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, {
          sandboxPolicy: { type: "readOnly", networkAccess: false },
        }),
      );
      expect(sandbox.latestThreadSettings?.activePermissionProfile).toBeNull();
      expect(sandbox.latestThreadSettings?.permissions).toBeNull();
      const explicit = produce(sandbox, (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, {
          permissions: "other",
          activePermissionProfile: { id: "explicit", extends: null },
        }),
      );
      expect(explicit.latestThreadSettings?.activePermissionProfile?.id).toBe("explicit");
    });
    test("collaboration settings supply model and effort while explicit scalar values take precedence", () => {
      const state = initial();
      const mode = {
        ...state.latestCollaborationMode,
        settings: {
          ...state.latestCollaborationMode.settings,
          model: "mode",
          reasoning_effort: "low" as const,
        },
      };
      const next = produce(state, (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, {
          collaborationMode: mode,
          model: "scalar",
          effort: null,
          cwd: null,
        }),
      );
      expect(next.latestModel).toBe("scalar");
      expect(next.latestReasoningEffort).toBeNull();
      expect(next.latestCollaborationMode).toEqual(mode);
      expect(next.cwd).toBe(state.cwd);
    });
  });

  function clientHarness() {
    let state = initial();
    let support: "unknown" | "supported" | "unsupported" = "unknown";
    const calls: string[] = [];
    const updates: import("@nodex/codex-app-server-protocol/v2").ThreadSettingsUpdateParams[] = [];
    let send: () => Promise<unknown> = async () => undefined;
    const client: import("./codex-thread-settings-update").CanonicalThreadSettingsClient = {
      getConversation: () => state,
      updateConversation: (_id, recipe) => {
        state = produce(state, recipe);
      },
      getSupport: () => support,
      setSupport: (next) => {
        support = next;
      },
      isUnsupported: (error) => error === "unsupported",
      updateThread: async (params) => {
        calls.push("thread");
        updates.push(params);
        return send();
      },
    };
    return {
      client,
      calls,
      updates,
      read: () => state,
      send: (next: typeof send) => {
        send = next;
      },
    };
  }

  test("peer settings update only the supported native controls", async () => {
    const f = clientHarness();
    const peerPatch = {
      model: "changed",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      permissions: "readonly",
    };
    const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
    await updateCanonicalThreadSettings(f.client, "id", peerPatch);
    expect(f.updates).toEqual([{ threadId: "id", model: "changed" }]);
    expect(f.read().latestModel).toBe("changed");
    expect(f.read().latestThreadSettings).not.toHaveProperty("permissions");
  });

  test("a native settings notification wins the in-flight update", async () => {
    const f = clientHarness();
    f.send(async () => {
      f.client.updateConversation("id", (draft) =>
        mutateCanonicalThreadSettingsPatch(draft, { model: "notification" }),
      );
    });
    const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
    expect(await updateCanonicalThreadSettings(f.client, "id", { model: "request" })).toBe(true);
    expect(f.read().latestModel).toBe("notification");
    expect(f.calls).toEqual(["thread"]);
  });

  test("condition failure performs neither native request nor local mutation", async () => {
    const f = clientHarness();
    const before = f.read();
    const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
    expect(
      await updateCanonicalThreadSettings(
        f.client,
        "id",
        { model: "request" },
        { ifEffortEquals: "low" },
      ),
    ).toBe(false);
    expect(f.read()).toBe(before);
    expect(f.calls).toEqual([]);
  });

  test("only unsupported method errors switch future updates to local fallback", async () => {
    const f = clientHarness();
    const { updateCanonicalThreadSettings } = await import("./codex-thread-settings-update");
    f.send(async () => {
      throw new Error("disconnected");
    });
    await expect(
      updateCanonicalThreadSettings(f.client, "id", { model: "failed" }),
    ).rejects.toThrow("disconnected");
    expect(f.client.getSupport()).toBe("unknown");
    f.send(async () => {
      throw "unsupported";
    });
    await updateCanonicalThreadSettings(f.client, "id", { model: "fallback" });
    await updateCanonicalThreadSettings(f.client, "id", { model: "next" });
    expect(f.read().latestModel).toBe("next");
    expect(f.calls).toEqual(["thread", "thread"]);
  });
});

describe("codex turn metadata", () => {
  const THREAD_ID = "thread-turn-metadata";

  function buildState(): CodexCanonicalConversationState {
    return createCodexCanonicalHydratedConversationState(
      {
        model: null,
        reasoningEffort: null,
        environments: null,
        id: THREAD_ID,
        extra: null,
        sessionId: "session-turn-metadata",
        forkedFromId: null,
        attachedToThreadId: null,
        parentThreadId: null,
        preview: "",
        ephemeral: false,
        section: null,
        sectionEnteredAt: null,
        projectId: null,
        historyMode: "paginated",
        modelProvider: "openai",
        createdAt: 1,
        updatedAt: 1,
        recencyAt: 1,
        status: { type: "idle" },
        path: null,
        cwd: "/workspace",
        originator: null,
        cliVersion: "test",
        source: "appServer",
        canAcceptDirectInput: true,
        threadSource: null,
        agentNickname: null,
        agentRole: null,
        gitInfo: null,
        daybreakEnabled: null,
        name: null,
        turns: [
          {
            rootTurnId: null,
            id: "turn-1",
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
            items: [],
          },
        ],
      },
      {
        hostId: "local",
        ...{
          model: "gpt-test",
          reasoningEffort: "high",
          cwd: "/workspace",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/workspace"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/workspace"],
          hasUnreadTurn: false,
        },
      },
    );
  }

  function hookRun(status: HookRunSummary["status"], completedAt: bigint | null): HookRunSummary {
    return {
      id: "hook-1",
      eventName: "preToolUse",
      handlerType: "command",
      executionMode: "sync",
      scope: "turn",
      sourcePath: "/workspace/.codex/hook.json",
      source: "project",
      displayOrder: 1n,
      status,
      statusMessage: "Preparing context",
      startedAt: 10n,
      completedAt,
      durationMs: completedAt === null ? null : completedAt - 10n,
      entries: [],
    };
  }

  describe("Codex 30751 turn metadata", () => {
    test("stores diff and safety metadata on the canonical turn", () => {
      const diffed = reduceCodexConversationTurnDiff(
        buildState(),
        THREAD_ID,
        "turn-1",
        "diff --git a/file.ts b/file.ts",
        10,
      );
      const buffered = reduceCodexConversationSafetyBuffering(
        diffed.state,
        THREAD_ID,
        "turn-1",
        {
          useCases: ["latency"],
          reasons: ["warming"],
          showBufferingUi: true,
          fasterModel: "gpt-fast",
        },
        11,
      );
      expect(diffed.state.turns[0]?.diff).toBe("diff --git a/file.ts b/file.ts");
      expect(buffered.state.turns[0]?.safetyBuffering?.showBufferingUi).toBe(true);
      expect(buffered.state.turns[0]?.safetyBuffering?.fasterModel).toBe("gpt-fast");
    });

    test("preserves a hook occurrence identity and suffixes repeated completed runs", () => {
      const started = reduceCodexConversationHookRun(
        buildState(),
        THREAD_ID,
        "turn-1",
        "hook/started",
        hookRun("running", null),
        20,
      );
      const completed = reduceCodexConversationHookRun(
        started.state,
        THREAD_ID,
        "turn-1",
        "hook/completed",
        hookRun("completed", 20n),
        21,
      );
      const repeated = reduceCodexConversationHookRun(
        completed.state,
        THREAD_ID,
        "turn-1",
        "hook/completed",
        hookRun("completed", 30n),
        31,
      );

      expect(started.effects[0]?.type).toBe("markConversationStreaming");
      expect(completed.state.turns[0]?.hookRuns?.[0]?.id).toBe("hook-1");
      expect(completed.state.turns[0]?.hookRuns?.[0]?.run.status).toBe("completed");
      expect(repeated.state.turns[0]?.hookRuns?.[1]?.id).toBe("hook-1:1");
    });

    test("synthesizes a missing started turn and routes null hook turn ids to latest", () => {
      const empty = { ...buildState(), turns: [] };
      const synthesized = reduceCodexConversationHookRun(
        empty,
        THREAD_ID,
        "turn-synthesized",
        "hook/started",
        hookRun("running", null),
        40,
      );
      const completed = reduceCodexConversationHookRun(
        synthesized.state,
        THREAD_ID,
        null,
        "hook/completed",
        hookRun("completed", 50n),
        50,
      );

      expect(synthesized.state.turns[0]?.turnId).toBe("turn-synthesized");
      expect(synthesized.state.turns[0]?.turnStartedAtMs).toBe(40);
      expect(completed.state.turns[0]?.hookRuns?.[0]?.run.completedAt).toBe(50n);
    });

    test("appends opaque plan, reroute, and error occurrences instead of upserting fixed IDs", () => {
      const plan = {
        method: "turn/plan/updated",
        params: {
          threadId: THREAD_ID,
          turnId: "turn-1",
          explanation: "Inspect first",
          plan: [{ step: "Inspect bundle", status: "inProgress" }],
        },
      } satisfies ServerNotification;
      const firstPlan = reduceCodexConversationTurnPlan(buildState(), plan, "todo-1", 10);
      const secondPlan = reduceCodexConversationTurnPlan(firstPlan.state, plan, "todo-2", 11);
      const rerouted = reduceCodexConversationModelRerouted(
        secondPlan.state,
        {
          method: "model/rerouted",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            fromModel: "gpt-a",
            toModel: "gpt-b",
            reason: "highRiskCyberActivity",
          },
        },
        "reroute-1",
        12,
      );
      const errored = reduceCodexConversationError(
        rerouted.state,
        {
          method: "error",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            error: {
              message: "Tool failed",
              codexErrorInfo: null,
              additionalDetails: "exit 1",
              misalignment: null,
            },
            willRetry: false,
          },
        },
        "error-1",
        13,
      );

      expect(errored.state.turns[0]?.items.map((item) => item.id).join(",")).toBe(
        "todo-1,todo-2,reroute-1,error-1",
      );
      expect(errored.state.turns[0]?.items[2]?.type).toBe("modelRerouted");
      expect(errored.state.turns[0]?.items[3]?.type).toBe("error");
    });

    test("upserts one review occurrence, preserves its start, and appends guardian warning", () => {
      const started = reduceCodexConversationAutomaticApprovalReview(
        buildState(),
        {
          method: "item/autoApprovalReview/started",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            startedAtMs: 1,
            reviewId: "review-1",
            targetItemId: "command-1",
            review: {
              status: "inProgress",
              riskLevel: "medium",
              userAuthorization: "unknown",
              rationale: null,
            },
            action: {
              type: "command",
              source: "unifiedExec",
              command: "pnpm test",
              cwd: "/workspace",
            },
          },
        },
        100,
      );
      const completed = reduceCodexConversationAutomaticApprovalReview(
        started.state,
        {
          method: "item/autoApprovalReview/completed",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            startedAtMs: 1,
            completedAtMs: 2,
            reviewId: "review-1",
            targetItemId: "command-1",
            decisionSource: "agent",
            review: {
              status: "denied",
              riskLevel: "high",
              userAuthorization: "low",
              rationale: "Too risky",
            },
            action: {
              type: "command",
              source: "unifiedExec",
              command: "pnpm test",
              cwd: "/workspace",
            },
          },
        },
        200,
      );
      const warned = reduceCodexConversationGuardianWarning(
        completed.state,
        THREAD_ID,
        "warning-1",
      );
      const review = warned.state.turns[0]?.items[0];
      const event =
        review?.type === "automaticApprovalReview"
          ? (review.event as {
              status?: string;
              action?: {
                source?: string;
              };
            })
          : null;

      expect(warned.state.turns[0]?.items.length).toBe(2);
      expect(review?.type).toBe("automaticApprovalReview");
      expect(review?.type === "automaticApprovalReview" ? review.startedAtMs : null).toBe(100);
      expect(event?.status).toBe("denied");
      expect(event?.action?.source).toBe("unified_exec");
      expect(started.state.updatedAt).toBe(100);
      expect(completed.state.updatedAt).toBe(200);
      expect(warned.state.turns[0]?.items[1]?.type).toBe("autoReviewInterruptionWarning");
    });

    test("preserves stdin approval identity in automatic-review metadata", () => {
      const completed = reduceCodexConversationAutomaticApprovalReview(
        buildState(),
        {
          method: "item/autoApprovalReview/completed",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-1",
            startedAtMs: 1,
            completedAtMs: 2,
            reviewId: "review-stdin",
            targetItemId: "command-1",
            decisionSource: "agent",
            review: {
              status: "denied",
              riskLevel: "high",
              userAuthorization: "low",
              rationale: "Interactive input requires approval",
            },
            action: {
              type: "writeStdin",
              approvalId: "approval-stdin",
              processId: "process-1",
              stdin: "yes\n",
              cwd: "/workspace",
            },
          },
        },
        200,
      );
      const review = completed.state.turns[0]?.items[0];
      const action =
        review?.type === "automaticApprovalReview"
          ? (
              review.event as {
                action?: Record<string, unknown>;
              }
            ).action
          : null;

      expect(action).toEqual({
        type: "write_stdin",
        approval_id: "approval-stdin",
        process_id: "process-1",
        stdin: "yes\n",
        cwd: "/workspace",
      });
    });
  });
});

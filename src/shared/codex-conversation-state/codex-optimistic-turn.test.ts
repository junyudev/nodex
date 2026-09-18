import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import {
  mutateCodexTurnStartRejection,
  type CodexPreparedTurnExecution,
} from "./codex-turn-execution";
import type { Turn } from "@nodex/codex-app-server-protocol/v2/Turn";
import {
  createCodexCanonicalHydratedConversationState,
  appendCodexCanonicalWorktreeInitItem,
  type CodexCanonicalLiveTurnParams,
} from "./codex-conversation-state";
import {
  appendCodexCanonicalOptimisticFirstTurn,
  appendCodexCanonicalOptimisticTurn,
  bindCodexCanonicalOptimisticTurn,
  failCodexCanonicalOptimisticTurn,
  removeCodexCanonicalOptimisticTurn,
} from "./codex-optimistic-turn";

function buildState() {
  return createCodexCanonicalHydratedConversationState(
    {
      model: null,
      reasoningEffort: null,
      id: "thread-created",
      environments: null,
      extra: null,
      sessionId: "session-created",
      forkedFromId: null,
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
      threadSource: "subagent",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      daybreakEnabled: null,
      turns: [],
    },
    {
      hostId: "local",
      ...{
        model: "gpt-test",
        reasoningEffort: "medium",
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
        activePermissionProfile: { id: ":workspace", extends: null },
        runtimeWorkspaceRoots: ["/workspace"],
        pendingRequests: [],
        hasUnreadTurn: false,
      },
    },
  );
}

function buildParams(): CodexCanonicalLiveTurnParams {
  return {
    threadId: "thread-created",
    clientUserMessageId: "client-message",
    input: [{ type: "text", text: "delegated", text_elements: [] }],
    cwd: "/workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    permissions: ":workspace",
    runtimeWorkspaceRoots: ["/workspace"],
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: ["/workspace"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
    useAppServerPermissionDefault: false,
    model: null,
    serviceTier: "fast",
    effort: "medium",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
  };
}

const preparedExecution = (before = buildState()): CodexPreparedTurnExecution => ({
  model: null,
  reasoningEffort: null,
  shouldUpdateReasoningEffort: true,
  collaborationMode: {
    mode: "plan",
    settings: {
      model: "selected-model",
      reasoning_effort: "high",
      developer_instructions: "Keep selected instructions",
    },
  },
  permissions: {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  },
  previousPermissions: before.currentPermissions,
});

describe("prepared Turn execution context", () => {
  test("updates execution metadata and permissions without manufacturing next-Turn settings", () => {
    const before = buildState();
    const execution = preparedExecution(before);
    const after = appendCodexCanonicalOptimisticTurn(before, { params: buildParams(), execution });
    expect(after.latestModel).toBe(before.latestModel);
    expect(after.latestReasoningEffort).toBeNull();
    expect(after.latestCollaborationMode).toBe(execution.collaborationMode);
    expect(after.currentPermissions).toBe(execution.permissions);
    expect(after.latestThreadSettings).toBe(before.latestThreadSettings);
    expect(after.hydrationContext).toBe(before.hydrationContext);
    expect(after.turns[0]?.params).toEqual(buildParams());
  });

  test("keeps current permissions until a pending workspace is accepted", () => {
    const before = buildState();
    const execution: CodexPreparedTurnExecution = {
      ...preparedExecution(before),
      workspaceKind: "project",
      pendingWorkspace: {
        projectSources: ["/next-project"],
        cwd: "/next-project",
        runtimeWorkspaceRoots: ["/next-project"],
      },
    };
    const after = appendCodexCanonicalOptimisticTurn(before, { params: buildParams(), execution });

    expect(after.currentPermissions).toBe(before.currentPermissions);
  });

  test("publishes an owner-prepared projectless workspace before dispatch", () => {
    const before = produce(buildState(), (draft) => {
      draft.workspaceKind = "projectless";
      draft.workspaceBrowserRoot = null;
      draft.cwd = "/outside";
    });
    const execution: CodexPreparedTurnExecution = {
      ...preparedExecution(before),
      workspaceKind: "projectless",
      projectlessWorkspace: {
        cwd: "/Users/test/Documents/Nodex/2026-09-17/new-chat",
        workspaceRoot: "/Users/test/Documents/Nodex",
      },
      pendingWorkspace: null,
    };
    const after = appendCodexCanonicalOptimisticTurn(before, { params: buildParams(), execution });

    expect(after.workspaceKind).toBe("projectless");
    expect(after.workspaceBrowserRoot).toBe("/Users/test/Documents/Nodex");
    expect(after.cwd).toBe("/Users/test/Documents/Nodex/2026-09-17/new-chat");
    expect(after.currentPermissions).toBe(execution.permissions);
  });

  test.each([
    { explicit: false, effort: null, expected: "high" },
    { explicit: true, effort: null, expected: null },
    { explicit: false, effort: "low" as const, expected: "low" },
  ])(
    "retains effort only when a null resolution is implicit: $explicit / $effort",
    ({ explicit, effort, expected }) => {
      const before = { ...buildState(), latestReasoningEffort: "high" as const };
      const after = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution: {
          ...preparedExecution(before),
          reasoningEffort: effort,
          shouldUpdateReasoningEffort: explicit,
        },
      });
      expect(after.latestReasoningEffort).toBe(expected);
    },
  );

  test.each([true, false])(
    "restores permission presence after rejecting an empty Turn: $0",
    (hadPermissions) => {
      const before = produce(buildState(), (draft) => {
        draft.hydrationContext = null;
        if (!hadPermissions) delete draft.currentPermissions;
      });
      const execution = preparedExecution(before);
      const pending = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution,
      });
      expect(pending.currentPermissions).toBe(execution.permissions);
      const after = produce(pending, (draft) =>
        mutateCodexTurnStartRejection(draft, {
          clientUserMessageId: "client-message",
          previousPermissions: before.currentPermissions,
          message: "Native request rejected",
          failureItemId: "failed",
          restoreRuntimeStatus: before.threadRuntimeStatus,
        }),
      );
      expect(after.turns).toHaveLength(0);
      expect(after.currentPermissions).toBe(before.currentPermissions);
      expect(Object.hasOwn(after, "currentPermissions")).toBe(hadPermissions);
      expect(after.hydrationContext).toBeNull();
      expect(after.latestCollaborationMode).toBe(execution.collaborationMode);
      expect(after.threadRuntimeStatus).toBe(before.threadRuntimeStatus);
    },
  );

  test("retains received content and newer settings when a submitted Turn fails", () => {
    const before = buildState();
    const execution = preparedExecution(before);
    const pending = appendCodexCanonicalOptimisticTurn(before, {
      params: buildParams(),
      execution,
    });
    const observed = produce(pending, (draft) => {
      draft.turns[0]!.items.push({
        type: "agentMessage",
        id: "partial",
        text: "Already received",
        phase: "commentary",
        delivery: null,
        memoryCitation: null,
        questions: null,
      });
      draft.latestThreadSettings = {
        model: "newer-setting",
        effort: "high",
        collaborationMode: before.latestCollaborationMode,
        personality: "pragmatic",
      };
    });
    const after = produce(observed, (draft) =>
      mutateCodexTurnStartRejection(draft, {
        clientUserMessageId: "client-message",
        previousPermissions: before.currentPermissions,
        message: "Submission failed after content arrived",
        failureItemId: "failed",
      }),
    );
    expect(after.turns[0]?.items[0]).toEqual(observed.turns[0]?.items[0]);
    expect(after.turns[0]?.status).toBe("failed");
    expect(after.turns[0]?.error?.message).toBe("Submission failed after content arrived");
    expect(after.latestThreadSettings).toBe(observed.latestThreadSettings);
    expect(after.currentPermissions).toBe(before.currentPermissions);
  });

  test.each(["assigned", "completed", "missing"] as const)(
    "a late rejection cannot change a %s Turn or its status",
    (kind) => {
      const before = buildState();
      const pending = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution: preparedExecution(before),
      });
      const observed = produce(pending, (draft) => {
        if (kind === "assigned") draft.turns[0]!.turnId = "native-turn";
        if (kind === "completed") draft.turns[0]!.status = "completed";
        if (kind === "missing") draft.turns[0]!.params.clientUserMessageId = "another-client";
        draft.threadRuntimeStatus = { type: "active", activeFlags: [] };
      });
      const after = produce(observed, (draft) =>
        mutateCodexTurnStartRejection(draft, {
          clientUserMessageId: "client-message",
          previousPermissions: before.currentPermissions,
          message: "Late native error",
          failureItemId: "failed",
          restoreRuntimeStatus: before.threadRuntimeStatus,
        }),
      );
      expect(after.turns).toBe(observed.turns);
      expect(after.threadRuntimeStatus).toBe(observed.threadRuntimeStatus);
      expect(after.currentPermissions).toBe(before.currentPermissions);
    },
  );

  test("an uncertain injection retains its empty placeholder as a failed Turn", () => {
    const before = buildState();
    const pending = appendCodexCanonicalOptimisticTurn(before, {
      params: buildParams(),
      execution: preparedExecution(before),
    });
    const after = produce(pending, (draft) =>
      mutateCodexTurnStartRejection(draft, {
        clientUserMessageId: "client-message",
        previousPermissions: before.currentPermissions,
        message: "Injection outcome is unknown",
        failureItemId: "failed",
        retainTurn: true,
        restoreRuntimeStatus: before.threadRuntimeStatus,
      }),
    );
    expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({
      turnId: null,
      status: "failed",
      error: { message: "Injection outcome is unknown" },
    });
    expect(after.currentPermissions).toBe(before.currentPermissions);
    expect(after.threadRuntimeStatus).toBe(before.threadRuntimeStatus);
  });
});

describe("Codex optimistic worktree initialization ordering", () => {
  test("publishes worktree initialization inside the optimistic first turn", () => {
    const state = appendCodexCanonicalOptimisticFirstTurn(
      buildState(),
      { params: buildParams(), startedAtMs: 42 },
      {
        type: "worktreeInit",
        id: "pending:1",
        worktreeOutputText: "created\n",
        setup: null,
      },
    );

    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]?.status).toBe("inProgress");
    expect(state.turns[0]?.items[0]?.type).toBe("worktreeInit");
    expect(state.turns[0]?.params.clientUserMessageId).toBe("client-message");
  });

  test("publishes the exact nullable in-progress placeholder before dispatch", () => {
    const state = appendCodexCanonicalOptimisticTurn(buildState(), {
      params: buildParams(),
      startedAtMs: 42,
    });
    const turn = state.turns[0];

    expect(turn?.turnId).toBe(null);
    expect(turn?.status).toBe("inProgress");
    expect(turn?.turnStartedAtMs).toBe(42);
    expect(state.updatedAt).toBe(42);
    expect(state.recencyAt).toBe(42);
    expect(state.threadRuntimeStatus).toEqual({ type: "active", activeFlags: [] });
    expect(turn?.params.clientUserMessageId).toBe("client-message");
    expect(turn?.entityKey).toBe("turn-local:client-message");
    expect(turn?.items.length).toBe(0);
  });

  test("retains active runtime flags while submission advances manager timestamps", () => {
    const before = {
      ...buildState(),
      threadRuntimeStatus: { type: "active" as const, activeFlags: ["waitingOnApproval" as const] },
      updatedAt: 100,
      recencyAt: 100,
    };
    const after = appendCodexCanonicalOptimisticTurn(before, {
      params: buildParams(),
      startedAtMs: 42,
    });
    expect(after.threadRuntimeStatus).toBe(before.threadRuntimeStatus);
    expect(after.updatedAt).toBe(42);
    expect(after.recencyAt).toBe(42);
  });

  test("binds the matching placeholder while preserving its launch params", () => {
    const optimistic = appendCodexCanonicalOptimisticTurn(buildState(), {
      params: buildParams(),
      startedAtMs: 42,
    });
    const withWorktreeInit = appendCodexCanonicalWorktreeInitItem(optimistic, {
      type: "worktreeInit",
      id: "pending:1",
      worktreeOutputText: "created\n",
      setup: null,
    });
    const responseTurn: Turn = {
      id: "turn-server",
      items: [
        {
          questions: null,
          type: "agentMessage",
          id: "response-only-item",
          text: "must arrive through lifecycle",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
        },
      ],
      itemsView: "full",
      status: "completed",
      error: {
        message: "response-only error",
        codexErrorInfo: null,
        additionalDetails: null,
        misalignment: null,
      },
      startedAt: 10,
      completedAt: 12,
      durationMs: 2000,
    };
    const bound = bindCodexCanonicalOptimisticTurn(
      withWorktreeInit,
      "client-message",
      responseTurn,
    );

    expect(bound.turns[0]?.turnId).toBe("turn-server");
    expect(bound.turns[0]?.status).toBe("completed");
    expect(bound.turns[0]?.error).toBe(null);
    expect(bound.turns[0]?.durationMs).toBe(null);
    expect(bound.turns[0]?.turnStartedAtMs).toBe(42);
    expect(bound.turns[0]?.params.input[0]?.type).toBe("text");
    expect(bound.turns[0]?.entityKey).toBe("turn-local:client-message");
    expect(bound.turns[0]?.items).toStrictEqual(withWorktreeInit.turns[0]?.items);
  });

  test("prefers an already-bound response turn without overwriting notification state", () => {
    const optimistic = appendCodexCanonicalOptimisticTurn(buildState(), {
      params: buildParams(),
      startedAtMs: 42,
    });
    const existing = optimistic.turns[0];
    if (!existing) throw new Error("Expected optimistic turn");
    const notificationItem = {
      type: "modelChanged" as const,
      id: "notification-item",
      fromModel: "old",
      toModel: "new",
    };
    const raced = {
      ...optimistic,
      turns: [
        {
          ...existing,
          turnId: "turn-server",
          status: "completed" as const,
          durationMs: 90,
          items: [notificationItem],
          completedAtMs: 132,
        },
      ],
    };
    const rebound = bindCodexCanonicalOptimisticTurn(raced, "unrelated-client-id", {
      id: "turn-server",
      items: [],
      itemsView: "full",
      status: "failed",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });

    expect(rebound).toBe(raced);
    expect(rebound.turns[0]?.items).toStrictEqual([notificationItem]);
    expect(rebound.turns[0]?.status).toBe("completed");
    expect(rebound.turns[0]?.durationMs).toBe(90);
    expect(rebound.turns[0]?.completedAtMs).toBe(132);
  });

  test("merges a server turn that raced ahead of its optimistic occurrence", () => {
    const optimistic = appendCodexCanonicalOptimisticTurn(buildState(), {
      params: buildParams(),
      startedAtMs: 42,
    });
    const placeholder = optimistic.turns[0];
    if (!placeholder) throw new Error("Expected optimistic turn");
    const assistant = {
      questions: null,
      type: "agentMessage" as const,
      id: "assistant-streaming",
      text: "partial",
      phase: null,
      memoryCitation: null,
      delivery: null,
    };
    const echo = {
      type: "userMessage" as const,
      id: "server-user-echo",
      clientId: "client-message",
      content: [{ type: "text" as const, text: "delegated", text_elements: [] }],
    };
    const split = {
      ...optimistic,
      turns: [
        placeholder,
        {
          ...placeholder,
          turnId: "turn-server",
          items: [assistant, echo],
          params: { ...placeholder.params, input: [] },
          firstTurnWorkItemStartedAtMs: 50,
        },
      ],
    };

    const rebound = bindCodexCanonicalOptimisticTurn(split, "client-message", {
      id: "turn-server",
      items: [],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });

    expect(rebound.turns).toHaveLength(1);
    expect(rebound.turns[0]?.turnId).toBe("turn-server");
    expect(rebound.turns[0]?.params.input).toEqual(buildParams().input);
    expect(rebound.turns[0]?.turnStartedAtMs).toBe(42);
    expect(rebound.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(50);
    expect(rebound.turns[0]?.items).toEqual([assistant, echo]);
  });

  test("keeps the created thread and terminalizes a failed first request", () => {
    const optimistic = appendCodexCanonicalOptimisticTurn(buildState(), {
      params: buildParams(),
    });
    const failed = failCodexCanonicalOptimisticTurn(optimistic, "client-message");

    expect(failed.id).toBe("thread-created");
    expect(failed.turns[0]?.turnId).toBe(null);
    expect(failed.turns[0]?.status).toBe("failed");
    expect(failed.turns[0]?.error?.message).toBe("Error submitting message");
    expect(failed.turns[0]?.items[0]?.type).toBe("error");
  });

  test("removes a failed userless Resume placeholder without creating an error turn", () => {
    const base = buildState();
    const withPendingModel = {
      ...base,
      previousTurnModel: "gpt-before-resume",
    };
    const optimistic = appendCodexCanonicalOptimisticTurn(withPendingModel, {
      params: { ...buildParams(), input: [] },
    });
    const restored = removeCodexCanonicalOptimisticTurn(optimistic, "client-message", {
      previousTurnModel: "gpt-before-resume",
    });

    expect(restored.turns).toEqual([]);
    expect(restored.previousTurnModel).toBe("gpt-before-resume");
  });

  test("adds the exact model-change marker for a downgrade and consumes the pending model", () => {
    const base = buildState();
    const state = {
      ...base,
      previousTurnModel: "gpt-terra",
      latestCollaborationMode: {
        ...base.latestCollaborationMode,
        settings: { ...base.latestCollaborationMode.settings, model: "gpt-luna" },
      },
    };
    const params = {
      ...buildParams(),
      collaborationMode: {
        mode: "default" as const,
        settings: {
          model: "gpt-luna",
          reasoning_effort: null,
          developer_instructions: null,
        },
      },
    };

    const optimistic = appendCodexCanonicalOptimisticTurn(state, {
      params,
    });

    expect(optimistic.turns[0]?.items[0]).toMatchObject({
      type: "modelChanged",
      fromModel: "gpt-terra",
      toModel: "gpt-luna",
    });
    expect(optimistic.previousTurnModel).toBe(null);

    const upgrade = appendCodexCanonicalOptimisticTurn(
      {
        ...base,
        previousTurnModel: "gpt-luna",
        latestCollaborationMode: {
          ...base.latestCollaborationMode,
          settings: { ...base.latestCollaborationMode.settings, model: "gpt-terra" },
        },
      },
      {
        params: {
          ...params,
          collaborationMode: {
            ...params.collaborationMode,
            settings: { ...params.collaborationMode.settings, model: "gpt-terra" },
          },
        },
      },
    );
    expect(upgrade.turns[0]?.items).toStrictEqual([]);
  });
});

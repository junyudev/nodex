import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  GIT_ACTION_COMMIT_OR_PUSH_PROMPT,
  GIT_ACTION_CREATE_PR_PROMPT,
} from "@/lib/git-action-prompts";
import type { CodexApprovalResponse, CodexProtocolRequestId } from "@/lib/types";
import {
  createThreadStageActions,
  type ThreadActionControllerInput,
} from "./thread-action-controller";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import { isUuidV7 } from "../../../shared/uuid-v7";

afterEach(() => {
  sessionFirstSubmissionOwner.dispose();
});

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  invoke: invokeMock,
}));

vi.mock("@/lib/renderer-command", () => ({
  defineRendererCommand: <Definition>(definition: Definition) => definition,
  invokePlainCommand: (definition: { readonly channel: string }, ...args: readonly unknown[]) =>
    invokeMock(definition.channel, ...args),
  invokeRendererQuery: (...args: readonly unknown[]) => invokeMock(...args),
}));

function buildInput(overrides?: Partial<ThreadActionControllerInput>): ThreadActionControllerInput {
  const settingsUpdates: unknown[] = [];
  const draftModes: string[] = [];
  const draftModels: string[] = [];
  const draftReasoning: string[] = [];

  return {
    activeThreadId: "thread_1",
    codexControl: {
      setConversationThreadSettings: async (threadId: string, patch: unknown) => {
        settingsUpdates.push({ threadId, patch });
        return {
          model: "gpt-5.3-codex",
          reasoningEffort: "high",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-5.3-codex",
              reasoning_effort: "high",
              developer_instructions: null,
            },
          },
        };
      },
      setThreadModel: (model: string) => {
        draftModels.push(model);
      },
      setThreadReasoningEffort: (reasoningEffort: string) => {
        draftReasoning.push(reasoningEffort);
      },
      setPersonality: async () => undefined,
    } as unknown as ThreadActionControllerInput["codexControl"],
    currentSessionId: "session_1",
    currentSessionProjectId: "project_1",
    projectId: "project_1",
    selectedCollaborationMode: "default",
    setSelectedCollaborationMode: (mode) => {
      draftModes.push(mode);
    },
    onOpenThread: () => {},
    onOpenTurnDiffReview: () => {},
    onEnsureDefaultDraftSessionForProject: async () => ({ id: "session_1" }) as never,
    onRefreshProjectSessions: async () => [],
    onQueueingEnabledChange: () => {},
    onNewThreadProjectChange: () => {},
    onRequestNewChatProjectCreate: () => {},
    onNewThreadStartInTargetChange: () => {},
    onNewThreadStartInEnvironmentChange: () => {},
    onRefreshNewThreadStartInEnvironments: async () => {},
    onOpenNewThreadLocalEnvironmentsSettings: () => {},
    ...overrides,
  };
}

describe("createThreadStageActions settings routing", () => {
  test("sets the host personality and current-thread next-turn personality together", async () => {
    const calls: string[] = [];
    const input = buildInput({
      codexControl: {
        setPersonality: async (personality: string) => {
          calls.push(`host:${personality}`);
        },
        setConversationThreadSettings: async (
          threadId: string,
          patch: { personality?: string },
        ) => {
          calls.push(`thread:${threadId}:${patch.personality ?? ""}`);
          return null;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onPersonalityChange?.("pragmatic");

    expect(calls.includes("host:pragmatic")).toBe(true);
    expect(calls.includes("thread:thread_1:pragmatic")).toBe(true);
  });

  test("routes active thread settings through conversation settings update", () => {
    const settingsUpdates: unknown[] = [];
    const draftModes: string[] = [];
    const input = buildInput({
      codexControl: {
        setConversationThreadSettings: async (threadId: string, patch: unknown) => {
          settingsUpdates.push({ threadId, patch });
          return null;
        },
        setThreadModel: () => {
          throw new Error("active thread model changes must not use draft settings");
        },
        setThreadReasoningEffort: () => {
          throw new Error("active thread reasoning changes must not use draft settings");
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      setSelectedCollaborationMode: (mode) => {
        draftModes.push(mode);
      },
    });
    const actions = createThreadStageActions(input);

    void actions.onCollaborationModeChange("plan");
    void actions.onModelChange("gpt-5.9-codex");
    void actions.onReasoningEffortChange("medium");

    expect(JSON.stringify(draftModes)).toBe("[]");
    expect(JSON.stringify(settingsUpdates)).toBe(
      JSON.stringify([
        { threadId: "thread_1", patch: { collaborationMode: "plan" } },
        { threadId: "thread_1", patch: { model: "gpt-5.9-codex" } },
        { threadId: "thread_1", patch: { reasoningEffort: "medium" } },
      ]),
    );
  });

  test("routes new thread settings to local draft fallbacks", () => {
    const draftModes: string[] = [];
    const draftModels: string[] = [];
    const draftReasoning: string[] = [];
    const settingsUpdates: unknown[] = [];
    const input = buildInput({
      activeThreadId: null,
      codexControl: {
        setConversationThreadSettings: async (threadId: string, patch: unknown) => {
          settingsUpdates.push({ threadId, patch });
          return null;
        },
        setThreadModel: (model: string) => {
          draftModels.push(model);
        },
        setThreadReasoningEffort: (reasoningEffort: string) => {
          draftReasoning.push(reasoningEffort);
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      setSelectedCollaborationMode: (mode) => {
        draftModes.push(mode);
      },
    });
    const actions = createThreadStageActions(input);

    void actions.onCollaborationModeChange("plan");
    void actions.onModelChange("gpt-5.9-codex");
    void actions.onReasoningEffortChange("medium");

    expect(JSON.stringify(settingsUpdates)).toBe("[]");
    expect(JSON.stringify(draftModes)).toBe(JSON.stringify(["plan"]));
    expect(JSON.stringify(draftModels)).toBe(JSON.stringify(["gpt-5.9-codex"]));
    expect(JSON.stringify(draftReasoning)).toBe(JSON.stringify(["medium"]));
  });

  test("commits Codex intelligence and Default mode in one awaited settings patch", async () => {
    const settingsUpdates: unknown[] = [];
    const actions = createThreadStageActions(
      buildInput({
        codexControl: {
          setConversationThreadSettings: async (threadId: string, patch: unknown) => {
            settingsUpdates.push({ threadId, patch });
            return null;
          },
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    await actions.onIntelligenceSelectionChange?.(
      {
        kind: "codex",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      },
      { collaborationMode: "default" },
    );

    expect(settingsUpdates).toEqual([
      {
        threadId: "thread_1",
        patch: {
          collaborationMode: "default",
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
        },
      },
    ]);
  });

  test("forwards explicit intelligence overrides to the owner turn start", async () => {
    const calls: unknown[] = [];
    const actions = createThreadStageActions(
      buildInput({
        codexControl: {
          startTurn: async (threadId: string, prompt: string, options: unknown) => {
            calls.push({ threadId, prompt, options });
          },
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    await actions.onSendPrompt("Implement", {
      collaborationMode: "default",
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      serviceTier: "fast",
    });

    expect(calls).toEqual([
      {
        threadId: "thread_1",
        prompt: "Implement",
        options: {
          projectId: "project_1",
          collaborationMode: "default",
          promptInput: undefined,
          model: "gpt-5.6-sol",
          reasoningEffort: "xhigh",
          serviceTier: "fast",
        },
      },
    ]);
  });

  test("opens a pending worktree route with its actual target Session", async () => {
    const calls: string[] = [];
    const input = buildInput({
      activeThreadId: null,
      codexControl: {
        startThreadForSession: async () => ({
          kind: "pending" as const,
          pendingWorktreeId: "local:pending-composer",
          clientThreadId: "client-new-thread:pending-composer",
        }),
      } as unknown as ThreadActionControllerInput["codexControl"],
      currentSessionProjectId: "project_1",
      onEnsureDefaultDraftSessionForProject: async () => ({ id: "session_2" }) as never,
      onOpenPendingWorktree: (clientThreadId, projectSessionId) => {
        calls.push(`open:${clientThreadId}:${projectSessionId}`);
      },
      onRefreshProjectSessions: async (projectId) => {
        calls.push(`refresh:${projectId}`);
        return [];
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onStartThreadForSession?.({
      projectId: "project_2",
      sessionId: "session_1",
      prompt: "Start in a worktree",
      runInTarget: "newWorktree",
    });

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify(["open:client-new-thread:pending-composer:session_2"]),
    );
  });

  test("rejects a second new-task start while canonical worktree setup is pending", async () => {
    const startThreadForSession = vi.fn();
    const actions = createThreadStageActions(
      buildInput({
        activeThreadId: null,
        newThreadStartBlockedReason: "Worktree setup is already in progress",
        codexControl: {
          startThreadForSession,
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    expect(() =>
      actions.onStartThreadForSession?.({
        projectId: "project_1",
        sessionId: "session_1",
        prompt: "Start again",
        runInTarget: "newWorktree",
      }),
    ).toThrow("Worktree setup is already in progress");
    expect(startThreadForSession).not.toHaveBeenCalled();
  });

  test("refreshes real project sessions after a direct session thread starts", async () => {
    const calls: string[] = [];
    const startInputs: unknown[] = [];
    const input = buildInput({
      activeThreadId: null,
      codexControl: {
        startThreadForSession: async (startInput: unknown) => {
          startInputs.push(startInput);
          return {
            kind: "started" as const,
            detail: { threadId: "thread-started" },
          };
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      onOpenPendingWorktree: (clientThreadId) => {
        calls.push(`open:${clientThreadId}`);
      },
      onRefreshProjectSessions: async (projectId) => {
        calls.push(`refresh:${projectId}`);
        return [];
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onStartThreadForSession?.({
      projectId: "project_1",
      sessionId: "session_1",
      prompt: "Start locally",
      threadGoalMaterializedDraft: {
        objective: "Keep the local goal active",
        attachmentDirectory: "/tmp/goal-materialized",
      },
      runInTarget: "localProject",
    });

    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]).toMatchObject({
      projectId: "project_1",
      sessionId: "session_1",
      prompt: "Start locally",
      threadGoalMaterializedDraft: {
        objective: "Keep the local goal active",
        attachmentDirectory: "/tmp/goal-materialized",
      },
      runInTarget: "localProject",
      collaborationMode: "default",
    });
    const firstSubmission = (
      startInputs[0] as {
        firstSubmission: { launchId: string; clientUserMessageId: string };
      }
    ).firstSubmission;
    expect(isUuidV7(firstSubmission.launchId)).toBe(true);
    expect(isUuidV7(firstSubmission.clientUserMessageId)).toBe(true);
    expect(JSON.stringify(calls)).toBe(JSON.stringify(["refresh:project_1"]));
  });

  test("captures the owning Session Browser before an idle task turn starts", async () => {
    const events: string[] = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_channel, command) => {
      events.push(`capture:${command.codexSessionId}`);
      return { ok: true };
    });
    const actions = createThreadStageActions(
      buildInput({
        browserUseViewScopeId: "window-session-1",
        codexControl: {
          startTurn: async (threadId: string) => {
            events.push(`start:${threadId}`);
          },
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    await actions.onSendPrompt?.("Continue", {});

    expect(events).toEqual(["capture:thread_1", "start:thread_1"]);
    expect(invokeMock).toHaveBeenCalledWith("browser-sidebar-command", {
      type: "capture-browser-use-route",
      browserConversationId: "session_1",
      browserViewScopeId: "window-session-1",
      codexSessionId: "thread_1",
      projectId: "project_1",
    });
  });

  test("captures the owning Session Browser before resuming an interrupted turn", async () => {
    const events: string[] = [];
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_channel, command) => {
      events.push(`capture:${command.codexSessionId}`);
      return { ok: true };
    });
    const actions = createThreadStageActions(
      buildInput({
        browserUseViewScopeId: "window-session-1",
        codexControl: {
          resumeInterruptedTurn: async (threadId: string) => {
            events.push(`resume:${threadId}`);
          },
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    await actions.onResumeInterruptedTurn?.();

    expect(events).toEqual(["capture:thread_1", "resume:thread_1"]);
  });

  test("materializes and starts a Project draft exactly once across duplicate submits", async () => {
    const events: string[] = [];
    let releaseStart: () => void = () => undefined;
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (_channel, command) => {
      events.push(`capture:${command.codexSessionId}`);
      return { ok: true };
    });
    const input = buildInput({
      activeThreadId: null,
      browserUseViewScopeId: "window-session-1",
      codexControl: {
        startThreadForSession: async (startInput: { sessionId: string }) => {
          events.push(`start:${startInput.sessionId}`);
          await new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
          return {
            kind: "started" as const,
            detail: { threadId: "thread-started" },
          };
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      onMaterializeProjectDraft: async () => {
        events.push("materialize:draft-1");
        return { id: "session-real", projectId: "project_1" } as never;
      },
      onCommitMaterializedProjectDraft: ({ sessionId }) => {
        events.push(`commit:${sessionId}`);
      },
      onRefreshProjectSessions: async () => {
        events.push("refresh:project_1");
        return [];
      },
    });
    const actions = createThreadStageActions(input);
    const request = {
      projectId: "project_1",
      sessionId: "draft-session",
      projectDraftId: "draft-1",
      prompt: "Start from Home",
      runInTarget: "localProject" as const,
    };

    const first = actions.onStartThreadForSession?.(request);
    const duplicate = actions.onStartThreadForSession?.(request);
    await vi.waitFor(() => {
      expect(events).toEqual(["materialize:draft-1", "capture:session-real", "start:session-real"]);
    });
    expect(first).toBe(duplicate);
    releaseStart();
    await Promise.all([first, duplicate]);
    expect(events.slice(-2)).toEqual(["commit:session-real", "refresh:project_1"]);
    expect(invokeMock).toHaveBeenCalledWith("browser-sidebar-command", {
      type: "capture-browser-use-route",
      browserConversationId: "session-real",
      browserViewScopeId: "window-session-1",
      codexSessionId: "session-real",
      projectId: "project_1",
    });
  });

  test("publishes the first submission before target Session materialization settles", async () => {
    sessionFirstSubmissionOwner.dispose();
    let releaseTarget: (session: { id: string; projectId: string }) => void = () => undefined;
    const targetSession = new Promise<{ id: string; projectId: string }>((resolve) => {
      releaseTarget = resolve;
    });
    const actions = createThreadStageActions(
      buildInput({
        activeThreadId: null,
        currentSessionProjectId: "project_1",
        onEnsureDefaultDraftSessionForProject: async () => (await targetSession) as never,
        codexControl: {
          startThreadForSession: async () => ({
            kind: "started" as const,
            detail: { threadId: "thread-started" },
          }),
        } as unknown as ThreadActionControllerInput["codexControl"],
      }),
    );

    const completion = actions.onStartThreadForSession?.({
      projectId: "project_2",
      sessionId: "session_1",
      prompt: "Remain visible before the target Session exists.",
      runInTarget: "localProject",
    });
    const projected = sessionFirstSubmissionOwner.projectTurns(
      { projectId: "project_1", sessionId: "session_1", threadId: null },
      [],
    );

    expect(projected[0]?.items[0]?.markdownText).toBe(
      "Remain visible before the target Session exists.",
    );
    releaseTarget({ id: "session_2", projectId: "project_2" });
    await completion;
    sessionFirstSubmissionOwner.dispose();
  });

  test("allocates a split workspace before starting a projectless session", async () => {
    const startInputs: unknown[] = [];
    const refreshScopes: Array<string | null> = [];
    const workspace = {
      cwd: "/Users/test/Documents/Nodex/2026-07-18/research-projectless-launch",
      outputDirectory: "/Users/test/Documents/Nodex/2026-07-18/research-projectless-launch/outputs",
      workspaceRoot: "/Users/test/Documents/Nodex",
    };
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(workspace);
    const input = buildInput({
      activeThreadId: null,
      currentSessionProjectId: null,
      projectId: null,
      codexControl: {
        startThreadForSession: async (startInput: unknown) => {
          startInputs.push(startInput);
          return {
            kind: "started" as const,
            detail: { threadId: "thread-projectless" },
          };
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      onRefreshProjectSessions: async (projectId) => {
        refreshScopes.push(projectId);
        return [];
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onStartThreadForSession?.({
      projectId: null,
      sessionId: "session-projectless",
      prompt: "Research projectless launch behavior",
      runInTarget: "localProject",
    });

    expect(invokeMock).toHaveBeenCalledWith("codex:projectless-thread-cwd", {
      prompt: "Research projectless launch behavior",
      createSplitDirectories: true,
    });
    expect(startInputs).toHaveLength(1);
    expect(startInputs[0]).toMatchObject({
      projectId: null,
      sessionId: "session-projectless",
      prompt: "Research projectless launch behavior",
      projectlessWorkspace: workspace,
      runInTarget: "localProject",
      collaborationMode: "default",
    });
    expect(refreshScopes).toStrictEqual([null]);
  });

  test("cleans a materialized goal when cross-project session preflight fails", async () => {
    const cleaned: unknown[] = [];
    let startCalls = 0;
    const input = buildInput({
      activeThreadId: null,
      codexControl: {
        startThreadForSession: async () => {
          startCalls += 1;
          throw new Error("service must not start");
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      cleanupThreadGoalMaterializedDraft: async (materialized) => {
        cleaned.push(materialized);
      },
      onEnsureDefaultDraftSessionForProject: async () => {
        throw new Error("blank session failed");
      },
    });
    const actions = createThreadStageActions(input);
    let errorMessage = "";

    try {
      await actions.onStartThreadForSession?.({
        projectId: "project_2",
        sessionId: "session_1",
        prompt: "Materialized goal",
        threadGoalDraft: {
          objective: "Raw goal",
          pastedTextAttachments: [{ text: "raw source" }],
          imageAttachments: [],
        },
        threadGoalMaterializedDraft: {
          objective: "Materialized goal",
          attachmentDirectory: "/tmp/materialized-goal",
        },
        runInTarget: "localProject",
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("blank session failed");
    expect(startCalls).toBe(0);
    expect(JSON.stringify(cleaned)).toBe(
      JSON.stringify([
        {
          objective: "Materialized goal",
          attachmentDirectory: "/tmp/materialized-goal",
        },
      ]),
    );
  });

  test("retains materialized goal ownership after the start service returns", async () => {
    let cleanupCalls = 0;
    const input = buildInput({
      activeThreadId: null,
      codexControl: {
        startThreadForSession: async () => ({
          kind: "started" as const,
          detail: { threadId: "thread-started" },
        }),
      } as unknown as ThreadActionControllerInput["codexControl"],
      cleanupThreadGoalMaterializedDraft: async () => {
        cleanupCalls += 1;
      },
      onRefreshProjectSessions: async () => {
        throw new Error("refresh failed after start");
      },
    });
    const actions = createThreadStageActions(input);
    let errorMessage = "";

    try {
      await actions.onStartThreadForSession?.({
        projectId: "project_1",
        sessionId: "session_1",
        prompt: "Materialized goal",
        threadGoalMaterializedDraft: {
          objective: "Materialized goal",
          attachmentDirectory: "/tmp/materialized-goal",
        },
        runInTarget: "localProject",
      });
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    expect(errorMessage).toBe("refresh failed after start");
    expect(cleanupCalls).toBe(0);
  });

  test("routes permission request responses through Codex control with conversation context", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      codexControl: {
        respondPermissionRequest: async (
          requestId: CodexProtocolRequestId,
          response: unknown,
          conversationId: string | null,
        ) => {
          calls.push({ requestId, response, conversationId });
          return true;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onRespondPermissionRequest?.(
      "permission-1",
      {
        permissions: {},
        scope: "turn",
      },
      {
        conversationId: "thread-1",
      },
    );

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          requestId: "permission-1",
          response: {
            permissions: {},
            scope: "turn",
          },
          conversationId: "thread-1",
        },
      ]),
    );
  });

  test("routes setup-step responses through the owning conversation", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      codexControl: {
        respondSetupCodexStep: async (
          conversationId: string,
          requestId: CodexProtocolRequestId,
          response: unknown,
        ) => {
          calls.push({ conversationId, requestId, response });
          return true;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onRespondSetupCodexStep?.(
      "setup-context-1",
      {
        step: "context",
        action: "continue",
        selectedSources: ["google-drive"],
      },
      {
        conversationId: "thread-child",
      },
    );

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          conversationId: "thread-child",
          requestId: "setup-context-1",
          response: {
            step: "context",
            action: "continue",
            selectedSources: ["google-drive"],
          },
        },
      ]),
    );
  });

  test("routes approval kind through Codex control with conversation context", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      codexControl: {
        respondApproval: async (
          requestId: CodexProtocolRequestId,
          response: CodexApprovalResponse,
          conversationId: string | null,
        ) => {
          calls.push({ requestId, response, conversationId });
          return true;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onRespondApproval(
      "approval-1",
      { kind: "file", decision: "decline" },
      {
        conversationId: "thread-1",
      },
    );

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          requestId: "approval-1",
          response: { kind: "file", decision: "decline" },
          conversationId: "thread-1",
        },
      ]),
    );
  });

  test("routes summary commit-or-push action through the active thread", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      activeThreadId: "thread-summary",
      projectId: "project-summary",
      selectedCollaborationMode: "plan",
      codexControl: {
        startTurn: async (threadId: string, prompt: string, opts: unknown) => {
          calls.push({ threadId, prompt, opts });
          return null;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onStartSummaryGitAction?.({ action: "commit-or-push" });

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          threadId: "thread-summary",
          prompt: GIT_ACTION_COMMIT_OR_PUSH_PROMPT,
          opts: {
            projectId: "project-summary",
            collaborationMode: "plan",
          },
        },
      ]),
    );
  });

  test("routes summary create-pull-request action through the active thread", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      activeThreadId: "thread-summary",
      projectId: "project-summary",
      selectedCollaborationMode: "plan",
      codexControl: {
        startTurn: async (threadId: string, prompt: string, opts: unknown) => {
          calls.push({ threadId, prompt, opts });
          return null;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onStartSummaryGitAction?.({ action: "create-pull-request" });

    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          threadId: "thread-summary",
          prompt: GIT_ACTION_CREATE_PR_PROMPT,
          opts: {
            projectId: "project-summary",
            collaborationMode: "plan",
          },
        },
      ]),
    );
  });

  test("passes subagent context to the shell opener without reading child data", async () => {
    const calls: string[] = [];
    const input = buildInput({
      activeThreadId: "thread-parent",
      codexControl: {
        requestThreadStreamSnapshot: async (threadId: string) => {
          calls.push(`snapshot:${threadId}`);
          return null;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      onOpenThread: (threadId, context) => {
        calls.push(`open:${threadId}:${context?.subagent?.conversationId ?? "none"}`);
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onOpenThread("thread-child", {
      subagent: {
        agentRole: "reviewer",
        conversationId: "thread-child",
        diffStats: null,
        displayName: "Reviewer",
        spawnModel: "gpt-5.3-codex",
        status: "active",
        statusSummary: "checking changes",
      },
    });

    expect(JSON.stringify(calls)).toBe(JSON.stringify(["open:thread-child:thread-child"]));
  });

  test("does not run subagent hydration for ordinary thread opens", async () => {
    const calls: string[] = [];
    const input = buildInput({
      codexControl: {
        requestThreadStreamSnapshot: async (threadId: string) => {
          calls.push(`snapshot:${threadId}`);
          return null;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
      onOpenThread: (threadId, context) => {
        calls.push(`open:${threadId}:${context?.subagent?.conversationId ?? "none"}`);
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onOpenThread("thread-ordinary");

    expect(JSON.stringify(calls)).toBe(JSON.stringify(["open:thread-ordinary:none"]));
  });

  test("stops background agents by interrupting unique child threads", async () => {
    const calls: string[] = [];
    const input = buildInput({
      codexControl: {
        interruptTurn: async (threadId: string) => {
          calls.push(threadId);
          return true;
        },
      } as unknown as ThreadActionControllerInput["codexControl"],
    });
    const actions = createThreadStageActions(input);

    await actions.onStopBackgroundAgents?.([
      "thread-child-a",
      "thread-child-b",
      "thread-child-a",
      " ",
    ]);

    expect(JSON.stringify(calls)).toBe(JSON.stringify(["thread-child-a", "thread-child-b"]));
  });

  test("passes summary output side-panel opener through the action controller", async () => {
    const calls: unknown[] = [];
    const input = buildInput({
      onOpenSummaryOutputInSidePanel: async (target) => {
        calls.push(target);
        return true;
      },
    });
    const actions = createThreadStageActions(input);

    const opened = await actions.onOpenSummaryOutputInSidePanel?.({
      path: "/repo/project/report.txt",
      title: "report.txt",
    });

    expect(opened).toBe(true);
    expect(JSON.stringify(calls)).toBe(
      JSON.stringify([
        {
          path: "/repo/project/report.txt",
          title: "report.txt",
        },
      ]),
    );
  });

  test("passes summary Computer Use PiP toggles through the action controller", async () => {
    const calls: boolean[] = [];
    const input = buildInput({
      onToggleSummaryComputerUsePip: async (nextVisible) => {
        calls.push(nextVisible);
      },
    });
    const actions = createThreadStageActions(input);

    await actions.onToggleSummaryComputerUsePip?.(true);

    expect(JSON.stringify(calls)).toBe(JSON.stringify([true]));
  });
});

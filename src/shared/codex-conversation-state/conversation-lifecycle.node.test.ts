import { expect, test, describe } from "vite-plus/test";
import { CanonicalConversationArchiveState } from "./codex-conversation-archive-state";
import { produce } from "immer";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalItem,
  type CodexCanonicalTurnParams,
  type CodexCanonicalTurnState,
  appendCodexCanonicalWorktreeInitItem,
  type CodexCanonicalLiveTurnParams,
  type CodexCanonicalPlanImplementationItem,
  type CodexCanonicalSteeringUserMessageItem,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  interruptCanonicalConversationTurn,
  type CanonicalInterruptClient,
} from "./codex-conversation-interrupt";
import { residentConversationTurns } from "./codex-turn-mutation";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { CodexItemView, CodexTranscriptEntry } from "../types";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import { projectCodexItemViewToTranscriptEntry } from "../codex-transcript-entry-projection";
import {
  applyCodexLifecycleProjectionDiff,
  collectCodexLifecycleChangedRawOwnerIds,
} from "./codex-lifecycle-projection-diff";
import {
  mutateCodexTurnStartRejection,
  type CodexPreparedTurnExecution,
} from "./codex-turn-execution";
import type { Turn } from "@nodex/codex-app-server-protocol/v2/Turn";
import {
  appendCodexCanonicalOptimisticFirstTurn,
  appendCodexCanonicalOptimisticTurn,
  bindCodexCanonicalOptimisticTurn,
  failCodexCanonicalOptimisticTurn,
  removeCodexCanonicalOptimisticTurn,
} from "./codex-optimistic-turn";
import { encodeCodexAsyncQuestionReplies } from "../codex-async-user-input";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import { createCodexCanonicalPlanImplementationRequest } from "./codex-server-request-lifecycle";
import { reduceCodexConversationTurnLifecycle } from "./codex-turn-lifecycle";
import { resolveCodexTurnReference, type CodexTurnReference } from "./codex-turn-reference";

describe("codex conversation archive state", () => {
  function fixture() {
    const archive = new CanonicalConversationArchiveState();
    let resident = false;
    let ordinary = false;
    let suppressions = 0;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const callbacks = {
      hasOrdinaryState: () => ordinary,
      hasConversation: () => resident,
      hasPreviewHistory: () => false,
      onSuppressed: () => {
        suppressions += 1;
      },
      hydrate: async (isCurrent: () => boolean) => {
        await gate;
        if (isCurrent()) resident = true;
      },
    };
    return {
      archive,
      callbacks,
      resume,
      setOrdinary: () => {
        ordinary = true;
      },
      resident: () => resident,
      suppressions: () => suppressions,
    };
  }

  test("ordinary and explicitly unarchived threads never begin archived preview hydration", async () => {
    const f = fixture();
    f.setOrdinary();
    expect(await f.archive.hydratePreview("thread", f.callbacks)).toBe(false);
    f.archive.unsuppress("other");
    expect(
      await f.archive.hydratePreview("other", { ...f.callbacks, hasOrdinaryState: () => false }),
    ).toBe(false);
    expect(f.suppressions()).toBe(0);
  });

  test("repeated archive suppression retires an outstanding preview even though visibility stays archived", async () => {
    const f = fixture();
    const pending = f.archive.hydratePreview("thread", f.callbacks);
    expect(f.archive.isSuppressed("thread")).toBe(true);
    expect(f.archive.suppress("thread")).toBe(false);
    f.resume();
    expect(await pending).toBe(false);
    expect(f.resident()).toBe(false);
    expect(f.archive.suppressedIds()).toEqual(["thread"]);
  });

  test("unarchive retires outstanding preview and keeps an explicit unsuppressed marker", async () => {
    const f = fixture();
    const pending = f.archive.hydratePreview("thread", f.callbacks);
    f.archive.unsuppress("thread");
    f.resume();
    expect(await pending).toBe(false);
    expect(f.archive.suppressedIds()).toEqual([]);
    expect(await f.archive.hydratePreview("thread", f.callbacks)).toBe(false);
  });

  test("current preview succeeds after hydration and reuses already loaded preview history", async () => {
    const f = fixture();
    const pending = f.archive.hydratePreview("thread", f.callbacks);
    f.resume();
    expect(await pending).toBe(true);
    expect(f.suppressions()).toBe(1);
    expect(
      await f.archive.hydratePreview("thread", {
        ...f.callbacks,
        hasPreviewHistory: () => true,
        hydrate: () => {
          throw new Error("Must reuse history");
        },
      }),
    ).toBe(true);
  });

  test("current hydration with no resulting conversation reports the archived task failure", async () => {
    const f = fixture();
    await expect(
      f.archive.hydratePreview("thread", { ...f.callbacks, hydrate: async () => {} }),
    ).rejects.toThrow("Could not load archived task");
  });
});

describe("codex conversation interrupt", () => {
  function harness() {
    const thread = {
      ...buildAgentActivityV2CorpusThread([]),
      turns: [
        {
          rootTurnId: null,
          id: "active",
          status: "inProgress" as const,
          itemsView: "full" as const,
          items: [],
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
    let state = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "m",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    });
    const calls: string[] = [];
    let send = async (_id: string) => {};
    const client: CanonicalInterruptClient = {
      getConversation: () => state,
      updateConversation: (_id, recipe) => {
        state = produce(state, recipe);
      },
      sendInterrupt: async (_threadId, turnId) => {
        calls.push(`interrupt:${turnId}`);
        await send(turnId);
      },
      cleanBackgroundTerminals: async () => {
        calls.push("clean");
      },
      killNodeReplExecutions: async (_sessionId, turnId) => {
        calls.push(`kill:${turnId}`);
      },
      onInterruptStarted: () => {
        calls.push("started");
      },
      errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
      warn: () => {
        calls.push("warning");
      },
    };
    return {
      client,
      calls,
      read: () => state,
      send: (next: typeof send) => {
        send = next;
      },
    };
  }

  test("expected-turn mismatch has no cleanup or mutation side effects", async () => {
    const f = harness();
    expect(await interruptCanonicalConversationTurn(f.client, "id", "other")).toBeNull();
    expect(f.calls).toEqual([]);
    expect(residentConversationTurns(f.read())[0]?.status).toBe("inProgress");
  });
  test("expected-turn cleanup starts only after the native interrupt succeeds", async () => {
    const f = harness();
    expect(await interruptCanonicalConversationTurn(f.client, "id", "active")).toBe("active");
    expect(f.calls).toEqual(["interrupt:active", "started", "kill:active"]);
    expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
  });
  test("unconditional interrupt retries the server's current turn and cleans both executions", async () => {
    const f = harness();
    f.send(async (id) => {
      if (id === "active") throw new Error("expected active turn id `active` but found `new`");
    });
    expect(await interruptCanonicalConversationTurn(f.client, "id")).toBe("new");
    expect(f.calls).toEqual([
      "started",
      "kill:active",
      "interrupt:active",
      "kill:new",
      "interrupt:new",
    ]);
    expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
  });
  test("expected-turn no-active response cannot mark the old turn interrupted", async () => {
    const f = harness();
    f.send(async () => {
      throw new Error("no active turn to interrupt");
    });
    expect(await interruptCanonicalConversationTurn(f.client, "id", "active")).toBeNull();
    expect(f.calls).toEqual(["interrupt:active"]);
    expect(residentConversationTurns(f.read())[0]?.status).toBe("inProgress");
  });

  test.each([undefined, "active"])(
    "cleanup failure cannot replace a successful interrupt: %s",
    async (expectedTurnId) => {
      const f = harness();
      const client = {
        ...f.client,
        killNodeReplExecutions: async () => {
          throw new Error("Cleanup owner retired");
        },
      };
      expect(await interruptCanonicalConversationTurn(client, "id", expectedTurnId)).toBe("active");
      expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
      expect(f.calls.filter((call) => call === "interrupt:active")).toHaveLength(1);
      expect(f.calls).toContain("warning");
    },
  );
});

describe("codex lifecycle projection diff", () => {
  const THREAD_ID = "thread_projection_diff";
  const TURN_ID = "turn_projection_diff";

  function buildTurnParams(): CodexCanonicalTurnParams {
    return {
      threadId: THREAD_ID,
      input: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      model: "fixture-model",
      cwd: "/workspace/project",
      attachments: [],
      effort: "high",
      summary: "none",
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    };
  }

  function buildTurn(
    items: readonly CodexCanonicalItem[],
    status: CodexCanonicalTurnState["status"] = "inProgress",
  ): CodexCanonicalTurnState {
    return {
      rootTurnId: null,
      turnId: TURN_ID,
      itemsView: "full",
      status,
      error: null,
      durationMs: null,
      items,
      params: buildTurnParams(),
      diff: null,
      turnStartedAtMs: 1000,
      completedAtMs: null,
      firstTurnWorkItemStartedAtMs: 1100,
      finalAssistantStartedAtMs: null,
    };
  }

  function buildCommand(
    id: string,
    status: "inProgress" | "completed" = "inProgress",
    output: string | null = null,
  ): Extract<
    ThreadItem,
    {
      type: "commandExecution";
    }
  > {
    return {
      type: "commandExecution",
      id,
      command: `printf ${id}`,
      cwd: "/workspace/project",
      processId: null,
      pluginId: null,
      scriptPath: null,
      source: "agent",
      status,
      commandActions: [],
      aggregatedOutput: output,
      exitCode: status === "completed" ? 0 : null,
      durationMs: status === "completed" ? 50 : null,
    };
  }
  function project(item: CodexCanonicalItem, observedAtMs = 2000): CodexItemView {
    const projected = projectCodexCanonicalTurnItemViews({
      threadId: THREAD_ID,
      turnId: TURN_ID,
      items: [item],
      observedAtMs,
      turnStatus: "inProgress",
      isBackgroundSubagentsEnabled: true,
    })[0];
    if (!projected) throw new Error(`Fixture item ${item.id} did not project`);
    return projected;
  }

  function transcript(view: CodexItemView, sequence: number): CodexTranscriptEntry {
    return projectCodexItemViewToTranscriptEntry(view, "live", sequence);
  }

  function overlay(id: string): CodexItemView {
    return {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      itemId: id,
      type: "automaticApprovalReview",
      normalizedKind: "systemEvent",
      semanticKind: "automaticApprovalReview",
      status: "inProgress",
      markdownText: "Reviewing command",
      rawItem: { id, type: "automaticApprovalReview" },
      createdAt: 1500,
      updatedAt: 1500,
    };
  }

  describe("scoped canonical lifecycle projection diff", () => {
    test("rebuilds a complete turn from params before raw items and suppresses the server echo", () => {
      const content: Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"] = [{ type: "text", text: "Inspect the exact projection", text_elements: [] }];
      const serverEcho = {
        type: "userMessage",
        id: "server-user-echo",
        content,
        clientId: "client-user-input",
      } satisfies Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >;
      const command = buildCommand("command-after-input");
      const existingCommand = {
        ...project(command),
        approvalRequestId: "approval-command",
        createdAt: 1250,
      } satisfies CodexItemView;
      const reviewOverlay = overlay("review-overlay");
      const baseTurn = buildTurn([serverEcho, command]);
      const afterTurn = {
        ...baseTurn,
        params: {
          ...baseTurn.params,
          clientUserMessageId: "client-user-input",
          input: content,
        },
      } satisfies CodexCanonicalTurnState;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: null,
        afterTurn,
        currentViews: [project(serverEcho), reviewOverlay, existingCommand],
        currentTranscript: [
          transcript(project(serverEcho), 0),
          transcript(reviewOverlay, 1),
          transcript(existingCommand, 2),
        ],
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => view.itemId)).toEqual([
        `${TURN_ID}:input`,
        "review-overlay",
        "command-after-input",
      ]);
      expect(result.views[0]?.markdownText).toBe("Inspect the exact projection");
      expect(result.views[2]?.approvalRequestId).toBe("approval-command");
      expect(result.views[2]?.createdAt).toBe(1250);
      expect(result.transcript.map((entry) => entry.sequence)).toEqual([0, 1, 2]);
      expect(result.itemIds).toEqual(["server-user-echo", "command-after-input"]);
    });

    test("projects a nullable local occurrence through the same params-first typed boundary", () => {
      const afterTurn = {
        ...buildTurn([
          {
            id: "pending-worktree:1",
            type: "worktreeInit",
            worktreeOutputText: "Worktree created",
            setup: null,
          },
        ]),

        turnId: null,
        params: {
          ...buildTurnParams(),
          clientUserMessageId: "client-local",
          input: [{ type: "text", text: "Implement locally", text_elements: [] }],
        },
      } satisfies CodexCanonicalTurnState;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        turnKey: "turn-index-4",
        beforeTurn: null,
        afterTurn,
        currentViews: [],
        currentTranscript: [],
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => [view.itemId, view.turnId])).toStrictEqual([
        ["turn-index-4:input", null],
        ["pending-worktree:1", null],
      ]);
      expect(result.transcript.map((entry) => entry.semanticKind)).toStrictEqual([
        "userMessage",
        "worktreeInit",
      ]);
    });

    test("rebinds the optimistic params row by client id without duplicating it", () => {
      const content: Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"] = [{ type: "text", text: "Keep optimistic identity", text_elements: [] }];
      const serverEcho = {
        type: "userMessage",
        id: "server-user-echo",
        content,
        clientId: "client-optimistic",
      } satisfies Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >;
      const baseTurn = buildTurn([serverEcho]);
      const afterTurn = {
        ...baseTurn,
        params: {
          ...baseTurn.params,
          clientUserMessageId: "client-optimistic",
          input: content,
        },
      } satisfies CodexCanonicalTurnState;
      const optimisticView = {
        threadId: THREAD_ID,
        turnId: "replay:owner-turn:client-optimistic",
        itemId: "replay:owner-user:client-optimistic",
        type: "userMessage",
        normalizedKind: "userMessage",
        semanticKind: "userMessage",
        role: "user",
        status: "completed",
        markdownText: "Keep optimistic identity",
        rawItem: {
          id: "replay:owner-user:client-optimistic",
          type: "userMessage",
          clientUserMessageId: "client-optimistic",
          content,
        },
        createdAt: 1234,
        updatedAt: 1234,
      } satisfies CodexItemView;
      const optimisticTranscript = {
        ...transcript(optimisticView, 0),
        source: "bootstrap" as const,
      };

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: null,
        afterTurn,
        currentViews: [optimisticView],
        currentTranscript: [optimisticTranscript],
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => view.itemId)).toEqual([`${TURN_ID}:input`]);
      expect(result.views[0]?.turnId).toBe(TURN_ID);
      expect(result.views[0]?.createdAt).toBe(1234);
      expect(result.transcript[0]?.source).toBe("bootstrap");
      expect(result.transcript[0]?.sequence).toBe(0);
    });

    test("suppresses a matching user-message echo that arrives after optimistic rebind", () => {
      const content: Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"] = [{ type: "text", text: "Edited prompt", text_elements: [] }];
      const baseTurn = buildTurn([]);
      const reboundTurn = {
        ...baseTurn,
        params: {
          ...baseTurn.params,
          clientUserMessageId: "client-edited-prompt",
          input: content,
        },
      } satisfies CodexCanonicalTurnState;
      const optimistic = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: null,
        afterTurn: reboundTurn,
        currentViews: [],
        currentTranscript: [],
        observedAtMs: 2000,
      });
      const updatedContent: Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"] = [{ type: "text", text: "Updated edited prompt", text_elements: [] }];
      const afterParamsChange = {
        ...reboundTurn,
        params: {
          ...reboundTurn.params,
          input: updatedContent,
        },
      } satisfies CodexCanonicalTurnState;
      const paramsChanged = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: reboundTurn,
        afterTurn: afterParamsChange,
        currentViews: optimistic.views,
        currentTranscript: optimistic.transcript,
        observedAtMs: 2500,
      });
      expect(paramsChanged.views.map((view) => view.markdownText)).toEqual([
        "Updated edited prompt",
      ]);

      const serverEcho = {
        type: "userMessage",
        id: "server-user-echo",
        clientId: "client-edited-prompt",
        content,
      } satisfies Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >;
      const afterEcho = {
        ...reboundTurn,
        items: [serverEcho],
      } satisfies CodexCanonicalTurnState;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: reboundTurn,
        afterTurn: afterEcho,
        currentViews: optimistic.views,
        currentTranscript: optimistic.transcript,
        observedAtMs: 3000,
        lifecycleStatus: "inProgress",
      });

      expect(result.views.map((view) => view.itemId)).toEqual([`${TURN_ID}:input`]);
      expect(result.transcript.map((entry) => entry.itemId)).toEqual([`${TURN_ID}:input`]);
      expect(result.views[0]?.createdAt).toBe(optimistic.views[0]?.createdAt);
      expect(result.transcript[0]?.source).toBe(optimistic.transcript[0]?.source);
      expect(result.transcript[0]?.createdAt).toBe(optimistic.transcript[0]?.createdAt);
      expect(result.itemIds).toEqual(["server-user-echo"]);

      const command = buildCommand("command-before-echo");
      const afterActivity = {
        ...afterEcho,
        items: [command, serverEcho],
      } satisfies CodexCanonicalTurnState;
      const visibleAfterActivity = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: afterEcho,
        afterTurn: afterActivity,
        currentViews: result.views,
        currentTranscript: result.transcript,
        observedAtMs: 4000,
        lifecycleStatus: "inProgress",
      });

      expect(visibleAfterActivity.views.map((view) => view.itemId)).toEqual([
        `${TURN_ID}:input`,
        "command-before-echo",
        "server-user-echo",
      ]);
      expect(visibleAfterActivity.views.map((view) => view.semanticKind)).toEqual([
        "userMessage",
        "exec",
        "steered",
      ]);
      expect(visibleAfterActivity.transcript.map((entry) => entry.itemId)).toEqual([
        `${TURN_ID}:input`,
        "command-before-echo",
        "server-user-echo",
      ]);
    });

    test("replaces only the changed raw owner and preserves unrelated streamed state and overlays", () => {
      const startedA = buildCommand("command-a");
      const startedB = buildCommand("command-b");
      const completedA = buildCommand("command-a", "completed", "final-a\n");
      const streamedB = {
        ...project(startedB, 1200),
        aggregatedOutput: "streamed-b\n",
        rawItem: { ...startedB, aggregatedOutput: "streamed-b\n" },
      } satisfies CodexItemView;
      const review = overlay("review-overlay");
      const currentA = {
        ...project(startedA, 1100),
        approvalRequestId: "approval-a",
        createdAt: 1100,
      } satisfies CodexItemView;
      const currentTranscript = [
        transcript(currentA, 0),
        transcript(streamedB, 1),
        transcript(review, 2),
      ];

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([startedA, startedB]),
        afterTurn: buildTurn([completedA, startedB]),
        currentViews: [currentA, streamedB, review],
        currentTranscript,
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual(["command-a"]);
      expect(result.itemIds).toEqual(["command-a", "command-b"]);
      expect(result.views.map((view) => view.itemId)).toEqual([
        "command-a",
        "command-b",
        "review-overlay",
      ]);
      expect(result.views[0]?.aggregatedOutput).toBe("final-a\n");
      expect(result.views[0]?.approvalRequestId).toBe("approval-a");
      expect(result.views[0]?.createdAt).toBe(1100);
      expect(result.views[1]).toBe(streamedB);
      expect(result.views[1]?.aggregatedOutput).toBe("streamed-b\n");
      expect(result.views[2]).toBe(review);
      expect(result.transcript[1]).toBe(currentTranscript[1]);
      expect(result.transcript[2]).toBe(currentTranscript[2]);
    });

    test("can preserve the existing view timestamp for non-lifecycle raw mutations", () => {
      const started = buildCommand("command-output");
      const withOutput = { ...started, aggregatedOutput: "streamed output\n" };
      const current = {
        ...project(started, 1200),
        createdAt: 1100,
        updatedAt: 1250,
      } satisfies CodexItemView;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([started]),
        afterTurn: buildTurn([withOutput]),
        currentViews: [current],
        currentTranscript: [transcript(current, 0)],
        observedAtMs: 3000,
        preserveExistingUpdatedAt: true,
      });

      expect(result.views[0]?.aggregatedOutput).toBe("streamed output\n");
      expect(result.views[0]?.createdAt).toBe(1100);
      expect(result.views[0]?.updatedAt).toBe(1250);
    });

    test("reprojects statusless items when only the lifecycle metadata changes", () => {
      const reasoning = {
        type: "reasoning",
        id: "reasoning-only-status",
        summary: ["Checking the patch stream."],
        content: [],
      } satisfies Extract<
        ThreadItem,
        {
          type: "reasoning";
        }
      >;
      const base = buildTurn([reasoning]);
      const beforeTurn = {
        ...base,
        lifecycleStatusByItemId: { [reasoning.id]: "inProgress" as const },
      } satisfies CodexCanonicalTurnState;
      const afterTurn = {
        ...beforeTurn,
        lifecycleStatusByItemId: { [reasoning.id]: "completed" as const },
      } satisfies CodexCanonicalTurnState;
      const currentViews = projectCodexCanonicalTurnItemViews({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        items: beforeTurn.items,
        observedAtMs: 2000,
        turnStatus: beforeTurn.status,
        lifecycleStatusByItemId: beforeTurn.lifecycleStatusByItemId,
        isBackgroundSubagentsEnabled: true,
      });

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn,
        afterTurn,
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual([]);
      expect(result.views[0]?.status).toBe("completed");
      expect(result.transcript[0]?.status).toBe("completed");
    });

    test("stabilizes a display alias by explicit canonical raw owner type and id", () => {
      const started = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "assistant-alias",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      } satisfies Extract<
        ThreadItem,
        {
          type: "agentMessage";
        }
      >;
      const streamed = { ...started, text: "partial" };
      const current = {
        ...project(started, 1200),
        type: "message",
        status: "inProgress",
        createdAt: 1100,
        updatedAt: 1250,
      } satisfies CodexItemView;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([started]),
        afterTurn: buildTurn([streamed]),
        currentViews: [current],
        currentTranscript: [transcript(current, 0)],
        observedAtMs: 3000,
        preserveExistingUpdatedAt: true,
      });

      expect(result.views[0]?.markdownText).toBe("partial");
      expect(result.views[0]?.status).toBe("inProgress");
      expect(result.views[0]?.createdAt).toBe(1100);
      expect(result.views[0]?.updatedAt).toBe(1250);
    });

    test("retains hidden raw identities and exact raw order while removing their former visible row", () => {
      const before = buildCommand("before");
      const visibleTarget = buildCommand("target");
      const after = buildCommand("after");
      const hiddenTarget = {
        type: "enteredReviewMode",
        id: "target",
        review: "Review target",
      } satisfies Extract<
        ThreadItem,
        {
          type: "enteredReviewMode";
        }
      >;
      const currentViews = [project(before), project(visibleTarget), project(after)];

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([before, visibleTarget, after]),
        afterTurn: buildTurn([before, hiddenTarget, after]),
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual(["target"]);
      expect(result.itemIds).toEqual(["before", "target", "after"]);
      expect(result.views.map((view) => view.itemId)).toEqual(["before", "after"]);
      expect(result.views[0]).toBe(currentViews[0]);
      expect(result.views[1]).toBe(currentViews[2]);
    });

    test("removes a pending compaction owner without rolling back an unchanged assistant delta", () => {
      const pendingCompaction = {
        type: "contextCompaction",
        id: "pending-manual-context-compaction",
        completed: false,
        source: "manual",
      } satisfies CodexCanonicalItem;
      const startedCompaction = {
        type: "contextCompaction",
        id: "context-compaction-1",
        completed: false,
        source: "manual",
      } satisfies CodexCanonicalItem;
      const assistant = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "assistant-1",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      } satisfies Extract<
        ThreadItem,
        {
          type: "agentMessage";
        }
      >;
      const streamedAssistant = {
        ...project(assistant),
        markdownText: "streamed assistant text",
        rawItem: { ...assistant, text: "streamed assistant text" },
      } satisfies CodexItemView;
      const currentPending = project(pendingCompaction);

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([pendingCompaction, assistant]),
        afterTurn: buildTurn([startedCompaction, assistant]),
        currentViews: [currentPending, streamedAssistant],
        currentTranscript: [transcript(currentPending, 0), transcript(streamedAssistant, 1)],
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual([
        "pending-manual-context-compaction",
        "context-compaction-1",
      ]);
      expect(result.itemIds).toEqual(["context-compaction-1", "assistant-1"]);
      expect(result.views.map((view) => view.itemId)).toEqual([
        "context-compaction-1",
        "assistant-1",
      ]);
      expect(result.views[1]).toBe(streamedAssistant);
      expect(result.views[1]?.markdownText).toBe("streamed assistant text");
    });

    test("projects every changed duplicate raw slot in canonical order", () => {
      const firstStarted = buildCommand("duplicate");
      const secondStarted = buildCommand("duplicate");
      const firstCompleted = buildCommand("duplicate", "completed", "first final\n");
      const current = project(firstStarted);

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([firstStarted, secondStarted]),
        afterTurn: buildTurn([firstCompleted, secondStarted]),
        currentViews: [current],
        currentTranscript: [transcript(current, 0)],
        observedAtMs: 3000,
      });

      expect(
        collectCodexLifecycleChangedRawOwnerIds(
          [firstStarted, secondStarted],
          [firstCompleted, secondStarted],
        ),
      ).toEqual(["duplicate"]);
      expect(result.itemIds).toEqual(["duplicate", "duplicate"]);
      expect(result.views).toHaveLength(2);
      expect(result.views[0]?.rawItem).toBe(firstCompleted);
      expect(result.views[1]?.rawItem).toBe(secondStarted);
      expect(result.views[0]?.aggregatedOutput).toBe("first final\n");
      expect(result.views[1]?.aggregatedOutput).toBeNull();
    });

    test("reorders unchanged same-type raw references instead of preserving stale view order", () => {
      const first = buildCommand("first");
      const second = buildCommand("second");
      const review = overlay("review-overlay");
      const currentViews = [project(first), review, project(second)];

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([first, second]),
        afterTurn: buildTurn([second, first]),
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual(["first", "second"]);
      expect(result.views.map((view) => view.itemId)).toEqual([
        "second",
        "first",
        "review-overlay",
      ]);
      expect(result.views[2]).toBe(review);
      expect(result.transcript.map((entry) => entry.itemId)).toEqual([
        "second",
        "first",
        "review-overlay",
      ]);
    });

    test("reprojects every non-positional owner affected by a terminal turn status", () => {
      const command = buildCommand("running-command");
      const mcp = {
        type: "mcpToolCall",
        environmentId: null,
        id: "running-mcp",
        server: "fixture",
        tool: "lookup",
        status: "inProgress",
        arguments: {},
        appContext: null,
        mcpAppUi: null,
        pluginId: null,
        readOnlyHint: null,
        result: null,
        error: null,
        durationMs: null,
      } satisfies Extract<
        ThreadItem,
        {
          type: "mcpToolCall";
        }
      >;
      const compaction = {
        type: "contextCompaction",
        id: "running-compaction",
        completed: false,
        source: "automatic",
      } satisfies CodexCanonicalItem;
      const review = {
        type: "automaticApprovalReview",
        id: "running-review",
        targetItemId: command.id,
        action: { type: "applyPatch", cwd: "/workspace/project", files: [] },
        startedAtMs: 1200,
        completedAtMs: null,
        event: null,
        status: "inProgress",
        riskLevel: null,
        userAuthorization: null,
        rationale: null,
      } satisfies CodexCanonicalItem;
      const assistant = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "last-assistant",
        text: "Done",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
      } satisfies Extract<
        ThreadItem,
        {
          type: "agentMessage";
        }
      >;
      const items = [command, mcp, compaction, review, assistant] as const;
      const currentViews = projectCodexCanonicalTurnItemViews({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        items,
        observedAtMs: 2000,
        turnStatus: "inProgress",
        isBackgroundSubagentsEnabled: true,
      });

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn(items),
        afterTurn: buildTurn(items, "interrupted"),
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });
      const byId = new Map(result.views.map((view) => [view.itemId, view]));

      expect(result.changedRawOwnerIds).toEqual([]);
      expect(byId.get(command.id)?.status).toBe("interrupted");
      expect(byId.get(mcp.id)?.mcpToolCall?.completed).toBe(true);
      expect(byId.get(compaction.id)?.contextCompaction?.status).toBe("interrupted");
      expect(byId.get(review.id)?.status).toBe("completed");
      expect(byId.get(review.id)?.markdownText).not.toBe(
        currentViews.find((view) => view.itemId === review.id)?.markdownText,
      );
      expect(byId.get(assistant.id)?.status).toBe("completed");
    });

    test("keeps an overlay anchored after the raw owner it followed", () => {
      const startedA = buildCommand("command-a");
      const completedA = buildCommand("command-a", "completed", "final-a\n");
      const commandB = buildCommand("command-b");
      const review = overlay("review-overlay");
      const currentA = project(startedA);
      const currentB = project(commandB);

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([startedA, commandB]),
        afterTurn: buildTurn([completedA, commandB]),
        currentViews: [currentA, review, currentB],
        currentTranscript: [
          transcript(currentA, 0),
          transcript(review, 1),
          transcript(currentB, 2),
        ],
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => view.itemId)).toEqual([
        "command-a",
        "review-overlay",
        "command-b",
      ]);
      expect(result.views[1]).toBe(review);
    });

    test("rebuilds params identity while rebinding unchanged rows and overlays", () => {
      const command = buildCommand("command-a");
      const review = overlay("review-overlay");
      const content: Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"] = [{ type: "text", text: "Bind this occurrence", text_elements: [] }];
      const base = buildTurn([command]);
      const before = {
        ...base,
        turnId: null,
        params: {
          ...base.params,
          clientUserMessageId: "client-rebind",
          input: content,
        },
      } satisfies CodexCanonicalTurnState;
      const after = {
        ...before,
        turnId: TURN_ID,
      } satisfies CodexCanonicalTurnState;
      const optimistic = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        turnKey: "turn-index-2",
        beforeTurn: null,
        afterTurn: before,
        currentViews: [],
        currentTranscript: [],
        observedAtMs: 2000,
      });
      const currentReview = { ...review, turnId: null };
      const currentViews = [...optimistic.views, currentReview];
      const currentTranscript = [
        ...optimistic.transcript,
        transcript(currentReview, optimistic.transcript.length),
      ];

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: before,
        afterTurn: after,
        currentViews,
        currentTranscript,
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => view.itemId)).toStrictEqual([
        `${TURN_ID}:input`,
        "command-a",
        "review-overlay",
      ]);
      expect(result.views.filter((view) => view.semanticKind === "userMessage")).toHaveLength(1);
      expect(result.views[0]?.turnId).toBe(TURN_ID);
      expect(result.views[1]?.turnId).toBe(TURN_ID);
      expect(result.transcript[0]?.turnId).toBe(TURN_ID);
      expect(result.transcript[1]?.turnId).toBe(TURN_ID);
      expect(result.transcript[0]?.source).toBe(optimistic.transcript[0]?.source);
      expect(result.transcript[0]?.createdAt).toBe(optimistic.transcript[0]?.createdAt);
    });

    test("publishes hook feedback and generated images from the typed canonical path", () => {
      const hookPrompt = {
        type: "hookPrompt",
        id: "hook-feedback",
        fragments: [{ text: "Please adjust", hookRunId: "hook-run" }],
      } satisfies Extract<
        ThreadItem,
        {
          type: "hookPrompt";
        }
      >;
      const generatedImage = {
        generationId: null,
        type: "imageGeneration",
        id: "generated-image",
        status: "completed",
        revisedPrompt: null,
        result: "aW1hZ2U=",
        failure: null,
        src: "data:image/png;base64,aW1hZ2U=",
      } satisfies CodexCanonicalItem;

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([]),
        afterTurn: buildTurn([hookPrompt, generatedImage]),
        currentViews: [],
        currentTranscript: [],
        observedAtMs: 3000,
      });

      expect(result.views.map((view) => view.itemId)).toEqual(["hook-feedback", "generated-image"]);
      expect(result.views[0]?.hookFeedback).toBe(true);
      expect(result.views[1]?.generatedImage?.src).toBe("data:image/png;base64,aW1hZ2U=");
    });

    test("reprojects image-run neighbors when a hidden raw item splits the run", () => {
      const first = {
        type: "imageView",
        id: "image-1",
        path: "/tmp/1.png",
      } satisfies Extract<
        ThreadItem,
        {
          type: "imageView";
        }
      >;
      const second = {
        type: "imageView",
        id: "image-2",
        path: "/tmp/2.png",
      } satisfies Extract<
        ThreadItem,
        {
          type: "imageView";
        }
      >;
      const hidden = {
        type: "sleep",
        id: "sleep-between-images",
        durationMs: 1,
      } satisfies Extract<
        ThreadItem,
        {
          type: "sleep";
        }
      >;
      const currentViews = projectCodexCanonicalTurnItemViews({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        items: [first, second],
        observedAtMs: 2000,
        turnStatus: "inProgress",
      });

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([first, second]),
        afterTurn: buildTurn([first, hidden, second]),
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual(["sleep-between-images"]);
      expect(result.views).toHaveLength(2);
      expect(result.views[0]?.stepImages?.map((image) => image.source)).toEqual(["/tmp/1.png"]);
      expect(result.views[1]?.stepImages?.map((image) => image.source)).toEqual(["/tmp/2.png"]);
    });

    test("reprojects the unchanged former last-work row when a new work item is appended", () => {
      const webSearch = {
        type: "webSearch",
        id: "web-last",
        query: "projection dependency",
        action: null,
        results: null,
      } satisfies Extract<
        ThreadItem,
        {
          type: "webSearch";
        }
      >;
      const command = buildCommand("new-last-work");
      const currentWeb = project(webSearch);

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([webSearch]),
        afterTurn: buildTurn([webSearch, command]),
        currentViews: [currentWeb],
        currentTranscript: [transcript(currentWeb, 0)],
        observedAtMs: 3000,
      });

      expect(result.changedRawOwnerIds).toEqual(["new-last-work"]);
      expect(result.views[0]?.webSearch?.completed).toBe(true);
      expect(result.views[1]?.itemId).toBe("new-last-work");
    });

    test("stabilizes each split command action by projected identity", () => {
      const started = {
        ...buildCommand("split-command"),
        commandActions: [
          { type: "unknown", command: "first" },
          { type: "unknown", command: "second" },
        ],
      } satisfies Extract<
        ThreadItem,
        {
          type: "commandExecution";
        }
      >;
      const completed = {
        ...started,
        status: "completed",
        aggregatedOutput: "done\n",
        exitCode: 0,
        durationMs: 5,
      } satisfies Extract<
        ThreadItem,
        {
          type: "commandExecution";
        }
      >;
      const currentViews = projectCodexCanonicalTurnItemViews({
        threadId: THREAD_ID,
        turnId: TURN_ID,
        items: [started],
        observedAtMs: 1000,
        turnStatus: "inProgress",
      }).map((view, index) => ({
        ...view,
        createdAt: 1100 + index,
      }));

      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn: buildTurn([started]),
        afterTurn: buildTurn([completed]),
        currentViews,
        currentTranscript: currentViews.map(transcript),
        observedAtMs: 3000,
      });
      expect(result.views.map((view) => view.createdAt)).toEqual([1100, 1101]);
      expect(result.views.map((view) => view.itemId)).toEqual([
        "split-command:0",
        "split-command:1",
      ]);
    });
  });

  test("hook-only updates preserve transcript identities for both incremental and full projection", () => {
    const before = buildTurn([buildCommand("command")]);
    const after: CodexCanonicalTurnState = {
      ...before,
      hookRuns: [
        {
          id: "hook",
          run: {
            id: "hook",
            eventName: "sessionStart",
            source: "user",
            handlerType: "command",
            executionMode: "sync",
            scope: "turn",
            sourcePath: "",
            displayOrder: 0n,
            status: "completed",
            statusMessage: "Context loaded",
            startedAt: 1n,
            completedAt: 2n,
            durationMs: 1n,
            entries: [{ kind: "context", text: "Injected context" }],
          },
        },
      ],
    };
    const baseline = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: null,
      afterTurn: before,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 1000,
    });
    for (const beforeTurn of [before, null]) {
      const result = applyCodexLifecycleProjectionDiff({
        threadId: THREAD_ID,
        beforeTurn,
        afterTurn: after,
        currentViews: baseline.views,
        currentTranscript: baseline.transcript,
        observedAtMs: 1000,
      });
      expect(result.itemIds).toEqual(["command"]);
      expect(result.views).toEqual(baseline.views);
      expect(result.transcript).toEqual(baseline.transcript);
    }
  });

  test("a blocked prompt hook refreshes the existing user delivery state without adding hook items", () => {
    const initial = buildTurn([]);
    const before: CodexCanonicalTurnState = {
      ...initial,
      params: {
        ...initial.params,
        input: [{ type: "text", text: "Run the task", text_elements: [] }],
      },
    };
    const after: CodexCanonicalTurnState = {
      ...before,
      hookRuns: [
        {
          id: "blocked",
          run: {
            id: "blocked",
            eventName: "userPromptSubmit",
            source: "project",
            handlerType: "command",
            executionMode: "sync",
            scope: "turn",
            sourcePath: "",
            displayOrder: 0n,
            status: "blocked",
            statusMessage: null,
            startedAt: 1n,
            completedAt: 2n,
            durationMs: 1n,
            entries: [],
          },
        },
      ],
    };
    const baseline = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: null,
      afterTurn: before,
      currentViews: [],
      currentTranscript: [],
      observedAtMs: 1000,
    });
    const result = applyCodexLifecycleProjectionDiff({
      threadId: THREAD_ID,
      beforeTurn: before,
      afterTurn: after,
      currentViews: baseline.views,
      currentTranscript: baseline.transcript,
      observedAtMs: 1001,
    });
    expect(result.views).toHaveLength(1);
    expect(result.views[0]?.itemId).toBe(baseline.views[0]?.itemId);
    expect(result.views[0]?.deliveryStatus).toBe("not-sent");
    expect(result.transcript[0]?.deliveryStatus).toBe("not-sent");
    expect(result.itemIds).toEqual([]);
  });
});

describe("codex optimistic turn", () => {
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
          environments: null,
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
      environments: null,
      permissions: ":workspace",
      runtimeWorkspaceRoots: ["/workspace"],
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/workspace"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },

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
      const after = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution,
      });
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
      const after = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution,
      });

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
      const after = appendCodexCanonicalOptimisticTurn(before, {
        params: buildParams(),
        execution,
      });

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
          moderation: null,
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
        threadRuntimeStatus: {
          type: "active" as const,
          activeFlags: ["waitingOnApproval" as const],
        },
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
        rootTurnId: null,
        id: "turn-server",
        items: [
          {
            questions: null,
            type: "agentMessage",
            moderation: null,
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
        rootTurnId: null,
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
        moderation: null,
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
        rootTurnId: null,
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
});

describe("codex turn lifecycle", () => {
  const THREAD_ID = "thread-turn-lifecycle";

  function buildState() {
    return createCodexCanonicalHydratedConversationState(
      {
        model: null,
        reasoningEffort: null,
        environments: null,
        id: THREAD_ID,
        extra: null,
        sessionId: "session-turn-lifecycle",
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
        turns: [],
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
          activePermissionProfile: { id: ":workspace", extends: null },
          runtimeWorkspaceRoots: ["/workspace"],
          hasUnreadTurn: false,
        },
      },
    );
  }

  function appendPlaceholder() {
    return appendCodexCanonicalOptimisticTurn(buildState(), {
      startedAtMs: 41,
      params: {
        threadId: THREAD_ID,
        clientUserMessageId: "client-1",
        input: [],
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

        model: "gpt-test",
        serviceTier: null,
        effort: "high",
        summary: "none",
        personality: null,
        outputSchema: null,
        collaborationMode: null,
        attachments: [],
      },
    });
  }

  describe("Codex 30751 turn lifecycle", () => {
    test("rebinds the latest nullable in-progress turn and preserves launch context", () => {
      const result = reduceCodexConversationTurnLifecycle(appendPlaceholder(), {
        conversationId: THREAD_ID,
        method: "turn/started",
        observedAtMs: 99,
        turn: {
          id: "turn-1",
          status: "inProgress",
          error: null,
          startedAt: 2,
          completedAt: null,
          durationMs: null,
        },
      });

      expect(result.disposition).toBe("applied");
      expect(result.state.turns.length).toBe(1);
      expect(result.state.turns[0]?.turnId).toBe("turn-1");
      expect(result.state.turns[0]?.turnStartedAtMs).toBe(41);
      expect(result.state.turns[0]?.params.clientUserMessageId).toBe("client-1");
    });

    test("completes stale plan rows on start, then creates one canonical follow-up on completion", () => {
      const placeholder = appendPlaceholder();
      const params = placeholder.turns[0]!.params;
      const staleItem: CodexCanonicalPlanImplementationItem = {
        id: "implement-plan:old-turn",
        type: "planImplementation",
        turnId: "old-turn",
        planContent: "Old plan",
        isCompleted: false,
      };
      const withOldTurn = {
        ...placeholder,
        turns: [
          {
            rootTurnId: null,
            turnId: "old-turn",
            itemsView: "full" as const,
            status: "completed" as const,
            error: null,
            durationMs: 1,
            items: [staleItem],
            params,
            diff: null,
            turnStartedAtMs: 1,
            finalAssistantStartedAtMs: null,
          },
          ...placeholder.turns,
        ],
        requests: [
          createCodexCanonicalPlanImplementationRequest(
            THREAD_ID,
            "old-turn",
            "Old plan",
            staleItem.id,
          ),
        ],
      };
      const started = reduceCodexConversationTurnLifecycle(withOldTurn, {
        conversationId: THREAD_ID,
        method: "turn/started",
        observedAtMs: 99,
        turn: {
          id: "turn-1",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      }).state;
      expect((started.turns[0]?.items[0] as CodexCanonicalPlanImplementationItem).isCompleted).toBe(
        true,
      );
      expect(started.requests.length).toBe(0);

      const activeIndex = started.turns.findIndex((turn) => turn.turnId === "turn-1");
      const active = started.turns[activeIndex]!;
      const turns = [...started.turns];
      turns[activeIndex] = {
        ...active,
        items: [{ type: "plan", id: "plan-1", text: "  Ship exact parity  " }],
      };
      const completed = reduceCodexConversationTurnLifecycle(
        { ...started, turns },
        {
          conversationId: THREAD_ID,
          method: "turn/completed",
          observedAtMs: 120,
          turn: {
            id: "turn-1",
            status: "completed",
            error: null,
            startedAt: null,
            completedAt: 3,
            durationMs: 42,
          },
        },
      ).state;
      const completedTurn = completed.turns[activeIndex];
      const implementation = completedTurn?.items.find(
        (item) => item.type === "planImplementation",
      );

      expect(completedTurn?.durationMs).toBe(42);
      expect(implementation?.planContent).toBe("Ship exact parity");
      expect(completed.requests[0]?.method).toBe("item/plan/requestImplementation");
      expect(completed.hasUnreadTurn).toBe(true);
    });

    test("ignores completion for an unknown turn", () => {
      const state = buildState();
      const result = reduceCodexConversationTurnLifecycle(state, {
        conversationId: THREAD_ID,
        method: "turn/completed",
        observedAtMs: 120,
        turn: {
          id: "missing",
          status: "completed",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: 1,
        },
      });
      expect(result.state === state).toBe(true);
      expect(result.disposition).toBe("missingTurn");
    });

    test("retains pending steering messages through terminal notifications and replay", () => {
      const started = reduceCodexConversationTurnLifecycle(appendPlaceholder(), {
        conversationId: THREAD_ID,
        method: "turn/started",
        observedAtMs: 99,
        turn: {
          id: "turn-1",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      }).state;
      const steer = (id: string, status: "pending" | "accepted") =>
        ({
          type: "steeringUserMessage",
          id,
          targetTurnId: "turn-1",
          targetTurnStartedAtMs: 41,
          status,
          clientUserMessageId: `client-${id}`,
          input: [{ type: "text", text: id, text_elements: [] }],
          attachments: [],
          restoreMessage: {
            queueRow: createCodexQueuedFollowUp({
              followUpId: `follow-up-${id}`,
              clientUserMessageId: `client-${id}`,
              threadId: THREAD_ID,
              prompt: id,
              createdAtMs: 100,
            }),
            context: { commentAttachments: [] },
          },
          compareKey: { rawText: id, imageCount: 0 },
        }) satisfies CodexCanonicalSteeringUserMessageItem;
      const state = {
        ...started,
        turns: [
          {
            ...started.turns[0]!,
            items: [
              steer("first", "pending"),
              steer("accepted", "accepted"),
              steer("second", "pending"),
              steer(
                encodeCodexAsyncQuestionReplies([
                  { questionItemId: "q", question: "Scope?", answer: "Local" },
                ]),
                "pending",
              ),
            ],
          },
        ],
      };
      for (const terminalStatus of ["completed", "interrupted"] as const) {
        const update = {
          conversationId: THREAD_ID,
          method: "turn/completed" as const,
          observedAtMs: 120,
          turn: {
            id: "turn-1",
            status: terminalStatus,
            error: null,
            startedAt: null,
            completedAt: 1,
            durationMs: 20,
          },
        };

        const completed = reduceCodexConversationTurnLifecycle(state, update);
        expect(completed.effects).toEqual([]);
        expect(completed.state.turns[0]?.items.map((item) => item.id)).toEqual(
          state.turns[0]?.items.map((item) => item.id),
        );

        const replay = reduceCodexConversationTurnLifecycle(completed.state, update);
        expect(replay.effects).toEqual([]);
        expect(replay.state.turns[0]?.items.map((item) => item.id)).toEqual(
          state.turns[0]?.items.map((item) => item.id),
        );
      }
    });
  });
});

describe("codex turn reference", () => {
  function turn(
    turnId: string | null,
    overrides: Partial<CodexTurnReference> = {},
  ): CodexTurnReference {
    return {
      turnId,
      status: "inProgress",
      hasError: false,
      itemCount: 0,
      ...overrides,
    };
  }

  describe("Codex non-synthesizing turn reference resolution", () => {
    test("returns none without turns and uses the latest turn for a nullable ID", () => {
      const noTurns = resolveCodexTurnReference([], "missing");
      const turns = [turn("older"), turn("latest")];
      const latest = resolveCodexTurnReference(turns, null);

      expect(noTurns.kind).toBe("none");
      expect(latest.kind).toBe("latest");
      expect(latest.kind === "latest" ? latest.turnIndex : -1).toBe(1);
    });

    test("finds the newest duplicate exact turn ID", () => {
      const result = resolveCodexTurnReference(
        [turn("duplicate"), turn("between"), turn("duplicate")],
        "duplicate",
      );

      expect(result.kind).toBe("existing");
      expect(result.kind === "existing" ? result.turnIndex : -1).toBe(2);
    });

    test("rebinds an in-progress null placeholder only when the event opts in", () => {
      const turns = [turn("older"), turn(null)];
      const disabled = resolveCodexTurnReference(turns, "bound-turn");
      const enabled = resolveCodexTurnReference(turns, "bound-turn", {
        rebindLatestInProgressPlaceholder: true,
      });
      const namedLatest = resolveCodexTurnReference(
        [turn("older"), turn("different-live-turn")],
        "bound-turn",
        { rebindLatestInProgressPlaceholder: true },
      );

      expect(disabled.kind).toBe("none");
      expect(enabled.kind).toBe("reboundInProgressPlaceholder");
      expect(enabled.kind === "reboundInProgressPlaceholder" ? enabled.turnIndex : -1).toBe(1);
      expect(namedLatest.kind).toBe("none");
    });

    test("rebinds only the sole completed error-free empty null placeholder", () => {
      const eligible = turn(null, { status: "completed" });
      const rebound = resolveCodexTurnReference([eligible], "bound-turn");
      const withError = resolveCodexTurnReference(
        [turn(null, { status: "completed", hasError: true })],
        "bound-turn",
      );
      const withItems = resolveCodexTurnReference(
        [turn(null, { status: "completed", itemCount: 1 })],
        "bound-turn",
      );
      const notSole = resolveCodexTurnReference(
        [turn("older", { status: "completed" }), eligible],
        "bound-turn",
      );

      expect(rebound.kind).toBe("reboundCompletedEmptyPlaceholder");
      expect(rebound.kind === "reboundCompletedEmptyPlaceholder" ? rebound.turnIndex : -1).toBe(0);
      expect(withError.kind).toBe("none");
      expect(withItems.kind).toBe("none");
      expect(notSole.kind).toBe("none");
    });
  });
});

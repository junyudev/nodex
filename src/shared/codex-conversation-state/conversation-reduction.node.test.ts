import { describe, expect, test } from "vite-plus/test";
import { produce } from "immer";
import {
  appendCodexAcceptedServerQueueSubmission,
  discardCodexAcceptedServerQueueSubmission,
} from "../codex-native-queued-submission";
import type { ServerNotification, ServerRequest } from "@nodex/codex-app-server-protocol";
import type {
  Thread,
  ThreadItem,
  HookRunSummary,
  Turn,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import {
  createCodexCanonicalConversationState,
  createCodexCanonicalTurnState,
  mergeCodexCanonicalTurnState,
  type CodexCanonicalConversationState,
  type CodexCanonicalSteeringUserMessageItem,
  type CodexCanonicalTurnParams,
  type CodexCanonicalTurnState,
  appendCodexCanonicalForkedFromConversationItem,
  appendCodexCanonicalInProgressSyntheticItem,
  appendCodexCanonicalWorktreeInitItem,
  buildCodexCanonicalRequestIdentityKey,
  canonicalizeCodexCanonicalTurnStates,
  createCodexCanonicalHydratedConversationState,
  createCodexCanonicalHookRun,
  createCodexCanonicalProtocolItem,
  createCodexCanonicalProtocolRequest,
  projectCodexCanonicalProtocolThread,
  extractCodexCanonicalHydratedAttachments,
  mergeCodexCanonicalOlderTurnStates,
  mergeCodexCanonicalTurnStates,
  materializeCodexCanonicalProtocolItem,
  resolveCodexCanonicalHydratedCwd,
  resolveCodexCanonicalHydratedPermissionContext,
  resolveCodexCanonicalProjectlessCwd,
  removeCodexCanonicalLocalSyntheticItem,
  isCodexCanonicalProtocolItem,
  type CodexCanonicalHydratedSandboxTurnParams,
  type CodexCanonicalOptionPickerRequest,
  type CodexCanonicalPlanImplementationRequest,
  type CodexCanonicalMcpElicitation,
  type CodexCanonicalProtocolItem,
  type CodexCanonicalProtocolRequest,
  type CodexCanonicalRequestSyntheticItem,
  type CodexCanonicalWorktreeInitItem,
  type CodexProtocolServerRequestOf,
} from "./codex-conversation-state";
import {
  reduceCodexConversationEvent,
  reduceCodexConversationEventWithEffects,
  type CodexConversationReducerContext,
} from "./codex-conversation-reducer";
import {
  agentActivityV2WebSearchItem,
  agentActivityV2ItemFamilyCorpus,
  agentActivityV2McpAppContextPrecedenceItem,
  agentActivityV2MultiActionCommandItem,
} from "./test-fixtures/agent-activity-v2-item-family-corpus";
import type { Thread as ThreadForCodexConversationReplay } from "@nodex/codex-app-server-protocol/v2/Thread";
import {
  replayCodexConversationEvents,
  replayCodexConversationFixture,
  type CodexConversationReplayContext,
  type CodexConversationReplayEvent,
} from "./codex-conversation-replay";
import { sanitizedCommandLifecycleFixture } from "./test-fixtures/sanitized-command-lifecycle";
import { resolveAssistantResponseWorkDurationMs } from "../codex-assistant-response-timing";
import { assertCodexFailedTurnContinuation } from "./codex-failed-turn-continuation";
import { projectCodexCanonicalTurnItemViews } from "../codex-canonical-item-projector";
import {
  AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
  AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
  buildAgentActivityV2CorpusThread,
} from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  agentActivityV2CommandApprovalRequest,
  agentActivityV2DynamicOptionPickerRequest,
  agentActivityV2McpElicitationRequest,
  agentActivityV2OneShotRequestCases,
  agentActivityV2PendingResolvedRequestCases,
  agentActivityV2PermissionRequest,
  agentActivityV2UserInputRequest,
} from "./test-fixtures/agent-activity-v2-request-family-corpus";

describe("codex conversation reducer", () => {
  const THREAD_ID = "thread_c03";
  const TURN_ID = "turn_c03";

  function restoreQueueRow(id: string, prompt: string) {
    return createCodexQueuedFollowUp({
      followUpId: `follow-up-${id}`,
      clientUserMessageId: `client-${id}`,
      threadId: THREAD_ID,
      prompt,
      createdAtMs: 1,
    });
  }

  function buildTurnParams(threadId = THREAD_ID): CodexCanonicalTurnParams {
    return {
      threadId,
      input: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      environments: null,
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

  function buildThread(items: ThreadItem[] = [], turnId = TURN_ID): Thread {
    return {
      model: null,
      reasoningEffort: null,
      id: THREAD_ID,
      environments: null,
      extra: null,
      sessionId: "session_c03",
      forkedFromId: null,
      attachedToThreadId: null,
      parentThreadId: null,
      preview: "C-03 lifecycle fixture",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 2,
      recencyAt: 2,
      status: {
        type: "active",
        activeFlags: [],
      },
      path: null,
      cwd: "/workspace/project",
      cliVersion: "fixture",
      originator: null,
      source: "unknown",
      canAcceptDirectInput: true,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: "C-03 lifecycle fixture",
      daybreakEnabled: null,
      turns: [
        {
          rootTurnId: null,
          id: turnId,
          items,
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      ],
    };
  }

  function buildState(items: ThreadItem[] = []): CodexCanonicalConversationState {
    return createCodexCanonicalConversationState(buildThread(items), {
      hostId: "local",
      ...{
        turnParamsById: {
          [TURN_ID]: buildTurnParams(),
        },
      },
    });
  }

  function buildCommand(
    id: string,
    status: "inProgress" | "completed" = "inProgress",
    durationMs: number | null = null,
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
      aggregatedOutput: status === "completed" ? `${id}\n` : null,
      exitCode: status === "completed" ? 0 : null,
      durationMs,
    };
  }

  function lifecycleEvent(
    notification: Extract<
      ServerNotification,
      {
        method: "item/started" | "item/completed";
      }
    >,
  ) {
    return {
      type: "notification" as const,
      notification,
    };
  }

  function buildClock(...values: number[]): {
    readonly context: CodexConversationReducerContext;
    readonly calls: () => number;
  } {
    let callCount = 0;
    return {
      context: {
        now: () => {
          const value = values[callCount];
          callCount += 1;
          if (value === undefined) {
            throw new Error(`Unexpected clock call ${callCount}`);
          }
          return value;
        },
      },
      calls: () => callCount,
    };
  }

  function reduceLifecycle(
    state: CodexCanonicalConversationState,
    notification: Extract<
      ServerNotification,
      {
        method: "item/started" | "item/completed";
      }
    >,
    context: CodexConversationReducerContext,
  ): CodexCanonicalConversationState {
    return reduceCodexConversationEvent(state, lifecycleEvent(notification), context);
  }

  describe("provider recovery lifecycle", () => {
    function session(items: ThreadItem[] = []) {
      let state = buildState(items);
      let sequence = 0;
      const send = (notification: ServerNotification) => {
        state = reduceCodexConversationEvent(
          state,
          { type: "notification", notification },
          { now: () => 100 + sequence, createId: () => `notice-${++sequence}` },
        );
      };
      const fail = (message = "Reconnecting 1/5", willRetry = true) =>
        send({
          method: "error",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            error: {
              message,
              codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
              additionalDetails: "The upstream response stream disconnected.",
              misalignment: null,
            },
            willRetry,
          },
        });
      return {
        send,
        fail,
        state: () => state,
        errors: () => state.turns[0]!.items.filter((item) => item.type === "error"),
      };
    }

    const message: Extract<ThreadItem, { type: "agentMessage" }> = {
      type: "agentMessage",
      moderation: null,
      id: "answer",
      text: "",
      phase: "commentary",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };

    test("an outage wait says it is waiting for the network until the stream resumes", () => {
      const f = session([message]);
      f.fail("Reconnecting... waiting for network");
      expect(f.errors()[0]!.recovery).toMatchObject({
        state: "retrying",
        reason: "connection",
        waitingForNetwork: true,
      });
      f.fail("Reconnecting 2/5");
      expect(f.errors()[0]!.recovery.waitingForNetwork).toBeUndefined();
    });

    test("updates one pending retry and opens another occurrence only after recovery", () => {
      const f = session([message]);
      f.fail();
      const id = f.errors()[0]!.id;
      f.fail("Reconnecting 2/5");
      expect(f.errors()).toHaveLength(1);
      expect(f.errors()[0]).toMatchObject({
        id,
        message: "Reconnecting 2/5",
        recovery: { state: "retrying", reason: "connection", attempt: 2, maxAttempts: 5 },
      });
      f.fail("Waiting for the provider");
      f.fail("Waiting for the provider");
      expect(f.errors()[0]!.recovery).toMatchObject({ attempt: 2, maxAttempts: 5 });
      f.send({
        method: "item/agentMessage/delta",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: message.id, delta: "Resumed" },
      });
      expect(f.errors()[0]!.recovery.state).toBe("recovered");
      f.fail("Waiting for the provider");
      expect(f.errors()).toHaveLength(2);
      expect(f.errors()[1]!.id).not.toBe(id);
      expect(f.errors()[1]!.recovery).toMatchObject({
        state: "retrying",
        attempt: null,
        maxAttempts: null,
      });
      f.fail("Waiting for the provider");
      expect(f.errors()[1]!.recovery.attempt).toBeNull();
    });

    test("new model tools recover the stream while local completion and empty text do not", () => {
      const command = buildCommand("running-command");
      const f = session([command, message]);
      f.fail();
      f.send({
        method: "item/started",
        params: { threadId: THREAD_ID, turnId: TURN_ID, item: command, startedAtMs: 100 },
      });
      expect(f.errors()[0]!.recovery.state).toBe("retrying");
      f.send({
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: buildCommand(command.id, "completed", 10),
          completedAtMs: 110,
        },
      });
      f.send({
        method: "item/agentMessage/delta",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: message.id, delta: "" },
      });
      expect(f.errors()[0]!.recovery.state).toBe("retrying");
      f.send({
        method: "item/started",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { ...buildCommand("user-command"), source: "userShell" },
          startedAtMs: 120,
        },
      });
      expect(f.errors()[0]!.recovery.state).toBe("retrying");
      f.send({
        method: "item/started",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: buildCommand("next-model-command"),
          startedAtMs: 130,
        },
      });
      expect(f.errors()[0]!.recovery.state).toBe("recovered");
    });

    test.each(["completed", "interrupted", "failed"] as const)(
      "settles an unresolved retry on a %s turn without duplicating the row",
      (status) => {
        const f = session();
        f.fail("Reconnecting 3/5");
        const id = f.errors()[0]!.id;
        f.send({
          method: "turn/completed",
          params: {
            threadId: THREAD_ID,
            turn: {
              id: TURN_ID,
              rootTurnId: null,
              status,
              itemsView: "full",
              items: [],
              error:
                status === "failed"
                  ? {
                      message: "The provider could not resume.",
                      codexErrorInfo: "serverOverloaded",
                      additionalDetails: "Please try again shortly.",
                      misalignment: null,
                    }
                  : null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            },
          },
        });
        expect(f.errors()).toHaveLength(1);
        expect(f.errors()[0]).toMatchObject({
          id,
          recovery: {
            state:
              status === "completed"
                ? "recovered"
                : status === "interrupted"
                  ? "stopped"
                  : "failed",
            attempt: 3,
            maxAttempts: 5,
            retryAt: null,
          },
        });
        if (status === "failed")
          expect(f.errors()[0]).toMatchObject({
            message: "The provider could not resume.",
            additionalDetails: "Please try again shortly.",
            recovery: { reason: "overloaded" },
          });
        f.fail("Reconnecting 4/5");
        expect(f.errors()).toHaveLength(1);
        expect(f.errors()[0]!.recovery.state).not.toBe("retrying");
        expect(f.state().turns[0]!.status).toBe(status);
      },
    );

    test("a non-retryable error terminates the active retry with its original progress", () => {
      const f = session();
      f.fail("Reconnecting 5/5");
      const id = f.errors()[0]!.id;
      f.fail("No more attempts are available.", false);
      expect(f.errors()).toHaveLength(1);
      expect(f.errors()[0]).toMatchObject({
        id,
        message: "No more attempts are available.",
        recovery: { state: "failed", attempt: 5, maxAttempts: 5 },
      });
    });

    test("a terminal reconnect snapshot settles a retry whose completion notification was missed", () => {
      const f = session();
      f.fail();
      const current = f.state().turns[0]!;
      const merged = mergeCodexCanonicalTurnState(current, {
        ...current,
        items: [],
        status: "completed",
        completedAtMs: 250,
      });
      const error = merged.items.find((item) => item.type === "error");
      expect(error?.recovery).toMatchObject({ state: "recovered", updatedAt: 250 });
      expect(f.errors()[0]!.recovery.state).toBe("retrying");
    });
  });

  test("external environment membership is thread-scoped, idempotent, and excludes the managed runtime", () => {
    const update = (
      state: CodexCanonicalConversationState,
      environmentId: string,
      connected: boolean,
      threadId = THREAD_ID,
    ) =>
      reduceCodexConversationEvent(
        state,
        {
          type: "notification",
          notification: {
            method: connected ? "thread/environment/connected" : "thread/environment/disconnected",
            params: { threadId, environmentId },
          },
        },
        { now: () => 1 },
      );
    const initial = buildState();
    expect(update(initial, "managed", true)).toBe(initial);
    expect(update(initial, "remote", true, "another-thread")).toBe(initial);
    const connected = update(initial, "remote", true);
    expect(connected.connectedEnvironmentIds).toEqual(["remote"]);
    expect(update(connected, "remote", true)).toBe(connected);
    const second = update(connected, "other", true);
    expect(second.connectedEnvironmentIds).toEqual(["remote", "other"]);
    expect(update(second, "remote", false).connectedEnvironmentIds).toEqual(["other"]);
    expect(update(connected, "remote", false).connectedEnvironmentIds).toEqual([]);
  });

  describe("canonical item lifecycle reducer", () => {
    test.each([false, true])(
      "retains web results across live completion (sparse completion: %s)",
      (sparseCompletion) => {
        const search = agentActivityV2WebSearchItem;
        const sparse = { ...search, results: null };
        const clock = buildClock(100, 200);
        const location = { threadId: THREAD_ID, turnId: TURN_ID };
        const started = reduceLifecycle(
          buildState(),
          {
            method: "item/started",
            params: { ...location, item: sparseCompletion ? search : sparse, startedAtMs: 100 },
          },
          clock.context,
        );
        const completed = reduceLifecycle(
          started,
          {
            method: "item/completed",
            params: { ...location, item: sparseCompletion ? sparse : search, completedAtMs: 200 },
          },
          clock.context,
        );

        expect(completed.turns[0]?.items).toContainEqual({ ...search, startedAtMs: 100 });
        expect(completed.turns[0]?.completedItemIds?.[search.id]).toBe(true);
      },
    );

    test("async question delivery never starts final-answer timing while the Agent continues", () => {
      const item = {
        type: "agentMessage",
        moderation: null,
        id: "question",
        text: "Which scope?",
        phase: "final_answer",
        delivery: "async",
        questions: [{ title: "Which scope?", options: null }],
        memoryCitation: null,
      } satisfies ThreadItem;
      const clock = buildClock(100, 200);
      const started = reduceLifecycle(
        buildState([]),
        {
          method: "item/started",
          params: { threadId: THREAD_ID, turnId: TURN_ID, item, startedAtMs: 100 },
        },
        clock.context,
      );
      const completed = reduceLifecycle(
        started,
        {
          method: "item/completed",
          params: { threadId: THREAD_ID, turnId: TURN_ID, item, completedAtMs: 200 },
        },
        clock.context,
      );
      expect(completed.turns[0]?.finalAssistantStartedAtMs).toBeNull();
      expect(completed.turns[0]?.status).toBe("inProgress");
      expect(completed.turns[0]?.items).toContainEqual({ ...item, startedAtMs: 100 });
    });

    test("keeps first-arrival order and replaces completed raw items in their original slots", () => {
      const startedA = buildCommand("command-a");
      const startedB = buildCommand("command-b");
      const completedA = buildCommand("command-a", "completed", 50);
      const clock = buildClock(10001);
      const initial = buildState();

      const afterA = reduceLifecycle(
        initial,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: startedA,
            startedAtMs: 1000,
          },
        },
        clock.context,
      );
      const afterB = reduceLifecycle(
        afterA,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: startedB,
            startedAtMs: 1010,
          },
        },
        clock.context,
      );
      const completed = reduceLifecycle(
        afterB,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completedA,
            completedAtMs: 1050,
          },
        },
        clock.context,
      );
      const turn = completed.turns[0]!;

      expect(turn.items[0]).toEqual({ ...completedA, startedAtMs: 1000 });
      expect(turn.items[1]).toEqual({ ...startedB, startedAtMs: 1010 });
      expect(JSON.stringify(turn.items.map((item) => item.id))).toBe(
        JSON.stringify(["command-a", "command-b"]),
      );
      expect(turn.commandExecutionStartedAtMsById?.["command-a"]).toBe(1000);
      expect(turn.commandExecutionStartedAtMsById?.["command-b"]).toBe(1010);
      expect(turn.lifecycleStatusByItemId?.["command-a"]).toBe("completed");
      expect(turn.lifecycleStatusByItemId?.["command-b"]).toBe("inProgress");
      expect(turn.firstTurnWorkItemStartedAtMs).toBe(10001);
      expect(clock.calls()).toBe(1);
      expect(initial.turns[0]?.items.length).toBe(0);
    });

    test("duplicate starts replace in place and overwrite command start timing", () => {
      const first = buildCommand("command-repeat");
      const second = {
        ...first,
        processId: "pty-repeat",
      };
      const clock = buildClock(20001);
      const afterFirst = reduceLifecycle(
        buildState(),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: first,
            startedAtMs: 2000,
          },
        },
        clock.context,
      );
      const afterSecond = reduceLifecycle(
        afterFirst,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: second,
            startedAtMs: 2500,
          },
        },
        clock.context,
      );

      expect(afterSecond.turns[0]?.items.length).toBe(1);
      expect(afterSecond.turns[0]?.items[0]).toEqual({ ...second, startedAtMs: 2500 });
      expect(afterSecond.turns[0]?.commandExecutionStartedAtMsById?.["command-repeat"]).toBe(2500);
      expect(clock.calls()).toBe(1);
    });

    test("does not reopen a terminal lifecycle entry after a delayed start", () => {
      const command = buildCommand("command-order");
      const completed = buildCommand("command-order", "completed", 10);
      const afterStart = reduceLifecycle(
        buildState(),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: command,
            startedAtMs: 21000,
          },
        },
        buildClock(21001).context,
      );
      const afterComplete = reduceLifecycle(
        afterStart,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 21010,
          },
        },
        buildClock().context,
      );
      const afterDelayedStart = reduceLifecycle(
        afterComplete,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: command,
            startedAtMs: 21011,
          },
        },
        buildClock().context,
      );
      expect(afterDelayedStart.turns[0]?.lifecycleStatusByItemId?.["command-order"]).toBe(
        "completed",
      );
      expect(afterDelayedStart.turns[0]?.items[0]).toEqual({ ...completed, startedAtMs: 21000 });
    });

    test("completion infers a missing command start but never overwrites an observed start", () => {
      const hydrated = buildCommand("command-hydrated");
      const completed = buildCommand("command-hydrated", "completed", 75);
      const inferredClock = buildClock(30001);
      const inferred = reduceLifecycle(
        buildState([hydrated]),
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 3075,
          },
        },
        inferredClock.context,
      );
      const observedClock = buildClock(31001);
      const started = reduceLifecycle(
        buildState(),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: hydrated,
            startedAtMs: 2900,
          },
        },
        observedClock.context,
      );
      const observed = reduceLifecycle(
        started,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 3075,
          },
        },
        observedClock.context,
      );
      expect(inferred.turns[0]?.commandExecutionStartedAtMsById?.["command-hydrated"]).toBe(3000);
      expect(observed.turns[0]?.commandExecutionStartedAtMsById?.["command-hydrated"]).toBe(2900);
    });

    test("authoritative command completion survives a missing start with its output and timing", () => {
      const completed = {
        ...buildCommand("command-orphan", "completed", 40),
        aggregatedOutput: "final output\n",
      };
      const clock = buildClock(40001);
      const next = reduceLifecycle(
        buildState(),
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 4040,
          },
        },
        clock.context,
      );

      expect(next.turns[0]?.items).toEqual([completed]);
      expect(next.turns[0]?.commandExecutionStartedAtMsById?.["command-orphan"]).toBe(4000);
      expect(next.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(40001);
    });

    test("completion requires the same ID and protocol type", () => {
      const command = buildCommand("shared-id");
      const agentMessage = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "shared-id",
        text: "final",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
      } satisfies ThreadItem;
      const clock = buildClock(50001);
      const next = reduceLifecycle(
        buildState([command]),
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: agentMessage,
            completedAtMs: 5000,
          },
        },
        clock.context,
      );

      expect(next.turns[0]?.items[0] === command).toBe(true);
      expect(next.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(50001);
      expect(next.turns[0]?.finalAssistantStartedAtMs).toBe(null);
    });

    test("starts replace a same-ID slot across visible and hidden protocol types", () => {
      const command = buildCommand("cross-type-id");
      const enteredReview = {
        type: "enteredReviewMode",
        id: "cross-type-id",
        review: "sanitized review",
      } satisfies ThreadItem;
      const exitedReview = {
        type: "exitedReviewMode",
        id: "cross-type-id",
        review: "sanitized review",
      } satisfies ThreadItem;
      const clock = buildClock(55001);
      const hidden = reduceLifecycle(
        buildState([command]),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: enteredReview,
            startedAtMs: 5500,
          },
        },
        clock.context,
      );
      const mismatchedCompletion = reduceLifecycle(
        hidden,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: exitedReview,
            completedAtMs: 5510,
          },
        },
        clock.context,
      );
      const visibleAgain = reduceLifecycle(
        mismatchedCompletion,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: command,
            startedAtMs: 5520,
          },
        },
        clock.context,
      );

      expect(hidden.turns[0]?.items.length).toBe(1);
      expect(hidden.turns[0]?.items[0]).toEqual({ ...enteredReview, startedAtMs: 5500 });
      expect(mismatchedCompletion.turns[0]?.items[0]).toEqual({
        ...enteredReview,
        startedAtMs: 5500,
      });
      expect(visibleAgain.turns[0]?.items.length).toBe(1);
      expect(visibleAgain.turns[0]?.items[0]).toEqual({ ...command, startedAtMs: 5520 });
      expect(visibleAgain.turns[0]?.lifecycleStatusByItemId?.[command.id]).toBe("inProgress");
      expect(clock.calls()).toBe(1);
    });

    test("user, hook, and subagent completions are accepted without a started item", () => {
      const user = {
        type: "userMessage",
        id: "user-orphan",
        clientId: null,
        content: [
          {
            type: "text",
            text: "fixture user",
            text_elements: [],
          },
        ],
      } satisfies ThreadItem;
      const hook = {
        type: "hookPrompt",
        id: "hook-orphan",
        fragments: [],
      } satisfies ThreadItem;
      const subagent = {
        type: "subAgentActivity",
        model: null,
        reasoningEffort: null,
        id: "subagent-orphan",
        kind: "started",
        agentThreadId: "agent-thread",
        agentPath: "agent/path",
      } satisfies ThreadItem;
      const clock = buildClock(60001);
      let state = buildState();

      for (const item of [user, hook, subagent]) {
        state = reduceLifecycle(
          state,
          {
            method: "item/completed",
            params: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              item,
              completedAtMs: 6000,
            },
          },
          clock.context,
        );
      }

      expect(JSON.stringify(state.turns[0]?.items.map((item) => item.id))).toBe(
        JSON.stringify(["user-orphan", "hook-orphan", "subagent-orphan"]),
      );
      expect(state.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(60001);
      expect(clock.calls()).toBe(1);
    });

    test("agent response uses its recorded start while live work keeps the observer clock", () => {
      const started = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "agent-message",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      } satisfies ThreadItem;
      const completed = {
        ...started,
        text: "authoritative final",
        phase: "final_answer" as const,
      };
      const clock = buildClock(70001, 70002);
      const afterStart = reduceLifecycle(
        buildState(),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: started,
            startedAtMs: 7000,
          },
        },
        clock.context,
      );
      const afterComplete = reduceLifecycle(
        afterStart,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 7050,
          },
        },
        clock.context,
      );
      expect(afterComplete.turns[0]?.finalAssistantStartedAtMs).toBe(7000);
      expect(afterComplete.turns[0]?.assistantResponseWorkDurationMs).toBe(0);
      expect(afterComplete.turns[0]?.assistantMessageStartedAtMsById).toEqual({
        "agent-message": 7000,
      });
      expect(afterComplete.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(70001);
      expect(afterStart.turns[0]?.lifecycleStatusByItemId?.["agent-message"]).toBe("inProgress");
      expect(afterComplete.turns[0]?.lifecycleStatusByItemId?.["agent-message"]).toBe("completed");
      expect(afterComplete.turns[0]?.items[0]).toEqual({ ...completed, startedAtMs: 7000 });
      expect(clock.calls()).toBe(1);
    });

    test("missing started turns clone latest context while clearing exact lifecycle fields", () => {
      const initial = buildState();
      const seededTurn: CodexCanonicalTurnState = {
        ...initial.turns[0]!,
        status: "completed",
        durationMs: 400,
        error: {
          message: "old failure",
          codexErrorInfo: null,
          additionalDetails: null,
          misalignment: null,
        },
        diff: "old diff",
        firstTurnWorkItemStartedAtMs: 1,
        finalAssistantStartedAtMs: 2,
        commandExecutionStartedAtMsById: { surviving: 3 },
        interruptedCommandExecutionItemIds: ["surviving"],
      };
      const state = {
        ...initial,
        turns: [seededTurn],
      };
      const command = buildCommand("new-turn-command");
      const clock = buildClock(80001, 80002);
      const next = reduceLifecycle(
        state,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: "turn_missing",
            item: command,
            startedAtMs: 8000,
          },
        },
        { ...clock.context, createId: () => "missing-turn-entity" },
      );
      const synthesized = next.turns[1]!;

      expect(synthesized.turnId).toBe("turn_missing");
      expect(synthesized.status).toBe("inProgress");
      expect(synthesized.error).toBe(null);
      expect(synthesized.durationMs).toBe(null);
      expect(synthesized.turnStartedAtMs).toBe(80001);
      expect(synthesized.firstTurnWorkItemStartedAtMs).toBe(80002);
      expect(synthesized.finalAssistantStartedAtMs).toBe(null);
      expect(synthesized.diff).toBe(null);
      expect(synthesized.params.input.length).toBe(0);
      expect((synthesized.params.attachments ?? []).length).toBe(0);
      expect(synthesized.commandExecutionStartedAtMsById?.surviving).toBe(3);
      expect(synthesized.interruptedCommandExecutionItemIds?.[0]).toBe("surviving");
      expect(synthesized.items[0]).toMatchObject(command);
      expect(state.turns.length).toBe(1);
    });

    test("started work rebinds a client-identified optimistic turn instead of splitting it", () => {
      const initial = buildState();
      const placeholder: CodexCanonicalTurnState = {
        ...initial.turns[0]!,
        turnId: null,
        params: {
          ...initial.turns[0]!.params,
          clientUserMessageId: "client-racing-turn",
          input: [{ type: "text", text: "Keep one turn", text_elements: [] }],
        },
      };
      const assistant = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "assistant-before-turn-started",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      } satisfies ThreadItem;
      const next = reduceLifecycle(
        { ...initial, turns: [placeholder] },
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: "turn_racing",
            item: assistant,
            startedAtMs: 8000,
          },
        },
        buildClock(80001, 80002).context,
      );

      expect(next.turns).toHaveLength(1);
      expect(next.turns[0]?.turnId).toBe("turn_racing");
      expect(next.turns[0]?.params.input).toEqual(placeholder.params.input);
      expect(next.turns[0]?.items).toEqual([{ ...assistant, startedAtMs: 8000 }]);
    });

    test("context compaction rebinds the in-progress placeholder and keeps manual source", () => {
      const initial = {
        ...buildState(),
        lastInjectedPassiveContextKey: "confirmed-before-compaction",
      };
      const placeholder: CodexCanonicalTurnState = {
        ...initial.turns[0]!,
        turnId: null,
        items: [
          {
            type: "contextCompaction",
            id: "pending-manual-context-compaction",
            completed: false,
            source: "manual",
          },
        ],
        turnStartedAtMs: null,
      };
      const state = { ...initial, turns: [placeholder] };
      const compaction = {
        type: "contextCompaction",
        id: "context-compaction",
      } satisfies ThreadItem;
      const clock = buildClock(90001, 90002);
      let consumedSourceCount = 0;
      const next = reduceCodexConversationEvent(
        state,
        lifecycleEvent({
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: compaction,
            startedAtMs: 9000,
          },
        }),
        {
          ...clock.context,
          consumeContextCompactionSource: () => {
            consumedSourceCount += 1;
            return "manual";
          },
        },
      );
      const stored = next.turns[0]?.items[0];

      expect(next.turns[0]?.turnId).toBe(TURN_ID);
      expect(next.turns[0]?.turnStartedAtMs).toBe(90001);
      expect(next.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(90002);
      expect(stored?.id).toBe("context-compaction");
      expect(stored?.type).toBe("contextCompaction");
      expect(stored && "source" in stored ? stored.source : null).toBe("manual");
      expect(stored && "completed" in stored ? stored.completed : null).toBe(false);
      expect(stored && "startedAtMs" in stored ? stored.startedAtMs : null).toBe(9000);
      expect(consumedSourceCount).toBe(1);
      expect(next.lastInjectedPassiveContextKey).toBe("confirmed-before-compaction");
    });

    test("rejected compaction completion cannot invalidate a confirmed passive injection", () => {
      const initial = { ...buildState(), turns: [], lastInjectedPassiveContextKey: "confirmed" };
      const next = reduceLifecycle(
        initial,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: "missing-turn",
            item: { type: "contextCompaction", id: "old-compaction" },
            completedAtMs: 20,
          },
        },
        buildClock().context,
      );
      expect(next.lastInjectedPassiveContextKey).toBe("confirmed");
      expect(next.turns).toEqual([]);
    });

    test("completed compaction reads only the first same-ID row before source fallback", () => {
      const initial = buildState();
      const rawCompaction = {
        type: "contextCompaction",
        id: "duplicate-context-compaction",
      } satisfies ThreadItem;
      const state: CodexCanonicalConversationState = {
        ...initial,
        lastInjectedPassiveContextKey: "confirmed-before-compaction",
        turns: [
          {
            ...initial.turns[0]!,
            items: [
              rawCompaction,
              {
                ...rawCompaction,
                completed: false,
                source: "manual",
              },
            ],
          },
        ],
      };
      const next = reduceLifecycle(
        state,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: rawCompaction,
            completedAtMs: 9400,
          },
        },
        buildClock(94001).context,
      );
      const completed = next.turns[0]?.items[0];

      expect(completed?.type).toBe("contextCompaction");
      expect(completed && "source" in completed ? completed.source : null).toBe("automatic");
      expect(completed && "completed" in completed ? completed.completed : null).toBe(true);
      expect(next.lastInjectedPassiveContextKey).toBeUndefined();
    });

    test("materializes only the bundle-defined image and collaboration extensions", () => {
      const image = {
        generationId: null,
        type: "imageGeneration",
        id: "image-generation",
        status: "completed",
        revisedPrompt: null,
        result: "fallback-base64",
        failure: null,
        savedPath: "C:\\Fixture\\generated.png",
      } satisfies ThreadItem;
      const collab = {
        type: "collabAgentToolCall",
        id: "collab-call",
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: THREAD_ID,
        receiverThreadIds: ["receiver-thread"],
        prompt: "Inspect the fixture",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      } satisfies ThreadItem;
      const receiverThread: Thread = {
        ...buildThread([], "receiver-turn"),
        id: "receiver-thread",
        name: "Fixture agent",
      };
      const trace: string[] = [];
      const clock = buildClock(95001);
      const context: CodexConversationReducerContext = {
        now: () => {
          trace.push("now:firstWork");
          return clock.context.now();
        },
        resolveCollabReceiverThread: (threadId) => {
          trace.push("resolveReceiver");
          return threadId === "receiver-thread" ? receiverThread : null;
        },
      };
      const collabResult = reduceCodexConversationEventWithEffects(
        buildState(),
        lifecycleEvent({
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: collab,
            startedAtMs: 9501,
          },
        }),
        context,
      );
      const afterImage = reduceLifecycle(
        collabResult.state,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: image,
            startedAtMs: 9500,
          },
        },
        context,
      );
      const storedCollab = afterImage.turns[0]?.items[0];
      const storedImage = afterImage.turns[0]?.items[1];

      expect(
        storedImage?.type === "imageGeneration" && "src" in storedImage ? storedImage.src : null,
      ).toBe("/C:/Fixture/generated.png");
      expect(
        storedCollab?.type === "collabAgentToolCall" && "receiverThreads" in storedCollab
          ? storedCollab.receiverThreads[0]?.thread === receiverThread
          : false,
      ).toBe(true);
      expect(collabResult.effects[0]?.type).toBe("markConversationStreaming");
      expect(collabResult.effects[1]?.type).toBe("hydrateCollabThreads");
      expect(
        collabResult.effects[1]?.type === "hydrateCollabThreads"
          ? collabResult.effects[1].receiverThreadIds[0]
          : null,
      ).toBe("receiver-thread");
      expect(trace.join(",")).toBe("now:firstWork,resolveReceiver");
      expect(clock.calls()).toBe(1);
    });

    test("emits collaboration hydration before dropping an unmatched completion", () => {
      const collab = {
        type: "collabAgentToolCall",
        id: "orphan-collab-call",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: THREAD_ID,
        receiverThreadIds: ["receiver-orphan"],
        prompt: "Inspect the orphan fixture",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      } satisfies ThreadItem;
      const trace: string[] = [];
      const clock = buildClock(96001);
      const result = reduceCodexConversationEventWithEffects(
        buildState(),
        lifecycleEvent({
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: collab,
            completedAtMs: 9600,
          },
        }),
        {
          now: () => {
            trace.push("now:firstWork");
            return clock.context.now();
          },
          resolveCollabReceiverThread: () => {
            trace.push("resolveReceiver");
            return null;
          },
        },
      );

      expect(result.effects[0]?.type).toBe("hydrateCollabThreads");
      expect(
        result.effects[0]?.type === "hydrateCollabThreads"
          ? result.effects[0].receiverThreadIds[0]
          : null,
      ).toBe("receiver-orphan");
      expect(trace.join(",")).toBe("resolveReceiver,now:firstWork");
      expect(result.state.turns[0]?.items.length).toBe(0);
      expect(result.state.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(96001);
    });

    test("ordinary user starts are suppressed while exact heartbeat starts survive", () => {
      const ordinary = {
        type: "userMessage",
        id: "ordinary-user",
        clientId: null,
        content: [{ type: "text", text: "hello", text_elements: [] }],
      } satisfies ThreadItem;
      const heartbeat = {
        type: "userMessage",
        id: "heartbeat-user",
        clientId: null,
        content: [
          {
            type: "text",
            text: [
              "<heartbeat>",
              "<current_time_iso>2026-07-10T00:00:00Z</current_time_iso>",
              "<instructions>check fixture</instructions>",
              "</heartbeat>",
            ].join("\n"),
            text_elements: [],
          },
        ],
      } satisfies ThreadItem;
      const clock = buildClock();
      const afterOrdinary = reduceLifecycle(
        buildState(),
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: ordinary,
            startedAtMs: 10000,
          },
        },
        clock.context,
      );
      const afterHeartbeat = reduceLifecycle(
        afterOrdinary,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: heartbeat,
            startedAtMs: 10001,
          },
        },
        clock.context,
      );

      expect(afterOrdinary.turns[0]?.items.length).toBe(0);
      expect(afterHeartbeat.turns[0]?.items[0]).toMatchObject(heartbeat);
      expect(clock.calls()).toBe(0);
    });

    test("completed matching user message accepts the steer and inserts the exact marker ID", () => {
      const initial = buildState();
      const content = [
        {
          type: "text" as const,
          text: "steer fixture",
          text_elements: [],
        },
      ];
      const steeringItem = {
        type: "steeringUserMessage",
        id: "pending-steer",
        targetTurnId: TURN_ID,
        targetTurnStartedAtMs: null,
        status: "pending",
        clientUserMessageId: "client-pending-steer",
        input: content,
        attachments: [],
        restoreMessage: {
          queueRow: restoreQueueRow("pending-steer", "steer fixture"),
          context: {
            commentAttachments: [],
          },
        },
        compareKey: {
          rawText: "steer fixture",
          imageCount: 0,
        },
      } satisfies CodexCanonicalSteeringUserMessageItem;
      const state = {
        ...initial,
        turns: [
          {
            ...initial.turns[0]!,
            items: [steeringItem],
          },
        ],
      };
      const completed = {
        type: "userMessage",
        id: "accepted-user-id",
        clientId: null,
        content,
      } satisfies ThreadItem;
      const next = reduceLifecycle(
        state,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 11000,
          },
        },
        buildClock().context,
      );

      expect(next.turns[0]?.items[0]?.type).toBe("steeringUserMessage");
      expect(
        next.turns[0]?.items[0]?.type === "steeringUserMessage"
          ? next.turns[0]?.items[0]?.status
          : null,
      ).toBe("accepted");
      expect(
        next.turns[0]?.items[0]?.type === "steeringUserMessage"
          ? next.turns[0]?.items[0]?.acceptedInput
          : null,
      ).toEqual(content);
      expect(next.turns[0]?.items[1]?.type).toBe("steered");
      expect(next.turns[0]?.items[1]?.id).toBe("accepted-user-id");
    });

    test.each(["started", "matching", "wrong-input", "already-cleaned"] as const)(
      "a handed-off native queue steer records cleanup only for its actual completed input: %s",
      (form) => {
        const initial = buildState();
        const input = [
          {
            type: "text" as const,
            text: "Stored native context\n## My request:\nContinue",
            text_elements: [],
          },
        ];
        const raw = {
          id: "native-row",
          clientUserMessageId: "native-client",
          input,
          responsesapiClientMetadata: null,
        };
        const pending: CodexCanonicalSteeringUserMessageItem = {
          type: "steeringUserMessage",
          id: "handoff-steer",
          targetTurnId: TURN_ID,
          targetTurnStartedAtMs: null,
          status: "pending",
          clientUserMessageId: raw.clientUserMessageId,
          input,
          serverQueuedSubmission: raw,
          attachments: [],
          restoreMessage: { context: { commentAttachments: [] } },
          compareKey: { rawText: input[0]!.text, imageCount: 0 },
        };
        let state: CodexCanonicalConversationState = {
          ...initial,
          turns: [{ ...initial.turns[0]!, items: [pending] }],
        };
        if (form === "already-cleaned")
          state = produce(state, (draft) => {
            appendCodexAcceptedServerQueueSubmission(draft, raw);
            discardCodexAcceptedServerQueueSubmission(draft, raw);
          });
        const echo: ThreadItem = {
          type: "userMessage",
          id: "native-user",
          clientId: raw.clientUserMessageId,
          content:
            form === "wrong-input"
              ? [{ type: "text", text: "Other request", text_elements: [] }]
              : input,
        };
        const next = reduceLifecycle(
          state,
          form === "started"
            ? {
                method: "item/started",
                params: { threadId: THREAD_ID, turnId: TURN_ID, item: echo, startedAtMs: 11000 },
              }
            : {
                method: "item/completed",
                params: { threadId: THREAD_ID, turnId: TURN_ID, item: echo, completedAtMs: 11000 },
              },
          buildClock().context,
        );
        expect(next.unconfirmedServerQueueMessages).toEqual(
          form === "matching" ? [raw] : undefined,
        );
        expect(next.turns[0]?.items[0]).toMatchObject({
          type: "steeringUserMessage",
          status: form === "started" ? "pending" : "accepted",
        });
        const nextSteer = next.turns[0]?.items[0];
        expect(
          nextSteer?.type === "steeringUserMessage" ? nextSteer.serverQueuedSubmission : null,
        ).toEqual(form === "already-cleaned" ? undefined : raw);
      },
    );

    for (const initialStatus of ["pending", "accepted"] as const)
      test(`matches identical ${initialStatus} steers by app-server client identity`, () => {
        const initial = buildState();
        const content = [
          {
            type: "text" as const,
            text: "same text",
            text_elements: [],
          },
        ];
        const buildPending = (id: string): CodexCanonicalSteeringUserMessageItem => ({
          type: "steeringUserMessage",
          id,
          targetTurnId: TURN_ID,
          targetTurnStartedAtMs: null,
          status: initialStatus,
          clientUserMessageId: id,
          input: content,
          attachments: [],
          restoreMessage: {
            queueRow: restoreQueueRow(id, "same text"),
            context: { commentAttachments: [] },
          },
          compareKey: { rawText: "same text", imageCount: 0 },
        });
        const state = {
          ...initial,
          turns: [
            {
              ...initial.turns[0]!,
              items: [
                {
                  ...buildPending("steer-first"),
                  clientUserMessageId: initialStatus === "accepted" ? null : "steer-first",
                },
                buildPending("steer-second"),
              ],
            },
          ],
        };
        const next = reduceLifecycle(
          state,
          {
            method: "item/completed",
            params: {
              threadId: THREAD_ID,
              turnId: TURN_ID,
              completedAtMs: 11000,
              item: {
                type: "userMessage",
                id: "server-second",
                clientId: "steer-second",
                content,
              },
            },
          },
          buildClock().context,
        );

        expect(
          next.turns[0]?.items.slice(0, 2).map((item) => ({
            id: item.id,
            status: item.type === "steeringUserMessage" ? item.status : null,
          })),
        ).toEqual([
          { id: "steer-first", status: initialStatus },
          { id: "steer-second", status: "accepted" },
        ]);
        expect(next.turns[0]?.items[1]).toMatchObject({ serverUserMessageId: "server-second" });
        expect(next.turns[0]?.items[2]).toMatchObject({ type: "steered", id: "server-second" });
      });

    test("steer matching excludes exact comment-attachment labels but keeps image count", () => {
      const initial = buildState();
      const commentLabel =
        "The next image was attached by the user as additional visual context for Comment 7.";
      const content = [
        {
          type: "text" as const,
          text: "steer fixture",
          text_elements: [],
        },
        {
          type: "text" as const,
          text: commentLabel,
          text_elements: [],
        },
        {
          type: "localImage" as const,
          path: "/tmp/comment.png",
        },
      ];
      const commentAttachment = {
        position: {
          line: 7,
          path: "browser:fixture",
        },
        localBrowserAttachedImages: [
          {
            dataUrl: "data:image/png;base64,fixture",
            localPath: "/tmp/comment.png",
          },
        ],
      };
      const steeringItem = {
        type: "steeringUserMessage",
        id: "pending-attachment-steer",
        targetTurnId: TURN_ID,
        targetTurnStartedAtMs: null,
        status: "pending",
        clientUserMessageId: "client-pending-attachment-steer",
        input: content,
        attachments: [],
        restoreMessage: {
          queueRow: restoreQueueRow("pending-attachment-steer", "steer fixture"),
          context: {
            commentAttachments: [commentAttachment],
          },
        },
        compareKey: {
          rawText: "steer fixture",
          imageCount: 1,
        },
      } satisfies CodexCanonicalSteeringUserMessageItem;
      const state = {
        ...initial,
        turns: [
          {
            ...initial.turns[0]!,
            items: [steeringItem],
          },
        ],
      };
      const completed = {
        type: "userMessage",
        id: "accepted-attachment-user-id",
        clientId: null,
        content,
      } satisfies ThreadItem;
      const next = reduceLifecycle(
        state,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: completed,
            completedAtMs: 11100,
          },
        },
        buildClock().context,
      );

      expect(
        next.turns[0]?.items[0]?.type === "steeringUserMessage"
          ? next.turns[0]?.items[0]?.status
          : null,
      ).toBe("accepted");
      expect(next.turns[0]?.items[1]?.type).toBe("steered");
      expect(next.turns[0]?.items[1]?.id).toBe("accepted-attachment-user-id");
    });

    test("does not synthesize a first turn or a missing completion turn", () => {
      const initial = buildState();
      const emptyConversation = {
        ...initial,
        turns: [],
      };
      const command = buildCommand("missing-turn-command");
      const noFirstTurn = reduceLifecycle(
        emptyConversation,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: "turn_missing",
            item: command,
            startedAtMs: 12000,
          },
        },
        buildClock().context,
      );
      const noCompletionTurn = reduceLifecycle(
        initial,
        {
          method: "item/completed",
          params: {
            threadId: THREAD_ID,
            turnId: "turn_missing",
            item: { ...command, status: "completed" },
            completedAtMs: 12050,
          },
        },
        buildClock().context,
      );

      expect(noFirstTurn === emptyConversation).toBe(true);
      expect(noCompletionTurn === initial).toBe(true);
    });

    test("emits streaming before turn resolution without consuming rejected compaction source", () => {
      const initial = buildState();
      const compaction = {
        type: "contextCompaction",
        id: "streaming-resolution-compaction",
      } satisfies ThreadItem;
      let consumedSourceCount = 0;
      const context: CodexConversationReducerContext = {
        ...buildClock().context,
        consumeContextCompactionSource: () => {
          consumedSourceCount += 1;
          return "manual";
        },
      };
      const known = reduceCodexConversationEventWithEffects(
        { ...initial, turns: [] },
        lifecycleEvent({
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: "turn-missing",
            item: compaction,
            startedAtMs: 12100,
          },
        }),
        context,
      );
      const unknown = reduceCodexConversationEventWithEffects(
        initial,
        lifecycleEvent({
          method: "item/started",
          params: {
            threadId: "unknown-thread",
            turnId: TURN_ID,
            item: compaction,
            startedAtMs: 12101,
          },
        }),
        context,
      );

      expect(known.effects[0]?.type).toBe("markConversationStreaming");
      expect(known.state.turns.length).toBe(0);
      expect(unknown.effects.length).toBe(0);
      expect(unknown.state === initial).toBe(true);
      expect(consumedSourceCount).toBe(0);
    });

    test("started items never force an existing terminal turn back to in-progress", () => {
      const initial = buildState();
      const state = {
        ...initial,
        turns: [
          {
            ...initial.turns[0]!,
            status: "completed" as const,
          },
        ],
      };
      const agent = {
        questions: null,
        type: "agentMessage",
        moderation: null,
        id: "terminal-turn-agent",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      } satisfies ThreadItem;
      const next = reduceLifecycle(
        state,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item: agent,
            startedAtMs: 13000,
          },
        },
        buildClock(13001, 13002).context,
      );

      expect(next.turns[0]?.status).toBe("completed");
    });

    test("unknown conversations and unrelated events preserve state identity", () => {
      const initial = buildState();
      const command = buildCommand("unknown-command");
      const unknown = reduceLifecycle(
        initial,
        {
          method: "item/started",
          params: {
            threadId: "another-thread",
            turnId: TURN_ID,
            item: command,
            startedAtMs: 12000,
          },
        },
        buildClock().context,
      );
      const unrelated = reduceCodexConversationEvent(
        initial,
        {
          type: "notification",
          notification: {
            method: "thread/closed",
            params: { threadId: THREAD_ID },
          },
        },
        buildClock().context,
      );

      expect(unknown === initial).toBe(true);
      expect(unrelated === initial).toBe(true);
    });
  });

  test("records resident item mutations without changing the canonical overlay", () => {
    const initial = buildState([buildCommand("resident-command")]);
    const resident = initial.turns[0]!;
    const overlay = { ...resident, turnId: "overlay", items: [buildCommand("resident-command")] };
    const boundary = (id: string) => ({ status: "exhausted" as const, boundaryId: id });
    const state: CodexCanonicalConversationState = {
      ...initial,
      turns: [overlay],
      turnHistory: {
        kind: "canonical",
        history: {
          generation: 3,
          isComplete: false,
          entitiesByKey: { "resident-stable": resident },
          islands: [
            {
              id: "resident-island",
              entries: [{ key: "entry", value: "resident-stable" }],
              olderBoundary: boundary("older"),
              newerBoundary: boundary("newer"),
            },
          ],
        },
      },
    };
    const event = {
      type: "notification" as const,
      notification: {
        method: "item/commandExecution/outputDelta" as const,
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "resident-command",
          delta: "output",
        },
      },
    };
    const changed = reduceCodexConversationEventWithEffects(state, event, { now: () => 500 });
    expect(changed.state.turns).toBe(state.turns);
    expect(changed.state.updatedAt).toBe(state.updatedAt);
    expect(changed.patches).toEqual([
      {
        op: "replace",
        path: [
          "turnHistory",
          "history",
          "entitiesByKey",
          "resident-stable",
          "items",
          0,
          "aggregatedOutput",
        ],
        value: "output",
      },
    ]);
    const unchanged = reduceCodexConversationEventWithEffects(
      changed.state,
      {
        ...event,
        notification: {
          ...event.notification,
          params: { ...event.notification.params, delta: "" },
        },
      },
      { now: () => 600 },
    );
    expect(unchanged.state).toBe(changed.state);
    expect(unchanged.patches).toEqual([]);
  });

  test("retains independent assistant start timestamps across repeats and terminal notifications", () => {
    const message = (id: string): Extract<ThreadItem, { type: "agentMessage" }> => ({
      type: "agentMessage",
      moderation: null,
      id,
      text: "",
      phase: "commentary",
      questions: null,
      memoryCitation: null,
      delivery: null,
    });
    const start = (state: CodexCanonicalConversationState, id: string, startedAtMs: number) =>
      reduceLifecycle(
        state,
        {
          method: "item/started",
          params: { threadId: THREAD_ID, turnId: TURN_ID, item: message(id), startedAtMs },
        },
        { now: () => 99999 },
      );
    const first = start(buildState(), "commentary", 1200);
    const second = start(first, "final", 4000);
    const repeated = start(second, "commentary", 5000);
    const completed = reduceLifecycle(
      repeated,
      {
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: { ...message("final"), phase: "final_answer", text: "Done" },
          completedAtMs: 8000,
        },
      },
      { now: () => 99999 },
    );
    expect(completed.turns[0]?.assistantMessageStartedAtMsById).toEqual({
      commentary: 1200,
      final: 4000,
    });
    expect(repeated.turns[0]?.finalAssistantStartedAtMs).toBe(4000);
    expect(completed.turns[0]?.finalAssistantStartedAtMs).toBe(4000);
  });

  test("native response timing and work duration survive reload independently of observer clock skew", () => {
    const reasoning: ThreadItem = {
      type: "reasoning",
      id: "hidden-thought",
      summary: [],
      content: [],
    };
    const response: ThreadItem = {
      type: "agentMessage",
      moderation: null,
      id: "response",
      text: "Done",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const notifyStart = (
      state: CodexCanonicalConversationState,
      item: ThreadItem,
      startedAtMs: number,
    ) =>
      reduceLifecycle(
        state,
        {
          method: "item/started",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            item,
            startedAtMs,
          },
        },
        { now: () => 100_000 },
      );
    const thinking = notifyStart(buildState(), reasoning, 1000);
    const started = notifyStart(thinking, response, 8000);
    const completed = reduceLifecycle(
      started,
      {
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: response,
          completedAtMs: 9000,
        },
      },
      { now: () => 200_000 },
    );
    const live = completed.turns[0]!;
    expect(live.firstTurnWorkItemStartedAtMs).toBe(100_000);
    expect(live.finalAssistantStartedAtMs).toBe(8000);
    expect(live.assistantResponseWorkDurationMs).toBe(7000);
    const [thought, answer] = live.items;
    if (thought?.type !== "reasoning" || answer?.type !== "agentMessage")
      throw new Error("Missing response items");
    const reloaded = createCodexCanonicalTurnState(
      {
        id: TURN_ID,
        rootTurnId: null,
        items: [thought, answer],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: 1,
        completedAt: 9,
        durationMs: 8000,
      },
      live.params,
    );
    expect(reloaded.finalAssistantStartedAtMs).toBe(live.finalAssistantStartedAtMs);
    expect(reloaded.assistantResponseWorkDurationMs).toBe(live.assistantResponseWorkDurationMs);
  });
});

describe("codex conversation replay", () => {
  function describeEvent(
    event: CodexConversationReplayEvent,
    context: CodexConversationReplayContext,
  ): string {
    if (event.type === "request") {
      return [
        context.sourceIndex,
        "request",
        event.request.method,
        typeof event.request.id,
        event.request.id,
      ].join(":");
    }

    if (event.notification.method === "serverRequest/resolved") {
      return [
        context.sourceIndex,
        "notification",
        event.notification.method,
        typeof event.notification.params.requestId,
        event.notification.params.requestId,
      ].join(":");
    }

    return [context.sourceIndex, "notification", event.notification.method].join(":");
  }

  function recordEvent(
    state: readonly string[],
    event: CodexConversationReplayEvent,
    context: CodexConversationReplayContext,
  ): readonly string[] {
    return [...state, describeEvent(event, context)];
  }

  function buildHydratedCommandThread(): ThreadForCodexConversationReplay {
    const initialThread = sanitizedCommandLifecycleFixture.initialThread;
    const commandCompletedEvent: CodexConversationReplayEvent | undefined =
      sanitizedCommandLifecycleFixture.events[4];
    if (initialThread === null || commandCompletedEvent?.type !== "notification") {
      throw new Error("Invalid sanitized command replay fixture");
    }

    const { notification } = commandCompletedEvent;
    if (notification.method !== "item/completed") {
      throw new Error("Invalid sanitized command replay fixture");
    }

    const { item } = notification.params;
    if (item.type !== "commandExecution") {
      throw new Error("Invalid sanitized command replay fixture");
    }

    return {
      ...initialThread,
      turns: initialThread.turns.map((turn) => ({
        ...turn,
        items: [
          {
            ...item,
            status: "inProgress",
            exitCode: null,
            durationMs: null,
          },
        ],
      })),
    };
  }

  describe("codex conversation replay", () => {
    test("replays complete protocol envelopes in their original interleaved order", () => {
      const fixtureBeforeReplay = JSON.stringify(sanitizedCommandLifecycleFixture);
      const firstReplay = replayCodexConversationFixture(
        sanitizedCommandLifecycleFixture,
        [] as readonly string[],
        recordEvent,
      );
      const secondReplay = replayCodexConversationFixture(
        sanitizedCommandLifecycleFixture,
        [] as readonly string[],
        recordEvent,
      );
      const replayedEvents = replayCodexConversationFixture(
        sanitizedCommandLifecycleFixture,
        [] as readonly CodexConversationReplayEvent[],
        (state, event) => [...state, event],
      );

      expect(JSON.stringify(firstReplay)).toBe(
        JSON.stringify([
          "0:notification:item/started",
          "1:notification:item/commandExecution/outputDelta",
          "2:request:item/commandExecution/requestApproval:number:73",
          "3:notification:serverRequest/resolved:number:73",
          "4:notification:item/completed",
        ]),
      );
      expect(JSON.stringify(secondReplay)).toBe(JSON.stringify(firstReplay));
      expect(JSON.stringify(replayedEvents)).toBe(
        JSON.stringify(sanitizedCommandLifecycleFixture.events),
      );
      expect(JSON.stringify(sanitizedCommandLifecycleFixture)).toBe(fixtureBeforeReplay);
    });

    test("consumes a hydrated command-output suffix across multiple buffered deltas", () => {
      const outputEvent: CodexConversationReplayEvent | undefined =
        sanitizedCommandLifecycleFixture.events[1];
      if (
        outputEvent?.type !== "notification" ||
        outputEvent.notification.method !== "item/commandExecution/outputDelta"
      ) {
        throw new Error("Invalid sanitized command replay fixture");
      }

      const events: readonly CodexConversationReplayEvent[] = [
        sanitizedCommandLifecycleFixture.events[0],
        {
          type: "notification",
          notification: {
            ...outputEvent.notification,
            params: {
              ...outputEvent.notification.params,
              delta: "fixture ",
            },
          },
        },
        {
          type: "notification",
          notification: {
            ...outputEvent.notification,
            params: {
              ...outputEvent.notification.params,
              delta: "output\n",
            },
          },
        },
        ...sanitizedCommandLifecycleFixture.events.slice(2),
      ];

      const replayed = replayCodexConversationEvents({
        threadId: sanitizedCommandLifecycleFixture.threadId,
        initialState: [] as readonly string[],
        hydratedThread: buildHydratedCommandThread(),
        events,
        reduce: recordEvent,
      });

      expect(JSON.stringify(replayed)).toBe(
        JSON.stringify([
          "0:notification:item/started",
          "3:request:item/commandExecution/requestApproval:number:73",
          "4:notification:serverRequest/resolved:number:73",
          "5:notification:item/completed",
        ]),
      );
    });

    test("lets a final agent message replace its buffered text deltas", () => {
      const events = [
        {
          type: "notification",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread_fixture",
              turnId: "turn_fixture",
              itemId: "item_fixture_agent",
              delta: "buffered fixture text",
            },
          },
        },
        {
          type: "notification",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread_fixture",
              turnId: "turn_fixture",
              completedAtMs: 2_000,
              item: {
                questions: null,
                type: "agentMessage",
                moderation: null,
                id: "item_fixture_agent",
                text: "authoritative fixture text",
                phase: "final_answer",
                memoryCitation: null,
                delivery: null,
              },
            },
          },
        },
      ] satisfies readonly CodexConversationReplayEvent[];

      const replayed = replayCodexConversationEvents({
        threadId: "thread_fixture",
        initialState: [] as readonly string[],
        hydratedThread: null,
        events,
        reduce: recordEvent,
      });

      expect(JSON.stringify(replayed)).toBe(JSON.stringify(["1:notification:item/completed"]));
    });

    test("rejects a hydrated snapshot from a different per-thread buffer", () => {
      let errorMessage = "";
      try {
        replayCodexConversationEvents({
          threadId: "another_thread",
          initialState: [] as readonly string[],
          hydratedThread: buildHydratedCommandThread(),
          events: sanitizedCommandLifecycleFixture.events,
          reduce: recordEvent,
        });
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error);
      }

      expect(errorMessage).toBe("Hydrated thread does not match the replay buffer");
    });
  });
});

describe("codex conversation state", () => {
  type IsExact<TLeft, TRight> =
    (<T>() => T extends TLeft ? 1 : 2) extends <T>() => T extends TRight ? 1 : 2
      ? (<T>() => T extends TRight ? 1 : 2) extends <T>() => T extends TLeft ? 1 : 2
        ? true
        : false
      : false;

  const generatedItemTypeProof: IsExact<CodexCanonicalProtocolItem, ThreadItem> = true;
  const generatedRequestTypeProof: IsExact<CodexCanonicalProtocolRequest, ServerRequest> = true;

  function collectAllGeneratedCorpusRequests(): ServerRequest[] {
    const requests = agentActivityV2PendingResolvedRequestCases.map(
      (requestCase) => requestCase.request,
    );

    for (const requestCase of agentActivityV2OneShotRequestCases) {
      for (const event of requestCase.fixture.events) {
        if (event.type === "request") {
          switch (event.request.method) {
            case "item/tool/requestOptionPicker":
            case "item/plan/requestImplementation":
              break;
            default:
              requests.push(event.request);
          }
        }
      }
    }

    return requests;
  }

  function getCommandApprovalItemId(
    request: CodexProtocolServerRequestOf<"item/commandExecution/requestApproval">,
  ): string {
    return request.params.itemId;
  }

  const optionPickerRequest = {
    id: 301,
    method: "item/tool/requestOptionPicker",
    params: {
      threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
      turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      question: "Choose a fixture option.",
      options: [
        {
          label: "Continue",
          description: "Continue with the sanitized fixture.",
        },
      ],
      allowMultiple: false,
      submitLabel: "Continue",
      skipLabel: null,
    },
  } satisfies CodexCanonicalOptionPickerRequest;

  const planImplementationRequest = {
    id: "implement-plan:turn-activity-v2-corpus",
    method: "item/plan/requestImplementation",
    params: {
      threadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
      turnId: AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
      planContent: "Implement the sanitized fixture plan.",
    },
  } satisfies CodexCanonicalPlanImplementationRequest;

  function buildCompleteFixtureTurnParams(
    threadId: string,
    cwd: string | null,
  ): CodexCanonicalHydratedSandboxTurnParams {
    return {
      threadId,
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
      cwd,
      attachments: [],
      effort: "high",
      summary: "none",
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    };
  }

  function hydrateCanonicalFixtureTurns(
    turns: Turn[],
    turnItemsPaginationById?: Parameters<
      typeof createCodexCanonicalHydratedConversationState
    >[1]["turnItemsPaginationById"],
  ) {
    const fixtureThread = buildAgentActivityV2CorpusThread([]);
    return createCodexCanonicalHydratedConversationState(
      {
        ...fixtureThread,
        turns,
      },
      {
        hostId: "local",
        ...{
          model: "gpt-fixture",
          reasoningEffort: "high",
          cwd: "/workspace/project",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          environments: null,
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/workspace/project"],
          turnItemsPaginationById,
        },
      },
    );
  }

  describe("protocol-backed canonical conversation state", () => {
    test.each([null, 0, 1.25, 1730000000.125])(
      "preserves protocol timestamp %s across repeated hydration and projection",
      (startedAt) => {
        const completedAt = startedAt === null ? null : startedAt + 1.25;
        let state = hydrateCanonicalFixtureTurns([
          {
            rootTurnId: null,
            id: "timestamp-roundtrip",
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt,
            completedAt,
            durationMs: 1250,
          },
        ]);
        for (let cycle = 0; cycle < 3; cycle += 1) {
          expect(state.turns[0]?.turnStartedAtMs).toBe(
            startedAt === null ? null : startedAt * 1000,
          );
          expect(state.turns[0]?.finalAssistantStartedAtMs).toBeNull();
          expect(state.turns[0]?.assistantMessageStartedAtMsById).toBeUndefined();
          const projected = projectCodexCanonicalProtocolThread(
            state,
            buildAgentActivityV2CorpusThread([]),
          );
          expect(projected.turns[0]).toEqual({
            rootTurnId: null,
            id: "timestamp-roundtrip",
            items: [],
            itemsView: "full",
            status: "completed",
            error: null,
            startedAt,
            completedAt,
            durationMs: 1250,
          });
          state = hydrateCanonicalFixtureTurns(projected.turns);
        }
      },
    );

    test("uses generated item/request unions directly and retains exact references", () => {
      expect(generatedItemTypeProof).toBe(true);
      expect(generatedRequestTypeProof).toBe(true);

      for (const payloadCase of agentActivityV2ItemFamilyCorpus) {
        const canonical = createCodexCanonicalProtocolItem(payloadCase.item);
        expect(canonical === payloadCase.item).toBe(true);
      }

      for (const request of collectAllGeneratedCorpusRequests()) {
        const canonical = createCodexCanonicalProtocolRequest(request);
        expect(canonical === request).toBe(true);
      }

      expect(getCommandApprovalItemId(agentActivityV2CommandApprovalRequest)).toBe(
        "pending-command-approval",
      );
    });

    test("retains partial turns without requiring a separate item pagination cursor", () => {
      const turn: Turn = {
        rootTurnId: null,
        id: "turn-partial-history",
        items: [],
        itemsView: "summary",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };

      const state = hydrateCanonicalFixtureTurns([turn]);
      expect(state.turns[0]?.turnId).toBe(turn.id);
      expect(state.turns[0]?.itemsView).toBe("summary");
      expect(state.turns[0]?.items).toEqual([]);
      expect(state.turns[0]?.params.input).toEqual([]);
    });

    test("hydrates partial turns from their stable opening user input", () => {
      const turn: Turn = {
        rootTurnId: null,
        id: "turn-partial-history",
        items: [],
        itemsView: "summary",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      const openingInput: UserInput[] = [
        { type: "text", text: "oldest prompt", text_elements: [] },
      ];

      const state = hydrateCanonicalFixtureTurns([turn], {
        [turn.id]: {
          olderCursor: "items:older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          oldestUserInput: openingInput,
          openingUserMessageId: "opening-user",
          openingUserMessageClientId: "opening-client",
          itemsView: "summary",
        },
      });
      expect(state.turns[0]?.params.input).toEqual(openingInput);
      expect(state.turns[0]?.params.clientUserMessageId).toBe("opening-client");
      expect(state.turns[0]?.itemsView).toBe("summary");
    });

    test("finds the opening input past compaction but never treats a partial suffix as the opening", () => {
      const user: ThreadItem = {
        type: "userMessage",
        id: "user",
        clientId: "client",
        content: [{ type: "text", text: "prompt", text_elements: [] }],
      };
      const turn: Turn = {
        rootTurnId: null,
        id: "turn-opening",
        items: [{ type: "contextCompaction", id: "compaction" }, user],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      };
      const complete = hydrateCanonicalFixtureTurns([turn]).turns[0]!;
      expect(complete.params.input).toEqual(user.content);
      expect(complete.params.clientUserMessageId).toBe("client");
      const partial = hydrateCanonicalFixtureTurns([turn], {
        [turn.id]: {
          olderCursor: "older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          itemsView: "summary",
        },
      }).turns[0]!;
      expect(partial.params.input).toEqual([]);
      expect(partial.params.clientUserMessageId).toBeUndefined();
      const known = hydrateCanonicalFixtureTurns([turn], {
        [turn.id]: {
          olderCursor: "older",
          isLoadingOlder: false,
          hasLoadedOldest: false,
          itemsView: "summary",
          oldestUserInput: [],
          openingUserMessageId: null,
          openingUserMessageClientId: null,
        },
      }).turns[0]!;
      expect(known.params.input).toEqual([]);
      expect(known.params.clientUserMessageId).toBeNull();
    });

    test("hydrates only caller-supplied pending requests and preserves private exact extensions", () => {
      const items = agentActivityV2ItemFamilyCorpus.map((payloadCase) => payloadCase.item);
      const pendingRequests = [
        ...agentActivityV2PendingResolvedRequestCases.map((requestCase) => requestCase.request),
        agentActivityV2DynamicOptionPickerRequest,
        optionPickerRequest,
        planImplementationRequest,
      ];
      const thread = buildAgentActivityV2CorpusThread(items);
      const turnParams = buildCompleteFixtureTurnParams(thread.id, thread.cwd);
      const options = {
        pendingRequests,
        turnParamsById: {
          [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams,
        },
      };
      const serializedThreadBefore = JSON.stringify(thread);

      const first = createCodexCanonicalConversationState(thread, { hostId: "local", ...options });
      const second = createCodexCanonicalConversationState(thread, { hostId: "local", ...options });
      const turn = first.turns[0];
      if (!turn) {
        throw new Error("Canonical corpus turn is missing");
      }

      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(JSON.stringify(thread)).toBe(serializedThreadBefore);
      expect(Object.prototype.hasOwnProperty.call(first, "protocol")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(first, "sidecar")).toBe(false);
      expect(first.hasUnreadTurn).toBe(false);
      expect(first.hydrationContext).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(turn, "protocol")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(turn, "startedAt")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(turn, "completedAt")).toBe(false);
      expect(turn.items.length).toBe(items.length);
      expect(first.requests.length).toBe(pendingRequests.length);
      expect(Object.prototype.hasOwnProperty.call(turn, "sidecar")).toBe(false);
      expect(turn.params === turnParams).toBe(true);
      expect(turn.params.threadId).toBe(thread.id);
      expect(turn.params.cwd).toBe(thread.cwd);
      expect(turn.turnStartedAtMs).toBe(1000);
      expect(turn.finalAssistantStartedAtMs).toBe(null);
      expect(turn.diff).toBe(null);
      expect(Object.prototype.hasOwnProperty.call(turn, "commandExecutionStartedAtMsById")).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(turn, "interruptedCommandExecutionItemIds")).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(turn, "hookRuns")).toBe(false);
      expect(turn.items[0] === items[0]).toBe(true);
      expect(first.requests[0] === pendingRequests[0]).toBe(true);
      expect(first.requests.at(-1)?.method).toBe("item/plan/requestImplementation");
    });

    test("hydrates complete production context without flattening duplicate or hidden raw slots", () => {
      const duplicateId = "shared-slot";
      const userMessage = {
        type: "userMessage",
        id: "hydrated-user-message",
        clientId: null,
        content: [
          {
            type: "text",
            text: [
              "# Files mentioned by the user:",
              "",
              "## fixture: /workspace/project/file.ts (lines 2-7)",
              "",
              "## My request for Codex:",
              "Inspect the raw slots.",
            ].join("\n"),
            text_elements: [],
          },
        ],
      } satisfies ThreadItem;
      const hidden = {
        type: "enteredReviewMode",
        id: duplicateId,
        review: "hidden payload",
      } satisfies ThreadItem;
      const fileChange = {
        type: "fileChange",
        id: duplicateId,
        changes: [],
        status: "inProgress",
      } satisfies ThreadItem;
      const command = {
        type: "commandExecution",
        id: duplicateId,
        command: "pwd",
        cwd: "/workspace/project",
        processId: null,
        pluginId: null,
        scriptPath: null,
        source: "agent",
        status: "inProgress",
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null,
      } satisfies ThreadItem;
      const thread = buildAgentActivityV2CorpusThread([userMessage, hidden, fileChange, command]);
      const state = createCodexCanonicalHydratedConversationState(thread, {
        hostId: "local",
        ...{
          model: "gpt-fixture",
          reasoningEffort: "high",
          cwd: "/workspace/project",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          environments: null,
          sandboxPolicy: {
            type: "workspaceWrite",
            writableRoots: ["/workspace/project"],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          },
          activePermissionProfile: null,
          runtimeWorkspaceRoots: ["/workspace/project"],
        },
      });

      const turn = state.turns[0];
      if (!turn) throw new Error("Hydrated production turn is missing");
      expect(turn.items.length).toBe(4);
      expect(turn.items[0] === userMessage).toBe(true);
      expect(turn.items[1] === hidden).toBe(true);
      expect(turn.items[2] === fileChange).toBe(true);
      expect(turn.items[3] === command).toBe(true);
      expect(turn.params.input === userMessage.content).toBe(true);
      expect(turn.params.approvalPolicy).toBe("on-request");
      expect(turn.params.approvalsReviewer).toBe("user");
      expect(turn.params.model).toBe("gpt-fixture");
      expect(turn.params.cwd).toBe("/workspace/project");
      expect(turn.params.effort).toBe("high");
      expect(JSON.stringify(turn.params.attachments)).toBe(
        JSON.stringify([
          {
            label: "fixture",
            path: "/workspace/project/file.ts",
            fsPath: "/workspace/project/file.ts",
          },
        ]),
      );
      expect(turn.params.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(Object.prototype.hasOwnProperty.call(turn.params, "permissions")).toBe(false);
      expect(state.hydrationContext?.model ?? null).toBe("gpt-fixture");
      expect(state.hydrationContext?.cwd ?? null).toBe("/workspace/project");
      expect(state.currentPermissions?.sandboxPolicy.type ?? null).toBe("workspaceWrite");
    });

    test("hydrates duplicate turn ids per occurrence before the exact DB fold", () => {
      const baseTurn = buildAgentActivityV2CorpusThread([]).turns[0];
      if (!baseTurn) throw new Error("Canonical corpus turn is missing");
      const heartbeatInput = [
        {
          type: "text",
          text: [
            "<heartbeat>",
            "<current_time_iso>2026-07-10T00:00:00Z</current_time_iso>",
            "<instructions>Check status</instructions>",
            "</heartbeat>",
          ].join("\n"),
          text_elements: [],
        },
      ] satisfies Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"];
      const ordinaryInput = [
        {
          type: "text",
          text: "Continue normally",
          text_elements: [],
        },
      ] satisfies Extract<
        ThreadItem,
        {
          type: "userMessage";
        }
      >["content"];
      const duplicateTurns = [
        {
          ...baseTurn,
          id: "turn-duplicate-hydration",
          items: [
            {
              type: "userMessage",
              id: "heartbeat-input",
              clientId: null,
              content: heartbeatInput,
            },
          ],
        },
        {
          ...baseTurn,
          id: "turn-duplicate-hydration",
          items: [
            {
              type: "userMessage",
              id: "ordinary-input",
              clientId: null,
              content: ordinaryInput,
            },
          ],
        },
      ] satisfies Turn[];

      const hydrated = hydrateCanonicalFixtureTurns(duplicateTurns);
      expect(hydrated.turns.length).toBe(2);
      expect(hydrated.turns[0]?.params.input === heartbeatInput).toBe(true);
      expect(hydrated.turns[1]?.params.input === ordinaryInput).toBe(true);
      const canonical = canonicalizeCodexCanonicalTurnStates(hydrated.turns);
      expect(canonical.length).toBe(1);
      expect(canonical[0]?.params.input === heartbeatInput).toBe(true);
    });

    test("hydrates active permission profiles with required runtime roots", () => {
      const thread = buildAgentActivityV2CorpusThread([]);
      const state = createCodexCanonicalHydratedConversationState(thread, {
        hostId: "local",
        ...{
          model: "gpt-fixture",
          reasoningEffort: null,
          cwd: "/workspace/project",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          environments: null,
          sandboxPolicy: {
            type: "readOnly",
            networkAccess: false,
          },
          activePermissionProfile: { id: "profile-fixture", extends: null },
          runtimeWorkspaceRoots: ["/workspace/project", "/workspace/shared"],
        },
      });
      const params = state.turns[0]?.params;
      expect(params?.permissions).toBe("profile-fixture");
      expect(JSON.stringify(params?.runtimeWorkspaceRoots)).toBe(
        JSON.stringify(["/workspace/project", "/workspace/shared"]),
      );
      expect(Object.prototype.hasOwnProperty.call(params ?? {}, "sandboxPolicy")).toBe(false);
    });

    test("resolves paged-resume cwd with the exact requested-descendant rule", () => {
      expect(
        resolveCodexCanonicalHydratedCwd({
          requestedCwd: "/workspace/project/subdir/",
          responseCwd: "/workspace/project",
          threadCwd: "/stale/thread",
          fallbackCwd: "/fallback",
        }),
      ).toBe("/workspace/project/subdir/");
      expect(
        resolveCodexCanonicalHydratedCwd({
          requestedCwd: "/other/project",
          responseCwd: "/workspace/project",
          threadCwd: null,
          fallbackCwd: "/fallback",
        }),
      ).toBe("/workspace/project");
      expect(
        resolveCodexCanonicalHydratedCwd({
          requestedCwd: "C:\\Workspace\\Project\\Subdir",
          responseCwd: "c:/workspace/project",
          threadCwd: null,
          fallbackCwd: null,
        }),
      ).toBe("C:\\Workspace\\Project\\Subdir");
      expect(
        resolveCodexCanonicalHydratedCwd({
          requestedCwd: null,
          responseCwd: null,
          threadCwd: null,
          fallbackCwd: null,
        }),
      ).toBe(null);
    });

    test("clamps projectless cwd to the workspace-browser root across path styles", () => {
      expect(
        resolveCodexCanonicalProjectlessCwd({
          cwd: "/workspace/root/nested",
          fallbackCwd: null,
          workspaceBrowserRoot: "/workspace/root",
          projectless: true,
        }),
      ).toBe("/workspace/root/nested");
      expect(
        resolveCodexCanonicalProjectlessCwd({
          cwd: "/outside/root",
          fallbackCwd: null,
          workspaceBrowserRoot: "/workspace/root/",
          projectless: true,
        }),
      ).toBe("/workspace/root/");
      expect(
        resolveCodexCanonicalProjectlessCwd({
          cwd: "C:\\Workspace\\Root\\nested",
          fallbackCwd: null,
          workspaceBrowserRoot: "c:/workspace/root",
          projectless: true,
        }),
      ).toBe("C:\\Workspace\\Root\\nested");
      expect(
        resolveCodexCanonicalProjectlessCwd({
          cwd: "D:\\outside",
          fallbackCwd: null,
          workspaceBrowserRoot: "C:\\Workspace\\Root",
          projectless: true,
        }),
      ).toBe("C:\\Workspace\\Root");
      expect(
        resolveCodexCanonicalProjectlessCwd({
          cwd: "/outside",
          fallbackCwd: "/fallback",
          workspaceBrowserRoot: null,
          projectless: false,
        }),
      ).toBe("/outside");
    });

    test("appends exact fork provenance and synthesizes the S1 placeholder when empty", () => {
      const base = createCodexCanonicalHydratedConversationState(
        buildAgentActivityV2CorpusThread([]),
        {
          hostId: "local",
          ...{
            model: "gpt-fixture",
            reasoningEffort: null,
            cwd: "/workspace/project",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            environments: null,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["/workspace/project"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        },
      );
      const marker = {
        id: "fork-marker",
        type: "forkedFromConversation" as const,
        sourceConversationId: "source-thread",
        sourceConversationTitle: "Source task",
      };
      const appended = appendCodexCanonicalForkedFromConversationItem(base, marker);
      const latestTurn = appended.turns.at(-1);
      expect(latestTurn?.items.at(-1) === marker).toBe(true);
      expect(JSON.stringify(latestTurn?.hookRuns ?? null)).toBe("[]");
      expect(isCodexCanonicalProtocolItem(marker)).toBe(false);

      const synthesized = appendCodexCanonicalForkedFromConversationItem(
        { ...base, turns: [] },
        marker,
      ).turns[0];
      expect(synthesized?.turnId).toBe(null);
      expect(synthesized?.status).toBe("completed");
      expect(synthesized?.turnStartedAtMs).toBe(null);
      expect(synthesized?.firstTurnWorkItemStartedAtMs).toBe(null);
      expect(synthesized?.params.model).toBe(null);
      expect(synthesized?.params.effort).toBe("minimal");
      expect(Object.prototype.hasOwnProperty.call(synthesized?.params ?? {}, "attachments")).toBe(
        false,
      );
      expect(JSON.stringify(synthesized?.hookRuns ?? null)).toBe("[]");
    });

    test("places worktree init in the optimistic first turn and isolates fork initialization", () => {
      const base = createCodexCanonicalHydratedConversationState(
        buildAgentActivityV2CorpusThread([]),
        {
          hostId: "local",
          ...{
            model: "gpt-fixture",
            reasoningEffort: "high",
            cwd: "/workspace/project",
            approvalPolicy: "never",
            approvalsReviewer: "guardian_subagent",
            environments: null,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["/workspace/project"],
              networkAccess: true,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        },
      );
      const item = {
        type: "worktreeInit",
        id: "pending-worktree:2",
        worktreeOutputText: "[info] Worktree created\n",
        setup: {
          outcome: "skipped",
          outputText: "[info] Continuing without local environment setup\n",
        },
      } satisfies CodexCanonicalWorktreeInitItem;

      const appendedToLatest = appendCodexCanonicalWorktreeInitItem(base, item);
      expect(appendedToLatest.turns.length).toBe(base.turns.length);
      expect(appendedToLatest.turns.at(-1)?.items.at(-1) === item).toBe(true);
      expect(appendedToLatest.turns.at(-1)?.status).toBe(base.turns.at(-1)?.status);

      const forkInit = appendCodexCanonicalWorktreeInitItem(base, item, "new-turn");
      const forkInitTurn = forkInit.turns.at(-1);
      expect(forkInit.turns.length).toBe(base.turns.length + 1);
      expect(forkInitTurn?.turnId).toBe(null);
      expect(forkInitTurn?.status).toBe("completed");
      expect(forkInitTurn?.items[0] === item).toBe(true);
      expect(forkInitTurn?.params.approvalPolicy).toBe("never");
      expect(forkInitTurn?.params.approvalsReviewer).toBe("guardian_subagent");
      expect(forkInitTurn?.params.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(forkInitTurn?.params.model).toBe(null);
      expect(forkInitTurn?.params.effort).toBe("minimal");
      expect(forkInitTurn?.turnStartedAtMs).toBe(null);
      expect(isCodexCanonicalProtocolItem(item)).toBe(false);

      const rendererReloadTurns = mergeCodexCanonicalTurnStates(forkInit.turns, base.turns);
      expect(rendererReloadTurns.flatMap((turn) => turn.items)).toContain(item);
      expect(rendererReloadTurns.filter((turn) => turn.turnId === null)).toHaveLength(1);

      const noTurns = appendCodexCanonicalWorktreeInitItem({ ...base, turns: [] }, item);
      expect(noTurns.turns.length).toBe(1);
      expect(noTurns.turns[0]?.status).toBe("completed");
      expect(noTurns.turns[0]?.items[0] === item).toBe(true);
    });

    test("creates and cancels an in-progress local compaction occurrence", () => {
      const base = createCodexCanonicalHydratedConversationState(
        buildAgentActivityV2CorpusThread([]),
        {
          hostId: "local",
          ...{
            model: "gpt-fixture",
            reasoningEffort: null,
            cwd: "/workspace/project",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            environments: null,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["/workspace/project"],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/workspace/project"],
          },
        },
      );
      const empty = { ...base, turns: [] };
      const placeholder = {
        id: "pending-manual-context-compaction",
        type: "contextCompaction" as const,
        completed: false,
        source: "manual" as const,
      };

      const pending = appendCodexCanonicalInProgressSyntheticItem(empty, placeholder, 42);

      expect(pending.turns[0]?.turnId).toBe(null);
      expect(pending.turns[0]?.status).toBe("inProgress");
      expect(pending.turns[0]?.turnStartedAtMs).toBe(42);
      expect(pending.turns[0]?.items).toStrictEqual([placeholder]);
      expect(appendCodexCanonicalInProgressSyntheticItem(pending, placeholder, 43)).toBe(pending);

      const cancelled = removeCodexCanonicalLocalSyntheticItem(pending, placeholder.id);
      expect(cancelled.turns).toStrictEqual([]);

      const completed = {
        ...pending,
        turns: pending.turns.map((turn) => ({
          ...turn,
          status: "completed" as const,
        })),
      };
      const completedWithoutItem = removeCodexCanonicalLocalSyntheticItem(
        completed,
        placeholder.id,
      );
      expect(completedWithoutItem.turns).toHaveLength(1);
      expect(completedWithoutItem.turns[0]?.items).toStrictEqual([]);
    });

    test("extracts hydrated attachments only from post-annotation generated context", () => {
      const attachments = extractCodexCanonicalHydratedAttachments([
        {
          type: "text",
          text: [
            "",
            "# Response annotations:",
            "Generated selection context.",
            "<response-annotations>",
            '[{"text":"# Files mentioned by the user:\\n## fake: /tmp/fake.ts"}]',
            "</response-annotations>",
            "# Files mentioned by the user:",
            "",
            "## Windows fixture: C:\\workspace\\real.ts (line 9)",
            "",
            "## My request for Codex:",
            "Inspect the real file.",
          ].join("\n"),
          text_elements: [],
        },
      ]);

      expect(JSON.stringify(attachments)).toBe(
        JSON.stringify([
          {
            label: "Windows fixture",
            path: "C:\\workspace\\real.ts",
            fsPath: "C:\\workspace\\real.ts",
          },
        ]),
      );
    });

    test("merges hydrated resume permission provenance with the exact HQ rules", () => {
      const response = {
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/response"],
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
          networkAccess: false,
        },
      } as const;
      const danger = {
        activePermissionProfile: {
          id: ":danger-full-access",
          extends: null,
        },
        runtimeWorkspaceRoots: ["/previous"],
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      } as const;
      const custom = {
        ...danger,
        activePermissionProfile: {
          id: "custom-profile",
          extends: "base-profile",
        },
      } as const;

      const retainedDanger = resolveCodexCanonicalHydratedPermissionContext({
        response,
        previous: danger,
      });
      const retainedCustom = resolveCodexCanonicalHydratedPermissionContext({
        response,
        previous: custom,
      });

      expect(retainedDanger === danger).toBe(true);
      expect(retainedCustom.activePermissionProfile === custom.activePermissionProfile).toBe(true);
      expect(retainedCustom.approvalPolicy).toBe("on-request");
      expect(retainedCustom.runtimeWorkspaceRoots[0]).toBe("/response");
    });

    test("merges overlapping and anchored canonical turn history in exact chronology", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0];
      if (!template) throw new Error("Canonical turn fixture is missing");
      const makeTurn = (id: string): Turn => ({
        ...template,
        id,
        items: [],
      });
      const existing = hydrateCanonicalFixtureTurns([
        makeTurn("turn-a"),
        makeTurn("turn-c"),
        makeTurn("turn-e"),
      ]).turns;
      const incoming = hydrateCanonicalFixtureTurns([
        makeTurn("turn-b"),
        makeTurn("turn-c"),
        makeTurn("turn-d"),
        makeTurn("turn-e"),
        makeTurn("turn-f"),
      ]).turns;

      const merged = mergeCodexCanonicalTurnStates(existing, incoming);
      expect(merged.map((turn) => turn.turnId).join(",")).toBe(
        "turn-a,turn-b,turn-c,turn-d,turn-e,turn-f",
      );

      const older = hydrateCanonicalFixtureTurns([
        makeTurn("turn-b"),
        makeTurn("turn-c"),
        makeTurn("turn-d"),
      ]).turns;
      const anchored = mergeCodexCanonicalOlderTurnStates({
        olderTurns: older,
        currentTurns: existing,
        oldestLoadedTurnId: "turn-c",
      });
      expect(anchored.map((turn) => turn.turnId).join(",")).toBe(
        "turn-a,turn-b,turn-c,turn-d,turn-e",
      );
    });

    test("hydrates terminal failures once and merges them into the live retry occurrence", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
      const failed = hydrateCanonicalFixtureTurns([
        {
          ...template,
          status: "failed",
          completedAt: 10,
          error: {
            message: "Request failed",
            codexErrorInfo: "other",
            additionalDetails: null,
            misalignment: null,
          },
        },
      ]).turns[0]!;
      const errors = failed.items.filter((item) => item.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]?.recovery).toMatchObject({
        state: "failed",
        attempt: null,
        updatedAt: 10_000,
      });
      expect(
        mergeCodexCanonicalTurnState(failed, failed).items.filter((item) => item.type === "error"),
      ).toHaveLength(1);

      const retry = {
        ...failed,
        status: "inProgress" as const,
        error: null,
        items: [
          {
            ...errors[0]!,
            id: "live-retry",
            recovery: {
              ...errors[0]!.recovery,
              state: "retrying" as const,
              attempt: 2,
              maxAttempts: 5,
            },
          },
        ],
      };
      const merged = mergeCodexCanonicalTurnState(retry, failed);
      const mergedErrors = merged.items.filter((item) => item.type === "error");
      expect(mergedErrors).toHaveLength(1);
      expect(mergedErrors[0]).toMatchObject({
        id: "live-retry",
        recovery: { state: "failed", attempt: 2, maxAttempts: 5 },
      });
    });

    test("failed-turn continuation refuses an unconfirmed server queue delivery", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
      const state = hydrateCanonicalFixtureTurns([{ ...template, status: "failed", error: null }]);
      expect(() =>
        assertCodexFailedTurnContinuation(
          {
            ...state,
            threadRuntimeStatus: { type: "idle" },
            unconfirmedServerQueueMessages: [
              {
                id: "pending-queue",
                clientUserMessageId: "pending-client",
                responsesapiClientMetadata: null,
                input: [],
              },
            ],
          },
          template.id,
        ),
      ).toThrow("pending thread action");
    });

    test("merges lifecycle metadata monotonically without reopening terminal items", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0];
      if (!template) throw new Error("Canonical turn fixture is missing");
      const existing = hydrateCanonicalFixtureTurns([template]).turns[0];
      if (!existing) throw new Error("Canonical turn fixture is missing");
      const incoming = {
        ...existing,
        lifecycleStatusByItemId: {
          "reasoning-live": "completed" as const,
          "reasoning-terminal": "completed" as const,
        },
      };
      const current = {
        ...existing,
        lifecycleStatusByItemId: {
          "reasoning-live": "inProgress" as const,
          "reasoning-terminal": "completed" as const,
        },
      };

      const merged = mergeCodexCanonicalTurnState(current, incoming);
      expect(merged.lifecycleStatusByItemId).toEqual({
        "reasoning-live": "completed",
        "reasoning-terminal": "completed",
      });
    });

    test("preserves async questions and delivery while reconciling a shorter hydrated turn", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0];
      if (!template) throw new Error("Canonical turn fixture is missing");
      const base = hydrateCanonicalFixtureTurns([template]).turns[0];
      if (!base) throw new Error("Canonical turn fixture is missing");
      const existingMessage = {
        questions: [{ title: "Which scope?", options: ["Project", "Library"] }],
        type: "agentMessage",
        moderation: null,
        id: "live-final",
        text: "Which scope?\n- Project\n- Library",
        phase: "final_answer",
        memoryCitation: null,
        delivery: "async",
      } satisfies ThreadItem;
      const hydratedMessage = {
        ...existingMessage,
        id: "hydrated-final",
        delivery: null,
        questions: null,
      } satisfies ThreadItem;

      const merged = mergeCodexCanonicalTurnState(
        {
          ...base,
          items: [existingMessage, { type: "plan", id: "live-plan", text: "Done" }],
        },
        { ...base, items: [hydratedMessage] },
      );

      expect(merged.items[0]).toMatchObject({
        id: "live-final",
        type: "agentMessage",
        moderation: null,
        delivery: "async",
        questions: existingMessage.questions,
      });
    });

    test("keeps distinct asynchronous calls with identical question text when hydrating a shorter tail", () => {
      const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
      const base = hydrateCanonicalFixtureTurns([template]).turns[0]!;
      const first: ThreadItem = {
        type: "agentMessage",
        moderation: null,
        id: "ask-first",
        text: "Which scope?",
        phase: "final_answer",
        delivery: "async",
        memoryCitation: null,
        questions: [{ title: "Which scope?", options: null }],
      };
      const second = { ...first, id: "ask-second" };
      const merged = mergeCodexCanonicalTurnState(
        { ...base, items: [first, { type: "plan", id: "plan", text: "Working" }] },
        { ...base, items: [second] },
      );
      expect(
        merged.items.filter((item) => item.type === "agentMessage").map((item) => item.id),
      ).toEqual(["ask-first", "ask-second"]);
    });

    test("rejects hydration when exact app-side turn context is unavailable", () => {
      const thread = buildAgentActivityV2CorpusThread([]);
      let error: unknown = null;

      try {
        createCodexCanonicalConversationState(thread, {
          hostId: "local",
          ...{ turnParamsById: {} },
        });
      } catch (caught) {
        error = caught;
      }

      expect(error instanceof Error).toBe(true);
      expect(error instanceof Error ? error.message : null).toBe(
        `Missing complete canonical params for turn ${AGENT_ACTIVITY_V2_CORPUS_TURN_ID}`,
      );
    });

    test("retains complete generated and app-side turn context without copying it into items", () => {
      const thread = buildAgentActivityV2CorpusThread([agentActivityV2MultiActionCommandItem]);
      const attachments = [{ type: "image", source: "fixture-image" }];
      const commentAttachments = [{ type: "comment", body: "fixture comment" }];
      const turnParams = {
        ...buildCompleteFixtureTurnParams(thread.id, thread.cwd),
        model: "fixture-model",
        effort: "high",
        collaborationMode: {
          mode: "default",
          settings: {
            model: "fixture-model",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
        attachments,
        commentAttachments,
      } satisfies CodexCanonicalTurnParams;
      const state = createCodexCanonicalConversationState(thread, {
        hostId: "local",
        ...{
          turnParamsById: {
            [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: turnParams,
          },
        },
      });
      expect(state.turns[0]?.params === turnParams).toBe(true);
      expect(state.turns[0]?.params.model).toBe("fixture-model");
      expect(state.turns[0]?.params.attachments === attachments).toBe(true);
      expect(state.turns[0]?.params.commentAttachments === commentAttachments).toBe(true);
      expect(state.turns[0]?.items[0] === agentActivityV2MultiActionCommandItem).toBe(true);
    });

    test.each([
      { source: { fileId: "file_123" }, expected: "file-service://file_123" },
      {
        source: { fileId: "file_123", savedPath: "/images/generated.png" },
        expected: "/images/generated.png",
      },
    ])("materializes a generated image reference $source", ({ source, expected }) => {
      const item = {
        type: "imageGeneration",
        id: "generated-1",
        status: "completed",
        revisedPrompt: null,
        failure: null,
        generationId: null,
        ...source,
      } satisfies ThreadItem;
      expect(materializeCodexCanonicalProtocolItem(item)).toEqual({ ...item, src: expected });
    });

    test("materializes hydrated image and collaboration items with exact app-side fields", () => {
      const image = {
        generationId: null,
        type: "imageGeneration",
        id: "hydrated-image",
        status: "completed",
        revisedPrompt: null,
        result: "aHlkcmF0ZWQ=",
        failure: null,
      } satisfies ThreadItem;
      const collab = {
        type: "collabAgentToolCall",
        id: "hydrated-collab",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: AGENT_ACTIVITY_V2_CORPUS_THREAD_ID,
        receiverThreadIds: ["receiver-a", "receiver-b"],
        prompt: "Inspect the hydrated fixture",
        model: null,
        reasoningEffort: null,
        agentsStates: {},
      } satisfies ThreadItem;
      const thread = buildAgentActivityV2CorpusThread([image, collab]);
      const state = createCodexCanonicalConversationState(thread, {
        hostId: "local",
        ...{
          turnParamsById: {
            [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: buildCompleteFixtureTurnParams(
              thread.id,
              thread.cwd,
            ),
          },
        },
      });
      const hydratedImage = state.turns[0]?.items[0];
      const hydratedCollab = state.turns[0]?.items[1];

      expect(
        hydratedImage?.type === "imageGeneration" && "src" in hydratedImage
          ? hydratedImage.src
          : null,
      ).toBe("data:image/png;base64,aHlkcmF0ZWQ=");
      expect(
        hydratedCollab?.type === "collabAgentToolCall" && "receiverThreads" in hydratedCollab
          ? hydratedCollab.receiverThreads
              .map((receiver) => `${receiver.threadId}:${String(receiver.thread)}`)
              .join(",")
          : "",
      ).toBe("receiver-a:null,receiver-b:null");
    });

    test("retains both exact hydrated-profile and live permission contexts", () => {
      const thread = buildAgentActivityV2CorpusThread([agentActivityV2MultiActionCommandItem]);
      const sandboxParams = buildCompleteFixtureTurnParams(thread.id, thread.cwd);
      const { sandboxPolicy: _sandboxPolicy, ...sharedParams } = sandboxParams;
      expect(_sandboxPolicy.type).toBe("workspaceWrite");
      const profileParams = {
        ...sharedParams,
        permissions: "fixture-profile",
        runtimeWorkspaceRoots: ["/workspace/project"],
      } satisfies CodexCanonicalTurnParams;
      const liveParams = {
        ...sandboxParams,
        permissions: "fixture-profile",
        runtimeWorkspaceRoots: ["/workspace/project"],
      } satisfies CodexCanonicalTurnParams;

      const profileState = createCodexCanonicalConversationState(thread, {
        hostId: "local",
        ...{
          turnParamsById: {
            [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: profileParams,
          },
        },
      });
      const liveState = createCodexCanonicalConversationState(thread, {
        hostId: "local",
        ...{
          turnParamsById: {
            [AGENT_ACTIVITY_V2_CORPUS_TURN_ID]: liveParams,
          },
        },
      });
      expect(profileState.turns[0]?.params === profileParams).toBe(true);
      expect(profileState.turns[0]?.params.runtimeWorkspaceRoots?.[0]).toBe("/workspace/project");
      expect(liveState.turns[0]?.params === liveParams).toBe(true);
      expect(liveState.turns[0]?.params.sandboxPolicy?.type).toBe("workspaceWrite");
      expect(liveState.turns[0]?.params.permissions).toBe("fixture-profile");
    });

    test("wraps hook runs with the exact stable local identity shape", () => {
      const run: HookRunSummary = {
        id: "fixture-hook",
        eventName: "sessionStart",
        handlerType: "command",
        executionMode: "sync",
        scope: "turn",
        sourcePath: "/fixture/hook.json",
        source: "user",
        displayOrder: 1n,
        status: "running",
        statusMessage: null,
        startedAt: 1n,
        completedAt: null,
        durationMs: null,
        entries: [],
      };

      const first = createCodexCanonicalHookRun(run);
      const repeated = createCodexCanonicalHookRun(run, "fixture-hook:1");

      expect(first.id).toBe(run.id);
      expect(first.run === run).toBe(true);
      expect(repeated.id).toBe("fixture-hook:1");
      expect(repeated.run === run).toBe(true);
    });

    test("models all request-caused synthetic families outside ThreadItem", () => {
      const userInputQuestions = agentActivityV2UserInputRequest.params.questions.map(
        (question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options ?? [],
        }),
      );
      const firstUserInputQuestion = userInputQuestions[0];
      if (!firstUserInputQuestion) {
        throw new Error("Canonical fixture user-input request must have a question");
      }
      const mcpParams = agentActivityV2McpElicitationRequest.params;
      if (mcpParams.mode !== "openai/form") {
        throw new Error("Canonical fixture MCP request must use openai/form mode");
      }
      const elicitation = {
        kind: "openaiForm",
        message: mcpParams.message,
        serverName: mcpParams.serverName,
        schema: mcpParams.requestedSchema,
      } satisfies CodexCanonicalMcpElicitation;
      const syntheticItems = [
        {
          type: "userInputResponse",
          id: `user-input-response-${agentActivityV2UserInputRequest.id}`,
          requestId: agentActivityV2UserInputRequest.id,
          turnId: agentActivityV2UserInputRequest.params.turnId,
          questions: userInputQuestions,
          answers: {},
          completed: false,
        },
        {
          type: "permissionRequest",
          id: `permission-request-${agentActivityV2PermissionRequest.id}`,
          requestId: agentActivityV2PermissionRequest.id,
          turnId: agentActivityV2PermissionRequest.params.turnId,
          reason: agentActivityV2PermissionRequest.params.reason,
          permissions: agentActivityV2PermissionRequest.params.permissions,
          completed: false,
          response: null,
        },
        {
          type: "mcpServerElicitation",
          id: `mcp-server-elicitation-${agentActivityV2McpElicitationRequest.id}`,
          requestId: agentActivityV2McpElicitationRequest.id,
          turnId: mcpParams.turnId ?? AGENT_ACTIVITY_V2_CORPUS_TURN_ID,
          elicitation,
          completed: false,
          action: null,
        },
      ] satisfies readonly CodexCanonicalRequestSyntheticItem[];
      expect(syntheticItems.length).toBe(3);
      expect(syntheticItems[0]?.requestId).toBe(agentActivityV2UserInputRequest.id);
      expect(Object.prototype.hasOwnProperty.call(syntheticItems[0], "request")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(firstUserInputQuestion, "isOther")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(firstUserInputQuestion, "isSecret")).toBe(false);
      expect(syntheticItems[1]?.type).toBe("permissionRequest");
      expect(syntheticItems[2]?.type).toBe("mcpServerElicitation");
      expect(Object.prototype.hasOwnProperty.call(elicitation, "mode")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(elicitation, "requestedSchema")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(elicitation, "threadId")).toBe(false);
    });

    test("preserves scalar request identity while making internal lookup collision-safe", () => {
      const numeric = createCodexCanonicalProtocolRequest({
        ...agentActivityV2CommandApprovalRequest,
        id: 73,
      });
      const textual = createCodexCanonicalProtocolRequest({
        ...agentActivityV2CommandApprovalRequest,
        id: "73",
      });

      expect(typeof numeric.id).toBe("number");
      expect(typeof textual.id).toBe("string");
      expect(buildCodexCanonicalRequestIdentityKey(numeric.id)).toBe("number:73");
      expect(buildCodexCanonicalRequestIdentityKey(textual.id)).toBe("string:73");
      expect(
        buildCodexCanonicalRequestIdentityKey(numeric.id) ===
          buildCodexCanonicalRequestIdentityKey(textual.id),
      ).toBe(false);
    });

    test("strict protocol normalization accepts the full corpus and valid hidden markers", () => {
      for (const payloadCase of agentActivityV2ItemFamilyCorpus) {
        expect(
          isCodexCanonicalProtocolItem(payloadCase.item),
          `expected protocol corpus case ${payloadCase.id} to pass ingress validation`,
        ).toBe(true);
        const views = projectCodexCanonicalTurnItemViews({
          threadId: "thread-canonical",
          turnId: "turn-canonical",
          items: [materializeCodexCanonicalProtocolItem(payloadCase.item)],
          observedAtMs: 7300,
          turnStatus: "inProgress",
        });
        for (const view of views) {
          expect(view.rawItemId).toBe(payloadCase.item.id);
          expect(view.createdAt).toBe(7300);
          expect(view.updatedAt).toBe(7300);
        }
      }

      const hiddenMarkers = [
        {
          type: "enteredReviewMode",
          id: "review-entered",
          review: "sanitized review",
        },
        {
          type: "exitedReviewMode",
          id: "review-exited",
          review: "sanitized review",
        },
      ] satisfies readonly ThreadItem[];

      for (const marker of hiddenMarkers) {
        expect(isCodexCanonicalProtocolItem(marker)).toBe(true);
        expect(
          projectCodexCanonicalTurnItemViews({
            threadId: "thread-canonical",
            turnId: "turn-canonical",
            items: [materializeCodexCanonicalProtocolItem(marker)],
            observedAtMs: 7300,
            turnStatus: "inProgress",
          }),
        ).toEqual([]);
      }
    });

    test("retains complete MCP protocol context for the C-02 projection boundary", () => {
      const canonical = createCodexCanonicalProtocolItem(
        agentActivityV2McpAppContextPrecedenceItem,
      );

      expect(canonical.appContext === agentActivityV2McpAppContextPrecedenceItem.appContext).toBe(
        true,
      );
      expect(Object.keys(canonical.appContext).length).toBe(5);
      expect(canonical.appContext.actionName).toBe("Lookup fixture");
    });
  });

  test("resume overlap closes reconnect using the resident Turn pagination anchor", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
    const base = hydrateCanonicalFixtureTurns([template]).turns[0]!;
    const stop = { type: "plan" as const, id: "snapshot-stop", text: "saved" };
    const existing = {
      ...base,
      items: [stop],
      itemsPagination: {
        olderCursor: "resume-current",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary" as const,
        reconnect: { beforeItemId: "before", stopItemId: stop.id, olderCursorAfterReconnect: null },
      },
    };
    const incoming = {
      ...base,
      items: [stop, { type: "plan" as const, id: "latest", text: "new" }],
      itemsPagination: {
        olderCursor: "server-cursor",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary" as const,
      },
    };
    const merged = mergeCodexCanonicalTurnState(existing, incoming, { isResumeSnapshot: true });
    expect(merged.itemsPagination?.olderCursor).toBeNull();
    expect(merged.itemsPagination?.hasLoadedOldest).toBe(true);
    expect(merged.itemsPagination?.reconnect).toBeUndefined();
    expect(merged.items.map((item) => item.id)).toEqual(["snapshot-stop", "latest"]);
  });

  describe.each(["ordinary", "timeline"] as const)(
    "incoming timeline pagination after %s history",
    (source) => {
      test.each([
        { existingComplete: false, resume: false, complete: false },
        { existingComplete: true, resume: false, complete: true },
        { existingComplete: false, resume: true, complete: false },
        { existingComplete: true, resume: true, complete: false },
      ])(
        "keeps completeness=$complete for existing=$existingComplete and resume=$resume",
        ({ existingComplete, resume, complete }) => {
          const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
          const base = hydrateCanonicalFixtureTurns([template]).turns[0]!;
          const existing = {
            ...base,
            itemsPagination: {
              source,
              olderCursor: "ordinary-item-cursor",
              isLoadingOlder: false,
              hasLoadedOldest: existingComplete,
              itemsView: "summary" as const,
              newestSnapshotItemId: "resident",
              reconnect: {
                beforeItemId: "resident",
                stopItemId: "stop",
                olderCursorAfterReconnect: "old-item-cursor",
              },
            },
          };
          const incoming = {
            ...base,
            itemsPagination: {
              source: "timeline" as const,
              olderCursor: null,
              isLoadingOlder: false,
              hasLoadedOldest: false,
              itemsView: "summary" as const,
              newestSnapshotItemId: "timeline-item",
            },
          };
          const result = mergeCodexCanonicalTurnState(existing, incoming, {
            isResumeSnapshot: resume,
          });
          expect(result.itemsPagination).toEqual({
            ...incoming.itemsPagination,
            hasLoadedOldest: complete,
            reconnect: undefined,
          });
        },
      );
    },
  );

  test("merges per-assistant starts without substituting a turn completion time", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
    const existing = hydrateCanonicalFixtureTurns([{ ...template, startedAt: 1, completedAt: 9 }])
      .turns[0]!;
    expect(existing.finalAssistantStartedAtMs).toBeNull();
    expect(existing.completedAtMs).toBe(9000);
    const merged = mergeCodexCanonicalTurnState(
      { ...existing, assistantMessageStartedAtMsById: { commentary: 2000, final: 5000 } },
      { ...existing, assistantMessageStartedAtMsById: { earlier: 1500, final: 6000 } },
    );
    expect(merged.assistantMessageStartedAtMsById).toEqual({
      earlier: 1500,
      commentary: 2000,
      final: 5000,
    });
    const hydratedAgain = mergeCodexCanonicalTurnState(merged, existing, {
      isResumeSnapshot: true,
    });
    expect(hydratedAgain.assistantMessageStartedAtMsById).toEqual(
      merged.assistantMessageStartedAtMsById,
    );
    expect(hydratedAgain.finalAssistantStartedAtMs).toBeNull();
  });

  test("hydrates the selected response start and keeps it across resume and older commentary", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
    const response = (id: string, startedAtMs: number | null): ThreadItem => ({
      type: "agentMessage",
      moderation: null,
      id,
      text: id,
      phase: "final_answer",
      delivery: null,
      memoryCitation: null,
      questions: null,
      startedAtMs,
      completedAtMs: 90_000,
    });
    const hydrate = (items: ThreadItem[]) =>
      hydrateCanonicalFixtureTurns([{ ...template, items, completedAt: 100 }]).turns[0]!;
    const final = response("final", 5000);
    const existing = hydrate([response("earlier", 3000), final]);
    expect(existing.finalAssistantStartedAtMs).toBe(5000);
    const older = { ...response("commentary", 70_000), phase: "commentary" as const };
    const merged = mergeCodexCanonicalTurnState(existing, hydrate([older]), {
      itemMergeMode: "prepend",
    });
    expect(merged.finalAssistantStartedAtMs).toBe(5000);
    const resumed = mergeCodexCanonicalTurnState(merged, hydrate([final]), {
      isResumeSnapshot: true,
    });
    expect(resumed.finalAssistantStartedAtMs).toBe(5000);
    const async = { ...response("question", 80_000), delivery: "async" as const };
    expect(hydrate([final, async]).finalAssistantStartedAtMs).toBe(5000);
    expect(hydrate([response("untimed", null)]).finalAssistantStartedAtMs).toBeNull();
    expect(
      mergeCodexCanonicalTurnState(existing, hydrate([response("new", null)]))
        .finalAssistantStartedAtMs,
    ).toBeNull();
  });

  test("joining native history prefers the selected response's recorded start over an observed anchor", () => {
    const template = buildAgentActivityV2CorpusThread([]).turns[0]!;
    const response: ThreadItem = {
      type: "agentMessage",
      moderation: null,
      id: "response",
      text: "Done",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const base = hydrateCanonicalFixtureTurns([{ ...template, items: [response] }]).turns[0]!;
    const live = {
      ...base,
      finalAssistantStartedAtMs: 70_001,
      assistantMessageStartedAtMsById: { response: 7000 },
    };
    const history = hydrateCanonicalFixtureTurns([
      { ...template, items: [{ ...response, startedAtMs: 7000 }] },
    ]).turns[0]!;
    expect(history.finalAssistantStartedAtMs).toBe(7000);
    expect(
      mergeCodexCanonicalTurnState(live, history, { isResumeSnapshot: true })
        .finalAssistantStartedAtMs,
    ).toBe(7000);
  });

  test("observed approval reviews cannot anchor execution-host worked duration", () => {
    expect(
      resolveAssistantResponseWorkDurationMs([
        { id: "review", type: "automaticApprovalReview", startedAtMs: 200_000 },
        { id: "thought", type: "reasoning", startedAtMs: 1000 },
        { id: "answer", type: "agentMessage", startedAtMs: 8000 },
      ]),
    ).toBe(7000);
  });
});

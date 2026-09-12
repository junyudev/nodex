import { describe, expect, test } from "vite-plus/test";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { Thread, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalSteeringUserMessageItem,
  type CodexCanonicalTurnParams,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import {
  reduceCodexConversationEvent,
  reduceCodexConversationEventWithEffects,
  type CodexConversationReducerContext,
} from "./codex-conversation-reducer";

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
    extra: null,
    sessionId: "session_c03",
    forkedFromId: null,
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
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "C-03 lifecycle fixture",
    turns: [
      {
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
  test("async question delivery never starts final-answer timing while the Agent continues", () => {
    const item = {
      type: "agentMessage",
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
    expect(completed.turns[0]?.items).toContainEqual(item);
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

    expect(turn.items[0] === completedA).toBe(true);
    expect(turn.items[1] === startedB).toBe(true);
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
    expect(afterSecond.turns[0]?.items[0] === second).toBe(true);
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
    expect(afterDelayedStart.turns[0]?.items[0]).toEqual(completed);
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
    expect(hidden.turns[0]?.items[0] === enteredReview).toBe(true);
    expect(mismatchedCompletion.turns[0]?.items[0] === enteredReview).toBe(true);
    expect(visibleAgain.turns[0]?.items.length).toBe(1);
    expect(visibleAgain.turns[0]?.items[0] === command).toBe(true);
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

  test("agent start uses independent wall-clock sites and completion does not refresh them", () => {
    const started = {
      questions: null,
      type: "agentMessage",
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
    expect(afterComplete.turns[0]?.finalAssistantStartedAtMs).toBe(70001);
    expect(afterComplete.turns[0]?.firstTurnWorkItemStartedAtMs).toBe(70002);
    expect(afterStart.turns[0]?.lifecycleStatusByItemId?.["agent-message"]).toBe("inProgress");
    expect(afterComplete.turns[0]?.lifecycleStatusByItemId?.["agent-message"]).toBe("completed");
    expect(afterComplete.turns[0]?.items[0] === completed).toBe(true);
    expect(clock.calls()).toBe(2);
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
    expect(synthesized.items[0] === command).toBe(true);
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
    expect(next.turns[0]?.items).toEqual([assistant]);
  });

  test("context compaction rebinds the in-progress placeholder and keeps manual source", () => {
    const initial = buildState();
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
    expect(consumedSourceCount).toBe(1);
  });

  test("completed compaction reads only the first same-ID row before source fallback", () => {
    const initial = buildState();
    const rawCompaction = {
      type: "contextCompaction",
      id: "duplicate-context-compaction",
    } satisfies ThreadItem;
    const state: CodexCanonicalConversationState = {
      ...initial,
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
  });

  test("materializes only the bundle-defined image and collaboration extensions", () => {
    const image = {
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
    expect(afterHeartbeat.turns[0]?.items[0] === heartbeat).toBe(true);
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
    expect(next.turns[0]?.items[1]?.type).toBe("steered");
    expect(next.turns[0]?.items[1]?.id).toBe("accepted-user-id");
  });

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
      params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "resident-command", delta: "output" },
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
      notification: { ...event.notification, params: { ...event.notification.params, delta: "" } },
    },
    { now: () => 600 },
  );
  expect(unchanged.state).toBe(changed.state);
  expect(unchanged.patches).toEqual([]);
});

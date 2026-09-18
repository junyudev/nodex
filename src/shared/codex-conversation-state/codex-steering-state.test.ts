import { mergeCodexResumedHistory } from "./codex-history-resume";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { describe, expect, test } from "vite-plus/test";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalSteeringUserMessageItem,
} from "./codex-conversation-state";
import {
  mergeCodexCanonicalTurnState,
  mergeCodexCanonicalTurnStates,
  createCodexCanonicalHydratedConversationState,
} from "./codex-conversation-state";

function buildState(): CodexCanonicalConversationState {
  return createCodexCanonicalHydratedConversationState(
    {
      model: null,
      reasoningEffort: null,
      id: "thread-a",
      environments: null,
      extra: null,
      sessionId: "session-a",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "active", activeFlags: [] },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      originator: null,
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: "appServer",
      name: null,
      daybreakEnabled: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [
        {
          id: "turn-a",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    },
    {
      hostId: "local",
      ...{
        model: "gpt-test",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: [],
      },
    },
  );
}

function buildSteer(id = "steer-a"): CodexCanonicalSteeringUserMessageItem {
  return {
    type: "steeringUserMessage",
    id,
    targetTurnId: "turn-a",
    targetTurnStartedAtMs: 10,
    status: "pending",
    clientUserMessageId: id,
    input: [{ type: "text", text: "continue", text_elements: [] }],
    attachments: [{ path: "/workspace/file.ts" }],
    restoreMessage: {
      queueRow: createCodexQueuedFollowUp({
        followUpId: `follow-up-${id}`,
        clientUserMessageId: `client-${id}`,
        threadId: "thread-a",
        prompt: "continue",
        createdAtMs: 10,
      }),
      context: { commentAttachments: [] },
    },
    compareKey: { rawText: "continue", imageCount: 0 },
  };
}

describe("hydrated steering reconciliation", () => {
  test("retains pending steering beside a longer history snapshot and refreshes existing assistant text", () => {
    const base = buildState().turns[0]!;
    const answer = {
      type: "agentMessage",
      id: "answer",
      text: "old",
      phase: "final_answer",
      memoryCitation: null,
      questions: null,
      delivery: null,
    } as const;
    const result = mergeCodexCanonicalTurnState(
      { ...base, items: [answer, buildSteer()] },
      {
        ...base,
        items: [
          { ...answer, text: "complete" },
          { type: "plan", id: "plan-a", text: "a" },
          { type: "plan", id: "plan-b", text: "b" },
        ],
      },
    );
    expect(result.items.map((item) => item.id)).toEqual(["answer", "steer-a", "plan-a", "plan-b"]);
    expect(result.items[0]).toMatchObject({ text: "complete" });
  });

  test("accepts a persisted correlated echo and places its local row before the echo marker", () => {
    const base = buildState().turns[0]!;
    const steer = buildSteer();
    const echo = {
      type: "userMessage",
      id: "echo",
      clientId: steer.clientUserMessageId,
      content: [...steer.input],
    } satisfies ThreadItem;
    const result = mergeCodexCanonicalTurnState(
      { ...base, items: [echo, steer] },
      { ...base, items: [echo] },
    );
    expect(result.items).toEqual([
      { ...steer, status: "accepted", serverUserMessageId: "echo" },
      { type: "steered", id: "echo" },
    ]);
  });

  test("keeps the opening message distinct from a pending steer with the same correlation", () => {
    const base = buildState().turns[0]!;
    const steer = buildSteer();
    const echo = {
      type: "userMessage",
      id: "opening",
      clientId: steer.clientUserMessageId,
      content: [...steer.input],
    } satisfies ThreadItem;
    const turn = {
      ...base,
      params: {
        ...base.params,
        clientUserMessageId: steer.clientUserMessageId,
        input: [...steer.input],
      },
    };
    const result = mergeCodexCanonicalTurnState(
      { ...turn, items: [steer] },
      { ...turn, items: [echo] },
    );
    expect(result.items).toEqual([steer, echo]);
  });

  test("moves steering to a newly loaded target and reconciles its server echo", () => {
    const base = buildState().turns[0]!;
    const steer = { ...buildSteer(), targetTurnId: "turn-b" };
    const target = {
      ...base,
      turnId: "turn-b",
      items: [
        {
          type: "userMessage",
          id: "echo",
          clientId: steer.clientUserMessageId,
          content: [...steer.input],
        } satisfies ThreadItem,
      ],
    };
    const result = mergeCodexCanonicalTurnStates([{ ...base, items: [steer] }], [target]);
    expect(result[0]!.items).toEqual([]);
    expect(result[1]!.items).toEqual([
      { ...steer, status: "accepted", serverUserMessageId: "echo" },
      { type: "steered", id: "echo" },
    ]);
  });

  test("preserves correlated nonempty input when hydration has no input", () => {
    const base = buildState().turns[0]!;
    const params = {
      ...base.params,
      clientUserMessageId: "opening",
      input: [...buildSteer().input],
    };
    const result = mergeCodexCanonicalTurnState({ ...base, params }, base);
    expect(result.params).toBe(params);
  });

  test("retains a completed heartbeat Turn until its pending steer has a server echo", () => {
    const base = buildState().turns[0]!;
    const turn = {
      ...base,
      status: "completed" as const,
      items: [
        {
          type: "agentMessage",
          id: "decision",
          text: "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>",
          phase: "final_answer",
          memoryCitation: null,
          questions: null,
          delivery: null,
        } as const,
        buildSteer(),
      ],
    };
    expect(mergeCodexCanonicalTurnStates([turn], [])).toEqual([turn]);
    expect(
      mergeCodexCanonicalTurnStates(
        [{ ...turn, items: [turn.items[0]!, { ...buildSteer(), serverUserMessageId: "echo" }] }],
        [],
      ),
    ).toEqual([]);
  });
});

describe("paginated steering opening authority", () => {
  test.each(["echo", "different-opening", null, undefined])(
    "uses opening identity %s when reconciling a resumed echo",
    (openingUserMessageId) => {
      const state = buildState();
      const base = state.turns[0]!;
      const steer = buildSteer();
      const turn = {
        ...base,
        params: {
          ...base.params,
          clientUserMessageId: steer.clientUserMessageId,
          input: [...steer.input],
        },
      };
      const echo = {
        type: "userMessage",
        id: "echo",
        clientId: steer.clientUserMessageId,
        content: [...steer.input],
      } satisfies ThreadItem;
      const pagination = {
        olderCursor: "older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary" as const,
        openingUserMessageId,
      };
      const result = mergeCodexResumedHistory({
        existing: { ...state, turns: [{ ...turn, items: [steer] }] },
        incoming: { ...state, turns: [{ ...turn, items: [echo] }] },
        existingPagination: { "turn-a": pagination },
        incomingPagination: { "turn-a": pagination },
      });
      const accepted =
        openingUserMessageId === null || openingUserMessageId === "different-opening";
      expect(result.canonical.turns[0]!.items).toEqual(
        accepted
          ? [
              { ...steer, status: "accepted", serverUserMessageId: "echo" },
              { type: "steered", id: "echo" },
            ]
          : [steer, echo],
      );
    },
  );
});

test("relocates steering without consuming the target Turn's known opening message", () => {
  const state = buildState();
  const base = state.turns[0]!;
  const steer = { ...buildSteer(), targetTurnId: "turn-b" };
  const echo = {
    type: "userMessage",
    id: "opening-b",
    clientId: steer.clientUserMessageId,
    content: [...steer.input],
  } satisfies ThreadItem;
  const target = { ...base, turnId: "turn-b", items: [echo] };
  const result = mergeCodexResumedHistory({
    existing: { ...state, turns: [{ ...base, items: [steer] }] },
    incoming: { ...state, turns: [target] },
    existingPagination: {},
    incomingPagination: {
      "turn-b": {
        olderCursor: "older",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        itemsView: "summary",
        openingUserMessageId: "opening-b",
      },
    },
  });
  expect(result.canonical.turns[0]!.items).toEqual([]);
  expect(result.canonical.turns[1]!.items).toEqual([echo, steer]);
});

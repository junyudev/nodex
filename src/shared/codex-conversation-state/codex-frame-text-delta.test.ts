import { describe, expect, test } from "vite-plus/test";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { Thread, ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalTurnParams,
} from "./codex-conversation-state";
import { reduceCodexConversationEvent } from "./codex-conversation-reducer";
import {
  reduceCodexConversationFrameTextDeltas,
  reduceCodexFrameTextDeltaItems,
  resolveCodexFrameTextDeltaTurn,
  toCodexFrameTextDelta,
} from "./codex-frame-text-delta";
import type { CodexFrameTextDeltaUpdate } from "./codex-frame-text-delta-queue";
import {
  CODEX_REASONING_MAX_PARTS,
  CODEX_REASONING_PARTS_TRUNCATION_MARKER,
} from "./codex-reasoning-parts";
import { replayCodexConversationEvents } from "./codex-conversation-replay";

const THREAD_ID = "thread_c04";
const TURN_ID = "turn_c04";

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

function buildState(
  items: ThreadItem[] = [],
  status: "inProgress" | "completed" = "inProgress",
): CodexCanonicalConversationState {
  const thread: Thread = {
    id: THREAD_ID,
    extra: null,
    sessionId: "session_c04",
    forkedFromId: null,
    parentThreadId: null,
    preview: "C-04 delta fixture",
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
    cwd: "/workspace/project",
    cliVersion: "fixture",
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: "C-04 delta fixture",
    turns: [
      {
        id: TURN_ID,
        items,
        itemsView: "full",
        status,
        error: null,
        startedAt: 1,
        completedAt: status === "completed" ? 2 : null,
        durationMs: status === "completed" ? 1_000 : null,
      },
    ],
  };
  return createCodexCanonicalConversationState(thread, {
    turnParamsById: { [TURN_ID]: buildTurnParams() },
  });
}

function update(
  target: CodexFrameTextDeltaUpdate["target"],
  delta: string,
  overrides: Partial<CodexFrameTextDeltaUpdate> = {},
): CodexFrameTextDeltaUpdate {
  return {
    conversationId: THREAD_ID,
    turnId: TURN_ID,
    itemId: "shared-item",
    target,
    delta,
    ...overrides,
  };
}

function notificationEvent(notification: ServerNotification) {
  return { type: "notification" as const, notification };
}

describe("canonical frame-text delta reduction", () => {
  test("maps all four generated notifications without resolving nullable turns early", () => {
    const notifications = [
      {
        method: "item/agentMessage/delta",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "a", delta: "A" },
      },
      {
        method: "item/plan/delta",
        params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: "p", delta: "P" },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "r",
          delta: "S",
          summaryIndex: 2,
        },
      },
      {
        method: "item/reasoning/textDelta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "r",
          delta: "C",
          contentIndex: 3,
        },
      },
    ] satisfies ServerNotification[];

    const mapped = notifications.map((notification) => toCodexFrameTextDelta(notification, null));
    expect(mapped.map((entry) => entry.target.type).join(",")).toBe(
      "agentMessage,plan,reasoningSummary,reasoningContent",
    );
    expect(mapped.map((entry) => String(entry.turnId)).join(",")).toBe("null,null,null,null");
  });

  test("updates the reverse-last same-ID exact raw protocol type", () => {
    const items: ThreadItem[] = [
      {
        type: "agentMessage",
        id: "shared-item",
        text: "first",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
      { type: "plan", id: "shared-item", text: "plan" },
      {
        type: "agentMessage",
        id: "shared-item",
        text: "last",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    ];
    const result = reduceCodexFrameTextDeltaItems(
      items,
      update({ type: "agentMessage" }, "+delta"),
    );
    const nextItems = result.items as ThreadItem[];

    expect(result.disposition).toBe("applied");
    expect(result.itemIndex).toBe(2);
    expect((nextItems[0] as { text?: string }).text).toBe("first");
    expect((nextItems[1] as { text?: string }).text).toBe("plan");
    expect((nextItems[2] as { text?: string }).text).toBe("last+delta");
    expect((items[2] as { text?: string }).text).toBe("last");
  });

  test("accepts only dense reasoning indexes and rejects gaps before allocating", () => {
    const reasoning: ThreadItem = {
      type: "reasoning",
      id: "shared-item",
      summary: ["zero"],
      content: [],
    };
    const appended = reduceCodexFrameTextDeltaItems(
      [reasoning],
      update({ type: "reasoningSummary", summaryIndex: 1 }, "one"),
    );
    const appendedItem = appended.items[0] as Extract<ThreadItem, { type: "reasoning" }>;
    const invalidIndexes = [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER + 1,
    ];

    expect(appendedItem.summary.join("|")).toBe("zero|one");
    const gapInput = [reasoning];
    const gap = reduceCodexFrameTextDeltaItems(
      gapInput,
      update({ type: "reasoningSummary", summaryIndex: 3 }, "three"),
    );
    expect(gap.disposition).toBe("invalidReasoningIndex");
    expect(gap.items === gapInput).toBe(true);
    for (const index of invalidIndexes) {
      const invalidInput = [reasoning];
      const invalid = reduceCodexFrameTextDeltaItems(
        invalidInput,
        update({ type: "reasoningContent", contentIndex: index }, "bad"),
      );
      expect(invalid.disposition).toBe("invalidReasoningIndex");
      expect(invalid.items === invalidInput).toBe(true);
      expect(invalid.items[0] === reasoning).toBe(true);
    }

    const negativeZero = reduceCodexFrameTextDeltaItems(
      [reasoning],
      update({ type: "reasoningContent", contentIndex: -0 }, "valid"),
    );
    const negativeZeroItem = negativeZero.items[0] as Extract<ThreadItem, { type: "reasoning" }>;
    expect(negativeZero.disposition).toBe("applied");
    expect(negativeZeroItem.content[0]).toBe("valid");
  });

  test("preserves raw and canonical identity for empty deltas in existing reasoning slots", () => {
    const reasoning: Extract<ThreadItem, { type: "reasoning" }> = {
      type: "reasoning",
      id: "shared-item",
      summary: ["existing summary"],
      content: ["existing content"],
    };
    const rawItems = [reasoning];
    const summaryResult = reduceCodexFrameTextDeltaItems(
      rawItems,
      update({ type: "reasoningSummary", summaryIndex: 0 }, ""),
    );
    const contentResult = reduceCodexFrameTextDeltaItems(
      rawItems,
      update({ type: "reasoningContent", contentIndex: 0 }, ""),
    );
    const initial = buildState([reasoning]);
    const canonicalResult = reduceCodexConversationFrameTextDeltas(
      initial,
      [
        update({ type: "reasoningSummary", summaryIndex: 0 }, ""),
        update({ type: "reasoningContent", contentIndex: 0 }, ""),
      ],
      {
        now: () => {
          throw new Error("an existing empty-delta slot must not read the clock");
        },
      },
    );

    expect(summaryResult.items === rawItems).toBe(true);
    expect(summaryResult.items[0] === reasoning).toBe(true);
    expect(contentResult.items === rawItems).toBe(true);
    expect(contentResult.items[0] === reasoning).toBe(true);
    expect(canonicalResult.state === initial).toBe(true);
    expect(canonicalResult.outcomes[0]?.stateChanged).toBe(false);
    expect(canonicalResult.outcomes[1]?.stateChanged).toBe(false);
  });

  test("uses latest for nullable turn IDs and never rebinds an in-progress null placeholder", () => {
    const latest = resolveCodexFrameTextDeltaTurn(
      [
        { turnId: "older", status: "completed", hasError: false, itemCount: 1 },
        { turnId: "latest", status: "inProgress", hasError: false, itemCount: 1 },
      ],
      null,
    );
    const inProgressPlaceholder = resolveCodexFrameTextDeltaTurn(
      [{ turnId: null, status: "inProgress", hasError: false, itemCount: 0 }],
      "incoming",
    );

    expect(latest.kind).toBe("latest");
    expect("turnIndex" in latest ? latest.turnIndex : -1).toBe(1);
    expect(inProgressPlaceholder.kind).toBe("none");
  });

  test("persists the sole completed-empty placeholder rebind when the item is missing", () => {
    const initial = buildState([], "completed");
    const placeholder = {
      ...initial,
      turns: [
        {
          ...initial.turns[0]!,
          protocol: {
            ...initial.turns[0]!.protocol,
            id: null,
            status: "completed" as const,
          },
          sidecar: {
            ...initial.turns[0]!.sidecar,
            turnStartedAtMs: null,
          },
        },
      ],
    };
    let clockCalls = 0;
    const result = reduceCodexConversationFrameTextDeltas(
      placeholder,
      [
        update({ type: "plan" }, "missing", {
          turnId: "rebound-turn",
          itemId: "missing-plan",
        }),
      ],
      {
        now: () => {
          clockCalls += 1;
          return 44_000;
        },
      },
    );

    expect(result.state.turns[0]?.protocol.id).toBe("rebound-turn");
    expect(result.state.turns[0]?.protocol.status).toBe("inProgress");
    expect(result.state.turns[0]?.sidecar.turnStartedAtMs).toBe(44_000);
    expect(result.outcomes[0]?.disposition).toBe("missingItem");
    expect(result.outcomes[0]?.stateChanged).toBe(true);
    expect(clockCalls).toBe(1);
  });

  test("applies all four targets in batch without changing lifecycle timing or status", () => {
    const items: ThreadItem[] = [
      {
        type: "agentMessage",
        id: "agent",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
      { type: "plan", id: "plan", text: "" },
      { type: "reasoning", id: "reasoning", summary: [], content: [] },
    ];
    const initialBase = buildState(items, "completed");
    const initial = {
      ...initialBase,
      turns: [
        {
          ...initialBase.turns[0]!,
          sidecar: {
            ...initialBase.turns[0]!.sidecar,
            turnStartedAtMs: 10,
            firstTurnWorkItemStartedAtMs: 20,
            finalAssistantStartedAtMs: 30,
          },
        },
      ],
    };
    const result = reduceCodexConversationFrameTextDeltas(
      initial,
      [
        update({ type: "agentMessage" }, "agent", { itemId: "agent" }),
        update({ type: "plan" }, "plan", { itemId: "plan" }),
        update({ type: "reasoningSummary", summaryIndex: 0 }, "summary", { itemId: "reasoning" }),
        update({ type: "reasoningContent", contentIndex: 0 }, "content", { itemId: "reasoning" }),
      ],
      {
        now: () => {
          throw new Error("ordinary deltas must not read the clock");
        },
      },
    );
    const turn = result.state.turns[0]!;
    const agent = turn.items[0] as Extract<ThreadItem, { type: "agentMessage" }>;
    const plan = turn.items[1] as Extract<ThreadItem, { type: "plan" }>;
    const reasoning = turn.items[2] as Extract<ThreadItem, { type: "reasoning" }>;

    expect(agent.text).toBe("agent");
    expect(plan.text).toBe("plan");
    expect(reasoning.summary.join("|")).toBe("summary");
    expect(reasoning.content.join("|")).toBe("content");
    expect(turn.protocol.status).toBe("completed");
    expect(turn.sidecar.turnStartedAtMs).toBe(10);
    expect(turn.sidecar.firstTurnWorkItemStartedAtMs).toBe(20);
    expect(turn.sidecar.finalAssistantStartedAtMs).toBe(30);
  });

  test("uses summaryPartAdded for one bounded dense summary append", () => {
    const initial = buildState([
      {
        type: "reasoning",
        id: "reasoning",
        summary: [],
        content: [],
      },
    ]);
    const next = reduceCodexConversationEvent(
      initial,
      notificationEvent({
        method: "item/reasoning/summaryPartAdded",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "reasoning",
          summaryIndex: 0,
        },
      }),
      { now: () => 1 },
    );

    const reasoning = next.turns[0]?.items[0] as Extract<ThreadItem, { type: "reasoning" }>;
    expect(reasoning.summary).toEqual([""]);

    const gap = reduceCodexConversationEvent(
      next,
      notificationEvent({
        method: "item/reasoning/summaryPartAdded",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "reasoning",
          summaryIndex: 2,
        },
      }),
      { now: () => 1 },
    );
    expect(gap === next).toBe(true);
  });

  test("bounds terminal reasoning arrays and replay rejects a giant sparse index", () => {
    const oversizedParts = Array.from(
      { length: CODEX_REASONING_MAX_PARTS + 1 },
      (_, index) => `part-${index}`,
    );
    const started = buildState([
      { type: "reasoning", id: "reasoning-terminal", summary: [], content: [] },
    ]);
    const completed = reduceCodexConversationEvent(
      started,
      notificationEvent({
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          completedAtMs: 2_000,
          item: {
            type: "reasoning",
            id: "reasoning-terminal",
            summary: oversizedParts,
            content: oversizedParts,
          },
        },
      }),
      { now: () => 3_000 },
    );
    const terminal = completed.turns[0]?.items[0] as Extract<ThreadItem, { type: "reasoning" }>;
    expect(terminal.summary.length).toBe(CODEX_REASONING_MAX_PARTS);
    expect(terminal.content.length).toBe(CODEX_REASONING_MAX_PARTS);
    expect(terminal.summary.at(-1)).toBe(CODEX_REASONING_PARTS_TRUNCATION_MARKER);

    const initial = buildState([{ type: "reasoning", id: "reasoning", summary: [], content: [] }]);
    const replayed = replayCodexConversationEvents({
      threadId: THREAD_ID,
      initialState: initial,
      hydratedThread: null,
      events: [
        notificationEvent({
          method: "item/reasoning/textDelta",
          params: {
            threadId: THREAD_ID,
            turnId: TURN_ID,
            itemId: "reasoning",
            contentIndex: Number.MAX_SAFE_INTEGER,
            delta: "must not allocate",
          },
        }),
      ],
      reduce: (state, event) => reduceCodexConversationEvent(state, event, { now: () => 4_000 }),
    });
    expect(replayed).toBe(initial);
  });

  test("lets authoritative completion replace provisional delta text", () => {
    const started: Extract<ThreadItem, { type: "plan" }> = {
      type: "plan",
      id: "shared-item",
      text: "draft",
    };
    const completed: Extract<ThreadItem, { type: "plan" }> = {
      type: "plan",
      id: "shared-item",
      text: "authoritative final",
    };
    const afterDelta = reduceCodexConversationEvent(
      buildState([started]),
      notificationEvent({
        method: "item/plan/delta",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: "shared-item",
          delta: " provisional",
        },
      }),
      { now: () => 1 },
    );
    const afterCompletion = reduceCodexConversationEvent(
      afterDelta,
      notificationEvent({
        method: "item/completed",
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          item: completed,
          completedAtMs: 2_000,
        },
      }),
      { now: () => 3_000 },
    );

    expect((afterDelta.turns[0]?.items[0] as { text?: string }).text).toBe("draft provisional");
    expect(afterCompletion.turns[0]?.items[0] === completed).toBe(true);
    expect((afterCompletion.turns[0]?.items[0] as { text?: string }).text).toBe(
      "authoritative final",
    );
  });
});

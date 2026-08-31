import { describe, expect, test } from "vite-plus/test";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import {
  approximateCodexLiveTurnBytes,
  boundChangedCodexLiveTurns,
  CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
  CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
  sanitizeCodexLiveLifecycleNotification,
} from "./codex-live-turn-residency";

const turn = (text: string): Turn => ({
  id: "turn-live",
  status: "inProgress",
  error: null,
  itemsView: "full",
  startedAt: 1,
  completedAt: null,
  durationMs: null,
  items: [
    {
      type: "agentMessage",
      id: "agent-live",
      text,
      phase: null,
      memoryCitation: null,
    },
  ],
});

const state = (liveTurn: Turn) => {
  const thread: Thread = {
    id: "thread-live",
    extra: null,
    sessionId: "session-live",
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    historyMode: "paginated",
    modelProvider: "openai",
    createdAt: 1,
    updatedAt: 1,
    recencyAt: 1,
    status: { type: "active", activeFlags: [] },
    path: null,
    cwd: "/repo",
    cliVersion: "test",
    source: "unknown",
    canAcceptDirectInput: true,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: [liveTurn],
  };
  return createCodexCanonicalHydratedConversationState(thread, {
    model: "gpt-test",
    reasoningEffort: "high",
    cwd: "/repo",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/repo"],
  });
};

describe("live Turn residency admission", () => {
  test("short-circuits a giant sparse container before walking its declared length", () => {
    const giant = new Array<unknown>(100_000_000);
    const candidate = turn("");
    candidate.items = giant as Turn["items"];

    expect(
      approximateCodexLiveTurnBytes(candidate, CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES),
    ).toBeGreaterThan(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES);
  });

  test("leaves unchanged history identity untouched and bounds only changed live Turns", () => {
    const before = state(turn("small"));
    const unchanged = boundChangedCodexLiveTurns(before, before);
    expect(unchanged).toBe(before);

    const after = state(turn("x".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES)));
    const bounded = boundChangedCodexLiveTurns(before, after);
    expect(bounded.turns[0]?.items[0]?.id).toBe(CODEX_LIVE_TURN_OVERFLOW_ITEM_ID);
    expect(
      approximateCodexLiveTurnBytes(bounded.turns[0]!, CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES),
    ).toBeLessThanOrEqual(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES);
  });

  test("sanitizes giant lifecycle turn and item payloads before canonical materialization", () => {
    const giantText = "x".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1);
    const giantTurnNotification = {
      method: "turn/completed",
      params: {
        threadId: "thread-live",
        turn: { ...turn(giantText), status: "failed" },
      },
    } as const;
    const sanitizedTurn = sanitizeCodexLiveLifecycleNotification(giantTurnNotification as never);
    expect(sanitizedTurn).not.toBe(giantTurnNotification);
    if (sanitizedTurn.method !== "turn/completed") throw new Error("expected turn completion");
    expect(sanitizedTurn.params.threadId).toBe("thread-live");
    expect(sanitizedTurn.params.turn.id).toBe("turn-live");
    expect(sanitizedTurn.params.turn.status).toBe("failed");
    expect(sanitizedTurn.params.turn.items).toHaveLength(1);
    expect(sanitizedTurn.params.turn.items[0]?.id).toBe(CODEX_LIVE_TURN_OVERFLOW_ITEM_ID);

    const giantItemNotification = {
      method: "item/completed",
      params: {
        threadId: "thread-live",
        turnId: "turn-live",
        completedAtMs: 42,
        item: {
          type: "commandExecution",
          id: "command-live",
          command: "echo overflow",
          cwd: "/repo",
          processId: null,
          pluginId: null,
          scriptPath: null,
          source: "agent",
          status: "failed",
          commandActions: [],
          aggregatedOutput: giantText,
          exitCode: null,
          durationMs: null,
        },
      },
    } as const;
    const sanitizedItem = sanitizeCodexLiveLifecycleNotification(giantItemNotification as never);
    expect(sanitizedItem).not.toBe(giantItemNotification);
    if (sanitizedItem.method !== "item/completed") throw new Error("expected item completion");
    expect(sanitizedItem.params.threadId).toBe("thread-live");
    expect(sanitizedItem.params.turnId).toBe("turn-live");
    expect(sanitizedItem.params.completedAtMs).toBe(42);
    expect(sanitizedItem.params.item).toMatchObject({
      type: "agentMessage",
      id: "command-live",
      status: "failed",
    });
  });
});

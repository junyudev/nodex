import { describe, expect, test } from "vite-plus/test";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import type { ThreadRealtimeItem } from "@nodex/codex-app-server-protocol/v2";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import { reduceCodexConversationEvent } from "./codex-conversation-reducer";

function fixture() {
  return createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: "thread",
      cliVersion: "0.162.0-alpha.17.2",
      turns: [],
    },
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
  );
}
const transcript = (text = "hello"): ThreadRealtimeItem => ({
  type: "transcriptSegment",
  id: "segment",
  realtimeSessionId: "session",
  role: "assistant",
  text,
});
function apply(
  state: CodexCanonicalConversationState,
  notification: ServerNotification,
  supportsThreadTimeline = true,
) {
  return reduceCodexConversationEvent(
    state,
    { type: "notification", notification },
    { now: () => 1, supportsThreadTimeline },
  );
}

describe("live canonical timeline", () => {
  test("streams only an unfinished transcript, completes it in place, and never revives it on duplicate start", () => {
    const initial = fixture();
    let state = apply(initial, {
      method: "thread/realtime/item/started",
      params: { threadId: "thread", item: transcript() },
    });
    expect(state.itemTimeline?.entries[0]).toMatchObject({ position: 1, item: { id: "segment" } });
    state = apply(state, {
      method: "thread/realtime/item/transcript/delta",
      params: { threadId: "thread", itemId: "segment", delta: " world" },
    });
    expect(state.realtimeItems?.segment?.item).toMatchObject({ text: "hello world" });
    state = apply(state, {
      method: "thread/realtime/item/completed",
      params: { threadId: "thread", item: transcript("final") },
    });
    expect(state.itemTimeline?.entries).toHaveLength(1);
    expect(state.itemTimeline?.entries[0]).toMatchObject({ position: 1, item: { text: "final" } });
    expect(state.realtimeItems?.segment).toMatchObject({
      completed: true,
      item: { text: "final" },
    });
    expect(
      apply(state, {
        method: "thread/realtime/item/transcript/delta",
        params: { threadId: "thread", itemId: "segment", delta: "late" },
      }),
    ).toBe(state);
    expect(
      apply(state, {
        method: "thread/realtime/item/started",
        params: { threadId: "thread", item: transcript("duplicate") },
      }),
    ).toBe(state);
    expect(initial.itemTimeline).toBeUndefined();
  });

  test("admits session and promotion records only on completion, appending after the resident timeline", () => {
    let state = {
      ...fixture(),
      itemTimeline: {
        activeRealtimeSessionAtPageStart: "older-session",
        entries: [{ type: "realtime" as const, position: 41, item: transcript() }],
      },
    };
    const item: ThreadRealtimeItem = {
      type: "bemItemPromoted",
      id: "receipt",
      realtimeSessionId: "session",
      turnId: "missing-turn",
      itemId: "missing-item",
      presentation: { type: "wholeItem" },
    };
    expect(
      apply(state, {
        method: "thread/realtime/item/started",
        params: { threadId: "thread", item },
      }),
    ).toBe(state);
    const completed = apply(state, {
      method: "thread/realtime/item/completed",
      params: { threadId: "thread", item },
    });
    expect(completed.itemTimeline?.entries.at(-1)).toEqual({
      type: "realtime",
      position: 42,
      item,
    });
    expect(completed.turns).toEqual([]);
    expect(completed.itemTimeline?.activeRealtimeSessionAtPageStart).toBe("older-session");
    expect(completed.realtimeItems?.receipt).toEqual({ item, completed: true });
  });

  test("preserves ordinary item identity across completion and distinguishes the same item id in another Turn", () => {
    const turn = buildAgentActivityV2CorpusThread().turns[0]!;
    let state = apply(fixture(), { method: "turn/started", params: { threadId: "thread", turn } });
    const item = { type: "plan" as const, id: "shared-id", text: "plan" };
    state = apply(state, {
      method: "item/started",
      params: { threadId: "thread", turnId: turn.id, item, startedAtMs: 1 },
    });
    state = apply(state, {
      method: "item/completed",
      params: { threadId: "thread", turnId: turn.id, item, completedAtMs: 2 },
    });
    state = apply(state, {
      method: "item/completed",
      params: { threadId: "thread", turnId: "other", item, completedAtMs: 3 },
    });
    expect(state.itemTimeline?.entries.map((entry) => entry.position)).toEqual([1, 2, 3]);
    expect(state.itemTimeline?.entries[1]).toMatchObject({
      type: "item",
      turnId: turn.id,
      item: { completed: true },
    });
    expect(state.itemTimeline?.entries[2]).toMatchObject({ type: "item", turnId: "other" });
  });

  test.each(["capability", "voice-history", "legacy-history", "wrong-thread"])(
    "does not mutate outside the %s boundary",
    (boundary) => {
      const initial = {
        ...fixture(),
        ...(boundary === "voice-history" ? { canonicalVoiceHistory: false } : {}),
        ...(boundary === "legacy-history" ? { historyMode: "legacy" as const } : {}),
      };
      const after = apply(
        initial,
        {
          method: "thread/realtime/item/completed",
          params: {
            threadId: boundary === "wrong-thread" ? "foreign" : "thread",
            item: transcript(),
          },
        },
        boundary !== "capability",
      );
      expect(after).toBe(initial);
    },
  );

  test("retains the raw itemAdded contract without interpreting it as a canonical receipt", () => {
    const initial = fixture();
    expect(
      apply(initial, {
        method: "thread/realtime/itemAdded",
        params: { threadId: "thread", item: { type: "bemItemPromoted", id: "raw" } },
      }),
    ).toBe(initial);
  });
});

import { mutateCodexConversationFrameTextDeltas } from "./codex-conversation-state/codex-frame-text-delta";
import type { CodexFrameTextDeltaUpdate } from "./codex-conversation-state/codex-frame-text-delta-queue";
import { describe, expect, test } from "vite-plus/test";
import type { Draft } from "immer";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { CodexConversationEntityDocument } from "./codex-conversation-entity-document";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalItem,
} from "./codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  applyCodexTranscriptTextChange,
  applyCodexTranscriptTextEdits,
  buildCodexTranscriptAcceptedMutation,
  type CodexTranscriptTextChange,
  codexTranscriptItemAddress,
  codexTranscriptItemSlots,
  projectCodexTranscript,
  projectCodexTranscriptUpdate,
  type CodexTranscriptConversationState,
} from "./codex-transcript-projection";

const key = { hostId: "local", threadId: "thread" };
function fixture(
  items: readonly ThreadItem[] = [{ type: "plan", id: "first", text: "hello" }],
): CodexCanonicalConversationState {
  const thread = buildAgentActivityV2CorpusThread([]);
  return createCodexCanonicalHydratedConversationState(
    {
      ...thread,
      id: "thread",
      turns: [
        {
          id: "one",
          rootTurnId: null,
          items: [...items],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
        {
          id: "two",
          rootTurnId: null,
          items: [{ type: "plan", id: "first", text: "second" }],
          itemsView: "full",
          status: "completed",
          error: null,
          startedAt: 3,
          completedAt: 4,
          durationMs: 1000,
        },
      ],
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
function mutate(
  before: CodexCanonicalConversationState,
  recipe: (draft: Draft<CodexCanonicalConversationState>) => void,
) {
  return new CodexConversationEntityDocument().withCanonicalState(before).mutate(recipe)!;
}

function mutateText(
  before: CodexCanonicalConversationState,
  updates: readonly CodexFrameTextDeltaUpdate[],
) {
  const changes: CodexTranscriptTextChange[] = [];
  const mutation = mutate(before, (draft) =>
    mutateCodexConversationFrameTextDeltas(draft, updates, {
      now: () => 1,
      onAcceptedText: (change) => changes.push(change),
    }),
  );
  return {
    ...mutation,
    accepted: buildCodexTranscriptAcceptedMutation(
      before,
      mutation.after,
      mutation.patches,
      changes,
    ),
  };
}

describe("normalized transcript mutation projection", () => {
  test("separates sparse slots, item scope and presentation details", () => {
    const state = fixture();
    const projected = projectCodexTranscript(state);
    expect(projected.turnEntityKeys).toEqual(["turn:one", "turn:two"]);
    expect(projected.itemsByKey[codexTranscriptItemAddress("turn:one", "first")]).toBe(
      state.turns[0]!.items[0],
    );
    expect(projected.itemsByKey[codexTranscriptItemAddress("turn:two", "first")]).toBe(
      state.turns[1]!.items[0],
    );
    expect(projected.turnsByKey["turn:one"]!.details).not.toHaveProperty("items");
    const sparse = Array<CodexCanonicalItem | undefined>(4);
    sparse[2] = state.turns[0]!.items[0];
    expect(codexTranscriptItemSlots(sparse)).toEqual({
      length: 4,
      entries: [{ index: 2, itemId: "first" }],
    });
  });

  test("subagent activity follows keyed append, text changes and removal", () => {
    const before = fixture();
    const appended = mutate(before, (draft) => {
      draft.turns[0]!.items.push({
        type: "subAgentActivity",
        model: null,
        reasoningEffort: null,
        id: "activity",
        kind: "completed",
        agentThreadId: "child",
        agentPath: "worker",
      });
    });
    const update = projectCodexTranscriptUpdate(key, before, appended.after, {
      patches: appended.patches,
    });
    expect(
      update?.type === "changes" && update.changes.find((change) => change.type === "turn"),
    ).toMatchObject({ hasSubagentActivity: true });
    const text = mutateText(appended.after, [
      {
        conversationId: "thread",
        turnId: "one",
        itemId: "first",
        target: { type: "plan" },
        delta: " next",
      },
    ]);
    projectCodexTranscriptUpdate(key, text.before, text.after, {
      patches: text.patches,
      acceptedTranscriptText: text.accepted,
    });
    expect(projectCodexTranscript(text.after).turnsByKey["turn:one"]?.hasSubagentActivity).toBe(
      true,
    );
    const removed = mutate(text.after, (draft) => {
      draft.turns[0]!.items.pop();
    });
    const removal = projectCodexTranscriptUpdate(key, removed.before, removed.after, {
      patches: removed.patches,
    });
    expect(
      removal?.type === "changes" && removal.changes.find((change) => change.type === "turn"),
    ).toMatchObject({ hasSubagentActivity: false });
  });

  test("one accepted text edit emits no structure, slots or unrelated Turn/item", () => {
    const mutation = mutateText(fixture(), [
      {
        conversationId: "thread",
        turnId: "one",
        itemId: "first",
        target: { type: "plan" },
        delta: "世界",
      },
    ]);
    const accepted = mutation.accepted;
    expect(accepted?.changes).toEqual([
      {
        type: "text",
        key: { ...key, entityKey: "turn:one", itemId: "first" },
        target: { field: "text" },
        edits: [{ at: 5, deleteCount: 0, insert: "世界" }],
      },
    ]);
    expect(
      projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
        patches: mutation.patches,
        acceptedTranscriptText: accepted,
      }),
    ).toEqual({ type: "changes", changes: accepted!.changes });
    expect(mutation.after.turns[1]).toBe(mutation.before.turns[1]);
  });

  test("a text replacement without successful reducer evidence emits an ordinary item", () => {
    const mutation = mutate(fixture(), (draft) => {
      const item = draft.turns[0]!.items[0]!;
      if (item.type === "plan") item.text = "server snapshot";
    });
    const update = projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
      patches: mutation.patches,
    });
    expect(update).toEqual({
      type: "changes",
      changes: [
        {
          type: "item",
          key: { ...key, entityKey: "turn:one", itemId: "first" },
          value: mutation.after.turns[0]!.items[0],
        },
      ],
    });
  });

  test("changed item replacement and append preserve original slot indexes", () => {
    const mutation = mutate(fixture(), (draft) => {
      draft.turns[0]!.items.push({ type: "plan", id: "appended", text: "next" });
    });
    const update = projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
      patches: mutation.patches,
    });
    expect(update?.type).toBe("changes");
    if (update?.type !== "changes") throw new Error("missing changes");
    expect(update.changes.map((change) => change.type)).toEqual(["item-slots-append", "item"]);
    expect(update.changes[0]).toEqual({
      type: "item-slots-append",
      key: { ...key, entityKey: "turn:one" },
      previousLength: 1,
      length: 2,
      entries: [{ index: 1, itemId: "appended" }],
    });
  });

  test("slot replacement explicitly removes old item payload", () => {
    const mutation = mutate(fixture(), (draft) => {
      draft.turns[0]!.items = [];
    });
    const update = projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
      patches: mutation.patches,
    });
    expect(update).toEqual({
      type: "changes",
      changes: [
        {
          type: "item-slots",
          key: { ...key, entityKey: "turn:one" },
          slots: { length: 0, entries: [] },
        },
        { type: "item", key: { ...key, entityKey: "turn:one", itemId: "first" }, value: null },
      ],
    });
  });

  test("structural replacement removes old Turn and suppresses duplicate accepted text", () => {
    const mutation = mutate(fixture(), (draft) => {
      draft.turns.splice(0, 1);
      const item = draft.turns[0]!.items[0]!;
      if (item.type === "plan") item.text += " new";
    });
    const update = projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
      patches: mutation.patches,
      acceptedTranscriptText: {
        turnEntityKeys: new Set(["turn:two"]),
        changes: [
          {
            type: "text",
            key: { ...key, entityKey: "turn:two", itemId: "first" },
            target: { field: "text" },
            edits: [],
          },
        ],
      },
    });
    expect(update?.type).toBe("changes");
    if (update?.type !== "changes") throw new Error("missing changes");
    expect(
      update.changes.some(
        (change) => change.type === "remove-turn" && change.key.entityKey === "turn:one",
      ),
    ).toBe(true);
    expect(update.changes.some((change) => change.type === "structure")).toBe(true);
    expect(update.changes.filter((change) => change.type === "item")).toHaveLength(1);
    expect(update.changes.filter((change) => change.type === "text")).toEqual([]);
  });

  test("missing evidence resets; unchanged transcript ignores other conversation metadata", () => {
    const before = fixture();
    const after = { ...before, title: "new title" };
    expect(projectCodexTranscriptUpdate(key, before, after)).toBeNull();
    const mutation = mutate(before, (draft) => {
      draft.turns[0]!.diff = "changed";
    });
    expect(projectCodexTranscriptUpdate(key, before, mutation.after)?.type).toBe("reset");
    expect(projectCodexTranscriptUpdate(key, null, mutation.after, { patches: [] })?.type).toBe(
      "reset",
    );
    expect(projectCodexTranscriptUpdate(key, before, null)).toEqual({ type: "reset", value: null });
  });

  test("reasoning part acceptance and sequential text edits replay actual canonical writes", () => {
    const before = fixture([{ type: "reasoning", id: "reason", summary: ["old"], content: [] }]);
    const mutation = mutateText(before, [
      {
        conversationId: "thread",
        turnId: "one",
        itemId: "reason",
        target: { type: "reasoningSummary", summaryIndex: 0 },
        delta: " text",
      },
      {
        conversationId: "thread",
        turnId: "one",
        itemId: "reason",
        target: { type: "reasoningSummary", summaryIndex: 1 },
        delta: "new part",
      },
      {
        conversationId: "thread",
        turnId: "one",
        itemId: "reason",
        target: { type: "reasoningContent", contentIndex: 0 },
        delta: "analysis",
      },
    ]);
    const accepted = mutation.accepted!;
    let item = before.turns[0]!.items[0]!;
    for (const change of accepted.changes) item = applyCodexTranscriptTextChange(item, change);
    expect(item).toEqual(mutation.after.turns[0]!.items[0]);
    expect(accepted.changes.filter((change) => change.type === "text-parts")).toHaveLength(2);
    expect(
      applyCodexTranscriptTextEdits("abcdef", [
        { at: 0, deleteCount: 2, insert: "[cut]" },
        { at: 9, deleteCount: 0, insert: "next" },
      ]),
    ).toBe("[cut]cdefnext");
  });

  test("invalid parts, wrong item families and edit order fail before silent corruption", () => {
    const item = fixture().turns[0]!.items[0]!;
    const textKey = { ...key, entityKey: "turn:one", itemId: "first" };
    expect(() =>
      applyCodexTranscriptTextEdits("abc", [{ at: 4, deleteCount: 0, insert: "d" }]),
    ).toThrow("out of order");
    expect(() =>
      applyCodexTranscriptTextEdits("abc", [{ at: 0, deleteCount: -1, insert: "d" }]),
    ).toThrow("out of order");
    expect(() =>
      applyCodexTranscriptTextChange(item, {
        type: "text",
        key: textKey,
        target: { field: "summary", index: 0 },
        edits: [],
      }),
    ).toThrow("incompatible");
    expect(() =>
      applyCodexTranscriptTextChange(
        { type: "reasoning", id: "reason", summary: [], content: [] },
        { type: "text-parts", key: textKey, field: "summary", at: 1, values: ["bad"] },
      ),
    ).toThrow("out of order");
  });

  test("timeline prepend, realtime append and completion project independent changes", () => {
    const item = { type: "turnStarted" as const, position: 1, turnId: "one", startedAt: 1 };
    const before: CodexTranscriptConversationState = {
      ...fixture(),
      itemTimeline: { entries: [item], activeRealtimeSessionAtPageStart: null },
      realtimeItems: {
        rt: {
          item: {
            type: "transcriptSegment",
            id: "rt",
            realtimeSessionId: "session",
            role: "assistant",
            text: "hello",
          },
          completed: false,
        },
      },
    };
    const after: CodexTranscriptConversationState = {
      ...before,
      itemTimeline: {
        entries: [{ ...item, position: 0 }, item],
        activeRealtimeSessionAtPageStart: "session",
      },
      realtimeItems: {
        rt: {
          ...before.realtimeItems!.rt!,
          item: {
            type: "transcriptSegment",
            id: "rt",
            realtimeSessionId: "session",
            role: "assistant",
            text: "hello there",
          },
        },
      },
    };
    const update = projectCodexTranscriptUpdate(key, before, after, {
      patches: [
        { op: "replace", path: ["realtimeItems", "rt", "item", "text"], value: "hello there" },
      ],
    });
    expect(update?.type).toBe("changes");
    if (update?.type !== "changes") throw new Error("missing changes");
    expect(update.changes.map((change) => change.type)).toEqual([
      "item-timeline-prepend",
      "realtime-text",
    ]);
  });

  test("ambiguous mixed item writes fall back together instead of double applying text", () => {
    const changes: CodexTranscriptTextChange[] = [];
    const mutation = mutate(fixture(), (draft) => {
      mutateCodexConversationFrameTextDeltas(
        draft,
        [
          {
            conversationId: "thread",
            turnId: "one",
            itemId: "first",
            target: { type: "plan" },
            delta: " next",
          },
        ],
        { now: () => 1, onAcceptedText: (change) => changes.push(change) },
      );
      draft.turns[0]!.items.push({ type: "plan", id: "new", text: "new" });
    });
    expect(
      buildCodexTranscriptAcceptedMutation(
        mutation.before,
        mutation.after,
        mutation.patches,
        changes,
      ),
    ).toBeUndefined();
    const update = projectCodexTranscriptUpdate(key, mutation.before, mutation.after, {
      patches: mutation.patches,
    });
    expect(
      update?.type === "changes" && update.changes.filter((change) => change.type === "item"),
    ).toHaveLength(2);
  });
});

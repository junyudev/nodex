import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import {
  projectCodexTranscript,
  type CodexTranscriptEvent,
  type CodexTranscriptSnapshot,
} from "../../../shared/codex-transcript-projection";
import { CodexTranscriptReadOwner } from "./normalized-transcript-read-owner";
import { selectNormalizedConversationTurnEntries } from "./normalized-transcript-selectors";
import { selectTurnRenderModel } from "./projection/build-turn-render-model";
import { resolveLocalConversationPersistedSearchTarget } from "./view/local-conversation-persisted-search";

const key = { hostId: "local", threadId: "thread" };
const itemKey = { ...key, entityKey: "turn:one", itemId: "first" };
function fixture(
  items: ThreadItem[] = [{ type: "plan", id: "first", text: "hello" }],
): CodexTranscriptSnapshot {
  const state = createCodexCanonicalHydratedConversationState(
    {
      ...buildAgentActivityV2CorpusThread([]),
      id: key.threadId,
      turns: [
        {
          id: "one",
          items,
          itemsView: "full",
          rootTurnId: null,
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
        {
          id: "two",
          items: [{ type: "plan", id: "first", text: "other" }],
          itemsView: "full",
          rootTurnId: null,
          status: "completed",
          error: null,
          startedAt: 2,
          completedAt: 3,
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
  return projectCodexTranscript(state);
}

function insertText(text: string): CodexTranscriptEvent {
  return {
    type: "changes",
    changes: [
      {
        type: "text",
        key: itemKey,
        target: { field: "text" },
        edits: [{ at: 5, deleteCount: 0, insert: text }],
      },
    ],
  };
}

describe("normalized transcript read owner", () => {
  test("resolves a native opening-message search occurrence through its visible input row", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        {
          type: "userMessage",
          id: "native-opening",
          clientId: "client-opening",
          content: [{ type: "text", text: "needle", text_elements: [] }],
        },
        { type: "plan", id: "answer", text: "answer" },
      ]),
    });
    const turn = owner.readTurn("turn:one");
    if (!turn) throw new Error("Expected the hydrated Turn");
    const entry = {
      turn,
      turnId: "one",
      turnKey: "turn:one",
      turnSearchKey: "turn:one",
      requests: [],
      isMostRecentTurn: false,
    };
    const units = selectTurnRenderModel({
      entry,
      canEditTurnUserPrefix: false,
      canForkTurn: false,
      cwd: "/workspace",
      projectlessOutputDirectory: null,
    }).searchUnits;
    const target = resolveLocalConversationPersistedSearchTarget({
      entry,
      occurrence: {
        turnId: "one",
        itemId: "native-opening",
        turnCursor: "cursor-one",
        snippet: "needle",
        snippetMatchRange: { start: 0, end: 6 },
      },
      itemOccurrenceIndex: 0,
      query: "needle",
      units,
    });
    expect(turn.items.filter((item) => item.role === "user")).toHaveLength(1);
    expect(target).toEqual({
      turnKey: "turn:one",
      unitKey: units.find((unit) => unit.blockType === "userMessage")?.key,
      occurrenceIndex: 0,
    });
  });
  test("exposes only the transport-neutral host and Thread identity", () => {
    const owner = new CodexTranscriptReadOwner({
      ...key,
      connect: () => () => {},
      onIdle: () => {},
    });
    expect(owner.key).toEqual(key);
  });
  test("realtime text stays in its keyed family without rebuilding transcript structure", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: {
        ...fixture(),
        realtimeItems: {
          voice: {
            completed: false,
            item: {
              type: "transcriptSegment",
              id: "voice",
              realtimeSessionId: "session",
              role: "assistant",
              text: "Voice",
            },
          },
        },
      },
    });
    const structure = owner.readStructure();
    let structureCalls = 0;
    let voiceCalls = 0;
    const releases = [
      owner.subscribeStructure(() => structureCalls++),
      owner.subscribeRealtimeItem("voice", () => voiceCalls++),
    ];
    owner.applyEvent({
      type: "changes",
      changes: [{ type: "realtime-text", itemId: "voice", delta: " updated" }],
    });
    expect(owner.readRealtimeItem("voice")?.item).toMatchObject({ text: "Voice updated" });
    expect(owner.readStructure()).toBe(structure);
    expect([structureCalls, voiceCalls]).toEqual([0, 1]);
    releases.forEach((release) => release());
    expect(owner.readRealtimeItem("voice")).toBeNull();
  });
  test("aggregates independent view protection, null veto and viewer release", () => {
    const reported: Array<
      readonly (
        | import("../../../shared/codex-history-policy").CodexHistoryViewportBoundary
        | null
      )[]
    > = [];
    const close = Object.assign(() => {}, {
      setHistoryViewport: (
        value: readonly (
          | import("../../../shared/codex-history-policy").CodexHistoryViewportBoundary
          | null
        )[],
      ) => reported.push(value),
    });
    const owner = new CodexTranscriptReadOwner({ ...key, connect: () => close });
    const release = owner.subscribeStructure(() => {});
    const one = Symbol("one");
    const two = Symbol("two");
    const boundary = { oldestRenderedTurnId: "one", firstProtectedItemId: null };
    owner.setHistoryViewport(one, boundary);
    owner.setHistoryViewport(two, null);
    owner.setHistoryViewport(two, undefined);
    owner.setHistoryViewport(one, boundary);
    expect(reported).toEqual([[], [boundary], [boundary, null], [boundary]]);
    release();
    const again = owner.subscribeStructure(() => {});
    expect(reported.at(-1)).toEqual([]);
    again();
  });

  test("invalid reset references leave the last complete projection visible", () => {
    const owner = new CodexTranscriptReadOwner(key);
    const snapshot = fixture();
    owner.applyEvent({ type: "reset", value: snapshot });
    const structure = owner.readStructure();
    expect(() =>
      owner.applyEvent({ type: "reset", value: { ...snapshot, itemsByKey: {} } }),
    ).toThrow("no addressed item");
    expect(owner.readStructure()).toBe(structure);
    expect(owner.readItem("turn:one", "first")).toMatchObject({ text: "hello" });
  });
  test("existing text touches only its item family and leaves Turn/list structure stable", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const structure = owner.readStructure()!;
    const entries = selectNormalizedConversationTurnEntries({
      owner,
      structure,
      conversation: null,
    });
    const slots = owner.readItemSlots("turn:one");
    const otherTurn = owner.readTurn("turn:two");
    const initialLeaf = owner.readProjectedItem("turn:one", "first", "first");
    let structureCalls = 0;
    let turnCalls = 0;
    let otherCalls = 0;
    let leafCalls = 0;
    const releases = [
      owner.subscribeStructure(() => structureCalls++),
      owner.subscribeTurn("turn:one", () => turnCalls++),
      owner.subscribeItem("turn:two", "first", () => otherCalls++),
      owner.subscribeItem("turn:one", "first", () => leafCalls++),
    ];
    owner.applyEvent(insertText(" world"));
    expect(owner.readStructure()).toBe(structure);
    expect(owner.readItemSlots("turn:one")).toBe(slots);
    expect(owner.readTurn("turn:two")).toBe(otherTurn);
    expect(
      selectNormalizedConversationTurnEntries({
        owner,
        structure: owner.readStructure()!,
        conversation: null,
      }),
    ).toBe(entries);
    expect(owner.readProjectedItem("turn:one", "first", "first")?.markdownText).toBe("hello world");
    expect(owner.readProjectedItem("turn:one", "first", "first")).not.toBe(initialLeaf);
    expect([structureCalls, turnCalls, otherCalls, leafCalls]).toEqual([0, 0, 0, 1]);
    releases.forEach((release) => release());
  });

  test("staged multi-map resets are atomic and can be abandoned by a fresh reset", () => {
    const owner = new CodexTranscriptReadOwner(key);
    const initial = fixture();
    owner.applyEvent({ type: "reset", value: initial });
    const current = owner.readStructure();
    const next = fixture([{ type: "plan", id: "replacement", text: "new" }]);
    owner.applyEvent({ type: "reset-start", value: next });
    owner.applyEvent({
      type: "reset-part",
      turnsByKey: next.turnsByKey,
      itemsByKey: {},
      realtimeItems: {},
    });
    expect(owner.readStructure()).toBe(current);
    expect(owner.readItem("turn:one", "replacement")).toBeNull();
    owner.applyEvent({
      type: "reset-part",
      turnsByKey: {},
      itemsByKey: next.itemsByKey,
      realtimeItems: {},
    });
    owner.applyEvent({ type: "reset-commit" });
    expect(owner.readItem("turn:one", "replacement")?.type).toBe("plan");
    expect(owner.readItem("turn:one", "first")).toBeNull();
    owner.applyEvent({ type: "reset-start", value: initial });
    owner.applyEvent({ type: "reset", value: null });
    expect(owner.readStructure()).toBeNull();
    expect(() => owner.applyEvent({ type: "reset-commit" })).toThrow("no staging owner");
  });

  test("sparse slot indexes survive materialization and stale appends roll back the batch", () => {
    const owner = new CodexTranscriptReadOwner(key);
    const snapshot = fixture();
    owner.applyEvent({
      type: "reset",
      value: {
        ...snapshot,
        turnsByKey: {
          ...snapshot.turnsByKey,
          "turn:one": {
            ...snapshot.turnsByKey["turn:one"]!,
            itemSlots: { length: 4, entries: [{ index: 2, itemId: "first" }] },
          },
        },
      },
    });
    const raw = owner.readCanonicalTurn("turn:one")!;
    expect(raw.items.length).toBe(4);
    expect(0 in raw.items).toBe(false);
    expect(raw.items[2]?.id).toBe("first");
    expect(owner.readTurn("turn:one")?.items[0]?.markdownText).toBe("hello");
    const structure = owner.readStructure();
    expect(() =>
      owner.applyEvent({
        type: "changes",
        changes: [
          { type: "item", key: itemKey, value: { type: "plan", id: "first", text: "wrong" } },
          {
            type: "item-slots-append",
            key: { ...key, entityKey: "turn:one" },
            previousLength: 3,
            length: 5,
            entries: [{ index: 4, itemId: "appended" }],
          },
        ],
      }),
    ).toThrow("out of order");
    expect(owner.readStructure()).toBe(structure);
    expect(owner.readItem("turn:one", "first")).toMatchObject({ text: "hello" });
    expect(owner.readCanonicalTurn("turn:one")).toBe(raw);
  });

  test("reasoning parts and command output project one addressed leaf", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        { type: "reasoning", id: "reason", summary: ["Heading"], content: ["private"] },
        {
          type: "commandExecution",
          id: "exec",
          pluginId: null,
          scriptPath: null,
          source: "agent",
          command: "echo",
          cwd: "/workspace",
          processId: null,
          status: "inProgress",
          commandActions: [],
          aggregatedOutput: "first",
          exitCode: null,
          durationMs: null,
        },
      ]),
    });
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "text-parts",
          key: { ...itemKey, itemId: "reason" },
          field: "summary",
          at: 1,
          values: ["Details"],
        },
        {
          type: "text",
          key: { ...itemKey, itemId: "exec" },
          target: { field: "aggregatedOutput" },
          edits: [{ at: 5, deleteCount: 0, insert: " output" }],
        },
      ],
    });
    expect(owner.readProjectedItem("turn:one", "reason", "reason")?.markdownText).toBe(
      "**Heading**\n\nDetails",
    );
    expect(owner.readProjectedItem("turn:one", "exec", "exec")?.aggregatedOutput).toBe(
      "first output",
    );
  });

  test("removal clears raw/derived references and identical item IDs stay scoped to a Turn", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const removed = owner.readTurn("turn:one");
    const retained = owner.readTurn("turn:two");
    const retainedItem = owner.readItem("turn:two", "first");
    owner.applyEvent({
      type: "changes",
      changes: [
        { type: "remove-turn", key: { ...key, entityKey: "turn:one" } },
        { type: "structure", timeline: null, turnEntityKeys: ["turn:two"] },
      ],
    });
    expect(removed).not.toBeNull();
    expect(owner.readTurn("turn:one")).toBeNull();
    expect(owner.readItem("turn:one", "first")).toBeNull();
    expect(owner.readProjectedItem("turn:one", "first", "first")).toBeNull();
    expect(owner.readTurn("turn:two")).toBe(retained);
    expect(owner.readItem("turn:two", "first")).toBe(retainedItem);
  });

  test("last subscriber clears retained state and fences a late connection callback", async () => {
    const deliveries: Array<(event: CodexTranscriptEvent) => Promise<void>> = [];
    let connects = 0;
    let disconnects = 0;
    const owner = new CodexTranscriptReadOwner({
      ...key,
      connect: (listener) => {
        deliveries.push(listener);
        connects++;
        return () => disconnects++;
      },
    });
    const first = owner.subscribeStructure(() => {});
    const second = owner.subscribeTurn("turn:one", () => {});
    await deliveries[0]!({ type: "reset", value: fixture() });
    expect(connects).toBe(1);
    first();
    expect(owner.readStructure()).not.toBeNull();
    second();
    expect(owner.readStructure()).toBeNull();
    expect(owner.readTurn("turn:one")).toBeNull();
    const third = owner.subscribeStructure(() => {});
    expect(connects).toBe(2);
    await deliveries[0]!({ type: "reset", value: fixture() });
    expect(owner.readStructure()).toBeNull();
    await deliveries[1]!({ type: "reset", value: fixture() });
    expect(owner.readStructure()).not.toBeNull();
    third();
    third();
    expect(disconnects).toBe(2);
    owner.dispose();
  });
});

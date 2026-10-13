import { describe, expect, test, vi } from "vite-plus/test";
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
  test("revision-qualified reads reject stale and future topology without reading a Turn", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const slice = { itemIds: ["first"], includeInput: false, includeTurnExtras: false };
    const version = owner.readTurnVersion("turn:one");
    const neighborVersion = owner.readTurnVersion("turn:two");
    const neighbor = owner.readTurnAtVersion("turn:two", neighborVersion, slice);
    const initial = owner.readTurnAtVersion("turn:one", version, slice);
    expect(initial?.items[0]?.markdownText).toBe("hello");
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item",
          key: { ...itemKey, itemId: "new" },
          value: { type: "plan", id: "new", text: "New work" },
        },
        {
          type: "item-slots-append",
          key: { ...key, entityKey: "turn:one" },
          previousLength: 1,
          length: 2,
          entries: [{ index: 1, itemId: "new" }],
        },
      ],
    });
    const currentVersion = owner.readTurnVersion("turn:one");
    expect(currentVersion).toBeGreaterThan(version);
    const readTurn = vi.spyOn(owner, "readTurn");
    const readSlice = vi.spyOn(owner, "readTurnSlice");
    expect(owner.readTurnAtVersion("turn:one", version)).toBeNull();
    expect(owner.readTurnAtVersion("turn:one", version, slice)).toBeNull();
    expect(owner.readTurnAtVersion("turn:one", currentVersion + 1, slice)).toBeNull();
    expect(readTurn).not.toHaveBeenCalled();
    expect(readSlice).not.toHaveBeenCalled();
    expect(owner.readTurnAtVersion("turn:two", neighborVersion, slice)).toBe(neighbor);
    expect(owner.readTurnAtVersion("turn:one", currentVersion, slice)?.items[0]?.markdownText).toBe(
      "hello",
    );
    expect(readTurn).not.toHaveBeenCalled();
    owner.dispose();
    expect(owner.readTurnAtVersion("turn:one", currentVersion, slice)).toBeNull();
  });

  test("revision-qualified metadata reads only selected raw addresses and rejects a retired version", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const version = owner.readTurnVersion("turn:one");
    const readTurn = vi.spyOn(owner, "readTurn");
    const readSlice = vi.spyOn(owner, "readTurnSlice");
    const readItem = vi.spyOn(owner, "readItem");
    const metadata = owner.readTurnMetadataAtVersion("turn:one", version, ["first"]);
    expect(metadata?.items.map((item) => item.id)).toEqual(["first"]);
    expect(metadata?.details).toBe(owner.readTurnDetails("turn:one"));
    expect(metadata?.latestSteeringItem).toBeNull();
    expect(readItem).toHaveBeenCalledExactlyOnceWith("turn:one", "first");
    expect(readTurn).not.toHaveBeenCalled();
    expect(readSlice).not.toHaveBeenCalled();
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey: "turn:one" },
          details: { ...owner.readTurnDetails("turn:one")!, status: "completed" },
          hasSubagentActivity: false,
        },
      ],
    });
    readItem.mockClear();
    expect(owner.readTurnMetadataAtVersion("turn:one", version, ["first"])).toBeNull();
    expect(readItem).not.toHaveBeenCalled();
    const next = owner.readTurnMetadataAtVersion("turn:one", owner.readTurnVersion("turn:one"), [
      "first",
    ]);
    expect(next?.details.status).toBe("completed");
    expect(next?.items.map((item) => item.id)).toEqual(["first"]);
    expect(readTurn).not.toHaveBeenCalled();
    expect(readSlice).not.toHaveBeenCalled();
  });

  test("an addressed text replacement preserves another slice in the same Turn", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        { type: "plan", id: "first", text: "hello" },
        { type: "plan", id: "sibling", text: "Stable" },
      ]),
    });
    const firstSlice = { itemIds: ["first"], includeInput: false, includeTurnExtras: false };
    const siblingSlice = { itemIds: ["sibling"], includeInput: false, includeTurnExtras: false };
    const beforeFirst = owner.readTurnSlice("turn:one", firstSlice);
    const beforeSibling = owner.readTurnSlice("turn:one", siblingSlice);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item",
          key: itemKey,
          value: { type: "plan", id: "first", text: "" },
        },
      ],
    });
    expect(owner.readTurnSlice("turn:one", firstSlice)).not.toBe(beforeFirst);
    expect(owner.readTurnSlice("turn:one", firstSlice)?.items[0]?.markdownText).toBe("");
    expect(owner.readTurnSlice("turn:one", siblingSlice)).toBe(beforeSibling);
    owner.applyEvent({
      type: "changes",
      changes: [
        { type: "remove-turn", key: { ...key, entityKey: "turn:one" } },
        { type: "structure", turnEntityKeys: ["turn:two"], timeline: null },
      ],
    });
    expect(owner.readTurnSlice("turn:one", siblingSlice)).toBeNull();
  });

  test("a Turn append or history update keeps another Turn's stable slice identity", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const slice = { itemIds: ["first"], includeInput: false, includeTurnExtras: false };
    const before = owner.readTurnSlice("turn:two", slice);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item-slots-append",
          key: { ...key, entityKey: "turn:one" },
          previousLength: 1,
          length: 2,
          entries: [{ index: 1, itemId: "appended" }],
        },
        {
          type: "item",
          key: { ...key, entityKey: "turn:one", itemId: "appended" },
          value: { type: "plan", id: "appended", text: "New" },
        },
      ],
    });
    expect(owner.readTurnSlice("turn:two", slice)).toBe(before);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey: "turn:one" },
          hasSubagentActivity: false,
          details: {
            ...structuredClone(owner.readTurnDetails("turn:one")!),
            itemsPagination: {
              itemsView: "summary",
              olderCursor: "older",
              hasLoadedOldest: false,
              isLoadingOlder: true,
            },
          },
        },
      ],
    });
    expect(owner.readTurnSlice("turn:two", slice)).toBe(before);
    owner.applyEvent({
      type: "changes",
      changes: [
        { type: "remove-turn", key: { ...key, entityKey: "turn:one" } },
        { type: "structure", turnEntityKeys: ["turn:two"], timeline: null },
      ],
    });
    expect(owner.readTurnSlice("turn:one", slice)).toBeNull();
    expect(owner.readTurnSlice("turn:two", slice)).toBe(before);
    owner.applyEvent({ type: "reset", value: null });
    expect(owner.readTurnSlice("turn:two", slice)).toBeNull();
  });

  test("stable timeline slices and completed projections stay separate from the native active Turn", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({ type: "reset", value: fixture() });
    const slice = {
      itemIds: ["first"],
      includeInput: false,
      includeTurnExtras: false,
      presentationStatus: "completed" as const,
    };
    const native = owner.readProjectedItem("turn:one", "first", "first");
    const completed = owner.readProjectedItem("turn:one", "first", "first", "completed");
    const initial = owner.readTurnSlice("turn:one", slice);
    expect(owner.readTurnSlice("turn:one", slice)).toBe(initial);
    expect(initial?.status).toBe("completed");
    expect(completed?.status).toBe("completed");
    expect(owner.readProjectedItem("turn:one", "first", "first", "completed")).toBe(completed);
    expect(owner.readTurn("turn:one")?.status).toBe("inProgress");
    expect(owner.readProjectedItem("turn:one", "first", "first")).toBe(native);
    owner.applyEvent(insertText(" next"));
    const updated = owner.readTurnSlice("turn:one", slice);
    expect(updated).not.toBe(initial);
    expect(updated?.items[0]?.markdownText).toBe("hello next");
    expect(owner.readProjectedItem("turn:one", "first", "first", "completed")).not.toBe(completed);
    expect(owner.readProjectedItem("turn:one", "first", "first", "completed")).toMatchObject({
      markdownText: "hello next",
      status: "completed",
    });
    expect(owner.readTurn("turn:one")?.status).toBe("inProgress");
  });

  test("a partial suffix keeps a later matching user when the proven opening is not resident", () => {
    const owner = new CodexTranscriptReadOwner(key);
    const snapshot = fixture([
      {
        type: "userMessage",
        id: "later",
        clientId: null,
        content: [{ type: "text", text: "Prompt", text_elements: [] }],
      },
    ]);
    const turn = snapshot.turnsByKey["turn:one"]!;
    owner.applyEvent({
      type: "reset",
      value: {
        ...snapshot,
        turnsByKey: {
          ...snapshot.turnsByKey,
          "turn:one": {
            ...turn,
            details: {
              ...turn.details,
              itemsPagination: {
                itemsView: "summary",
                olderCursor: "opening-page",
                hasLoadedOldest: false,
                isLoadingOlder: false,
                openingUserMessageId: "opening",
              },
            },
          },
        },
      },
    });
    const full = owner.readTurn("turn:one");
    expect(full?.items[0]?.rawItemId).toBe("opening");
    expect(full?.items.find((item) => item.rawItemId === "later")?.semanticKind).toBe("steered");
  });

  test("a later matching user message stays steered when its opening and work precede the fragment", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        {
          type: "userMessage",
          id: "opening",
          clientId: "client",
          content: [{ type: "text", text: "Prompt", text_elements: [] }],
        },
        { type: "plan", id: "work", text: "Work" },
        {
          type: "userMessage",
          id: "later",
          clientId: null,
          content: [{ type: "text", text: "Prompt", text_elements: [] }],
        },
      ]),
    });
    const full = owner.readTurn("turn:one")?.items.find((item) => item.rawItemId === "later");
    const slice = owner.readTurnSlice("turn:one", {
      itemIds: ["later"],
      includeInput: false,
      includeTurnExtras: false,
    });
    expect(full?.semanticKind).toBe("steered");
    expect(slice?.items[0]?.semanticKind).toBe("steered");
    expect(owner.readOpeningUserMessageId("turn:one")).toBe("opening");
    const voice = owner.readTurnSlice("turn:one", {
      itemIds: ["later"],
      includeInput: false,
      includeTurnExtras: false,
      preserveServerUserMessages: true,
    });
    expect(voice?.items[0]).toMatchObject({
      semanticKind: "userMessage",
      markdownText: "Prompt",
      rawItemId: "later",
    });
  });

  test("a timeline fragment does not reopen a search followed by work in another fragment", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        {
          type: "webSearch",
          id: "search",
          query: "needle",
          action: { type: "search", query: "needle", queries: null },
          results: null,
        },
        { type: "plan", id: "later-work", text: "Next" },
      ]),
    });
    const full = owner.readTurn("turn:one")?.items.find((item) => item.rawItemId === "search");
    const slice = owner.readTurnSlice("turn:one", {
      itemIds: ["search"],
      includeInput: false,
      includeTurnExtras: false,
    });
    expect(full?.webSearch?.completed).toBe(true);
    expect(slice?.items[0]?.webSearch?.completed).toBe(true);
  });

  test("timeline slices read selected addresses and retain one prompt and tail extras without changing sparse slots", () => {
    const owner = new CodexTranscriptReadOwner(key);
    const snapshot = fixture([
      {
        type: "agentMessage",
        id: "first",
        text: "First",
        phase: "commentary",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
      {
        type: "agentMessage",
        id: "second",
        text: "Second",
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    ]);
    const turn = snapshot.turnsByKey["turn:one"]!;
    const slots = {
      length: 1_000,
      entries: [
        { index: 499, itemId: "first" },
        { index: 999, itemId: "second" },
      ],
    };
    owner.applyEvent({
      type: "reset",
      value: {
        ...snapshot,
        turnsByKey: {
          ...snapshot.turnsByKey,
          "turn:one": {
            ...turn,
            itemSlots: slots,
            details: {
              ...turn.details,
              status: "completed",
              params: {
                ...turn.details.params,
                input: [{ type: "text", text: "Prompt", text_elements: [] }],
                clientUserMessageId: "client",
              },
              itemsPagination: {
                itemsView: "summary",
                olderCursor: "older",
                hasLoadedOldest: false,
                isLoadingOlder: false,
                openingUserMessageId: "native-opening",
              },
              diff: "Diff",
              completedAtMs: 2_000,
              durationMs: 1_000,
              firstTurnWorkItemStartedAtMs: 1_100,
              finalAssistantStartedAtMs: 1_500,
              safetyBuffering: {
                useCases: ["slow"],
                reasons: ["waiting"],
                showBufferingUi: true,
                fasterModel: null,
              },
            },
          },
        },
      },
    });
    const canonicalRead = vi.spyOn(owner, "readCanonicalTurn");
    const fullRead = vi.spyOn(owner, "readTurn");
    const itemRead = vi.spyOn(owner, "readItem");
    const head = owner.readTurnSlice("turn:one", {
      itemIds: ["first"],
      includeInput: true,
      includeTurnExtras: false,
    });
    const tail = owner.readTurnSlice("turn:one", {
      itemIds: ["second"],
      includeInput: false,
      includeTurnExtras: true,
    });
    expect(head?.items.map((item) => item.markdownText)).toEqual(["Prompt", "First"]);
    expect(head?.items[0]?.rawItemId).toBe("native-opening");
    expect(head).toMatchObject({
      itemIds: ["first"],
      completedAt: null,
      durationMs: null,
      finalAssistantStartedAtMs: null,
    });
    expect(head?.diff).toBeUndefined();
    expect(head?.safetyBuffering).toBeUndefined();
    expect(tail?.items.map((item) => item.markdownText)).toEqual(["Second"]);
    expect(tail).toMatchObject({
      itemIds: ["second"],
      diff: "Diff",
      completedAt: 2_000,
      durationMs: 1_000,
      finalAssistantStartedAtMs: 1_500,
      safetyBuffering: { showBufferingUi: true },
    });
    expect(itemRead.mock.calls).toEqual([
      ["turn:one", "first"],
      ["turn:one", "second"],
    ]);
    expect(canonicalRead).not.toHaveBeenCalled();
    expect(fullRead).not.toHaveBeenCalled();
    expect(owner.readItemSlots("turn:one")).toBe(slots);
    expect(owner.readItemSlots("turn:one")?.entries.map((slot) => slot.index)).toEqual([499, 999]);
  });

  test.each([false, true])(
    "hides a retained prewarm prompt with nonresident opening items (evicted=%s)",
    (evicted) => {
      const owner = new CodexTranscriptReadOwner(key);
      const snapshot = fixture([]);
      const turn = snapshot.turnsByKey["turn:one"]!;
      owner.applyEvent({
        type: "reset",
        value: {
          ...snapshot,
          turnsByKey: {
            ...snapshot.turnsByKey,
            "turn:one": {
              ...turn,
              details: {
                ...turn.details,
                params: {
                  ...turn.details.params,
                  input: [
                    { type: "text", text: "<startup_tool_prewarm>browser", text_elements: [] },
                  ],
                },
                itemsPagination: {
                  itemsView: evicted ? "full" : "summary",
                  olderCursor: "opening-page",
                  hasLoadedOldest: false,
                  isLoadingOlder: false,
                  evicted,
                },
              },
            },
          },
        },
      });
      expect(
        selectNormalizedConversationTurnEntries({
          owner,
          structure: owner.readStructure()!,
          conversation: null,
        }).map((entry) => entry.turnId),
      ).toEqual(["two"]);
    },
  );

  test("slot append and history metadata preserve existing item projections and subscriptions", () => {
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
            details: {
              ...snapshot.turnsByKey["turn:one"]!.details,
              lifecycleStatusByItemId: { first: "inProgress" },
              commandExecutionStartedAtMsById: { unrelated: 1_000 },
            },
          },
        },
      },
    });
    const first = owner.readProjectedItem("turn:one", "first", "first");
    const raw = owner.readItem("turn:one", "first");
    let leafCalls = 0;
    const release = owner.subscribeItem("turn:one", "first", () => leafCalls++);
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "item-slots-append",
          key: { ...key, entityKey: "turn:one" },
          previousLength: 1,
          length: 2,
          entries: [{ index: 1, itemId: "second" }],
        },
        {
          type: "item",
          key: { ...key, entityKey: "turn:one", itemId: "second" },
          value: { type: "plan", id: "second", text: "Second" },
        },
      ],
    });
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey: "turn:one" },
          details: {
            ...structuredClone(owner.readTurnDetails("turn:one")!),
            itemsPagination: {
              itemsView: "summary",
              olderCursor: "older",
              hasLoadedOldest: false,
              isLoadingOlder: true,
            },
          },
          hasSubagentActivity: false,
        },
      ],
    });
    expect(owner.readItem("turn:one", "first")).toBe(raw);
    expect(owner.readProjectedItem("turn:one", "first", "first")).toBe(first);
    expect(leafCalls).toBe(0);
    release();
  });

  test("real lifecycle and command context changes update the addressed projection", () => {
    const owner = new CodexTranscriptReadOwner(key);
    owner.applyEvent({
      type: "reset",
      value: fixture([
        {
          type: "agentMessage",
          id: "first",
          text: "Answer",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
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
          aggregatedOutput: "Output",
          exitCode: null,
          durationMs: null,
        },
      ]),
    });
    const first = owner.readProjectedItem("turn:one", "first", "first");
    const command = owner.readProjectedItem("turn:one", "exec", "exec");
    let firstCalls = 0;
    let commandCalls = 0;
    const releases = [
      owner.subscribeItem("turn:one", "first", () => firstCalls++),
      owner.subscribeItem("turn:one", "exec", () => commandCalls++),
    ];
    owner.applyEvent({
      type: "changes",
      changes: [
        {
          type: "turn",
          key: { ...key, entityKey: "turn:one" },
          details: {
            ...owner.readTurnDetails("turn:one")!,
            status: "interrupted",
            lifecycleStatusByItemId: { first: "completed" },
            commandExecutionStartedAtMsById: { exec: 2_000 },
          },
          hasSubagentActivity: false,
        },
      ],
    });
    expect(owner.readProjectedItem("turn:one", "first", "first")).not.toBe(first);
    expect(owner.readProjectedItem("turn:one", "first", "first")?.status).toBe("completed");
    expect(owner.readProjectedItem("turn:one", "exec", "exec")).not.toBe(command);
    expect(owner.readProjectedItem("turn:one", "exec", "exec")).toMatchObject({
      status: "interrupted",
      startedAtMs: 2_000,
    });
    expect([firstCalls, commandCalls]).toEqual([1, 1]);
    releases.forEach((release) => release());
  });

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

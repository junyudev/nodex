import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationTurn } from "../../../../shared/types";
import type { VisibleConversationTurnEntry } from "../selectors";
import { prepareUntrustedAppInput } from "../../../../shared/codex-untrusted-app-input";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
  realtimeSearchUnitKey,
  inlineMarkdownSearchUnitKey,
} from "./local-conversation-search-source";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
} from "../projection/normalized-timeline-entries";

function entry(turnKey: string, texts: string[]): VisibleConversationTurnEntry {
  const turn: CodexConversationTurn = {
    threadId: "thread",
    turnId: turnKey,
    status: "completed",
    itemIds: texts.map((_, index) => `${turnKey}-${index}`),
    items: texts.map((markdownText, index) => ({
      threadId: "thread",
      turnId: turnKey,
      itemId: `${turnKey}-${index}`,
      type: index === texts.length - 1 ? "assistant_message" : "user_message",
      kind: index === texts.length - 1 ? "assistantMessage" : "userMessage",
      semanticKind: index === texts.length - 1 ? "assistantMessage" : "userMessage",
      role: index === texts.length - 1 ? "assistant" : "user",
      markdownText,
      createdAt: index,
      updatedAt: index,
    })),
  };
  return {
    turn,
    turnId: turnKey,
    turnKey,
    turnSearchKey: turnKey,
    requests: [],
    isMostRecentTurn: true,
  };
}

function source(read: () => VisibleConversationTurnEntry[]) {
  return createLocalConversationSearchSource({
    routeContextId: "thread",
    getTurns: read,
    scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
  });
}

describe("resident transcript search cache", () => {
  test("finds restored visualization prompt text and excludes model instruction and app context", () => {
    const compiled = prepareUntrustedAppInput(
      "Inspect needle selection",
      {
        untrustedAppMessage: {
          source: "visualization",
          sourceId: "widget-a",
          text: "Inspect needle selection",
          structuredContent: { hidden: "secretContext" },
        },
      },
      "call",
    );
    const item = {
      type: "userMessage",
      id: "widget-prompt",
      clientId: null,
      content: [compiled.input],
    } as const;
    const { owner, project } = timelineOwnerFixture(
      {
        data: [
          {
            type: "item",
            position: 1,
            turnId: "one",
            item: { ...item, content: [...item.content] },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [{ ...item, content: [...item.content] }],
    );
    const read = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => project().entries,
      readOwner: () => owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    expect(read.findMatches("needle")).toMatchObject([
      { text: "Inspect needle selection", itemId: "widget-prompt" },
    ]);
    expect(read.findMatches("Respond to the user")).toEqual([]);
    expect(read.findMatches("secretContext")).toEqual([]);
    expect(read.findMatches("codex-untrusted-app-input")).toEqual([]);
  });
  test("preserves native user and assistant order across a mid-Turn steer", () => {
    const current = entry("one", [
      "needle opening",
      "needle commentary",
      "needle steer",
      "needle final",
    ]);
    current.turn.items[1] = {
      ...current.turn.items[1]!,
      type: "assistant_message",
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      role: "assistant",
      assistantPhase: "commentary",
    };
    current.turn.items[3] = { ...current.turn.items[3]!, assistantPhase: "final_answer" };
    expect(
      source(() => [current])
        .findMatches("needle")
        .map((unit) => unit.text),
    ).toEqual(["needle opening", "needle commentary", "needle steer", "needle final"]);
  });
  test("indexes collapsed assistant commentary with a native identity that survives a later answer", () => {
    let current = entry("one", ["User prompt", "commentary needle", "Final answer"]);
    current.turn.items[1] = {
      ...current.turn.items[1]!,
      kind: "assistantMessage",
      semanticKind: "assistantMessage",
      type: "assistant_message",
      role: "assistant",
      assistantPhase: "commentary",
      rawItemId: "native-commentary",
    };
    current.turn.items[2] = { ...current.turn.items[2]!, assistantPhase: "final_answer" };
    const read = source(() => [current]);
    const commentary = read.findMatches("commentary needle")[0];
    expect(commentary).toMatchObject({
      key: "one:assistant:native-commentary",
      itemId: "native-commentary",
    });
    const priorAnswer = read.findMatches("Final answer")[0]!;
    current = {
      ...current,
      turn: {
        ...current.turn,
        itemIds: [...current.turn.itemIds, "later"],
        items: [
          ...current.turn.items,
          { ...current.turn.items[2]!, itemId: "later", markdownText: "Later answer" },
        ],
      },
    };
    expect(read.findMatches("Final answer")[0]?.key).toBe(priorAnswer.key);
    expect(read.findMatches("commentary needle")[0]?.key).toBe(commentary?.key);
    expect(read.findMatches("Later answer")).toHaveLength(1);
  });
  test("indexes visible Markdown once without protocol envelope fields", () => {
    const current = entry("one", ["**Visible** [label](https://hidden.example)"]);
    current.turn.items[0]!.rawItem = {
      type: "agentMessage",
      id: "hidden-identity",
      text: "Visible label",
      privateMetadata: "secret",
    };
    const read = source(() => [current]);
    expect(read.findMatches("Visible")[0]?.text).toBe("Visible label");
    expect(read.findMatches("secret")).toEqual([]);
    expect(read.findMatches("hidden.example")).toEqual([]);
    expect(read.findMatches("hidden-identity")).toEqual([]);
  });
  test("reuses units for a materialized Turn even when its lightweight entry is recreated", () => {
    const current = entry("one", ["A distinct answer"]);
    const read = source(() => [{ ...current }]);
    const first = read.getUnitsForTurn(current);
    expect(read.getUnitsForTurn({ ...current })).toBe(first);
    expect(read.findMatches("distinct")).toHaveLength(1);
  });

  test("prunes removed Turns and refreshes search units after an item prefix is evicted", () => {
    const old = entry("one", ["Earlier sensitive text", "Current response"]);
    let entries = [old, entry("two", ["Other response"])];
    const read = source(() => entries);
    expect(read.findMatches("Earlier sensitive text")).toHaveLength(1);
    expect(read.findMatches("Other response")).toHaveLength(1);
    entries = [entry("one", ["Current response"])];
    read.pruneCachedData();
    expect(read.findMatches("Earlier sensitive text")).toEqual([]);
    expect(read.findMatches("Other response")).toEqual([]);
    expect(read.findMatches("Current response")).toHaveLength(1);
    read.clearCachedData();
    expect(read.findMatches("Current response")).toHaveLength(1);
  });

  test("indexes native voice text, refreshes keyed deltas and prunes removed history", () => {
    const { owner, project } = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 1,
          item: {
            type: "transcriptSegment",
            id: "voice",
            realtimeSessionId: "session",
            role: "assistant",
            text: "literal **needle** needle",
          },
        },
        {
          type: "realtime",
          position: 2,
          item: {
            type: "transcriptSegment",
            id: "second",
            realtimeSessionId: "session",
            role: "user",
            text: "second needle",
          },
        },
        {
          type: "realtime",
          position: 3,
          item: {
            type: "realtimeSessionClosed",
            id: "end",
            realtimeSessionId: "session",
            outcome: "ended",
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    let entries = project().entries;
    const read = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => entries,
      readOwner: () => owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const voice = entries.find(isCodexRealtimeTimelineEntry)!;
    const first = read.getUnitsForProjectedEntry(voice);
    expect(first[0]).toMatchObject({
      key: realtimeSearchUnitKey(voice),
      text: "literal **needle** needle",
      turnId: null,
    });
    expect(first[1]).toMatchObject({
      key: realtimeSearchUnitKey(voice, "second"),
      itemId: "second",
      turnKey: voice.turnKey,
      text: "second needle",
    });
    expect(read.findMatches("needle").map((unit) => [unit.turnKey, unit.itemId])).toEqual([
      [voice.turnKey, "voice"],
      [voice.turnKey, "second"],
    ]);
    expect(read.getUnitsForProjectedEntry(voice)).toBe(first);
    owner.applyEvent({
      type: "changes",
      changes: [{ type: "realtime-text", itemId: "voice", delta: " latest" }],
    });
    expect(read.findMatches("latest")[0]?.text).toBe("literal **needle** needle latest");
    expect(owner.readStructure()?.turns).toHaveLength(0);
    entries = [];
    read.pruneCachedData();
    expect(read.findMatches("needle")).toEqual([]);
    read.clearCachedData();
  });

  test("indexes inline Markdown presentation text but not HTML visualization declarations", () => {
    const item = {
      type: "agentMessage",
      id: "inline",
      text: "[FINAL]\n::codex-realtime-inline{}\n**Needle** [visible](https://hidden.example)",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
    } as const;
    const { owner, project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 1, turnId: "one", item },
          {
            type: "realtime",
            position: 2,
            item: {
              type: "bemItemPromoted",
              id: "promotion",
              realtimeSessionId: "session",
              turnId: "one",
              itemId: "inline",
              presentation: { type: "inlineMarkdown" },
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [item],
    );
    const entries = project().entries;
    const read = createLocalConversationSearchSource({
      routeContextId: "thread",
      getTurns: () => [],
      getProjectedEntries: () => entries,
      readOwner: () => owner,
      scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
    });
    const promotion = entries.find(
      (entry) =>
        isCodexTimelineTurnEntry(entry) && entry.timelinePresentation?.type === "inlineMarkdown",
    );
    if (!promotion || !isCodexTimelineTurnEntry(promotion))
      throw new Error("Missing native inline promotion");
    expect(read.findMatches("needle")).toMatchObject([
      {
        key: inlineMarkdownSearchUnitKey(promotion),
        turnKey: promotion.turnKey,
        text: "Needle visible",
      },
    ]);
    expect(read.findMatches("hidden.example")).toEqual([]);
    expect(read.findMatches("codex-realtime-inline")).toEqual([]);
    expect(
      read.getUnitsForProjectedEntry({
        ...promotion,
        timelinePresentation: { type: "inlineVisualization", index: 0 },
      }),
    ).toEqual([]);
  });

  test("counts all occurrences independently of its retained match budget", () => {
    const result = projectLocalConversationResidentSearchResult({
      query: "needle",
      contextId: "thread",
      limit: 2,
      units: [
        {
          key: "voice:one",
          turnKey: "voice",
          turnId: null,
          text: "needle needle needle",
          blockType: "assistantMessage",
        },
        {
          key: "voice:two",
          turnKey: "voice2",
          turnId: null,
          text: "needle",
          blockType: "userMessage",
        },
      ],
    });
    expect(result).toMatchObject({ totalMatches: 4, capped: true });
    expect(result.matches).toHaveLength(2);
    expect(result.matches.map((match) => match.meta)).toEqual([
      { turnKey: "voice", unitKey: "voice:one", occurrenceIndex: 0 },
      { turnKey: "voice", unitKey: "voice:one", occurrenceIndex: 1 },
    ]);
  });
});

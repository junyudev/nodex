import { describe, expect, test } from "vite-plus/test";
import type {
  ThreadItem,
  ThreadRealtimeBemItemPresentation,
  ThreadTimelineListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import {
  isCodexRealtimeTimelineEntry,
  isCodexTimelineTurnEntry,
  projectNormalizedTimelineEntries,
  markLatestCodexTimelineTurnEntry,
  readLatestCodexTimelineTurnEntry,
} from "./normalized-timeline-entries";

import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";

const agent = (id: string, text: string): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});

const voiceSegment = (
  id: string,
  position: number,
  role: "assistant" | "user" = "assistant",
): Extract<ThreadTimelineListResponse["data"][number], { type: "realtime" }> => ({
  type: "realtime",
  position,
  item: {
    type: "transcriptSegment",
    id,
    realtimeSessionId: "session",
    role,
    text: `${id} spoken text`,
  },
});

describe("normalized mixed timeline presentation", () => {
  test("groups consecutive native voice identities while text deltas leave the row structure untouched", () => {
    const { owner, project } = timelineOwnerFixture({
      data: [voiceSegment("first", 1, "user"), voiceSegment("second", 2)],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const structure = owner.readStructure();
    const rows = project();
    expect(rows.entries).toHaveLength(1);
    expect(rows.entries[0]).toMatchObject({
      turnKey: "realtime-voice:transcript:first",
      itemId: "first",
      segmentIds: ["first", "second"],
      estimatedHeightPx: 272,
      turnId: null,
    });
    const second = owner.readRealtimeItem("second");
    let structureNotifications = 0;
    let secondNotifications = 0;
    const stopStructure = owner.subscribeStructure(() => {
      structureNotifications += 1;
    });
    const stopSecond = owner.subscribeRealtimeItem("second", () => {
      secondNotifications += 1;
    });
    owner.applyEvent({
      type: "changes",
      changes: [{ type: "realtime-text", itemId: "first", delta: " more" }],
    });
    expect(owner.readStructure()).toBe(structure);
    expect(owner.readRealtimeItem("second")).toBe(second);
    expect(structureNotifications).toBe(0);
    expect(secondNotifications).toBe(0);
    expect(project().entries[0]).toEqual(rows.entries[0]);
    stopStructure();
    stopSecond();
  });

  test.each([
    {
      type: "realtime",
      position: 2,
      item: { type: "realtimeSessionStarted", id: "start", realtimeSessionId: "next" },
    },
    {
      type: "realtime",
      position: 2,
      item: {
        type: "realtimeSessionClosed",
        id: "end",
        realtimeSessionId: "session",
        outcome: "ended",
      },
    },
    {
      type: "realtime",
      position: 2,
      item: {
        type: "bemItemPromoted",
        id: "pending",
        realtimeSessionId: "session",
        turnId: "one",
        itemId: "pending-native",
        presentation: { type: "inlineMarkdown" },
      },
    },
    { type: "item", position: 2, turnId: "one", item: agent("ordinary", "Ordinary answer") },
  ] satisfies ThreadTimelineListResponse["data"])(
    "flushes a voice row at native boundary $type",
    (boundary) => {
      const { project } = timelineOwnerFixture(
        {
          data: [voiceSegment("before", 1), boundary, voiceSegment("after", 3)],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: "session",
        },
        [agent("ordinary", "Ordinary answer")],
      );
      const groups = project()
        .entries.filter(isCodexRealtimeTimelineEntry)
        .filter((entry) => entry.itemType === "transcriptSegment");
      expect(groups.map((entry) => entry.segmentIds)).toEqual([["before"], ["after"]]);
    },
  );

  test("keeps an uninterrupted voice group across receipts that emit no presentation", () => {
    const { project } = timelineOwnerFixture({
      data: [
        voiceSegment("first", 1),
        {
          type: "realtime",
          position: 2,
          item: {
            type: "realtimeSessionClosed",
            id: "wrong-session",
            realtimeSessionId: "other",
            outcome: "ended",
          },
        },
        { type: "turnStarted", position: 3, turnId: "unloaded", startedAt: 1 },
        {
          type: "turnCompleted",
          position: 4,
          turnId: "unloaded",
          status: "completed",
          error: null,
          startedAt: 1,
          completedAt: 2,
          durationMs: 1000,
        },
        voiceSegment("second", 5),
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    expect(project().entries).toHaveLength(1);
    expect(project().entries[0]).toMatchObject({ segmentIds: ["first", "second"] });
  });

  test("retains a realtime-only transcript without inventing a canonical Turn", () => {
    const { owner, project } = timelineOwnerFixture({
      data: [
        {
          type: "realtime",
          position: 5,
          item: {
            type: "transcriptSegment",
            id: "voice",
            realtimeSessionId: "session",
            role: "assistant",
            text: "Voice answer",
          },
        },
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: "session",
    });
    const result = project();
    expect(result.entries).toEqual([
      {
        type: "realtime",
        itemId: "voice",
        itemType: "transcriptSegment",
        segmentIds: ["voice"],
        estimatedHeightPx: 144,
        turnKey: "realtime-voice:transcript:voice",
        turnSearchKey: "realtime-voice:transcript:voice",
        turnId: null,
      },
    ]);
    expect(owner.readStructure()?.turns).toHaveLength(0);
    expect(result.historyRows?.map((row) => row.kind)).toEqual(["content"]);
  });

  test.each(["wholeItem", "inlineMarkdown", "inlineVisualization"] as const)(
    "moves %s promotions to their native timeline position once",
    (presentationType) => {
      const before = agent("before", "Before voice");
      const promoted = { type: "plan", id: "promoted", text: "Artifact" } as const;
      const after = agent("after", "After voice");
      const { project } = timelineOwnerFixture(
        {
          data: [
            { type: "turnStarted", position: 0, turnId: "one", startedAt: 1 },
            { type: "item", position: 1, turnId: "one", item: before },
            { type: "item", position: 2, turnId: "one", item: promoted },
            {
              type: "realtime",
              position: 3,
              item: { type: "realtimeSessionStarted", id: "start", realtimeSessionId: "session" },
            },
            {
              type: "realtime",
              position: 4,
              item: {
                type: "transcriptSegment",
                id: "voice",
                realtimeSessionId: "session",
                role: "user",
                text: "Voice prompt",
              },
            },
            {
              type: "realtime",
              position: 5,
              item: {
                type: "bemItemPromoted",
                id: "promotion",
                realtimeSessionId: "session",
                turnId: "one",
                itemId: "promoted",
                presentation:
                  presentationType === "inlineVisualization"
                    ? { type: presentationType, index: 0 }
                    : { type: presentationType },
              },
            },
            { type: "item", position: 6, turnId: "one", item: after },
            {
              type: "realtime",
              position: 7,
              item: {
                type: "realtimeSessionClosed",
                id: "closed",
                realtimeSessionId: "session",
                outcome: "ended",
              },
            },
            {
              type: "turnCompleted",
              position: 8,
              turnId: "one",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1000,
            },
          ],
          nextCursor: null,
          activeRealtimeSessionAtPageStart: null,
        },
        [before, promoted, after],
      );
      const result = project();
      const identities = result.entries.flatMap((entry) =>
        isCodexRealtimeTimelineEntry(entry)
          ? [entry.itemId]
          : isCodexTimelineTurnEntry(entry)
            ? entry.timelineSlice.itemIds
            : [],
      );
      expect(identities).toEqual(["before", "voice", "promoted", "after", "closed"]);
      expect(new Set(result.entries.map((entry) => entry.turnKey)).size).toBe(
        result.entries.length,
      );
      expect(
        result.entries.filter(
          (entry) => isCodexTimelineTurnEntry(entry) && entry.timelineSlice.includeTurnExtras,
        ),
      ).toHaveLength(1);
    },
  );

  test("marks the final native work fragment latest before a trailing realtime close", () => {
    const answer = agent("answer", "Answer");
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 1, turnId: "one", item: answer },
          {
            type: "realtime",
            position: 2,
            item: {
              type: "realtimeSessionClosed",
              id: "closed",
              realtimeSessionId: "session",
              outcome: "ended",
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [answer],
    );
    const entries = project().entries;
    expect(
      entries
        .filter((entry) => !isCodexRealtimeTimelineEntry(entry) && entry.isMostRecentTurn)
        .map((entry) => entry.turnKey),
    ).toEqual([entries[0]?.turnKey]);
    expect(entries.at(-1)).toMatchObject({ type: "realtime", itemId: "closed" });
  });

  test("keeps an ordinary live suffix latest outside the timeline and excludes inline presentations", () => {
    const answer = agent("answer", "Answer");
    const { owner, project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 1, turnId: "one", item: answer },
          {
            type: "realtime",
            position: 2,
            item: {
              type: "realtimeSessionClosed",
              id: "closed",
              realtimeSessionId: "session",
              outcome: "ended",
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [answer],
    );
    const structure = owner.readStructure()!;
    const base = selectNormalizedConversationTurnEntries({ owner, structure, conversation: null });
    const suffix = {
      turn: { ...owner.readTurn("turn:one")!, turnId: "live", status: "inProgress" as const },
      turnId: "live",
      turnKey: "live",
      turnSearchKey: "live",
      requests: [],
      isMostRecentTurn: false,
    };
    const mixed = projectNormalizedTimelineEntries({
      owner,
      structure,
      entries: [...base, suffix],
    }).entries;
    expect(readLatestCodexTimelineTurnEntry(mixed)).toBe(mixed.at(-1));
    expect(mixed.at(-1)).toMatchObject({ turnKey: "live", isMostRecentTurn: true });
    expect(mixed.find((entry) => entry.turnKey === base[0]!.turnKey)).toMatchObject({
      isMostRecentTurn: false,
    });
    const native = project().entries.find(isCodexTimelineTurnEntry)!;
    const inline = {
      ...native,
      turnKey: "inline",
      timelinePresentation: { type: "inlineMarkdown" as const },
      isMostRecentTurn: false,
    };
    const remapped = markLatestCodexTimelineTurnEntry([native, inline]);
    expect(readLatestCodexTimelineTurnEntry(remapped)?.turnKey).toBe(native.turnKey);
    expect(remapped[1]).toBe(inline);
  });

  test("leaves ordinary Turn entries unchanged when the native timeline is absent", () => {
    const answer = agent("answer", "Answer");
    const { owner } = timelineOwnerFixture(
      {
        data: [{ type: "item", position: 1, turnId: "one", item: answer }],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [answer],
    );
    const entries = selectNormalizedConversationTurnEntries({
      owner,
      structure: owner.readStructure()!,
      conversation: null,
    });
    const result = projectNormalizedTimelineEntries({
      owner,
      structure: { ...owner.readStructure()!, itemTimeline: null },
      entries,
    });
    expect(result.entries).toBe(entries);
    expect(result.historyRows).toBe(owner.readStructure()?.timeline);
  });

  test.each<{
    name: string;
    presentations: readonly ThreadRealtimeBemItemPresentation[];
  }>([
    {
      name: "distinct visualization indexes",
      presentations: [
        { type: "inlineVisualization", index: 0 },
        { type: "inlineVisualization", index: 1 },
      ],
    },
    {
      name: "distinct receipts for the same visualization index",
      presentations: [
        { type: "inlineVisualization", index: 0 },
        { type: "inlineVisualization", index: 0 },
      ],
    },
    {
      name: "distinct Markdown receipts",
      presentations: [{ type: "inlineMarkdown" }, { type: "inlineMarkdown" }],
    },
    {
      name: "inline followed by whole-item receipt",
      presentations: [{ type: "inlineVisualization", index: 0 }, { type: "wholeItem" }],
    },
  ])("retains $name for one native item without its ordinary receipt", ({ presentations }) => {
    const artifact = agent(
      "artifact",
      '::codex-inline-vis{file="chart.html"}\n::codex-inline-vis{file="table.html"}',
    );
    const { owner, project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: artifact },
          ...presentations.map((presentation, index) => ({
            type: "realtime" as const,
            position: index + 1,
            item: {
              type: "bemItemPromoted" as const,
              id: `promotion-${index}`,
              realtimeSessionId: "session",
              turnId: "one",
              itemId: artifact.id,
              presentation,
            },
          })),
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [artifact],
    );
    const slots = owner.readItemSlots("turn:one");
    const slices = project().entries.filter(isCodexTimelineTurnEntry);
    expect(slices.map((entry) => entry.timelinePresentation)).toEqual(presentations);
    expect(slices.map((entry) => entry.timelineSlice.itemIds)).toEqual([
      [artifact.id],
      [artifact.id],
    ]);
    expect(new Set(slices.map((entry) => entry.turnKey)).size).toBe(2);
    expect(owner.readItemSlots("turn:one")).toBe(slots);
    expect(slots?.entries.map((entry) => entry.itemId)).toEqual([artifact.id]);
  });

  test("repeated whole-item receipts keep one canonical item in their shared work segment", () => {
    const artifact = agent("artifact", "Repeated artifact");
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: artifact },
          ...["first", "second"].map((id, index) => ({
            type: "realtime" as const,
            position: index + 1,
            item: {
              type: "bemItemPromoted" as const,
              id,
              realtimeSessionId: "session",
              turnId: "one",
              itemId: artifact.id,
              presentation: { type: "wholeItem" as const },
            },
          })),
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [artifact],
    );
    const slices = project().entries.filter(isCodexTimelineTurnEntry);
    expect(slices).toHaveLength(1);
    expect(slices[0]?.timelineSlice.itemIds).toEqual([artifact.id]);
    expect(slices[0]?.readTurn()?.itemIds).toEqual([artifact.id]);
    expect(slices[0]?.readTurn()?.items.map((item) => item.rawItemId)).toEqual([artifact.id]);
  });

  test("a pending promotion preserves the surrounding active work segment", () => {
    const before = agent("before", "Before");
    const after = agent("after", "After");
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 0, turnId: "one", item: before },
          {
            type: "realtime",
            position: 1,
            item: {
              type: "bemItemPromoted",
              id: "pending",
              realtimeSessionId: "session",
              turnId: "one",
              itemId: "missing",
              presentation: { type: "wholeItem" },
            },
          },
          { type: "item", position: 2, turnId: "one", item: after },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [before, after],
    );
    const result = project();
    expect(result.entries).toHaveLength(2);
    const slice = result.entries[0];
    expect(isCodexTimelineTurnEntry(slice!)).toBe(true);
    if (!slice || !isCodexTimelineTurnEntry(slice)) throw new Error("Missing work segment");
    expect(slice.timelineSlice.itemIds).toEqual(["before", "after"]);
    expect(slice.readTurn()?.status).toBe("inProgress");
    expect(result.entries[1]).toMatchObject({ type: "realtime", itemId: "pending" });
  });

  test("uses timeline-only input/work/user boundaries with separate native completion status", () => {
    const opening: Extract<ThreadItem, { type: "userMessage" }> = {
      type: "userMessage",
      id: "opening",
      clientId: "client",
      content: [{ type: "text", text: "Prompt", text_elements: [] }],
    };
    const first = agent("first", "First");
    const later = { ...opening, id: "later", clientId: "later-client" };
    const last = agent("last", "Last");
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "turnStarted", position: 0, turnId: "one", startedAt: 1 },
          { type: "item", position: 1, turnId: "one", item: opening },
          { type: "item", position: 2, turnId: "one", item: first },
          { type: "item", position: 3, turnId: "one", item: later },
          { type: "item", position: 4, turnId: "one", item: last },
          {
            type: "turnCompleted",
            position: 5,
            turnId: "one",
            status: "completed",
            error: null,
            startedAt: 1,
            completedAt: 2,
            durationMs: 1000,
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [opening, first, later, last],
    );
    const slices = project().entries.filter(isCodexTimelineTurnEntry);
    expect(slices.map((entry) => entry.timelineSlice.itemIds)).toEqual([
      ["opening"],
      ["first"],
      ["later"],
      ["last"],
    ]);
    expect(slices.map((entry) => entry.timelineSlice.includeInput)).toEqual([
      true,
      false,
      false,
      false,
    ]);
    expect(slices.map((entry) => entry.timelineUserActions)).toEqual([true, false, false, false]);
    expect(slices.map((entry) => entry.timelineSlice.includeTurnExtras)).toEqual([
      false,
      false,
      false,
      true,
    ]);
    expect(slices.map((entry) => entry.readTurn()?.status)).toEqual([
      "completed",
      "completed",
      "completed",
      "completed",
    ]);
    expect(
      slices[2]
        ?.readTurn()
        ?.items.filter((item) => item.role === "user")
        .map((item) => item.rawItemId),
    ).toEqual(["later"]);
  });

  test("places canonical history outside the native item page before that page within the same island", () => {
    const answer = agent("answer", "Answer");
    const { owner } = timelineOwnerFixture(
      {
        data: [{ type: "item", position: 2, turnId: "one", item: answer }],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: null,
      },
      [answer],
    );
    const structure = owner.readStructure()!;
    const base = selectNormalizedConversationTurnEntries({
      owner,
      structure,
      conversation: null,
    })[0]!;
    const older = {
      ...base,
      isMostRecentTurn: false,
      turnKey: "older",
      turnSearchKey: "older",
      turnId: "older",
      historyEntityKey: "turn:older",
    };
    const result = projectNormalizedTimelineEntries({
      owner,
      entries: [older, base],
      structure: {
        ...structure,
        timeline: [
          { kind: "content", key: "old", turnKey: "older", entityKey: "turn:older" },
          { kind: "content", key: "new", turnKey: base.turnKey, entityKey: base.historyEntityKey },
        ],
      },
    });
    expect(result.entries[0]).toBe(older);
    expect(result.entries[1]).toMatchObject({ timelineSlice: { itemIds: ["answer"] } });
  });

  test("keeps one opening prompt and preserves a later identical native user message", () => {
    const opening: Extract<ThreadItem, { type: "userMessage" }> = {
      type: "userMessage",
      id: "opening",
      clientId: "client",
      content: [{ type: "text", text: "Same prompt", text_elements: [] }],
    };
    const later = { ...opening, id: "later" };
    const before = agent("before", "Before");
    const { project } = timelineOwnerFixture(
      {
        data: [
          { type: "turnStarted", position: 0, turnId: "one", startedAt: 1 },
          { type: "item", position: 1, turnId: "one", item: opening },
          { type: "item", position: 2, turnId: "one", item: before },
          {
            type: "realtime",
            position: 3,
            item: {
              type: "transcriptSegment",
              id: "voice",
              realtimeSessionId: "session",
              role: "assistant",
              text: "Voice",
            },
          },
          { type: "item", position: 4, turnId: "one", item: later },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [opening, before, later],
    );
    const nativeUsers = project().entries.flatMap((entry) =>
      isCodexTimelineTurnEntry(entry)
        ? (entry
            .readTurn()
            ?.items.filter((item) => item.role === "user")
            .map((item) => item.rawItemId) ?? [])
        : [],
    );
    expect(nativeUsers).toEqual(["opening", "later"]);
  });

  test("keeps an earlier search island and its recovery gap before mixed timeline rows", () => {
    const answer = agent("answer", "Answer");
    const { owner } = timelineOwnerFixture(
      {
        data: [
          { type: "item", position: 2, turnId: "one", item: answer },
          {
            type: "realtime",
            position: 3,
            item: {
              type: "transcriptSegment",
              id: "voice",
              realtimeSessionId: "session",
              role: "assistant",
              text: "Voice",
            },
          },
        ],
        nextCursor: null,
        activeRealtimeSessionAtPageStart: "session",
      },
      [answer],
    );
    const structure = owner.readStructure()!;
    const base = selectNormalizedConversationTurnEntries({
      owner,
      structure,
      conversation: null,
    })[0]!;
    const older = {
      ...base,
      isMostRecentTurn: false,
      turnKey: "older",
      turnSearchKey: "older",
      turnId: "older",
      historyEntityKey: "turn:older",
    };
    const gap = {
      kind: "gap",
      key: "between",
      olderBoundary: {
        generation: 1,
        islandId: "left",
        edge: "newer",
        boundaryId: "boundary",
        progressKey: "cursor",
        handle: { cursor: "cursor", oldestLoadedTurnId: null },
      },
      newerBoundary: null,
      estimatedHeightPx: 144,
    } as const;
    const result = projectNormalizedTimelineEntries({
      owner,
      entries: [older, base],
      structure: {
        ...structure,
        timeline: [
          { kind: "content", key: "old", turnKey: "older", entityKey: "turn:older" },
          gap,
          { kind: "content", key: "new", turnKey: base.turnKey, entityKey: base.historyEntityKey },
        ],
      },
    });
    expect(result.entries[0]).toBe(older);
    expect(result.historyRows?.[1]).toBe(gap);
    expect(result.historyRows?.at(-1)).toMatchObject({
      turnKey: "realtime-voice:transcript:voice",
    });
    const split = projectNormalizedTimelineEntries({
      owner,
      entries: [older, base],
      structure: {
        ...structure,
        timeline: [
          { kind: "content", key: "old", turnKey: "older", entityKey: "turn:older" },
          gap,
          { kind: "content", key: "new", turnKey: base.turnKey, entityKey: base.historyEntityKey },
        ],
        itemTimeline: {
          activeRealtimeSessionAtPageStart: "session",
          entries: [
            { type: "turnStarted", position: 0, turnId: "older", startedAt: 1 },
            voiceSegment("left", 1),
            { type: "turnStarted", position: 2, turnId: "one", startedAt: 2 },
            voiceSegment("right", 3),
          ],
        },
      },
    });
    const voiceGroups = split.entries
      .filter(isCodexRealtimeTimelineEntry)
      .filter((entry) => entry.itemType === "transcriptSegment");
    expect(voiceGroups.map((entry) => entry.segmentIds)).toEqual([["left"], ["right"]]);
    expect(split.historyRows?.[1]).toBe(gap);
  });
});

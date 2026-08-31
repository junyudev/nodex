import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  CodexHistoryResidencyPinsInput,
  CodexHistoryResidencyPinsResult,
} from "../../../../shared/codex-history-residency-pins";
import {
  createLocalConversationHistoryResidencyPinPublisher,
  resolveVisibleHistoryTurnIds,
} from "./local-conversation-history-residency-pins";

describe("local conversation history residency pins", () => {
  const applied = {
    status: "applied",
    evictedTurnIds: [],
    limitsSatisfied: true,
  } as const satisfies CodexHistoryResidencyPinsResult;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("selects only viewport-intersecting content and preserves chronology", () => {
    expect(
      resolveVisibleHistoryTurnIds({
        rows: [
          { turnId: "turn-before", startPx: 0, endPx: 100 },
          { turnId: null, startPx: 100, endPx: 244 },
          { turnId: "turn-visible-1", startPx: 244, endPx: 400 },
          { turnId: "turn-visible-2", startPx: 400, endPx: 560 },
          { turnId: "turn-after", startPx: 560, endPx: 700 },
        ],
        viewportStartPx: 300,
        viewportEndPx: 500,
      }),
    ).toEqual(["turn-visible-1", "turn-visible-2"]);
  });

  test("debounces and deduplicates scroll-frequency observations", async () => {
    const published: CodexHistoryResidencyPinsInput[] = [];
    const publisher = createLocalConversationHistoryResidencyPinPublisher({
      publish: async (pins) => {
        published.push(pins);
        return applied;
      },
    });

    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-1"],
    });
    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-1", "turn-2"],
    });
    await vi.advanceTimersByTimeAsync(120);
    await publisher.settle();
    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-1", "turn-2"],
    });
    await vi.advanceTimersByTimeAsync(120);
    await publisher.settle();

    expect(published).toEqual([
      {
        threadId: "thread-1",
        expectedConversationGeneration: 5,
        expectedTopologyGeneration: 3,
        expectedHistoryMutationRevision: 7,
        turnIds: ["turn-1", "turn-2"],
        islandIds: [],
      },
    ]);
  });

  test("cancels an obsolete pending viewport when the delivered viewport becomes current again", async () => {
    const published: CodexHistoryResidencyPinsInput[] = [];
    const publisher = createLocalConversationHistoryResidencyPinPublisher({
      publish: async (pins) => {
        published.push(pins);
        return applied;
      },
    });
    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-1"],
    });
    await vi.advanceTimersByTimeAsync(120);
    await publisher.settle();

    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-2"],
    });
    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-1"],
    });
    await vi.advanceTimersByTimeAsync(120);
    await publisher.settle();

    expect(published).toHaveLength(1);
    expect(published[0]?.turnIds).toEqual(["turn-1"]);
  });

  test("orders old-target cleanup and drops a new target disposed before publication", async () => {
    const published: CodexHistoryResidencyPinsInput[] = [];
    const publish = async (
      pins: CodexHistoryResidencyPinsInput,
    ): Promise<CodexHistoryResidencyPinsResult> => {
      published.push(pins);
      return applied;
    };
    const publisher = createLocalConversationHistoryResidencyPinPublisher({
      publish,
      debounceMs: 0,
    });

    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-old"],
    });
    publisher.flush();
    publisher.observe({
      threadId: "thread-2",
      conversationGeneration: 6,
      generation: 4,
      historyMutationRevision: 9,
      turnIds: ["turn-new"],
    });
    publisher.flush();
    publisher.dispose();
    await publisher.settle();

    expect(published).toEqual([
      {
        threadId: "thread-1",
        expectedConversationGeneration: 5,
        expectedTopologyGeneration: 3,
        expectedHistoryMutationRevision: 7,
        turnIds: ["turn-old"],
        islandIds: [],
      },
      {
        threadId: "thread-1",
        expectedConversationGeneration: 5,
        expectedTopologyGeneration: 3,
        expectedHistoryMutationRevision: 7,
        turnIds: [],
        islandIds: [],
      },
    ]);
  });

  test("keeps only the latest viewport while one IPC publication is blocked", async () => {
    const published: CodexHistoryResidencyPinsInput[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let callCount = 0;
    const publisher = createLocalConversationHistoryResidencyPinPublisher({
      debounceMs: 0,
      publish: async (pins) => {
        published.push(pins);
        callCount += 1;
        if (callCount === 1) await first;
        return applied;
      },
    });

    publisher.observe({
      threadId: "thread-1",
      conversationGeneration: 5,
      generation: 3,
      historyMutationRevision: 7,
      turnIds: ["turn-0"],
    });
    publisher.flush();
    for (let index = 1; index <= 100; index += 1) {
      publisher.observe({
        threadId: "thread-1",
        conversationGeneration: 5,
        generation: 3,
        historyMutationRevision: 7,
        turnIds: [`turn-${index}`],
      });
      publisher.flush();
    }

    expect(published).toHaveLength(1);
    releaseFirst();
    await publisher.settle();
    expect(published).toHaveLength(2);
    expect(published[1]?.turnIds).toEqual(["turn-100"]);
  });
});

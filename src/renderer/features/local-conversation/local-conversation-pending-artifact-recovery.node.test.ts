import { describe, expect, test, vi } from "vite-plus/test";
import { produce } from "immer";
import {
  createPendingArtifactRecovery,
  readPendingArtifactRecovery,
  type PendingArtifactRecoveryRead,
} from "./local-conversation-pending-artifact-recovery";
import { replaceCanonicalHistoryDraft } from "../../../shared/codex-conversation-state/codex-canonical-history-loader";
import {
  availableCodexHistoryBoundary,
  createCodexHistoryBoundaryRef,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import { CodexHistoryCursorStalled } from "../../../shared/codex-conversation-state/codex-history-cursor-stalled";
import { nativeImageTimelineFixture } from "./projection/normalized-timeline-image.test-fixtures";

function boundary(cursor: string) {
  const value = availableCodexHistoryBoundary("tail:older", {
    source: "timeline",
    cursor,
    oldestLoadedTurnId: "one",
  });
  if (value.status !== "available") throw new Error("Invalid test boundary");
  return value;
}

function snapshot(ids = ["receipt"], cursor: string | null = "older"): PendingArtifactRecoveryRead {
  return {
    missingReceiptIds: ids,
    olderPage:
      cursor === null
        ? null
        : {
            threadId: "thread",
            expectedConversationGeneration: 7,
            expectedHistoryMutationRevision: 3,
            target: {
              kind: "turnBoundary",
              boundary: createCodexHistoryBoundaryRef(2, "tail", "older", boundary(cursor)),
            },
          },
  };
}

function setup(initial = snapshot()) {
  let current: PendingArtifactRecoveryRead | null = initial;
  const loadOlder = vi.fn(async () => ({ status: "applied" as const }));
  const supportsTimeline = vi.fn(() => true);
  const owner = createPendingArtifactRecovery({ read: () => current, loadOlder, supportsTimeline });
  return {
    owner,
    loadOlder,
    supportsTimeline,
    set: (value: PendingArtifactRecoveryRead | null) => {
      current = value;
    },
  };
}

describe("pending artifact recovery", () => {
  test("uses one flight, consumes at most two pages, and requires explicit retry for seen receipts", async () => {
    const f = setup();
    f.loadOlder.mockImplementation(async () => {
      f.set(snapshot(["receipt"], `older-${f.loadOlder.mock.calls.length}`));
      return { status: "applied" };
    });
    const first = f.owner.hydrate();
    expect(f.owner.hydrate("retry")).toBe(first);
    await first;
    expect(f.loadOlder).toHaveBeenCalledTimes(2);
    expect(f.owner.getStatus()).toBe("unresolved");
    await f.owner.hydrate();
    expect(f.loadOlder).toHaveBeenCalledTimes(2);
    await f.owner.hydrate("retry");
    expect(f.loadOlder).toHaveBeenCalledTimes(4);
  });

  test("stops once the original receipt resolves and marks newly discovered receipts seen", async () => {
    const f = setup();
    f.loadOlder.mockImplementation(async () => {
      f.set(snapshot(["new-receipt"], "next"));
      return { status: "applied" };
    });
    await f.owner.hydrate();
    expect(f.loadOlder).toHaveBeenCalledTimes(1);
    await f.owner.hydrate();
    expect(f.loadOlder).toHaveBeenCalledTimes(1);
    f.set(snapshot([], null));
    await f.owner.hydrate();
    expect(f.owner.getStatus()).toBe("idle");
  });

  test("coalesces automatic signals and replays a receipt arriving after the final read", async () => {
    let readCount = 0;
    let owner: ReturnType<typeof createPendingArtifactRecovery>;
    const loadOlder = vi.fn(async () => ({ status: "applied" as const }));
    owner = createPendingArtifactRecovery({
      supportsTimeline: () => true,
      loadOlder,
      read: () => {
        readCount++;
        if (readCount === 2) {
          queueMicrotask(() => {
            void owner.hydrate();
          });
          return snapshot([], "next");
        }
        return readCount === 1 ? snapshot() : snapshot(["later"], null);
      },
    });
    await owner.hydrate();
    await vi.waitFor(() => expect(owner.getStatus()).toBe("exhausted"));
    expect(readCount).toBe(3);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  test.each(["unchanged", "stalled", "stale"])(
    "stops a %s page without misclassifying it as an IO failure",
    async (kind) => {
      const f = setup();
      if (kind === "stalled") f.loadOlder.mockRejectedValue(new CodexHistoryCursorStalled());
      if (kind === "stale") {
        const loadOlder = vi.fn(async () => ({ status: "stale" as const }));
        const owner = createPendingArtifactRecovery({
          read: () => snapshot(),
          supportsTimeline: () => true,
          loadOlder,
        });
        await owner.hydrate();
        expect(owner.getStatus()).toBe("unresolved");
        expect(loadOlder).toHaveBeenCalledTimes(1);
        return;
      }
      await f.owner.hydrate();
      expect(f.owner.getStatus()).toBe("unresolved");
      expect(f.loadOlder).toHaveBeenCalledTimes(1);
    },
  );

  test("publishes IO failure and allows explicit retry to exhaust the history", async () => {
    const f = setup();
    f.loadOlder.mockRejectedValueOnce(new Error("offline"));
    await f.owner.hydrate();
    expect(f.owner.getStatus()).toBe("failed");
    await f.owner.hydrate();
    expect(f.loadOlder).toHaveBeenCalledTimes(1);
    f.loadOlder.mockImplementation(async () => {
      f.set(snapshot(["receipt"], null));
      return { status: "applied" };
    });
    await f.owner.hydrate("retry");
    expect(f.owner.getStatus()).toBe("exhausted");
    expect(f.loadOlder).toHaveBeenCalledTimes(2);
  });

  test("does not issue a request without an admitted cursor or current capability", async () => {
    const exhausted = setup(snapshot(["receipt"], null));
    await exhausted.owner.hydrate();
    expect(exhausted.owner.getStatus()).toBe("exhausted");
    expect(exhausted.loadOlder).not.toHaveBeenCalled();
    const disabled = setup();
    disabled.supportsTimeline.mockReturnValue(false);
    await disabled.owner.hydrate();
    expect(disabled.owner.getStatus()).toBe("unresolved");
    expect(disabled.loadOlder).not.toHaveBeenCalled();
  });

  test("disposal fences a late response, queued replay, and subsequent subscriptions", async () => {
    const f = setup();
    let finish: (() => void) | undefined;
    f.loadOlder.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ status: "applied" });
        }),
    );
    const observe = vi.fn();
    f.owner.subscribe(observe);
    const flight = f.owner.hydrate();
    await vi.waitFor(() => expect(f.loadOlder).toHaveBeenCalledTimes(1));
    void f.owner.hydrate();
    f.owner.dispose();
    f.set(snapshot([], null));
    finish?.();
    await flight;
    expect(observe).toHaveBeenCalledTimes(1);
    expect(f.owner.getStatus()).toBe("loading");
    expect(f.loadOlder).toHaveBeenCalledTimes(1);
    await f.owner.hydrate("retry");
    expect(f.loadOlder).toHaveBeenCalledTimes(1);
  });

  test("an absent conversation does not publish or fetch", async () => {
    const f = setup();
    f.set(null);
    await f.owner.hydrate();
    expect(f.owner.getStatus()).toBe("idle");
    expect(f.loadOlder).not.toHaveBeenCalled();
  });
});

describe("pending artifact resident projection", () => {
  test("raw pending images are present; only a missing native Turn/item pair needs history", () => {
    const fixture = nativeImageTimelineFixture();
    expect(
      readPendingArtifactRecovery({ canonicalState: fixture.state })?.missingReceiptIds,
    ).toEqual([]);
    const foreignTurn = produce(fixture.state, (draft) => {
      for (const entry of draft.itemTimeline.entries)
        if (entry.type === "realtime" && entry.item.type === "bemItemPromoted")
          entry.item.turnId = "foreign";
    });
    expect(readPendingArtifactRecovery({ canonicalState: foreignTurn })?.missingReceiptIds).toEqual(
      ["first", "second"],
    );
  });

  test("addresses only the first admitted timeline boundary with current generations", () => {
    const fixture = nativeImageTimelineFixture();
    const canonicalState = produce(fixture.state, (draft) => {
      replaceCanonicalHistoryDraft(draft, [], false, {
        source: "timeline",
        cursor: "older",
        oldestLoadedTurnId: "one",
      });
    });
    const read = readPendingArtifactRecovery({
      canonicalState,
      conversationEntityGeneration: 8,
      historyMutationRevision: 11,
    });
    expect(read?.missingReceiptIds).toEqual(["first", "second"]);
    expect(read?.olderPage).toMatchObject({
      threadId: "thread",
      expectedConversationGeneration: 8,
      expectedHistoryMutationRevision: 11,
      target: {
        kind: "turnBoundary",
        boundary: { generation: 0, edge: "older", handle: { source: "timeline", cursor: "older" } },
      },
    });
    const ordinary = produce(canonicalState, (draft) => {
      const boundary = draft.turnHistory!.history.islands[0]!.olderBoundary;
      if (boundary.status === "available") boundary.handle.source = "ordinary";
    });
    expect(readPendingArtifactRecovery({ canonicalState: ordinary })?.olderPage).toBeNull();
    expect(readPendingArtifactRecovery(null)).toBeNull();
  });
});

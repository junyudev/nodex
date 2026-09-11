import { describe, expect, test } from "vite-plus/test";
import { LocalConversationStreamState } from "./local-conversation-stream-state";

function checkpoint(revision: number, ownerEpoch = 1) {
  return {
    protocolVersion: 1 as const,
    ownerEpoch,
    revision,
  };
}

function createManualTimers() {
  let nextTimerId = 1;
  const timers = new Map<number, () => void>();

  return {
    setTimeout: (callback: () => void) => {
      const timerId = nextTimerId;
      nextTimerId += 1;
      timers.set(timerId, callback);
      return timerId;
    },
    clearTimeout: (timer: unknown) => {
      timers.delete(timer as number);
    },
    fireNext: () => {
      const next = timers.entries().next();
      if (next.done) return false;

      const [timerId, callback] = next.value;
      timers.delete(timerId);
      callback();
      return true;
    },
    get size() {
      return timers.size;
    },
  };
}

async function readRejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("LocalConversationStreamState", () => {
  test("applies patches only for the active follower owner and drops mismatches from bundle 40608-40613", () => {
    const streamState = new LocalConversationStreamState();

    expect(
      streamState.evaluatePatch({
        conversationId: "thread-1",
        baseCheckpoint: checkpoint(0),
        checkpoint: checkpoint(1),
        sourceClientId: "owner-a",
      }).type,
    ).toBe("drop");

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(3),
      sourceClientId: "owner-a",
    });

    expect(
      streamState.evaluatePatch({
        conversationId: "thread-1",
        baseCheckpoint: checkpoint(3),
        checkpoint: checkpoint(4),
        sourceClientId: "owner-a",
      }).type,
    ).toBe("apply");
    expect(
      streamState.evaluatePatch({
        conversationId: "thread-1",
        baseCheckpoint: checkpoint(3),
        checkpoint: checkpoint(4),
        sourceClientId: "owner-b",
      }),
    ).toEqual({ type: "resync", reason: "owner-mismatch" });
    expect(
      streamState.evaluatePatch({
        conversationId: "thread-1",
        baseCheckpoint: checkpoint(2),
        checkpoint: checkpoint(3),
        sourceClientId: "owner-a",
      }),
    ).toEqual({ type: "resync", reason: "revision-gap" });
  });

  test("tracks streaming conversation ids without inventing an unowned stream role", () => {
    const streamState = new LocalConversationStreamState();

    streamState.setStreaming("thread-1", true);
    streamState.setStreaming("thread-2", true);
    streamState.setStreaming("thread-1", false);

    expect(streamState.getStreamingConversationIds().join(",")).toBe("thread-2");
    expect(streamState.getRole("thread-1")).toBe(null);
    expect(streamState.getRevision("thread-1")).toBe(null);
  });

  test("preserves follower intent while owner data is temporarily unavailable", () => {
    const streamState = new LocalConversationStreamState();

    streamState.setConversationFollowing("thread-1", true);
    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(4),
      sourceClientId: "owner-a",
    });

    streamState.markOwnerUnavailable("owner-a");

    expect(streamState.isConversationFollowing("thread-1")).toBe(true);
    expect(streamState.getRole("thread-1")).toBe(null);
    expect(streamState.getFollowedConversationIds()).toEqual(["thread-1"]);
  });

  test("keeps follow intent across a transport reset and clears the stale cursor", () => {
    const streamState = new LocalConversationStreamState();

    streamState.setConversationFollowing("thread-1", true);
    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(2),
      sourceClientId: "owner-a",
    });

    expect(streamState.handleTransportReset()).toEqual(["thread-1"]);
    expect(streamState.isConversationFollowing("thread-1")).toBe(true);
    expect(streamState.getRevision("thread-1")).toBe(null);
  });

  test("invalidates an owner role when its physical endpoint generation is lost", () => {
    const streamState = new LocalConversationStreamState();

    streamState.setConversationFollowing("thread-1", true);
    streamState.markOwner("thread-1", checkpoint(3));

    expect(streamState.handleTransportReset(["thread-1"])).toEqual(["thread-1"]);
    expect(streamState.isConversationFollowing("thread-1")).toBe(true);
    expect(streamState.getRole("thread-1")).toBe(null);
    expect(streamState.getRevision("thread-1")).toBe(null);
  });

  test("adopts the authoritative follower baseline returned by resume", () => {
    const streamState = new LocalConversationStreamState();

    streamState.markOwner("thread-1", checkpoint(7, 1));
    streamState.adoptFollowerBaseline({
      conversationId: "thread-1",
      checkpoint: checkpoint(11, 2),
      sourceClientId: "owner-b",
    });

    expect(streamState.getRole("thread-1")).toEqual({
      role: "follower",
      ownerClientId: "owner-b",
    });
    expect(streamState.getCheckpoint("thread-1")).toEqual(checkpoint(11, 2));
  });

  test("resolves revision waiters when matching owner reaches the target revision", async () => {
    const timers = createManualTimers();
    const streamState = new LocalConversationStreamState({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });
    let resolved = false;

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(1),
      sourceClientId: "owner-a",
    });
    const waiter = streamState
      .waitForRevision({
        conversationId: "thread-1",
        ownerClientId: "owner-a",
        revision: 2,
        timeoutMs: 50,
      })
      .then(() => {
        resolved = true;
      });

    streamState.acceptPatch({
      conversationId: "thread-1",
      checkpoint: checkpoint(2),
      sourceClientId: "owner-a",
    });

    await waiter;
    expect(resolved).toBe(true);
    expect(timers.size).toBe(0);
  });

  test("rejects revision waiters when the owner changes", async () => {
    const timers = createManualTimers();
    const streamState = new LocalConversationStreamState({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(1),
      sourceClientId: "owner-a",
    });
    const waiter = streamState.waitForRevision({
      conversationId: "thread-1",
      ownerClientId: "owner-a",
      revision: 3,
      timeoutMs: 50,
    });

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(2, 2),
      sourceClientId: "owner-b",
    });

    const message = await readRejectionMessage(waiter);
    expect(message.includes("Stream owner changed")).toBe(true);
    expect(timers.size).toBe(0);
  });

  test("rejects revision waiters when the owner becomes unavailable", async () => {
    const streamState = new LocalConversationStreamState();

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(1),
      sourceClientId: "owner-a",
    });
    const waiter = streamState.waitForRevision({
      conversationId: "thread-1",
      ownerClientId: "owner-a",
      revision: 3,
      timeoutMs: 50,
    });

    const affectedConversationIds = streamState.markOwnerUnavailable("owner-a");
    const message = await readRejectionMessage(waiter);

    expect(affectedConversationIds.join(",")).toBe("thread-1");
    expect(message.includes("unavailable")).toBe(true);
    expect(streamState.getRole("thread-1")).toBe(null);
  });

  test("rejects revision waiters on timeout", async () => {
    const timers = createManualTimers();
    const streamState = new LocalConversationStreamState({
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    });

    streamState.acceptSnapshot({
      conversationId: "thread-1",
      checkpoint: checkpoint(1),
      sourceClientId: "owner-a",
    });
    const waiter = streamState.waitForRevision({
      conversationId: "thread-1",
      ownerClientId: "owner-a",
      revision: 2,
      timeoutMs: 25,
    });

    expect(timers.fireNext()).toBe(true);

    const message = await readRejectionMessage(waiter);
    expect(message.includes("Timed out waiting")).toBe(true);
  });
});

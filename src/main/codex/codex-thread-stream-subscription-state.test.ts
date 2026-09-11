import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_THREAD_STREAM_FOLLOWER_RECONNECT_GRACE_MS,
  CodexThreadStreamSubscriptionState,
} from "./codex-thread-stream-subscription-state";

function checkpoint(revision = 0, ownerEpoch = 1) {
  return {
    protocolVersion: 1 as const,
    ownerEpoch,
    revision,
  };
}

function applyFollowerSnapshot(
  state: CodexThreadStreamSubscriptionState,
  conversationId = "thread-1",
  clientId = "follower",
  ownerClientId = "owner",
  value = checkpoint(),
): void {
  expect(state.markSnapshotSent(conversationId, clientId, value)).toBe(true);
  expect(
    state.acknowledgeSnapshotApplied({
      conversationId,
      clientId,
      ownerClientId,
      checkpoint: value,
      currentCheckpoint: value,
    }).accepted,
  ).toBe(true);
}

describe("CodexThreadStreamSubscriptionState", () => {
  test("tracks explicit followers and excludes the owner from targets", () => {
    const state = new CodexThreadStreamSubscriptionState();

    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    expect(state.setOwner("thread-1", "owner").actions).toEqual([
      {
        type: "request-following-status",
        conversationId: "thread-1",
        ownerClientId: "owner",
      },
    ]);
    state.setFollowing("thread-1", "owner", true);
    state.setFollowing("thread-1", "follower", true);
    applyFollowerSnapshot(state);

    expect(state.getFollowerClientIds("thread-1")).toEqual(["follower"]);
  });

  test("makes follow and unfollow idempotent and emits membership epochs", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.setOwner("thread-1", "owner");
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");

    const first = state.setFollowing("thread-1", "follower", true);
    const second = state.setFollowing("thread-1", "follower", true);
    expect(state.markSnapshotSent("thread-1", "follower", checkpoint())).toBe(true);
    const snapshotAck = state.acknowledgeSnapshotApplied({
      conversationId: "thread-1",
      clientId: "follower",
      ownerClientId: "owner",
      checkpoint: checkpoint(),
      currentCheckpoint: checkpoint(),
    });
    const third = state.setFollowing("thread-1", "follower", false);

    expect(first.changed).toBe(true);
    expect(first.shouldSendSnapshot).toBe(true);
    expect(first.actions[0]).toMatchObject({
      type: "followers-changed",
      followerClientIds: [],
      membershipEpoch: 1,
    });
    expect(snapshotAck.actions[0]).toMatchObject({
      type: "followers-changed",
      followerClientIds: ["follower"],
      membershipEpoch: 1,
    });
    expect(second.changed).toBe(false);
    expect(third.actions[0]).toMatchObject({
      type: "followers-changed",
      followerClientIds: [],
      membershipEpoch: 2,
    });
  });

  test("keeps the recovery lease during the follower reconnect grace period", () => {
    let now = 100;
    const state = new CodexThreadStreamSubscriptionState({
      now: () => now,
    });
    state.setOwner("thread-1", "owner");
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    state.setFollowing("thread-1", "follower", true);
    applyFollowerSnapshot(state);
    state.handleClientDisposed("follower");

    expect(state.hasFollowersOrPendingReconnect("thread-1")).toBe(true);
    now += CODEX_THREAD_STREAM_FOLLOWER_RECONNECT_GRACE_MS + 1;
    expect(state.hasFollowersOrPendingReconnect("thread-1")).toBe(false);
  });

  test("requests a status reannounce when an owner has no connected followers", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.setOwner("thread-1", "owner");
    state.handleClientConnected("owner");

    expect(state.handleClientConnected("new-client")).toEqual([
      {
        type: "request-following-status",
        conversationId: "thread-1",
        ownerClientId: "owner",
      },
    ]);
  });

  test("holds a newly attached follower behind a snapshot barrier", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    state.setOwner("thread-1", "owner");

    const following = state.setFollowing("thread-1", "follower", true);

    expect(following.shouldSendSnapshot).toBe(true);
    expect(state.getSnapshotClientIds("thread-1")).toEqual(["follower"]);
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);

    expect(state.markSnapshotSent("thread-1", "follower", checkpoint())).toBe(true);

    expect(state.getSnapshotClientIds("thread-1")).toEqual([]);
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);

    const ack = state.acknowledgeSnapshotApplied({
      conversationId: "thread-1",
      clientId: "follower",
      ownerClientId: "owner",
      checkpoint: checkpoint(),
      currentCheckpoint: checkpoint(),
    });

    expect(ack.accepted).toBe(true);
    expect(state.getSnapshotClientIds("thread-1")).toEqual([]);
    expect(state.getFollowerClientIds("thread-1")).toEqual(["follower"]);
  });

  test("requeues every follower snapshot when the owner is replaced", () => {
    const state = new CodexThreadStreamSubscriptionState();
    for (const clientId of ["owner-a", "owner-b", "follower"]) {
      state.handleClientConnected(clientId);
    }
    state.setOwner("thread-1", "owner-a");
    state.setFollowing("thread-1", "follower", true);
    applyFollowerSnapshot(state, "thread-1", "follower", "owner-a");

    const ownerChange = state.setOwner("thread-1", "owner-b");

    expect(ownerChange.snapshotClientIds).toEqual(["follower"]);
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);
    expect(state.getSnapshotClientIds("thread-1")).toEqual(["follower"]);
  });

  test("turns a failed target delivery into a pending reconnect", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    state.setOwner("thread-1", "owner");
    state.setFollowing("thread-1", "follower", true);
    applyFollowerSnapshot(state);

    const resetActions = state.handleIpcConnectionReset("follower");

    expect(resetActions[0]).toMatchObject({
      type: "followers-changed",
      followerClientIds: [],
      targetClientIds: ["owner"],
    });
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);
    expect(state.hasFollowersOrPendingReconnect("thread-1")).toBe(true);
  });

  test("does not clear a snapshot barrier after delivery fails synchronously", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    state.setOwner("thread-1", "owner");
    state.setFollowing("thread-1", "follower", true);

    state.handleIpcConnectionReset("follower");
    expect(state.markSnapshotSent("thread-1", "follower", checkpoint())).toBe(false);
    state.handleClientConnected("follower");

    expect(state.getSnapshotClientIds("thread-1")).toEqual(["follower"]);
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);
  });

  test("does not open the barrier until the exact applied checkpoint is acknowledged", () => {
    const state = new CodexThreadStreamSubscriptionState();
    state.handleClientConnected("owner");
    state.handleClientConnected("follower");
    state.setOwner("thread-1", "owner");
    state.setFollowing("thread-1", "follower", true);
    const sent = checkpoint(3, 1);
    const advanced = checkpoint(4, 1);

    expect(state.markSnapshotSent("thread-1", "follower", sent)).toBe(true);
    const stale = state.acknowledgeSnapshotApplied({
      conversationId: "thread-1",
      clientId: "follower",
      ownerClientId: "owner",
      checkpoint: sent,
      currentCheckpoint: advanced,
    });

    expect(stale).toMatchObject({ accepted: false, shouldSendSnapshot: true });
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);
    expect(state.getSnapshotClientIds("thread-1")).toEqual(["follower"]);
  });

  test("rejects an old owner epoch ACK after owner replacement", () => {
    const state = new CodexThreadStreamSubscriptionState();
    for (const clientId of ["owner-a", "owner-b", "follower"]) {
      state.handleClientConnected(clientId);
    }
    state.setOwner("thread-1", "owner-a");
    state.setFollowing("thread-1", "follower", true);
    expect(state.markSnapshotSent("thread-1", "follower", checkpoint(2, 1))).toBe(true);
    state.setOwner("thread-1", "owner-b");

    const stale = state.acknowledgeSnapshotApplied({
      conversationId: "thread-1",
      clientId: "follower",
      ownerClientId: "owner-a",
      checkpoint: checkpoint(2, 1),
      currentCheckpoint: checkpoint(2, 2),
    });

    expect(stale.accepted).toBe(false);
    expect(state.getFollowerClientIds("thread-1")).toEqual([]);
    expect(state.getSnapshotClientIds("thread-1")).toEqual(["follower"]);
  });
});

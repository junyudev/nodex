import { createHash } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationSnapshot } from "./types";
import {
  applyCodexThreadOwnerPublication,
  areCodexThreadStreamCheckpointsEqual,
  buildCodexThreadStreamCheckpoint,
  hashCodexConversationReplica,
  serializeCodexConversationReplica,
  serializeCodexConversationReplicaDigest,
} from "./codex-owner-follower-replication";
import { buildCodexConversationStateUpdates } from "./codex-conversation-patches";

function conversation(
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    source: null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-08-09T00:00:00.000Z",
    resumeState: "resumed",
    turns: [],
    canonicalState: null,
    canonicalRequests: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
  };
}

describe("owner/follower canonical checkpoints", () => {
  test("domain-separates an absent pre-hydration canonical state", () => {
    const hydratedNull = conversation({ canonicalState: null });
    const preHydration = { ...hydratedNull } as Partial<CodexConversationSnapshot>;
    delete preHydration.canonicalState;

    expect(() =>
      hashCodexConversationReplica(preHydration as CodexConversationSnapshot),
    ).not.toThrow();
    expect(hashCodexConversationReplica(preHydration as CodexConversationSnapshot)).not.toBe(
      hashCodexConversationReplica(hydratedNull),
    );
  });

  test("normalizes missing pre-hydration Turn and request sequences as empty", () => {
    const empty = conversation();
    const preHydration = { ...empty } as Partial<CodexConversationSnapshot>;
    delete preHydration.turns;
    delete preHydration.requests;

    expect(() =>
      hashCodexConversationReplica(preHydration as CodexConversationSnapshot),
    ).not.toThrow();
    expect(hashCodexConversationReplica(preHydration as CodexConversationSnapshot)).toBe(
      hashCodexConversationReplica(empty),
    );
  });

  test("hashes protocol bigint fields deterministically without colliding with strings", () => {
    const bigintConversation = conversation({
      canonicalState: { value: 10n } as never,
    });
    const stringConversation = conversation({
      canonicalState: { value: "10n" } as never,
    });

    expect(hashCodexConversationReplica(bigintConversation)).toBe(
      hashCodexConversationReplica(structuredClone(bigintConversation)),
    );
    expect(hashCodexConversationReplica(bigintConversation)).not.toBe(
      hashCodexConversationReplica(stringConversation),
    );
  });

  test("uses deterministic Merkle SHA-256 over stable object-key ordering", () => {
    const left = conversation({
      canonicalState: { protocol: { id: "thread-1", z: 2, a: 1 } } as never,
    });
    const right = conversation({
      canonicalState: { protocol: { a: 1, z: 2, id: "thread-1" } } as never,
    });

    const hash = hashCodexConversationReplica(left);
    expect(hash).toBe(hashCodexConversationReplica(right));
    expect(hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(hash).toBe(
      createHash("sha256").update(serializeCodexConversationReplicaDigest(left)).digest("hex"),
    );
    expect(serializeCodexConversationReplica(left)).toContain('"canonicalState"');
  });

  test("reuses immutable resident Turn leaves while binding order and changed content", () => {
    let stableItemReads = 0;
    const firstTurn = { turnId: "turn-1" } as Record<string, unknown>;
    Object.defineProperty(firstTurn, "items", {
      enumerable: true,
      get: () => {
        stableItemReads += 1;
        return [{ id: "item-1", text: "stable" }];
      },
    });
    const secondTurn = { turnId: "turn-2", items: [{ id: "item-2", text: "old" }] } as never;
    const base = conversation({ turns: [firstTurn as never, secondTurn] });
    const baseHash = hashCodexConversationReplica(base);
    const readsAfterBase = stableItemReads;
    const changed = conversation({
      turns: [
        firstTurn as never,
        { turnId: "turn-2", items: [{ id: "item-2", text: "new" }] } as never,
      ],
    });
    const reordered = conversation({ turns: [secondTurn, firstTurn as never] });

    expect(hashCodexConversationReplica(changed)).not.toBe(baseHash);
    expect(stableItemReads).toBe(readsAfterBase);
    expect(hashCodexConversationReplica(reordered)).not.toBe(baseHash);
  });

  test("includes canonical lifecycle state while excluding standalone read state", () => {
    const base = conversation({
      canonicalState: {
        protocol: { id: "thread-1" },
        turns: [
          {
            protocol: { id: "turn-1" },
            items: [{ id: "patch-1", changes: [] }],
            sidecar: { lifecycleStatusByItemId: { "patch-1": "inProgress" } },
          },
        ],
      } as never,
      hasUnreadTurn: false,
      unreadMessageCount: 0,
    });
    const readStateOnly = { ...base, hasUnreadTurn: true, unreadMessageCount: 4 };
    const terminal = {
      ...base,
      canonicalState: {
        ...(base.canonicalState as object),
        turns: [
          {
            protocol: { id: "turn-1" },
            items: [{ id: "patch-1", changes: [] }],
            sidecar: { lifecycleStatusByItemId: { "patch-1": "completed" } },
          },
        ],
      } as never,
    };

    expect(hashCodexConversationReplica(readStateOnly)).toBe(hashCodexConversationReplica(base));
    expect(hashCodexConversationReplica(terminal)).not.toBe(hashCodexConversationReplica(base));
  });

  test("binds hash to owner epoch and revision without conflating their roles", () => {
    const document = conversation();
    const first = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 3,
      revision: 7,
      conversation: document,
    });
    const same = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 3,
      revision: 7,
      conversation: document,
    });
    const replacementOwner = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 4,
      revision: 7,
      conversation: document,
    });

    expect(areCodexThreadStreamCheckpointsEqual(first, same)).toBe(true);
    expect(areCodexThreadStreamCheckpointsEqual(first, replacementOwner)).toBe(false);
  });

  test("accepts the first snapshot without a base checkpoint", () => {
    const document = conversation();
    const checkpoint = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 1,
      revision: 1,
      conversation: document,
    });

    expect(
      applyCodexThreadOwnerPublication({
        current: null,
        expectedOwnerEpoch: 1,
        publication: {
          conversationId: document.threadId,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: document,
          },
          baseCheckpoint: null,
          checkpoint,
        },
      }),
    ).toEqual({
      accepted: true,
      replica: { checkpoint, conversation: document },
    });
  });

  test("applies one exact delta and rejects replay, gaps, and same-revision replacement", () => {
    const base = conversation();
    const next = conversation({ threadPreview: "next" });
    const baseCheckpoint = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 2,
      revision: 7,
      conversation: base,
    });
    const nextCheckpoint = buildCodexThreadStreamCheckpoint({
      ownerEpoch: 2,
      revision: 8,
      conversation: next,
    });
    const publication = {
      conversationId: base.threadId,
      change: {
        type: "patches" as const,
        baseRevision: 7,
        revision: 8,
        patches: buildCodexConversationStateUpdates(base, next),
      },
      baseCheckpoint,
      checkpoint: nextCheckpoint,
    };
    const accepted = applyCodexThreadOwnerPublication({
      current: { checkpoint: baseCheckpoint, conversation: base },
      expectedOwnerEpoch: 2,
      publication,
    });
    expect(accepted).toEqual({
      accepted: true,
      replica: { checkpoint: nextCheckpoint, conversation: next },
    });
    if (!accepted.accepted) throw new Error("Expected accepted publication");

    expect(
      applyCodexThreadOwnerPublication({
        current: accepted.replica,
        expectedOwnerEpoch: 2,
        publication,
      }),
    ).toMatchObject({ accepted: false, reason: "base-checkpoint-mismatch" });
    expect(
      applyCodexThreadOwnerPublication({
        current: accepted.replica,
        expectedOwnerEpoch: 2,
        publication: {
          ...publication,
          baseCheckpoint: nextCheckpoint,
          checkpoint: { ...nextCheckpoint, revision: 10 },
          change: { ...publication.change, baseRevision: 8, revision: 10 },
        },
      }),
    ).toMatchObject({ accepted: false, reason: "revision-gap" });
  });
});

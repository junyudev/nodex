import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationSnapshot } from "./types";
import {
  applyCodexThreadOwnerPublication,
  areCodexThreadStreamCheckpointsEqual,
  buildCodexThreadStreamCheckpoint,
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
  test("distinguishes owner epochs and stream revisions", () => {
    const first = buildCodexThreadStreamCheckpoint({ ownerEpoch: 3, revision: 7 });
    const same = buildCodexThreadStreamCheckpoint({ ownerEpoch: 3, revision: 7 });
    const replacementOwner = buildCodexThreadStreamCheckpoint({ ownerEpoch: 4, revision: 7 });

    expect(areCodexThreadStreamCheckpointsEqual(first, same)).toBe(true);
    expect(areCodexThreadStreamCheckpointsEqual(first, replacementOwner)).toBe(false);
  });

  test("accepts the first snapshot without a base checkpoint", () => {
    const document = conversation();
    const checkpoint = buildCodexThreadStreamCheckpoint({ ownerEpoch: 1, revision: 1 });

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
    const baseCheckpoint = buildCodexThreadStreamCheckpoint({ ownerEpoch: 2, revision: 7 });
    const nextCheckpoint = buildCodexThreadStreamCheckpoint({ ownerEpoch: 2, revision: 8 });
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

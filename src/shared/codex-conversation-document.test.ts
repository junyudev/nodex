import { describe, expect, test } from "vite-plus/test";
import { projectCodexConversationDocument } from "./codex-conversation-document";
import {
  applyCodexConversationStateUpdates,
  buildCodexConversationStateUpdates,
} from "./codex-conversation-patches";
import { hashCodexConversationReplica } from "./codex-owner-follower-replication";
import {
  advanceRendererDeliveryAssembler,
  createRendererDeliveryAssemblerState,
  encodeRendererDelivery,
} from "./renderer-delivery-transport";
import type { CodexConversationSnapshot } from "./types";

const conversation = (): CodexConversationSnapshot => ({
  threadId: "thread-document",
  projectId: "project-1",
  source: null,
  threadName: "Thread",
  threadPreview: "BOOT_OK",
  modelProvider: "openai",
  cwd: "/workspace/project",
  statusType: "idle",
  statusActiveFlags: [],
  archived: false,
  createdAt: 0,
  updatedAt: 0,
  linkedAt: "2026-09-08T00:00:00Z",
  resumeState: "resumed",
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
  turns: [
    {
      threadId: "thread-document",
      turnId: "turn-completed",
      status: "completed",
      errorMessage: undefined,
      diff: undefined,
      itemIds: ["answer"],
      completedAt: null,
      items: [
        {
          threadId: "thread-document",
          turnId: "turn-completed",
          itemId: "answer",
          type: "agentMessage",
          kind: "assistantMessage",
          markdownText: "BOOT_OK",
          status: "completed",
          assistantPhase: undefined,
          createdAt: 0,
          updatedAt: 0,
          rawItem: { result: { text: "", enabled: false, count: 0, value: null } },
        },
      ],
    },
  ],
});

const relay = <T>(payload: T): T => {
  const dispatch = encodeRendererDelivery({
    target: { targetId: "renderer-follower", generation: 1 },
    transferId: "conversation-relay",
    payload,
  });
  let state = createRendererDeliveryAssemblerState();
  for (const envelope of dispatch.envelopes) {
    const result = advanceRendererDeliveryAssembler(state, envelope);
    state = result.state;
    if (result.kind === "complete") return result.delivery.payload as T;
  }
  throw new Error("The conversation relay did not complete");
};

describe("shared conversation document", () => {
  test("omits absent optional members before a strict snapshot relay and preserves defined data", () => {
    const local = conversation();
    const shared = projectCodexConversationDocument(local);
    const received = relay(shared);

    expect(received).toEqual(shared);
    expect(received.turns[0]).not.toHaveProperty("errorMessage");
    expect(received.turns[0]).not.toHaveProperty("diff");
    expect(received.turns[0]?.items[0]).not.toHaveProperty("assistantPhase");
    expect(received.turns[0]?.items[0]?.markdownText).toBe("BOOT_OK");
    expect(shared.turns[0]?.items[0]?.rawItem).toBe(local.turns[0]?.items[0]?.rawItem);
    expect(received.turns[0]?.items[0]?.rawItem).toEqual({
      result: { text: "", enabled: false, count: 0, value: null },
    });
    expect(received.turns[0]?.completedAt).toBeNull();
    expect(hashCodexConversationReplica(received)).toBe(hashCodexConversationReplica(local));
    expect(projectCodexConversationDocument(local)).toBe(shared);
    expect(projectCodexConversationDocument(shared)).toBe(shared);
    expect(local.turns[0]).toHaveProperty("errorMessage", undefined);
  });

  test("clearing an optional value relays a remove patch that converges with the next snapshot", () => {
    const local = conversation();
    const before = projectCodexConversationDocument({
      ...local,
      turns: [{ ...local.turns[0]!, errorMessage: "A prior failure" }],
    });
    const next = projectCodexConversationDocument({
      ...before,
      turns: [{ ...before.turns[0]!, errorMessage: undefined }],
    });
    const patches = relay(buildCodexConversationStateUpdates(before, next));
    expect(patches).toEqual([{ op: "remove", path: ["turns", 0, "errorMessage"] }]);
    const follower = applyCodexConversationStateUpdates(relay(before), patches);
    expect(follower).toEqual(relay(next));
    expect(hashCodexConversationReplica(follower)).toBe(hashCodexConversationReplica(next));
    expect(next.turns[0]?.items).toBe(before.turns[0]?.items);
  });

  test("rejects invalid array entries without removing or reordering them", () => {
    for (const turns of [[undefined], new Array(1), [Number.NaN], [() => null]]) {
      const invalid = { ...conversation(), turns } as CodexConversationSnapshot;
      expect(() => projectCodexConversationDocument(invalid)).toThrow();
      expect(() => relay(invalid)).toThrow();
    }
  });
});

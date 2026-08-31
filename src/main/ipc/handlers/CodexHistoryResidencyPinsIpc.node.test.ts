import { describe, expect, test } from "vitest";
import {
  CodexRendererConversationRegistry,
  makeCodexRendererConversationRegistryState,
} from "../../codex-application/CodexRendererConversationRegistry";
import type { ConversationEntityState } from "../../codex-application/internal/ConversationEntityState";
import { ConversationEntityMap } from "../../codex-application/internal/ConversationEntityMap";
import { applyCodexHistoryResidencyPins } from "./CodexRendererIpc";

function makeHarness() {
  const calls: unknown[] = [];
  const conversation = {
    generation: 5,
    setHistoryResidencyPins: (input: unknown) => {
      calls.push(input);
      return { status: "applied" as const, evictedTurnIds: ["turn-old"], limitsSatisfied: true };
    },
  } as unknown as ConversationEntityState;
  const conversations = ConversationEntityMap.of({
    current: (threadId: string) => (threadId === "thread-1" ? conversation : null),
  } as unknown as ConversationEntityMap["Service"]);
  const rendererConversations = CodexRendererConversationRegistry.of(
    makeCodexRendererConversationRegistryState(),
  );
  rendererConversations.setOwner("thread-1", "client-owner");
  rendererConversations.setViewActive("thread-1", "client-owner", true);
  rendererConversations.setPresented("thread-1", "client-owner", "surface-1", true);
  return { calls, conversations, rendererConversations };
}

describe("Codex history residency pin IPC", () => {
  test("admits a bounded owner viewport and preserves the topology generation fence", () => {
    const harness = makeHarness();
    const result = applyCodexHistoryResidencyPins({
      rawInput: {
        threadId: "thread-1",
        expectedConversationGeneration: 5,
        expectedTopologyGeneration: 9,
        expectedHistoryMutationRevision: 7,
        turnIds: ["turn-visible"],
        islandIds: [],
      },
      clientId: "client-owner",
      conversations: harness.conversations,
      rendererConversations: harness.rendererConversations,
    });

    expect(result).toEqual({
      status: "applied",
      evictedTurnIds: ["turn-old"],
      limitsSatisfied: true,
    });
    expect(harness.calls).toEqual([
      {
        clientId: "client-owner",
        expectedTopologyGeneration: 9,
        expectedHistoryMutationRevision: 7,
        turnIds: ["turn-visible"],
        islandIds: [],
      },
    ]);
  });

  test("rejects non-presenting clients and hidden non-empty pin writes without touching residency", () => {
    const harness = makeHarness();
    const input = {
      threadId: "thread-1",
      expectedConversationGeneration: 5,
      expectedTopologyGeneration: 9,
      expectedHistoryMutationRevision: 7,
      turnIds: ["turn-visible"],
      islandIds: [],
    };

    expect(
      applyCodexHistoryResidencyPins({
        rawInput: input,
        clientId: "client-follower",
        conversations: harness.conversations,
        rendererConversations: harness.rendererConversations,
      }),
    ).toEqual({ status: "notOwner" });
    harness.rendererConversations.setPresented("thread-1", "client-owner", "surface-1", false);
    expect(
      applyCodexHistoryResidencyPins({
        rawInput: input,
        clientId: "client-owner",
        conversations: harness.conversations,
        rendererConversations: harness.rendererConversations,
      }),
    ).toEqual({ status: "notPresenting" });
    expect(harness.calls).toEqual([]);
  });

  test("rejects a presenting follower so window count cannot multiply viewport residency", () => {
    const harness = makeHarness();
    harness.rendererConversations.setFollowing("thread-1", "client-follower", true);
    harness.rendererConversations.setViewActive("thread-1", "client-follower", true);
    harness.rendererConversations.setPresented(
      "thread-1",
      "client-follower",
      "surface-follower",
      true,
    );

    expect(
      applyCodexHistoryResidencyPins({
        rawInput: {
          threadId: "thread-1",
          expectedConversationGeneration: 5,
          expectedTopologyGeneration: 9,
          expectedHistoryMutationRevision: 7,
          turnIds: ["turn-follower"],
          islandIds: [],
        },
        clientId: "client-follower",
        conversations: harness.conversations,
        rendererConversations: harness.rendererConversations,
      }),
    ).toEqual({ status: "notOwner" });
    expect(harness.calls).toEqual([]);
  });

  test("rejects a delayed viewport write from a replaced Conversation Entity generation", () => {
    const harness = makeHarness();
    expect(
      applyCodexHistoryResidencyPins({
        rawInput: {
          threadId: "thread-1",
          expectedConversationGeneration: 4,
          expectedTopologyGeneration: 9,
          expectedHistoryMutationRevision: 7,
          turnIds: ["turn-visible"],
          islandIds: [],
        },
        clientId: "client-owner",
        conversations: harness.conversations,
        rendererConversations: harness.rendererConversations,
      }),
    ).toEqual({ status: "staleGeneration" });
    expect(harness.calls).toEqual([]);
  });

  test("allows the current owner to clear stale viewport pins during unmount", () => {
    const harness = makeHarness();
    harness.rendererConversations.setPresented("thread-1", "client-owner", "surface-1", false);

    expect(
      applyCodexHistoryResidencyPins({
        rawInput: {
          threadId: "thread-1",
          expectedConversationGeneration: 5,
          expectedTopologyGeneration: 9,
          expectedHistoryMutationRevision: 7,
          turnIds: [],
          islandIds: [],
        },
        clientId: "client-owner",
        conversations: harness.conversations,
        rendererConversations: harness.rendererConversations,
      }),
    ).toEqual({
      status: "applied",
      evictedTurnIds: ["turn-old"],
      limitsSatisfied: true,
    });
    expect(harness.calls).toHaveLength(1);
  });
});

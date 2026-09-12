import { expect, test } from "vite-plus/test";
import { produce } from "immer";
import { createCodexCanonicalHydratedConversationState } from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  interruptCanonicalConversationTurn,
  type CanonicalInterruptClient,
} from "./codex-conversation-interrupt";
import { residentConversationTurns } from "./codex-turn-mutation";

function harness() {
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    turns: [
      {
        id: "active",
        status: "inProgress" as const,
        itemsView: "full" as const,
        items: [],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
  let state = createCodexCanonicalHydratedConversationState(thread, {
    hostId: "local",
    model: "m",
    reasoningEffort: null,
    cwd: "/workspace",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: [],
  });
  const calls: string[] = [];
  let send = async (_id: string) => {};
  const client: CanonicalInterruptClient = {
    getConversation: () => state,
    updateConversation: (_id, recipe) => {
      state = produce(state, recipe);
    },
    sendInterrupt: async (_threadId, turnId) => {
      calls.push(`interrupt:${turnId}`);
      await send(turnId);
    },
    cleanBackgroundTerminals: async () => {
      calls.push("clean");
    },
    killNodeReplExecutions: async (_sessionId, turnId) => {
      calls.push(`kill:${turnId}`);
    },
    onInterruptStarted: () => {
      calls.push("started");
    },
    errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    warn: () => {
      calls.push("warning");
    },
  };
  return {
    client,
    calls,
    read: () => state,
    send: (next: typeof send) => {
      send = next;
    },
  };
}

test("expected-turn mismatch has no cleanup or mutation side effects", async () => {
  const f = harness();
  expect(await interruptCanonicalConversationTurn(f.client, "id", "other")).toBeNull();
  expect(f.calls).toEqual([]);
  expect(residentConversationTurns(f.read())[0]?.status).toBe("inProgress");
});
test("expected-turn cleanup starts only after the native interrupt succeeds", async () => {
  const f = harness();
  expect(await interruptCanonicalConversationTurn(f.client, "id", "active")).toBe("active");
  expect(f.calls).toEqual(["interrupt:active", "started", "kill:active"]);
  expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
});
test("unconditional interrupt retries the server's current turn and cleans both executions", async () => {
  const f = harness();
  f.send(async (id) => {
    if (id === "active") throw new Error("expected active turn id `active` but found `new`");
  });
  expect(await interruptCanonicalConversationTurn(f.client, "id")).toBe("new");
  expect(f.calls).toEqual([
    "started",
    "kill:active",
    "interrupt:active",
    "kill:new",
    "interrupt:new",
  ]);
  expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
});
test("expected-turn no-active response cannot mark the old turn interrupted", async () => {
  const f = harness();
  f.send(async () => {
    throw new Error("no active turn to interrupt");
  });
  expect(await interruptCanonicalConversationTurn(f.client, "id", "active")).toBeNull();
  expect(f.calls).toEqual(["interrupt:active"]);
  expect(residentConversationTurns(f.read())[0]?.status).toBe("inProgress");
});

test.each([undefined, "active"])(
  "cleanup failure cannot replace a successful interrupt: %s",
  async (expectedTurnId) => {
    const f = harness();
    const client = {
      ...f.client,
      killNodeReplExecutions: async () => {
        throw new Error("Cleanup owner retired");
      },
    };
    expect(await interruptCanonicalConversationTurn(client, "id", expectedTurnId)).toBe("active");
    expect(residentConversationTurns(f.read())[0]?.status).toBe("interrupted");
    expect(f.calls.filter((call) => call === "interrupt:active")).toHaveLength(1);
    expect(f.calls).toContain("warning");
  },
);

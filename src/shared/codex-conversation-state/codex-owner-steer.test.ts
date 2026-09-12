import { produce, castDraft } from "immer";
import { expect, test } from "vitest";
import { createCodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { residentConversationTurns } from "./codex-turn-mutation";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalConversationState,
  type CodexCanonicalSteeringUserMessageItem,
} from "./codex-conversation-state";
import {
  runCanonicalOwnerSteer,
  type CanonicalOwnerSteerClient,
  type CanonicalSteerNativeRequest,
} from "./codex-owner-steer";
import type { CodexTurnDelivery } from "./codex-turn-delivery";
function buildState(): CodexCanonicalConversationState {
  return createCodexCanonicalHydratedConversationState(
    {
      model: null,
      reasoningEffort: null,
      id: "thread-a",
      extra: null,
      sessionId: "session-a",
      forkedFromId: null,
      parentThreadId: null,
      preview: "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: 0,
      updatedAt: 0,
      recencyAt: null,
      status: { type: "active", activeFlags: [] },
      path: null,
      cwd: "/workspace",
      cliVersion: "test",
      source: "appServer",
      canAcceptDirectInput: true,
      threadSource: "appServer",
      name: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      turns: [
        {
          id: "turn-a",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null,
        },
      ],
    },
    {
      hostId: "local",
      ...{
        model: "gpt-test",
        reasoningEffort: null,
        cwd: "/workspace",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: [],
      },
    },
  );
}

function buildSteer(id = "steer-a"): CodexCanonicalSteeringUserMessageItem {
  return {
    type: "steeringUserMessage",
    id,
    targetTurnId: "turn-a",
    targetTurnStartedAtMs: 10,
    status: "pending",
    clientUserMessageId: id,
    input: [{ type: "text", text: "continue", text_elements: [] }],
    attachments: [{ path: "/workspace/file.ts" }],
    restoreMessage: {
      queueRow: createCodexQueuedFollowUp({
        followUpId: `follow-up-${id}`,
        clientUserMessageId: `client-${id}`,
        threadId: "thread-a",
        prompt: "continue",
        createdAtMs: 10,
      }),
      context: { commentAttachments: [] },
    },
    compareKey: { rawText: "continue", imageCount: 0 },
  };
}

function harness(sendNative: CanonicalOwnerSteerClient["sendNative"]) {
  let state = buildState();
  const requests: CanonicalSteerNativeRequest[] = [];
  const item = buildSteer();
  const client: CanonicalOwnerSteerClient = {
    read: () => state,
    update: (recipe) => {
      state = produce(state, recipe);
    },
    subscribe: () => ({ [Symbol.dispose]() {} }),
    onDispose: () => ({ [Symbol.dispose]() {} }),
    createId: () => "steer-a",
    sendNative: (request, options) => {
      requests.push(request);
      return sendNative(request, options);
    },
    outcomeUnknown: () => null,
    mismatchTurnId: (error) =>
      error instanceof Error && error.message === "mismatch" ? "turn-b" : null,
    isLocalHost: true,
    emitSteered() {},
  };
  return {
    client,
    requests,
    read: () => state,
    input: {
      conversationId: "thread-a",
      input: [...item.input],
      restoreMessage: item.restoreMessage,
      clientUserMessageId: "client-a",
    },
  };
}
test("steers the execution Turn when a completed local marker follows it", async () => {
  const h = harness(async (request) => ({
    turnId: request.method === "turn/steer" ? request.params.expectedTurnId : "unexpected",
  }));
  h.client.update((draft) => {
    draft.turns.push({ ...draft.turns[0]!, turnId: null, status: "completed", items: [] });
  });
  expect(await runCanonicalOwnerSteer(h.client, h.input)).toEqual({ turnId: "turn-a" });
  expect(h.requests).toHaveLength(1);
  expect(h.read().turns[0]!.items).toEqual([
    expect.objectContaining({ type: "steeringUserMessage", targetTurnId: "turn-a" }),
  ]);
  expect(h.read().turns[1]!.items).toEqual([]);
});

test("steers the resident canonical Turn without mutating the display overlay", async () => {
  const h = harness(async (request) => ({
    turnId: request.method === "turn/steer" ? request.params.expectedTurnId : "unexpected",
  }));
  h.client.update((draft) => {
    const execution = draft.turns[0]!;
    replaceCanonicalHistoryDraft(
      draft,
      [execution, { ...execution, turnId: null, status: "completed", items: [] }],
      true,
    );
    draft.turns = [{ ...execution, turnId: "display-only", items: [] }];
  });
  await expect(runCanonicalOwnerSteer(h.client, h.input)).resolves.toEqual({ turnId: "turn-a" });
  const resident = residentConversationTurns(h.read());
  expect(resident[0]?.items).toEqual([
    expect.objectContaining({ clientUserMessageId: "client-a", status: "accepted" }),
  ]);
  expect(resident[1]?.items).toEqual([]);
  expect(h.read().turns[0]?.items).toEqual([]);
});

test("preserves a display Turn identity when native steering corrects its wrapped protocol ID", async () => {
  let attempts = 0;
  const h = harness(async () => {
    if (++attempts === 1) throw new Error("mismatch");
    return { turnId: "turn-b" };
  });
  h.client.update((draft) => {
    draft.turns[0]!.turnId = "turn-b-berry-display-1";
  });
  await expect(runCanonicalOwnerSteer(h.client, h.input)).resolves.toEqual({ turnId: "turn-b" });
  expect(
    h.requests.map((request) =>
      request.method === "turn/steer" ? request.params.expectedTurnId : null,
    ),
  ).toEqual(["turn-b-berry-display-1", "turn-b"]);
  expect(h.read().turns[0]?.turnId).toBe("turn-b-berry-display-1");
  expect(h.read().turns[0]?.items[0]).toMatchObject({
    targetTurnId: "turn-b-berry-display-1",
    status: "accepted",
  });
});

test("retains unknown steering until late native result then accepts and clears its receipt", async () => {
  let finish!: (result: { turnId: string }) => void;
  const h = harness((_request, options) => {
    options.onOutcomeUnknown({
      requestId: "request-a",
      method: "turn/steer",
      stage: "outcome-unknown",
    });
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const result = runCanonicalOwnerSteer(h.client, h.input);
  await Promise.resolve();
  await Promise.resolve();
  expect(h.read().unconfirmedTurnSubmissions?.[0]?.clientUserMessageId).toBe("client-a");
  await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow(
    "earlier turn submission",
  );
  finish({ turnId: "turn-a" });
  expect(await result).toEqual({ turnId: "turn-a" });
  expect(h.read().unconfirmedTurnSubmissions).toBeUndefined();
  expect(h.read().turns[0]?.items[0]).toMatchObject({
    type: "steeringUserMessage",
    status: "accepted",
  });
});
test("retries one corrected turn identity and removes optimistic state on a definite failure", async () => {
  let attempts = 0;
  const h = harness(async () => {
    if (++attempts === 1) throw new Error("mismatch");
    throw new Error("rejected");
  });
  h.client.update((draft) => {
    draft.turns[0]!.items.push(castDraft(buildSteer("unrelated-message")));
  });
  await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow("rejected");
  expect(
    h.requests.map((request) =>
      request.method === "turn/steer" ? request.params.expectedTurnId : null,
    ),
  ).toEqual(["turn-a", "turn-b"]);
  expect(h.read().turns[0]?.turnId).toBe("turn-b");
  expect(h.read().turns[0]?.items).toEqual([expect.objectContaining({ id: "unrelated-message" })]);
});
test("unknown delivery failure retains its optimistic row and submission fence", async () => {
  const delivery: CodexTurnDelivery = {
    requestId: "request-a",
    method: "turn/steer",
    stage: "outcome-unknown",
  };
  const error = new Error("disconnected");
  const h = harness(async () => {
    throw error;
  });
  h.client.outcomeUnknown = (failure) => (failure === error ? delivery : null);
  await expect(runCanonicalOwnerSteer(h.client, h.input)).rejects.toThrow("disconnected");
  expect(h.read().turns[0]?.items[0]).toMatchObject({ status: "pending" });
  expect(h.read().unconfirmedTurnSubmissions).toEqual([
    { ...delivery, clientUserMessageId: "client-a" },
  ]);
});

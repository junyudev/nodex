import { expect, it } from "vite-plus/test";
import { applyAcpConversationDelta } from "../../../shared/acp-conversation";
import {
  ACP_CONVERSATION_MAX_DELTA_BYTES,
  ACP_CONVERSATION_MAX_TURN_BYTES,
  ACP_CONVERSATION_MAX_TURNS,
  beginAcpConversationTurn,
  completeAcpConversationAuthentication,
  diffAcpConversationSnapshots,
  emptyAcpConversationSnapshot,
  rebindAcpConversationSession,
  recoverAcpConversationTurnFailure,
  reduceAcpConversationEvent,
} from "./AcpConversationProjection";

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

it("coalesces cumulative message and tool updates into a bounded canonical snapshot", () => {
  let snapshot = emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  snapshot = beginAcpConversationTurn(snapshot, 1, [{ type: "text", text: "hello" }]);
  for (const text of ["a", "b"]) {
    snapshot = reduceAcpConversationEvent(snapshot, {
      kind: "session_update",
      sessionId: "session-1",
      turnSequence: 1,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text },
      },
    });
  }
  snapshot = reduceAcpConversationEvent(snapshot, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run command",
      status: "in_progress",
    },
  });
  snapshot = reduceAcpConversationEvent(snapshot, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-1",
      status: "completed",
    },
  });

  expect(snapshot.turns[0]?.updates).toHaveLength(2);
  expect(snapshot.turns[0]?.updates[0]).toMatchObject({
    kind: "message",
    text: "ab",
  });
  expect(snapshot.turns[0]?.updates[1]).toMatchObject({
    kind: "tool-call",
    title: "Run command",
    status: "completed",
  });
});

it("evicts old turns instead of allowing conversation memory to grow without a bound", () => {
  let snapshot = emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  for (let sequence = 1; sequence <= ACP_CONVERSATION_MAX_TURNS + 2; sequence += 1) {
    snapshot = beginAcpConversationTurn(snapshot, sequence, [
      { type: "text", text: `prompt-${sequence}` },
    ]);
  }
  expect(snapshot.turns).toHaveLength(ACP_CONVERSATION_MAX_TURNS);
  expect(snapshot.turns[0]?.sequence).toBe(3);
});

it("enforces the byte budget even when one canonical update is oversized", () => {
  let snapshot = emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  snapshot = beginAcpConversationTurn(snapshot, 1, [
    { type: "text", text: "prompt".repeat(8_000) },
  ]);
  snapshot = reduceAcpConversationEvent(snapshot, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "available_commands_update",
      availableCommands: Array.from({ length: 128 }, (_, index) => ({
        name: `command-${index}`,
        description: "🧪".repeat(4_096),
      })),
    },
  });

  const turn = snapshot.turns[0];
  expect(turn?.updates).toHaveLength(1);
  expect(encodedBytes(turn)).toBeLessThanOrEqual(ACP_CONVERSATION_MAX_TURN_BYTES);
  expect(encodedBytes(snapshot.turns)).toBeLessThanOrEqual(ACP_CONVERSATION_MAX_TURN_BYTES);
});

it("round-trips consecutive bounded deltas and rejects revision gaps", () => {
  const initial = emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  const running = beginAcpConversationTurn(initial, 1, [{ type: "text", text: "hello" }]);
  const firstDelta = diffAcpConversationSnapshots(initial, running);
  expect(firstDelta).not.toBeNull();
  const firstReplica = applyAcpConversationDelta(initial, firstDelta!);
  expect(firstReplica).toEqual(running);

  const streamed = reduceAcpConversationEvent(running, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "🧪".repeat(20_000) },
    },
  });
  const streamedDelta = diffAcpConversationSnapshots(running, streamed);
  expect(streamedDelta).not.toBeNull();
  expect(encodedBytes(streamedDelta)).toBeLessThanOrEqual(ACP_CONVERSATION_MAX_DELTA_BYTES);
  expect(applyAcpConversationDelta(firstReplica!, streamedDelta!)).toEqual(streamed);
  expect(applyAcpConversationDelta(initial, streamedDelta!)).toBeNull();

  const appended = reduceAcpConversationEvent(streamed, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "message-1",
      content: { type: "text", text: "tail" },
    },
  });
  const appendedDelta = diffAcpConversationSnapshots(streamed, appended);
  expect(appendedDelta?.turns[0]?.updates).toEqual([
    { kind: "append-message", key: "message:agent:message-1", text: "tail" },
  ]);
  expect(applyAcpConversationDelta(streamed, appendedDelta!)).toEqual(appended);
});

it("sends only the changed canonical update instead of the resident transcript", () => {
  let snapshot = beginAcpConversationTurn(
    emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" }),
    1,
    [{ type: "text", text: "inspect" }],
  );
  for (let index = 0; index < 64; index += 1) {
    snapshot = reduceAcpConversationEvent(snapshot, {
      kind: "session_update",
      sessionId: "session-1",
      turnSequence: 1,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: `tool-${index}`,
        title: `Read file ${index} ${"history".repeat(200)}`,
        status: "in_progress",
      },
    });
  }
  const next = reduceAcpConversationEvent(snapshot, {
    kind: "session_update",
    sessionId: "session-1",
    turnSequence: 1,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "tool-63",
      status: "completed",
    },
  });
  const delta = diffAcpConversationSnapshots(snapshot, next);
  expect(delta?.turns[0]?.updates).toHaveLength(1);
  expect(encodedBytes(delta)).toBeLessThan(encodedBytes(next) / 20);
  expect(applyAcpConversationDelta(snapshot, delta!)).toEqual(next);
});

it("keeps session recovery transitions monotone without reviving terminal projections", () => {
  const initial = emptyAcpConversationSnapshot({ threadId: "thread-1", sessionId: "pending" });
  const rebound = rebindAcpConversationSession(initial, "session-1");
  expect(rebound).toMatchObject({ sessionId: "session-1", revision: 1 });
  const authenticationRequired = recoverAcpConversationTurnFailure(
    rebound,
    new Error("Sign in"),
    "authentication-required",
  );
  expect(authenticationRequired).toMatchObject({
    status: "authentication-required",
    error: "Sign in",
    revision: 2,
  });
  expect(completeAcpConversationAuthentication(authenticationRequired, "session-2")).toMatchObject({
    sessionId: "session-2",
    status: "idle",
    error: null,
    revision: 3,
  });
});

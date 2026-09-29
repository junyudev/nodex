import { reduceAcpConversationEvent } from "./AcpConversationProjection";
import { expect, it } from "vite-plus/test";
import { applyAgentConversationDelta } from "../../../shared/agent-conversation";
import {
  AGENT_CONVERSATION_MAX_DELTA_BYTES,
  AGENT_CONVERSATION_MAX_TURN_BYTES,
  AGENT_CONVERSATION_MAX_TURNS,
  beginAgentConversationTurn,
  completeAgentConversationAuthentication,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
  rebindAgentConversationSession,
  recoverAgentConversationTurnFailure,
  reduceAgentConversationEvent,
} from "../AgentConversationProjection";

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

it("coalesces cumulative message and tool updates into a bounded canonical snapshot", () => {
  let snapshot = emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  snapshot = beginAgentConversationTurn(snapshot, 1, "hello");
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
  let snapshot = emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  for (let sequence = 1; sequence <= AGENT_CONVERSATION_MAX_TURNS + 2; sequence += 1) {
    snapshot = beginAgentConversationTurn(snapshot, sequence, `prompt-${sequence}`);
  }
  expect(snapshot.turns).toHaveLength(AGENT_CONVERSATION_MAX_TURNS);
  expect(snapshot.turns[0]?.sequence).toBe(3);
});

it("enforces the byte budget even when one canonical update is oversized", () => {
  let snapshot = emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  snapshot = beginAgentConversationTurn(snapshot, 1, "prompt".repeat(8_000));
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
  expect(encodedBytes(turn)).toBeLessThanOrEqual(AGENT_CONVERSATION_MAX_TURN_BYTES);
  expect(encodedBytes(snapshot.turns)).toBeLessThanOrEqual(AGENT_CONVERSATION_MAX_TURN_BYTES);
});

it("round-trips first-submission identity through consecutive bounded deltas", () => {
  const initial = emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" });
  const running = beginAgentConversationTurn(
    initial,
    1,
    "hello",
    "01991e60-b800-7000-8000-000000000012",
  );
  const firstDelta = diffAgentConversationSnapshots(initial, running);
  expect(firstDelta).not.toBeNull();
  const firstReplica = applyAgentConversationDelta(initial, firstDelta!);
  expect(firstReplica).toEqual(running);
  expect(firstReplica?.turns[0]?.clientUserMessageId).toBe("01991e60-b800-7000-8000-000000000012");

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
  const streamedDelta = diffAgentConversationSnapshots(running, streamed);
  expect(streamedDelta).not.toBeNull();
  expect(encodedBytes(streamedDelta)).toBeLessThanOrEqual(AGENT_CONVERSATION_MAX_DELTA_BYTES);
  expect(applyAgentConversationDelta(firstReplica!, streamedDelta!)).toEqual(streamed);
  expect(applyAgentConversationDelta(initial, streamedDelta!)).toBeNull();

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
  const appendedDelta = diffAgentConversationSnapshots(streamed, appended);
  expect(appendedDelta?.turns[0]?.updates).toEqual([
    { kind: "append-message", key: "message:agent:message-1", text: "tail" },
  ]);
  expect(applyAgentConversationDelta(streamed, appendedDelta!)).toEqual(appended);
});

it("sends only the changed canonical update instead of the resident transcript", () => {
  let snapshot = beginAgentConversationTurn(
    emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "session-1" }),
    1,
    "inspect",
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
  const delta = diffAgentConversationSnapshots(snapshot, next);
  expect(delta?.turns[0]?.updates).toHaveLength(1);
  expect(encodedBytes(delta)).toBeLessThan(encodedBytes(next) / 20);
  expect(applyAgentConversationDelta(snapshot, delta!)).toEqual(next);
});

it("keeps session recovery transitions monotone without reviving terminal projections", () => {
  const initial = emptyAgentConversationSnapshot({ threadId: "thread-1", sessionId: "pending" });
  const rebound = rebindAgentConversationSession(initial, "session-1");
  expect(rebound).toMatchObject({ sessionId: "session-1", revision: 1 });
  const authenticationRequired = recoverAgentConversationTurnFailure(
    rebound,
    new Error("Sign in"),
    "authentication-required",
  );
  expect(authenticationRequired).toMatchObject({
    status: "authentication-required",
    error: "Sign in",
    revision: 2,
  });
  expect(
    completeAgentConversationAuthentication(authenticationRequired, "session-2"),
  ).toMatchObject({
    sessionId: "session-2",
    status: "idle",
    error: null,
    revision: 3,
  });
});

it("retains tool identity within the turn budget when input and output are oversized", () => {
  const initial = beginAgentConversationTurn(
    emptyAgentConversationSnapshot({ threadId: "thread", sessionId: "session" }),
    1,
    "Inspect",
  );
  const bounded = reduceAgentConversationEvent(initial, {
    kind: "session_update",
    turnSequence: 1,
    update: {
      kind: "tool-call",
      key: "tool",
      toolCallId: "tool",
      title: "Inspect",
      name: "Read",
      toolKind: "read",
      status: "completed",
      input: "🧪".repeat(200_000),
      detail: "Result".repeat(200_000),
      locations: [],
    },
  });
  expect(bounded.turns[0]?.updates).toHaveLength(1);
  expect(bounded.turns[0]?.updates[0]).toMatchObject({ toolCallId: "tool", status: "completed" });
  expect(encodedBytes(bounded.turns[0])).toBeLessThanOrEqual(AGENT_CONVERSATION_MAX_TURN_BYTES);
});

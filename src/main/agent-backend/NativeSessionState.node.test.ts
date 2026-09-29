import { expect, it } from "vite-plus/test";
import { emptyAgentConversationSnapshot } from "./AgentConversationProjection";
import {
  nativeHistoryFacts,
  nativeSelectionFromState,
  nativeStateFromSnapshot,
  remapNativeState,
} from "./NativeSessionState";

it("retains inherited intent instead of persisting a native effective model", () => {
  const snapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "task",
    sessionId: "native",
  });
  const state = nativeStateFromSnapshot(
    {
      ...snapshot,
      metadata: {
        revision: 1,
        requestedSelection: { model: "default", effort: "high", fast: false },
        requestedMode: "plan",
        effectiveSelection: { model: "gateway/actual", effort: "medium" },
        configOptions: [],
        modes: null,
        capabilities: {
          prompt: {
            text: true,
            resourceLink: true,
            image: true,
            audio: false,
            embeddedContext: false,
          },
          session: {
            load: true,
            list: false,
            delete: false,
            resume: true,
            unstableFork: true,
            close: true,
            additionalDirectories: true,
          },
          authMethods: [],
        },
      },
    },
    null,
  );
  expect(nativeSelectionFromState(state)).toEqual({
    model: "default",
    effort: "high",
    fast: false,
  });
  expect(state.preferences.interaction_mode).toBe("plan");
  expect(state.ever_saved).toBe(false);
});

it("stores bounded terminal facts and rejoins only retained fork UUIDs", () => {
  const snapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "task",
    sessionId: "native",
  });
  const state = nativeStateFromSnapshot(
    {
      ...snapshot,
      turns: Array.from({ length: 70 }, (_, index) => ({
        sequence: index,
        clientUserMessageId: `client-${index}`,
        nativeUserMessageId: `record-${index}`,
        promptText: "Native content must not be copied into Core",
        updates: [],
        stopReason: "cancelled",
        createdAt: "2026-09-30T00:00:00.000Z",
        completedAt: "2026-09-30T00:00:05.000Z",
      })),
    },
    null,
    true,
  );
  expect(state.turns).toHaveLength(64);
  const forked = remapNativeState(state, {
    "record-6": "new-record-6",
    "record-7": "new-record-7",
  });
  expect(forked.turns.map((turn) => turn.client_user_message_id)).toEqual(["client-6", "client-7"]);
  expect(nativeHistoryFacts(forked)[0]).toEqual({
    clientUserMessageId: "client-6",
    nativeUserMessageId: "new-record-6",
    stopReason: "cancelled",
    error: undefined,
    createdAt: "2026-09-30T00:00:00.000Z",
    completedAt: "2026-09-30T00:00:05.000Z",
  });
});

it("keeps native error facts inside Core's UTF-8 byte budget", () => {
  const snapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "task",
    sessionId: "native",
  });
  const state = nativeStateFromSnapshot(
    {
      ...snapshot,
      turns: [
        {
          sequence: 1,
          clientUserMessageId: "client",
          promptText: "",
          updates: [],
          stopReason: "error",
          error: "失败🙂".repeat(2000),
        },
      ],
    },
    null,
  );
  const error = state.turns?.[0]!.error!;
  expect(Buffer.byteLength(error, "utf8")).toBeLessThanOrEqual(4096);
  expect(error).not.toContain("�");
});

it("restores observed usage, compactions and generated-file outcomes without transcript bytes", () => {
  const snapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "task",
    sessionId: "native",
  });
  const state = nativeStateFromSnapshot(
    {
      ...snapshot,
      turns: [
        {
          sequence: 1,
          clientUserMessageId: "client",
          nativeUserMessageId: "record",
          promptText: "Private content",
          stopReason: "end_turn",
          updates: [
            {
              kind: "usage",
              key: "usage",
              used: 123,
              size: 200000,
              model: "actual",
              contextEstimated: false,
              cost: { amount: 0.012345, currency: "USD" },
              tokens: { input: 10, output: 3, cacheRead: 7, cacheWrite: 5 },
              cumulativeTokens: { input: 100, output: 30, cacheRead: 70, cacheWrite: 50 },
            },
            {
              kind: "compaction",
              key: "compact",
              compactionId: "compact",
              status: "completed",
              trigger: "auto",
              summary: "",
              error: null,
              preTokens: 10000,
              postTokens: 123,
              durationMs: 4,
            },
            {
              kind: "diagnostic",
              key: "files",
              code: "files:record",
              severity: "error",
              message: "",
              details: {
                files: [{ filename: "report.pdf", file_id: "file" }],
                failed: [{ filename: "chart.png", error: "Save failed" }],
              },
            },
          ],
        },
      ],
    },
    null,
  );
  expect(JSON.stringify(state)).not.toContain("Private content");
  const fact = nativeHistoryFacts(state)[0]!;
  expect(fact.usage).toMatchObject({
    used: 123,
    size: 200000,
    model: "actual",
    contextEstimated: false,
    cost: { amount: 0.012345, currency: "USD" },
    tokens: { input: 10, output: 3, cacheRead: 7, cacheWrite: 5 },
  });
  expect(fact.compactions).toEqual([
    expect.objectContaining({
      compactionId: "compact",
      trigger: "auto",
      preTokens: 10000,
      postTokens: 123,
      durationMs: 4,
    }),
  ]);
  expect(fact.artifacts).toEqual([
    { filename: "report.pdf", fileId: "file", error: undefined },
    { filename: "chart.png", fileId: undefined, error: "Save failed" },
  ]);
  const reopened = nativeStateFromSnapshot(
    {
      ...snapshot,
      turns: [
        {
          sequence: 1,
          clientUserMessageId: "client",
          nativeUserMessageId: "record",
          promptText: null,
          stopReason: "end_turn",
          updates: [],
        },
      ],
    },
    state,
  );
  expect(nativeHistoryFacts(reopened)[0]).toEqual(fact);
});

it("retains the newest facts within Core's total serialized byte budget", () => {
  const snapshot = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "task",
    sessionId: "native",
  });
  const state = nativeStateFromSnapshot(
    {
      ...snapshot,
      turns: Array.from({ length: 64 }, (_, index) => ({
        sequence: index,
        clientUserMessageId: `client-${index}`,
        nativeUserMessageId: `record-${index}`,
        promptText: null,
        stopReason: "error",
        error: "失败🙂".repeat(1000),
        updates: [],
      })),
    },
    null,
  );
  expect(Buffer.byteLength(JSON.stringify(state), "utf8")).toBeLessThanOrEqual(262144);
  expect(state.turns?.at(-1)?.client_user_message_id).toBe("client-63");
  expect(state.turns?.length).toBeLessThan(64);
});

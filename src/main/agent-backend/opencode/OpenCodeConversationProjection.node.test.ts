import { expect, it } from "vite-plus/test";
import {
  AGENT_CONVERSATION_MAX_SESSION_BYTES,
  AGENT_CONVERSATION_MAX_TURNS,
  emptyAgentConversationSnapshot,
} from "../AgentConversationProjection";
import { projectOpenCodeHistory } from "./OpenCodeConversationProjection";
import { openCodeAssistantMessage, openCodeUserMessage } from "./OpenCodeHistory.test-fixtures";

const initial = () =>
  emptyAgentConversationSnapshot({
    backend: "opencode",
    threadId: "thread",
    sessionId: "ses_native",
  });

it.each([
  ["the same millisecond", 1],
  ["an earlier timestamp", 0],
] as const)(
  "joins an assistant to its parent at %s regardless of input or ID order",
  (_label, created) => {
    const user = openCodeUserMessage("msg_zzzz", "Native prompt");
    const assistant = openCodeAssistantMessage(
      "msg_0000",
      user.info.id,
      "Native response",
      created,
    );
    for (const messages of [
      [user, assistant],
      [assistant, user],
    ]) {
      const restored = projectOpenCodeHistory(initial(), messages, 100_000);
      expect(restored.turns).toHaveLength(1);
      expect(restored.turns[0]).toMatchObject({
        nativeUserMessageId: user.info.id,
        promptText: "Native prompt",
        status: "completed",
        stopReason: "stop",
        updates: [
          { kind: "message", messageId: assistant.info.id, text: "Native response" },
          { kind: "usage", size: 100_000, used: 1 },
        ],
      });
    }
  },
);

it("joins interleaved messages by parent identity without crossing native sessions or guessing an orphan", () => {
  const first = openCodeUserMessage("msg_first", "First prompt");
  const second = openCodeUserMessage("msg_second", "Second prompt", 2);
  const firstResponse = openCodeAssistantMessage("msg_a", first.info.id, "First response", 3);
  const secondResponse = openCodeAssistantMessage("msg_b", second.info.id, "Second response", 0);
  const messages = [
    secondResponse,
    openCodeUserMessage(first.info.id, "Foreign prompt", 1, "ses_other"),
    firstResponse,
    second,
    openCodeAssistantMessage("msg_foreign", first.info.id, "Foreign response", 1, "ses_other"),
    openCodeAssistantMessage("msg_orphan", "msg_missing", "Orphan response"),
    first,
  ];
  for (const input of [messages, messages.toReversed()]) {
    const restored = projectOpenCodeHistory(initial(), input);
    expect(restored.turns.map((turn) => turn.nativeUserMessageId)).toEqual([
      first.info.id,
      second.info.id,
    ]);
    expect(
      restored.turns.map((turn) => turn.updates.filter((update) => update.kind === "message")),
    ).toEqual([
      [expect.objectContaining({ messageId: firstResponse.info.id, text: "First response" })],
      [expect.objectContaining({ messageId: secondResponse.info.id, text: "Second response" })],
    ]);
  }
});

it("keeps native compaction summaries with their preceding user turn", () => {
  const user = openCodeUserMessage("msg_user", "Prompt");
  const compaction = {
    ...openCodeUserMessage("msg_zzzz", "", 2),
    parts: [
      {
        type: "compaction" as const,
        id: "prt_compact",
        sessionID: "ses_native",
        messageID: "msg_zzzz",
        auto: false,
      },
    ],
  };
  const assistant = openCodeAssistantMessage("msg_0000", compaction.info.id, "Summary", 2);
  const summary = {
    ...assistant,
    info:
      assistant.info.role === "assistant" ? { ...assistant.info, summary: true } : assistant.info,
  };
  const continued = openCodeAssistantMessage(
    "msg_continued",
    user.info.id,
    "Continued response",
    3,
  );
  const restored = projectOpenCodeHistory(initial(), [continued, summary, compaction, user]);
  expect(restored.turns).toHaveLength(1);
  expect(restored.turns[0]).toMatchObject({
    nativeUserMessageId: user.info.id,
    updates: [
      { kind: "message", role: "compaction", messageId: assistant.info.id, text: "Summary" },
      { kind: "usage" },
      { kind: "message", role: "agent", messageId: continued.info.id, text: "Continued response" },
    ],
    completedAt: new Date(4).toISOString(),
  });
});

it.each([64, 65, 100])(
  "keeps complete prompt and response identities when restoring %i turns",
  (count) => {
    const turns = Array.from({ length: count }, (_, index) => {
      const user = openCodeUserMessage(
        `msg_user_${String(index).padStart(3, "0")}`,
        `Prompt ${index}`,
        index * 2 + 1,
      );
      const assistant = openCodeAssistantMessage(
        `msg_assistant_${index}`,
        user.info.id,
        `Response ${index}`,
        index * 2 + 2,
      );
      return { user, assistant };
    });
    const restored = projectOpenCodeHistory(
      initial(),
      turns.flatMap(({ user, assistant }) => [assistant, user]).toReversed(),
    );
    expect(restored.turns).toMatchObject(
      turns.slice(-AGENT_CONVERSATION_MAX_TURNS).map(({ user, assistant }) => ({
        nativeUserMessageId: user.info.id,
        promptText: user.parts[0]?.type === "text" ? user.parts[0].text : null,
        updates: [
          {
            kind: "message",
            messageId: assistant.info.id,
            text: assistant.parts[0]?.type === "text" ? assistant.parts[0].text : null,
          },
          { kind: "usage" },
        ],
      })),
    );
  },
);

it("evicts complete older turns under the byte budget without replaying them as anonymous responses", () => {
  const turns = Array.from({ length: 40 }, (_, index) => {
    const prompt = `Prompt ${index} ${"x".repeat(60 * 1024)}`;
    const user = openCodeUserMessage(`msg_user_${index}`, prompt, index * 2 + 1);
    const assistant = openCodeAssistantMessage(
      `msg_assistant_${index}`,
      user.info.id,
      `Response ${index}`,
      index * 2 + 2,
    );
    return { user, assistant, prompt, text: `Response ${index}` };
  });
  const restored = projectOpenCodeHistory(
    initial(),
    turns.flatMap(({ user, assistant }) => [user, assistant]),
  );
  expect(restored.turns.length).toBeGreaterThan(0);
  expect(Buffer.byteLength(JSON.stringify(restored.turns))).toBeLessThanOrEqual(
    AGENT_CONVERSATION_MAX_SESSION_BYTES,
  );
  const expected = new Map(turns.map((turn) => [turn.user.info.id, turn]));
  for (const turn of restored.turns) {
    const original = expected.get(turn.nativeUserMessageId ?? "");
    expect(original).toBeDefined();
    expect(turn).toMatchObject({
      promptText: original?.prompt,
      updates: [
        { kind: "message", messageId: original?.assistant.info.id, text: original?.text },
        { kind: "usage" },
      ],
    });
  }
  expect(restored.turns.at(-1)?.nativeUserMessageId).toBe(turns.at(-1)?.user.info.id);
  expect(restored.turns.map((turn) => turn.sequence)).toEqual(
    restored.turns.map((turn) => turn.sequence).toSorted((a, b) => (a ?? 0) - (b ?? 0)),
  );
});

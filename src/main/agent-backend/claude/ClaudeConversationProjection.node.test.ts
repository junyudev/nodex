import { expect, it } from "vite-plus/test";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  beginAgentConversationTurn,
  diffAgentConversationSnapshots,
  emptyAgentConversationSnapshot,
} from "../AgentConversationProjection";
import { createClaudeMessageProjection } from "./ClaudeConversationProjection";

it("keeps tool identity and reports current context independently of cumulative usage", () => {
  const project = createClaudeMessageProjection();
  let snapshot = beginAgentConversationTurn(
    emptyAgentConversationSnapshot({ backend: "claude", threadId: "thread", sessionId: "session" }),
    1,
    "Inspect",
  );
  const events = [
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "root",
        usage: { input_tokens: 10, cache_read_input_tokens: 80, cache_creation_input_tokens: 5 },
        content: [
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "README.md" } },
        ],
      },
    },
    {
      type: "assistant",
      parent_tool_use_id: "child",
      message: { id: "child", usage: { input_tokens: 500 }, content: [] },
    },
    {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "read-1", content: "File contents", is_error: false },
        ],
      },
    },
    {
      type: "result",
      modelUsage: {
        sonnet: {
          inputTokens: 1000,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 2000,
          contextWindow: 200000,
        },
      },
      total_cost_usd: 0.25,
    },
  ];
  for (const event of events) snapshot = project(snapshot, event as unknown as SDKMessage, 1);
  expect(snapshot.turns[0]?.updates).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "tool-call",
        title: "Read",
        toolCallId: "read-1",
        status: "completed",
        detail: "File contents",
        input: JSON.stringify({ file_path: "README.md" }),
      }),
      expect.objectContaining({
        kind: "usage",
        used: 95,
        size: 200000,
        cost: { amount: 0.25, currency: "USD" },
      }),
    ]),
  );
});

it("emits one consecutive revision for a multi-block SDK record", () => {
  const before = emptyAgentConversationSnapshot({
    backend: "claude",
    threadId: "thread",
    sessionId: "session",
  });
  const after = createClaudeMessageProjection()(
    before,
    {
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        id: "message",
        content: [
          { type: "text", text: "Inspecting" },
          { type: "tool_use", id: "tool", name: "Read", input: {} },
        ],
      },
    } as unknown as SDKMessage,
    1,
  );
  expect(after.revision).toBe(before.revision + 1);
  expect(diffAgentConversationSnapshots(before, after)?.turns[0]?.updates).toHaveLength(2);
});

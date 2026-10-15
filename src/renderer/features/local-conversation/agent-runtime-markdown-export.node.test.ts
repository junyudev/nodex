import { expect, test, vi } from "vite-plus/test";
import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeConversation } from "../../../shared/agent-runtime-api";
import { createAgentRuntimeMarkdownReader } from "./agent-runtime-markdown-export";
import { streamReadOnlyConversationMarkdown } from "./copy-conversation-markdown";

const target = { sessionId: "product-session", threadId: "selected-child" };
const base = {
  threadId: "fork-origin",
  runId: "original-run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  startedAt: "2026-10-15T00:00:00Z",
  completedAt: null,
  updatedAt: "2026-10-15T00:00:00Z",
  status: "completed" as const,
};
const user: AgentTurnItem = {
  ...base,
  id: "original-user",
  ordinal: 1,
  type: "user_message",
  messageId: "user-message",
  text: "Original question",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
  inputIntent: "turn_start",
};
const command: AgentTurnItem = {
  ...base,
  id: "original-command",
  ordinal: 2,
  type: "command_execution",
  input: "printf result",
  outputOmitted: true,
  exitCode: 0,
};
const answer: AgentTurnItem = {
  ...base,
  id: "original-answer",
  ordinal: 3,
  type: "assistant_message",
  text: "Original answer",
  streaming: false,
  messageId: "answer-message",
};
const row = (item: AgentTurnItem, position = 0) => ({
  position,
  visibility: "inherited" as const,
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});
const snapshot = {
  kind: "snapshot",
  snapshotSequence: 10,
  historyCursor: "older",
  hasMoreHistory: true,
  projection: {
    thread: {
      id: target.threadId,
      worktreePath: "/workspace",
      runtimeMode: "full-access",
      modelSelection: { instanceId: "codex", model: "model" },
    },
    runs: [],
    visibleTurnItems: [row(command), row(answer, 1)],
  },
} as unknown as AgentSnapshot;
const conversation: AgentRuntimeConversation = { ...target, projectId: null, snapshot };

test("copy pages the selected Session and explicitly reads only omitted captured-ancestry items", async () => {
  const transport = {
    read: vi.fn(async () => conversation),
    history: vi.fn(async () => ({
      snapshotSequence: 10,
      items: [row(user)],
      nextCursor: null,
      hasMoreHistory: false,
    })),
    item: vi.fn(async () => ({ ...command, outputOmitted: false, output: "Full tool result" })),
  };
  const chunks: string[] = [];
  for await (const chunk of streamReadOnlyConversationMarkdown({
    title: "Selected child",
    cwd: "/workspace",
    signal: new AbortController().signal,
    readPage: createAgentRuntimeMarkdownReader(target, transport),
  }))
    chunks.push(chunk);
  const markdown = chunks.join("");
  expect(transport.read).toHaveBeenCalledExactlyOnceWith(target);
  expect(transport.history).toHaveBeenCalledExactlyOnceWith({
    ...target,
    cursor: "older",
    conversationOnly: true,
  });
  expect(transport.item).toHaveBeenCalledExactlyOnceWith({
    ...target,
    itemId: "original-command",
    sourceThreadId: "fork-origin",
    full: true,
  });
  expect(markdown).toContain("Original question");
  expect(markdown).toContain("Full tool result");
  expect(markdown).toContain("Original answer");
  expect(markdown.indexOf("Original question")).toBeLessThan(markdown.indexOf("Original answer"));
  expect(conversation.snapshot.projection.visibleTurnItems[0]!.item).toBe(command);
  expect("output" in command).toBe(false);
});

test("changed product bindings and unavailable detail stop export before later pages", async () => {
  const transport = {
    read: vi.fn(async () => ({ ...conversation, threadId: "another-thread" })),
    history: vi.fn(async () => ({
      snapshotSequence: 10,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    })),
    item: vi.fn(async () => null),
  };
  await expect(createAgentRuntimeMarkdownReader(target, transport)(null)).rejects.toThrow(
    "Conversation identity changed",
  );
  expect(transport.history).not.toHaveBeenCalled();
  expect(transport.item).not.toHaveBeenCalled();
  transport.read.mockResolvedValue(conversation);
  await expect(createAgentRuntimeMarkdownReader(target, transport)(null)).rejects.toThrow(
    "Conversation item is unavailable",
  );
  expect(transport.history).not.toHaveBeenCalled();
});

import { expect, it } from "vitest";
import type { SessionNotification } from "effect-acp/compat";
import { normalizeAntigravitySessionUpdate } from "../provider/acp/AntigravityProtocol.ts";
import { foldAntigravityImportReplay } from "./AntigravityImportSource.ts";

const cwd = "/workspace";
const asNotification = (update: SessionNotification["update"]): SessionNotification => ({
  sessionId: "fixture",
  update,
});
const text = (value: string) => ({ type: "text" as const, text: value });
const chunk = (
  sessionUpdate: "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk",
  value: string,
  messageId?: string,
) => asNotification({ sessionUpdate, content: text(value), ...(messageId ? { messageId } : {}) });

it("folds observed Antigravity wire shapes into ordered, rich history", () => {
  const preamble =
    "Created At: 2000-01-01\nCompleted At: 2000-01-02\nCommand exited with code 0.\n\nCommand output:\n";
  const content = (value: string) => [{ type: "content" as const, content: text(value) }];
  const updates = [
    chunk("user_message_chunk", "Show"),
    asNotification({ sessionUpdate: "usage_update", used: 3, size: 100 }),
    chunk("user_message_chunk", " a file."),
    asNotification({
      sessionUpdate: "user_message_chunk",
      content: { type: "image", mimeType: "image/png", data: "AQID" },
    }),
    chunk("agent_thought_chunk", "Checking"),
    chunk("agent_thought_chunk", " the file."),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "shell",
      name: "run_command",
      title: "Run a command",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "printf hello" },
    }),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "read",
      title: "Read note.txt",
      kind: "read",
      status: "completed",
      locations: [{ path: "/workspace/note.txt" }],
      rawOutput: "note",
    }),
    asNotification({
      sessionUpdate: "tool_call_update",
      toolCallId: "shell",
      name: "run_command",
      kind: "execute",
      status: "completed",
      rawOutput: { output: preamble + "hello", exit_code: 0 },
      content: content(preamble + "hello"),
    }),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "mcp",
      name: "mcp_nodex_app_get_context",
      title: "Nodex context",
      kind: "other",
      status: "completed",
      rawInput: { toolSummary: "Get context", id: "note" },
      rawOutput: { content: [text("context")] },
    }),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "failed",
      title: "Search files",
      kind: "search",
      status: "failed",
      content: content("Permission denied"),
    }),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "edit",
      title: "Edit note",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", path: "/workspace/note.txt", oldText: "before\n", newText: "after\n" },
      ],
    }),
    asNotification({
      sessionUpdate: "plan",
      entries: [{ content: "Read the note", priority: "medium", status: "completed" }],
    }),
    chunk("agent_message_chunk", "Here is", "reply"),
    asNotification({ sessionUpdate: "available_commands_update", availableCommands: [] }),
    asNotification({ sessionUpdate: "session_info_update", title: "Fixture" }),
    asNotification({ sessionUpdate: "current_mode_update", currentModeId: "ask" }),
    asNotification({ sessionUpdate: "config_option_update", configOptions: [] }),
    chunk("agent_message_chunk", " the note.", "reply"),
    chunk("user_message_chunk", "Thanks", "next"),
    chunk("user_message_chunk", "One more thing", "third"),
    chunk("agent_message_chunk", "Sure."),
  ];
  const fold = () =>
    foldAntigravityImportReplay({ cwd, updates: updates.map(normalizeAntigravitySessionUpdate) });
  const rows = fold();
  expect(rows).toEqual(fold());
  expect(new Set(rows.map(({ item }) => item.id)).size).toBe(rows.length);
  expect(rows.map(({ turnId }) => turnId)).toEqual([
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "1",
    "2",
    "3",
    "3",
  ]);
  expect(rows.map(({ item }) => item)).toMatchObject([
    {
      type: "userMessage",
      content: [{ text: "Show a file." }, { url: "data:image/png;base64,AQID" }],
    },
    { type: "reasoning", content: ["Checking the file."] },
    {
      type: "commandExecution",
      command: "printf hello",
      cwd,
      aggregatedOutput: "hello",
      exitCode: 0,
      status: "completed",
    },
    {
      type: "dynamicToolCall",
      tool: "Read",
      arguments: { path: "/workspace/note.txt" },
      contentItems: [{ text: "note" }],
    },
    {
      type: "mcpToolCall",
      server: "nodex_app",
      tool: "get_context",
      arguments: { id: "note" },
      result: { content: [text("context")] },
    },
    { type: "dynamicToolCall", status: "failed", contentItems: [{ text: "Permission denied" }] },
    {
      type: "fileChange",
      changes: [{ path: "/workspace/note.txt", diff: "@@ -1,1 +1,1 @@\n-before\n+after\n" }],
    },
    { type: "plan", text: "- [x] Read the note" },
    { type: "agentMessage", text: "Here is the note." },
    { type: "userMessage", content: [{ text: "Thanks" }] },
    { type: "userMessage", content: [{ text: "One more thing" }] },
    { type: "agentMessage", text: "Sure." },
  ]);
});

it("keeps Antigravity replay screenshots inside the MCP result after a summary update", () => {
  const screenshot = { type: "image", mimeType: "image/png", data: "AQID" };
  const updates = [
    chunk("user_message_chunk", "Capture the browser."),
    asNotification({
      sessionUpdate: "tool_call",
      toolCallId: "capture",
      title: "Capture browser",
      kind: "other",
      status: "in_progress",
      rawInput: { ServerName: "browser", ToolName: "screenshot", Arguments: { fullPage: true } },
    }),
    asNotification({
      sessionUpdate: "tool_call_update",
      toolCallId: "capture",
      status: "completed",
      rawOutput: { result: { content: [screenshot] } },
    }),
    asNotification({
      sessionUpdate: "tool_call_update",
      toolCallId: "capture",
      status: "completed",
      rawOutput: "Browser captured",
    }),
  ];
  expect(
    foldAntigravityImportReplay({ cwd, updates: updates.map(normalizeAntigravitySessionUpdate) })[1]
      ?.item,
  ).toMatchObject({
    type: "mcpToolCall",
    server: "browser",
    tool: "screenshot",
    status: "completed",
    arguments: { fullPage: true },
    result: { content: [text("Browser captured"), screenshot] },
  });
});

it("fails on unknown updates and on replays without any transcript", () => {
  expect(() =>
    foldAntigravityImportReplay({
      cwd,
      updates: [
        chunk("agent_message_chunk", "Partial"),
        asNotification({ sessionUpdate: "_unknown", originalSessionUpdate: "mystery", raw: {} }),
      ],
    }),
  ).toThrow("Antigravity returned an unsupported conversation update");
  expect(() =>
    foldAntigravityImportReplay({
      cwd,
      updates: [chunk("agent_thought_chunk", "Only thoughts")],
    }),
  ).toThrow("Antigravity didn't return this conversation's history, so it can't be copied.");
});

it("uses v2 message snapshots and retains streamed tool output", () => {
  const updates = [
    asNotification({ sessionUpdate: "user_message", messageId: "user", content: [text("Run it")] }),
    asNotification({
      sessionUpdate: "tool_call_update",
      toolCallId: "shell",
      title: "Run",
      kind: "execute",
      rawInput: { command: "printf hello" },
    }),
    asNotification({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "shell",
      content: { type: "content", content: text("hel") },
    }),
    asNotification({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "shell",
      content: { type: "content", content: text("lo") },
    }),
    asNotification({ sessionUpdate: "tool_call_update", toolCallId: "shell", status: "completed" }),
    chunk("agent_message_chunk", "Draft", "reply"),
    asNotification({
      sessionUpdate: "agent_message",
      messageId: "reply",
      content: [text("Finished"), text("Result above")],
    }),
  ];
  expect(foldAntigravityImportReplay({ cwd, updates }).map(({ item }) => item)).toMatchObject([
    { type: "userMessage", content: [expect.objectContaining({ text: "Run it" })] },
    {
      type: "commandExecution",
      command: "printf hello",
      aggregatedOutput: "hello",
      status: "completed",
    },
    { type: "agentMessage", text: "Finished\nResult above" },
  ]);
});

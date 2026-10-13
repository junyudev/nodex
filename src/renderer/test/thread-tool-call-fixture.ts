import type { CodexMcpToolCallView, CodexTranscriptEntry } from "@/lib/types";

const WORKSPACE_PATH = "/workspace/nodex";
function buildToolItem(overrides: Partial<CodexTranscriptEntry>): CodexTranscriptEntry {
  return {
    threadId: "thread-activity-fixture",
    turnId: "turn-activity-fixture",
    itemId: "item-activity-fixture",
    type: "tool_call",
    kind: "toolCall",
    semanticKind: "toolCall",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const mcpResult: NonNullable<CodexMcpToolCallView["result"]> = {
  type: "success",
  content: [{ type: "text", text: "Found renderer interaction documentation." }],
  structuredContent: null,
  raw: {
    content: [{ type: "text", text: "Found renderer interaction documentation." }],
    structuredContent: null,
    _meta: null,
  },
};

/** Representative production tool shapes shared by browser behavior and pressure checks. */
export const THREAD_TOOL_CALL_FIXTURE_ITEMS = {
  command: buildToolItem({
    itemId: "tool_fixture_command",
    type: "command_execution",
    kind: "commandExecution",
    semanticKind: "exec",
    status: "completed",
    command: "rg --files src/renderer/features/local-conversation",
    cwd: WORKSPACE_PATH,
    processId: "4172",
    commandActions: [
      {
        type: "listFiles",
        command: "rg --files src/renderer/features/local-conversation",
        path: "src/renderer/features/local-conversation",
      },
      {
        type: "read",
        command:
          "sed -n '1,220p' src/renderer/features/local-conversation/view/local-conversation-thread-body.tsx",
        name: "local-conversation-thread-body.tsx",
        path: "src/renderer/features/local-conversation/view/local-conversation-thread-body.tsx",
      },
    ],
    aggregatedOutput:
      "src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx\nsrc/renderer/features/local-conversation/view/local-conversation-thread-body.tsx",
    exitCode: 0,
    durationMs: 1_200,
    toolCall: {
      subtype: "command",
      toolName: "exec_command",
      args: {
        summaryLabel: "Explored thread renderer files",
      },
      result:
        "src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx\nsrc/renderer/features/local-conversation/view/local-conversation-thread-body.tsx",
    },
  }),
  fileChange: buildToolItem({
    itemId: "tool_fixture_file_change",
    type: "file_change",
    kind: "fileChange",
    fileChange: {
      label:
        "Edited src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
      success: true,
      changes: {
        "src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx": {
          type: "update",
          movePath: null,
          unifiedDiff: [
            "@@ -1,5 +1,7 @@",
            ' import { useState } from "react";',
            '+import { ThreadBody } from "./local-conversation-thread-body";',
            " ",
            " export function LocalConversationStageScreen() {",
            "+  return <ThreadBody />;",
            " }",
          ].join("\n"),
        },
      },
    },
    toolCall: {
      subtype: "fileChange",
      toolName: "file_change",
      args: {
        label:
          "Edited src/renderer/features/local-conversation/view/local-conversation-stage-screen.tsx",
      },
      result: null,
    },
  }),
  webSearch: buildToolItem({
    itemId: "tool_fixture_web_search",
    type: "web_search",
    semanticKind: "webSearch",
    webSearch: {
      query: "react renderer interaction tests",
      action: {
        type: "search",
        queries: ["react renderer interaction tests", "react browser tests"],
      },
      completed: true,
    },
    toolCall: {
      subtype: "webSearch",
      toolName: "web_search",
      args: { query: "react renderer interaction tests" },
      result: {
        type: "search",
        queries: ["react renderer interaction tests", "react browser tests"],
      },
    },
    rawItem: {
      query: "react renderer interaction tests",
      action: {
        type: "search",
        queries: ["react renderer interaction tests", "react browser tests"],
      },
    },
  }),
  mcp: buildToolItem({
    itemId: "tool-fixture-mcp",
    type: "mcp_tool_call",
    semanticKind: "mcpToolCall",
    status: "completed",
    toolCall: {
      subtype: "mcp",
      server: "docs",
      toolName: "search",
      args: { query: "renderer interactions" },
      result: mcpResult,
    },
    mcpToolCall: {
      callId: "call-fixture-mcp",
      functionName: "docs__search",
      pluginId: null,
      mcpAppResourceUri: undefined,
      source: null,
      invocation: {
        server: "docs",
        tool: "search",
        arguments: { query: "renderer interactions" },
      },
      durationMs: 120,
      completed: true,
      result: mcpResult,
      readOnlyHint: true,
    },
  }),
};

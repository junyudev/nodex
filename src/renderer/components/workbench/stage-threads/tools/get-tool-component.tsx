import type { ComponentType } from "react";
import type { CodexItemView } from "../../../../lib/types";
import { CommandToolCall } from "./command-tool-call";
import { FileChangeToolCall } from "./file-change-tool-call";
import { GenericToolCall } from "./generic-tool-call";
import { McpToolCall } from "./mcp-tool-call";
import { WebSearchToolCall } from "./web-search-tool-call";

export interface ToolComponentProps {
  item: CodexItemView;
  projectWorkspacePath?: string;
  threadCwd?: string;
}

type ToolComponent = ComponentType<ToolComponentProps>;

export function getToolComponent(item: CodexItemView): ToolComponent {
  if (item.normalizedKind === "commandExecution" || item.toolCall?.subtype === "command") {
    return CommandToolCall;
  }

  if (item.normalizedKind === "fileChange" || item.toolCall?.subtype === "fileChange") {
    return FileChangeToolCall;
  }

  if (item.toolCall?.subtype === "webSearch") {
    return WebSearchToolCall;
  }

  if (item.toolCall?.subtype === "mcp") {
    return McpToolCall;
  }

  return GenericToolCall;
}

import { resolveNativeSessionHandoffScope } from "../../../projection/tool-metadata/native-session-handoff";
import { NativeSessionHandoffToolCall } from "./native-session-handoff-tool-call";
import type { ComponentType } from "react";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import type { ThreadStageActions } from "../../../thread-stage-types";
import { CommandToolCall } from "./command-tool-call";
import { DynamicToolCall } from "./dynamic-tool-call";
import { FileChangeToolCall } from "./file-change-tool-call";
import { McpToolCall } from "./mcp-tool-call";
import { NativeAutomationToolCall } from "./native-automation-tool-call";
import { WebSearchToolCall } from "./web-search-tool-call";

export interface ToolComponentProps {
  item: CodexTranscriptEntry;
  projectWorkspacePath?: string;
  threadCwd?: string;
  isTurnCancelled?: boolean;
  isStreamingTurn?: boolean;
  automaticApprovalReviews?: CodexTranscriptEntry[];
  hideHeader?: boolean;
  showDiffDetails?: boolean;
  onOpenFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
}

type ToolComponent = ComponentType<ToolComponentProps>;

export function getToolComponent(item: CodexTranscriptEntry): ToolComponent | null {
  if (resolveNativeSessionHandoffScope(item.mcpToolCall, item.threadId))
    return NativeSessionHandoffToolCall;
  if (item.automationUpdate?.source === "nativeMcp") return NativeAutomationToolCall;
  if (item.semanticKind === "exec" || item.kind === "commandExecution") {
    return CommandToolCall;
  }

  if (item.kind === "fileChange") {
    return FileChangeToolCall;
  }

  if (item.semanticKind === "webSearch" || item.toolCall?.subtype === "webSearch") {
    return WebSearchToolCall;
  }

  if (item.semanticKind === "mcpToolCall" || item.toolCall?.subtype === "mcp") {
    return McpToolCall;
  }

  if (item.semanticKind === "dynamicToolCall" || item.toolCall?.subtype === "dynamic") {
    return DynamicToolCall;
  }

  return null;
}

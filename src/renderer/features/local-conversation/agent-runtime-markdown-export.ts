import type { AgentRuntimeSessionTarget } from "../../../shared/agent-runtime-api";
import type {
  AgentRuntimeProjectedItem,
  AgentRuntimeThread,
  AgentRuntimeRun,
} from "./agent-runtime-transcript-projection";
import { projectAgentRuntimeExportTurns } from "./agent-runtime-transcript-projection";
import {
  agentRuntimeRuntime,
  type AgentRuntimeRendererTransport,
} from "../../lib/agent-runtime-runtime";
import { copyReadOnlyConversationMarkdown } from "./copy-conversation-markdown";

/** Copy is an explicit paged read; exported bodies never enter the resident UI cache. */
export function createAgentRuntimeMarkdownReader(
  target: AgentRuntimeSessionTarget,
  transport: Pick<AgentRuntimeRendererTransport, "read" | "history" | "item"> = agentRuntimeRuntime,
) {
  let thread: AgentRuntimeThread | null = null;
  let runs: readonly AgentRuntimeRun[] = [];
  let threadId: string | null = target.threadId ?? null;
  return async (cursor: string | null) => {
    let rows: readonly AgentRuntimeProjectedItem[];
    let olderCursor: string | null;
    if (cursor === null) {
      const conversation = await transport.read(target);
      if (
        conversation.sessionId !== target.sessionId ||
        (threadId !== null && conversation.threadId !== threadId)
      )
        throw new Error("Conversation identity changed");
      threadId = conversation.threadId;
      thread = conversation.snapshot.projection.thread;
      if (thread.id !== threadId) throw new Error("Conversation identity changed");
      runs = conversation.snapshot.projection.runs;
      rows = conversation.snapshot.projection.visibleTurnItems;
      olderCursor = conversation.snapshot.historyCursor ?? null;
      if (conversation.snapshot.hasMoreHistory && !olderCursor)
        throw new Error("History cursor is unavailable");
    } else {
      if (!thread || !threadId) throw new Error("Conversation export has not started");
      const page = await transport.history({ ...target, threadId, cursor, conversationOnly: true });
      rows = page.items;
      olderCursor = page.hasMoreHistory ? page.nextCursor : null;
      if (page.hasMoreHistory && !olderCursor) throw new Error("History cursor is unavailable");
    }
    const complete: AgentRuntimeProjectedItem[] = [];
    for (const row of rows) {
      const item = row.item;
      if (!("outputOmitted" in item) || !item.outputOmitted) {
        complete.push(row);
        continue;
      }
      const full = await transport.item({
        ...target,
        threadId: threadId!,
        itemId: row.sourceItemId,
        sourceThreadId: row.sourceThreadId,
        full: true,
      });
      if (
        !full ||
        full.id !== row.sourceItemId ||
        full.threadId !== row.sourceThreadId ||
        full.runId !== item.runId
      )
        throw new Error("Conversation item is unavailable");
      complete.push({ ...row, item: full });
    }
    return { turns: projectAgentRuntimeExportTurns(thread!, complete, runs), olderCursor };
  };
}

export function copyAgentRuntimeConversationMarkdown(
  target: AgentRuntimeSessionTarget,
  title: string,
  cwd: string | null,
  transport: Pick<AgentRuntimeRendererTransport, "read" | "history" | "item"> = agentRuntimeRuntime,
) {
  return copyReadOnlyConversationMarkdown({
    title,
    cwd,
    readPage: createAgentRuntimeMarkdownReader(target, transport),
  });
}

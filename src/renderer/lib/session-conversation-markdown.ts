import { copyAgentRuntimeConversationMarkdown } from "@/features/local-conversation/agent-runtime-markdown-export";
import { copyConversationMarkdown } from "@/features/local-conversation/copy-conversation-markdown";
import {
  resolveSessionExecution,
  resolveSessionMarkdownExport,
  type SessionExecutionSource,
} from "./session-execution";

/**
 * Copies a Session's conversation through its execution owner's paged export. Runtime chats
 * read bounded Runtime history pages; native Codex chats use the native exporter.
 */
export async function copySessionConversationMarkdown(
  session: SessionExecutionSource,
  title: string,
  cwd: string | null = null,
): Promise<void> {
  const target = resolveSessionMarkdownExport(resolveSessionExecution(session));
  if (!target) return;
  if (target.kind === "runtime") {
    await copyAgentRuntimeConversationMarkdown(target.target, title, cwd);
    return;
  }
  await copyConversationMarkdown({
    conversationId: target.conversationId,
    executionHostId: target.executionHostId,
    parentConversationId: target.parentConversationId,
    title,
  });
}

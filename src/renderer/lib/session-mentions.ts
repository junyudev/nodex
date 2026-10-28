import type { CodexThreadSummary } from "./types";
import { readCurrentProjectSessionDetail } from "./project-session-query-cache";
import { sessionExecutionThreadId, runtimeSessionThreadSummary } from "./session-execution";
import { readCodexThreadSummary } from "./codex-thread-summary";

/** A mention's stable identity is its Session; execution details are only presentation. */
export async function readSessionMentionSummary(
  sessionId: string,
): Promise<CodexThreadSummary | null> {
  const session = await readCurrentProjectSessionDetail(sessionId);
  if (!session) return null;
  const threadId = sessionExecutionThreadId(session);
  const summary = threadId ? await readCodexThreadSummary(threadId) : null;
  return {
    ...(summary ?? runtimeSessionThreadSummary(session, threadId ?? session.id)),
    threadName: session.displayTitle,
  };
}

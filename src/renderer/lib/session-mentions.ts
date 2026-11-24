import type { CodexThreadSummary } from "./types";
import { readCurrentProjectSessionDetail } from "./project-session-query-cache";
import { sessionExecutionThreadId, runtimeSessionThreadSummary } from "./session-execution";

/** A mention's stable identity is its Session; execution details are only presentation. */
export async function readSessionMentionSummary(
  sessionId: string,
): Promise<CodexThreadSummary | null> {
  const session = await readCurrentProjectSessionDetail(sessionId);
  if (!session) return null;
  const threadId = sessionExecutionThreadId(session);
  const summary = runtimeSessionThreadSummary(session, threadId ?? session.id);
  const native = session.executionRef ? null : session.thread;
  return {
    ...summary,
    ...(native
      ? {
          ...native,
          source: native.parentThreadId ? { parentThreadId: native.parentThreadId } : null,
          cwd: native.cwd ?? null,
        }
      : {}),
    sessionId: session.id,
    threadName: session.displayTitle,
    archived: session.archived || native?.archived === true,
  };
}

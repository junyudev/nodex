import { isAgentExecutionThreadId } from "../../shared/agent-runtime-api";

interface ThreadBoundSession {
  readonly id: string;
  readonly archived: boolean;
  readonly executionRef?: { readonly threadId: string } | null;
  readonly thread?: { readonly threadId: string } | null;
}

export interface ChatSessionForThreadPorts<S extends ThreadBoundSession> {
  readonly knownSessions: readonly S[];
  /** The Session an Agent Runtime root Thread already belongs to. */
  readonly readAgentThreadSessionId: (threadId: string) => Promise<string | null | undefined>;
  readonly resolveSessionById: (sessionId: string) => Promise<S>;
  /** Admits a native Codex Thread as a Session. */
  readonly ensureThreadSession: (threadId: string) => Promise<S | null | undefined>;
}

/** Finds the chat a Thread belongs to: a known Session, its Runtime Session, or an admitted Thread. */
export async function resolveChatSessionForThreadId<S extends ThreadBoundSession>(
  threadId: string,
  ports: ChatSessionForThreadPorts<S>,
): Promise<S> {
  const normalizedThreadId = threadId.trim();
  if (!normalizedThreadId) throw new Error("Chat thread ID is required");
  const known = ports.knownSessions.find(
    (session) =>
      (session.executionRef?.threadId ?? session.thread?.threadId) === normalizedThreadId &&
      !session.archived,
  );
  if (known) return known;
  if (isAgentExecutionThreadId(normalizedThreadId)) {
    const sessionId = await ports.readAgentThreadSessionId(normalizedThreadId);
    if (!sessionId) throw new Error("This chat is no longer available");
    return await ports.resolveSessionById(sessionId);
  }
  const materialized = await ports.ensureThreadSession(normalizedThreadId);
  if (!materialized || materialized.archived) throw new Error("This chat is no longer available");
  return materialized;
}

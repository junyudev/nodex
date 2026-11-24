import { getIntl } from "@/lib/i18n";
import type { ConversationIdentity } from "../../shared/conversation-identity";

interface ThreadBoundSession {
  readonly id: string;
  readonly archived: boolean;
  readonly executionRef?: { readonly threadId: string } | null;
  readonly thread?: { readonly threadId: string } | null;
}

export interface ChatSessionForThreadPorts<S extends ThreadBoundSession> {
  readonly knownSessions: readonly S[];
  readonly readConversationIdentity: (threadId: string) => Promise<ConversationIdentity | null>;
  readonly resolveSessionById: (sessionId: string) => Promise<S>;
  /** Admits a native Codex Thread as a Session. */
  readonly ensureThreadSession: (threadId: string) => Promise<S | null | undefined>;
}

/** Finds the owning Session; only an identified native Codex conversation may be admitted. */
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
  const identity = await ports.readConversationIdentity(normalizedThreadId);
  const materialized =
    !identity || identity.archived
      ? null
      : identity.sessionId
        ? await ports.resolveSessionById(identity.sessionId)
        : identity.execution === "native-codex"
          ? await ports.ensureThreadSession(identity.threadId)
          : null;
  if (!materialized || materialized.archived)
    throw new Error(
      getIntl().formatMessage({
        id: "lib.chatSessionForThread.unavailable",
        defaultMessage: "This chat is no longer available",
      }),
    );
  return materialized;
}

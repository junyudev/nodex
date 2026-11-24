import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { CHAT_REPLY_PREVIEW_BATCH_LIMIT } from "../../shared/chat-reply-preview";
import { queryKeys } from "./query-keys";
import { invokeRendererQuery } from "./renderer-command";

interface PendingPreview {
  readonly resolve: (text: string | null) => void;
  readonly reject: (error: unknown) => void;
}

/** Chats whose reply a row asked for in the current task; a renderer document reads one Space. */
const pending = new Map<string, PendingPreview[]>();
let flushScheduled = false;

async function readBatch(batch: ReadonlyArray<readonly [string, PendingPreview[]]>): Promise<void> {
  try {
    const previews = await invokeRendererQuery("agent-runtime:session:reply-previews", {
      sessionIds: batch.map(([sessionId]) => sessionId),
    });
    const textBySession = new Map(previews.map((preview) => [preview.sessionId, preview.text]));
    for (const [sessionId, waiters] of batch)
      for (const waiter of waiters) waiter.resolve(textBySession.get(sessionId) ?? null);
  } catch (error) {
    for (const [, waiters] of batch) for (const waiter of waiters) waiter.reject(error);
  }
}

function flush(): void {
  flushScheduled = false;
  const entries = [...pending];
  pending.clear();
  for (let start = 0; start < entries.length; start += CHAT_REPLY_PREVIEW_BATCH_LIMIT)
    void readBatch(entries.slice(start, start + CHAT_REPLY_PREVIEW_BATCH_LIMIT));
}

/**
 * A chat's latest reply as row text, or null when it has none. Rows that ask in the same task,
 * as a list does when it first shows, share one request.
 */
export function readChatReplyPreview(sessionId: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const waiters = pending.get(sessionId);
    if (waiters) waiters.push({ resolve, reject });
    else pending.set(sessionId, [{ resolve, reject }]);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(flush);
  });
}

/**
 * The latest reply of a chat a row shows, read again only when the chat comes back to a person.
 * While a newer reply loads the row keeps the one it has, so it never collapses and regrows.
 */
export function useChatReplyPreview(sessionId: string | null, attentionAt: number): string | null {
  const query = useQuery({
    queryKey: queryKeys.projectSessions.replyPreview(sessionId ?? "", attentionAt),
    queryFn: () => readChatReplyPreview(sessionId!),
    enabled: sessionId !== null,
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  return sessionId === null ? null : (query.data ?? null);
}

export interface CodexConversationResumeRetryState {
  readonly timeoutRetries: number;
  readonly closingRetries: number;
}

export const INITIAL_CONVERSATION_RESUME_RETRY: CodexConversationResumeRetryState = {
  timeoutRetries: 0,
  closingRetries: 0,
};

/** Recovery uses an explicit deadline so its controller owns timeout retries. */
export function conversationResumeRequestOptions(
  isReconnectRecovery: boolean,
  timeoutMs?: number,
): { readonly priority: "interactive" | "critical"; readonly timeoutMs?: number } {
  if (isReconnectRecovery) return { priority: "interactive", timeoutMs: 30_000 };
  return { priority: "critical", ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export function conversationResumeTimeoutMs(
  state: CodexConversationResumeRetryState,
  explicitTimeoutMs?: number | null,
): number {
  return explicitTimeoutMs ?? 120_000 * 2 ** state.timeoutRetries;
}

/** Native closing errors and default response timeouts have independent retry budgets. */
export function nextConversationResumeRetry(
  state: CodexConversationResumeRetryState,
  threadId: string,
  message: string,
  explicitTimeoutMs?: number | null,
): { readonly state: CodexConversationResumeRetryState; readonly delayMs: number } | null {
  const closing = message.includes(
    `thread ${threadId} is closing; retry thread/resume after the thread is closed`,
  );
  if (closing && state.closingRetries < 4)
    return {
      state: { ...state, closingRetries: state.closingRetries + 1 },
      delayMs: 750 * 2 ** state.closingRetries,
    };
  if (message === "Timeout" && explicitTimeoutMs == null && state.timeoutRetries < 2)
    return {
      state: { ...state, timeoutRetries: state.timeoutRetries + 1 },
      delayMs: 750,
    };
  return null;
}

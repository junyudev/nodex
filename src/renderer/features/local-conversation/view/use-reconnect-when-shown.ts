import { useEffect, useRef } from "react";

/**
 * A chat whose connection failed is not retried in a loop. It is tried once more each time the
 * chat is shown, so coming back to a chat never finds a failure that nothing acted on.
 */
export function useReconnectWhenShown(input: {
  readonly threadId: string | null;
  readonly shown: boolean;
  /** The chat may connect now: the app is connected and nothing else holds the chat. */
  readonly canConnect: boolean;
  readonly connectionFailed: boolean;
  readonly reconnect: (threadId: string) => Promise<unknown>;
}): void {
  const { threadId, shown, canConnect, connectionFailed, reconnect } = input;
  const handledThreadId = useRef<string | null>(null);
  useEffect(() => {
    if (!shown || !threadId) {
      handledThreadId.current = null;
      return;
    }
    // A showing that cannot connect yet stays open until it can.
    if (handledThreadId.current === threadId || !canConnect) return;
    handledThreadId.current = threadId;
    if (connectionFailed) void reconnect(threadId).catch(() => {});
  }, [threadId, shown, canConnect, connectionFailed, reconnect]);
}

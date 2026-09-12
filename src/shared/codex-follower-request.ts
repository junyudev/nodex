import type { ConversationCoordinationHost } from "./codex-client-coordination";
import type { CodexPeerResponse } from "./codex-peer-protocol";

export interface ConversationFollowerRequestOptions {
  hostId: string;
  targetClientId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const requestError = (error: string): CodexPeerResponse => ({
  type: "response",
  requestId: "",
  resultType: "error",
  error,
});

/** A follower request retains its wire response and releases the RPC call on every exit. */
export async function requestConversationFollower(
  service: ConversationCoordinationHost | null,
  method: string,
  params: unknown,
  options: ConversationFollowerRequestOptions,
): Promise<CodexPeerResponse> {
  if (options.signal?.aborted) return requestError("aborted");
  if (!service) return requestError("client-coordination-service-unavailable");
  const pending: Promise<CodexPeerResponse> & Partial<Disposable> = service.requestThreadFollower({
    hostId: options.hostId,
    request: { method, params },
    targetClientId: options.targetClientId,
    timeoutMs: options.timeoutMs,
  });
  try {
    const response = await waitForFollowerResponse(pending, options.signal);
    if (response.resultType === "error" || response.method === method) return { ...response };
    return requestError("thread-follower-response-method-mismatch");
  } catch (error) {
    return requestError(error instanceof Error ? error.message : "unknown-error");
  } finally {
    pending[Symbol.dispose]?.();
  }
}

function waitForFollowerResponse(
  pending: Promise<CodexPeerResponse>,
  signal?: AbortSignal,
): Promise<CodexPeerResponse> {
  if (!signal) return pending;
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error("aborted"));
    signal.addEventListener("abort", abort, { once: true });
    void pending.then(
      (response) => {
        signal.removeEventListener("abort", abort);
        resolve(response);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

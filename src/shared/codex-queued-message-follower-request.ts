export interface CodexQueuedMessageFollowerParams {
  "thread-follower-remove-queued-message": {
    readonly conversationId: string;
    readonly messageId: string;
  };
  "thread-follower-clear-queued-messages": {
    readonly conversationId: string;
  };
}

export type CodexQueuedMessageFollowerMethod = keyof CodexQueuedMessageFollowerParams;
export type CodexQueuedMessageFollowerRequest = {
  [Method in CodexQueuedMessageFollowerMethod]: {
    readonly method: Method;
    readonly params: CodexQueuedMessageFollowerParams[Method];
  };
}[CodexQueuedMessageFollowerMethod];

export interface CodexQueuedMessageFollowerResult {
  readonly applied: boolean;
}

export function isCodexQueuedMessageFollowerMethod(
  method: string,
): method is CodexQueuedMessageFollowerMethod {
  return (
    method === "thread-follower-remove-queued-message" ||
    method === "thread-follower-clear-queued-messages"
  );
}

/** Queue controls retain their target fields instead of reconstructing a captured message. */
export function parseCodexQueuedMessageFollowerRequest(
  method: string,
  params: unknown,
): CodexQueuedMessageFollowerRequest {
  if (!isCodexQueuedMessageFollowerMethod(method))
    throw new Error("Unsupported queued message follower method");
  if (params === null || typeof params !== "object" || Array.isArray(params))
    throw new Error("Invalid queued message follower request");
  const conversationId: unknown = Reflect.get(params, "conversationId");
  if (typeof conversationId !== "string" || !conversationId.trim())
    throw new Error("Invalid queued message follower conversation");
  if (method === "thread-follower-clear-queued-messages")
    return { method, params: params as CodexQueuedMessageFollowerParams[typeof method] };
  const messageId: unknown = Reflect.get(params, "messageId");
  if (typeof messageId !== "string" || !messageId.trim())
    throw new Error("Invalid queued message follower identity");
  return { method, params: params as CodexQueuedMessageFollowerParams[typeof method] };
}

/** A successful transport response must also confirm the semantic queue operation. */
export function parseCodexQueuedMessageFollowerResult(
  value: unknown,
): CodexQueuedMessageFollowerResult {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof Reflect.get(value, "applied") !== "boolean"
  )
    throw new Error("Invalid queued message follower result");
  return value as CodexQueuedMessageFollowerResult;
}

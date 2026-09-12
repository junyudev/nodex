export const CODEX_PEER_METHOD_VERSIONS: Readonly<Record<string, number>> = {
  "thread-stream-state-changed": 11,
  "thread-stream-following-changed": 1,
  "thread-stream-following-status-requested": 1,
  "ipc-connection-reset": 1,
  "thread-read-state-changed": 3,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-owner-discovery": 1,
  "thread-follower-start-turn": 2,
  "thread-follower-load-complete-history": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 4,
  "thread-follower-update-thread-settings": 2,
  "thread-follower-edit-last-user-turn": 2,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 2,
};

export const codexPeerMethodVersion = (method: string): number =>
  CODEX_PEER_METHOD_VERSIONS[method] ?? 0;

export function codexPeerRequestVersion(method: string, params?: unknown, hostId?: string): number {
  if (hostId !== undefined && method.startsWith("thread-follower-"))
    return codexPeerMethodVersion(method) + 1;
  if (
    method === "thread-follower-interrupt-turn" &&
    params !== null &&
    typeof params === "object" &&
    Reflect.get(params, "expectedTurnId") == null
  )
    return 3;
  return codexPeerMethodVersion(method);
}

export function acceptsCodexPeerRequestVersion(request: CodexPeerRequest): boolean {
  return (
    request.version === codexPeerRequestVersion(request.method, undefined, request.hostId) ||
    (request.hostId === undefined &&
      request.method === "thread-follower-interrupt-turn" &&
      request.version === 3)
  );
}

export interface CodexPeerBroadcast {
  type: "broadcast";
  method: string;
  sourceClientId: string;
  targetClientIds?: readonly string[];
  params: unknown;
  version: number;
}

export interface CodexPeerRequest {
  type: "request";
  requestId: string;
  sourceClientId: string;
  method: string;
  params: unknown;
  version: number;
  targetClientId?: string;
  hostId?: string;
  timeoutMs?: number;
}

export type CodexPeerResponse =
  | { type: "response"; requestId: string; resultType: "error"; error: string }
  | {
      type: "response";
      requestId: string;
      resultType: "success";
      method: string;
      handledByClientId: string;
      result: unknown;
    };

export type CodexPeerMessage =
  | CodexPeerBroadcast
  | CodexPeerRequest
  | CodexPeerResponse
  | { type: "client-discovery-request"; requestId: string; request: CodexPeerRequest }
  | { type: "client-discovery-response"; requestId: string; response: { canHandle: boolean } };

import type { AgentAcpFailure } from "@nodex/agent-runtime/contracts";

export type AgentManagementFailure = AgentAcpFailure & {
  readonly affectedSessions?: readonly { readonly sessionId: string; readonly threadId: string }[];
};
export type AgentManagementResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: AgentManagementFailure };

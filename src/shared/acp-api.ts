import type { AgentAcpFailure, AgentAcpManagementOperations } from "@nodex/agent-runtime/contracts";
import type { AgentManagementFailure, AgentManagementResult } from "./agent-management-result";
export type AcpFailure = AgentManagementFailure;
export type AcpResult<Value> = AgentManagementResult<Value>;

type RuntimeMethod = Exclude<keyof AgentAcpManagementOperations, "acp.activity">;
type PublicInput<Input> = Omit<Input, "ownerId" | "cwd" | "returnUrl" | "callbackMode"> &
  (Input extends { readonly cwd: string } ? { readonly projectId?: string | null } : {});
export interface AcpConversationImportInput {
  readonly instanceId: string;
  readonly projectId?: string | null;
  readonly sessionId: string;
  readonly requestId: string;
  readonly acceptedAt: number;
}
export interface AcpConversationImportResult {
  readonly sessionId: string;
  readonly threadId: string;
  readonly projectId: string | null;
}
type PublicOutput<Output> = Output extends { readonly error: AgentAcpFailure | null }
  ? Omit<Output, "error"> & { readonly error: AcpFailure | null }
  : Output;
export type AcpOperations = {
  readonly [Method in RuntimeMethod]: Method extends "acp.sessions.import"
    ? {
        readonly input: AcpConversationImportInput;
        readonly output: AcpConversationImportResult;
      }
    : {
        readonly input: PublicInput<AgentAcpManagementOperations[Method]["input"]>;
        readonly output: PublicOutput<AgentAcpManagementOperations[Method]["output"]>;
      };
};
export type AcpMethod = keyof AcpOperations;
type Channel<Method extends string> = Method extends `${infer Head}.${infer Tail}`
  ? `${Head}:${Channel<Tail>}`
  : Method;
export type AcpIpcApi = {
  readonly [Method in AcpMethod as Channel<Method>]: {
    readonly args: [input: AcpOperations[Method]["input"]];
    readonly result: AcpResult<AcpOperations[Method]["output"]>;
  };
};

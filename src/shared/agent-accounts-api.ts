import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentBackendBinding } from "./agent-backend";
import type { AgentManagementResult } from "./agent-management-result";

export type AgentAccountBackend = AgentBackendBinding;

type ProviderMethod = Extract<keyof AgentRuntimeOperations, `providers.auth.${string}`>;
export type AgentAccountOperations = {
  readonly [
    Method in ProviderMethod as Method extends `providers.auth.${infer Action}` ? Action : never
  ]: {
    readonly input: Omit<
      AgentRuntimeOperations[Method]["input"],
      "instanceId" | "ownerId" | "returnUrl" | "callbackMode"
    > & { readonly backend: AgentAccountBackend };
    readonly output: Method extends "providers.auth.read"
      ? AgentAccountState | null
      : AgentAccountState;
  };
};

export type AgentAccountState = AgentRuntimeOperations["providers.auth.read"]["output"];
export type AgentAccountIpcApi = {
  readonly [Action in keyof AgentAccountOperations as `agent-accounts:${Action}`]: {
    readonly args: [input: AgentAccountOperations[Action]["input"]];
    readonly result: AgentManagementResult<AgentAccountOperations[Action]["output"]>;
  };
};

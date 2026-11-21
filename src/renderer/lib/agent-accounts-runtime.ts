import type { AgentAccountOperations } from "../../shared/agent-accounts-api";
import type { AgentManagementResult } from "../../shared/agent-management-result";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { resolveRendererTransport } from "./renderer-transport";

type Action = keyof AgentAccountOperations;
export type AgentAccountsRuntime = {
  readonly [Key in Action]: (
    input: AgentAccountOperations[Key]["input"],
  ) => Promise<AgentManagementResult<AgentAccountOperations[Key]["output"]>>;
};

const command = <const Action extends Exclude<keyof AgentAccountOperations, "read">>(
  action: Action,
) =>
  defineRendererCommand({
    key: `agent_accounts.${action}`,
    channel: `agent-accounts:${action}` as const,
    owner: "AgentAccounts",
    authority: "external",
    protocol: { kind: "returned_value" },
  });

const start = command("start");
const respond = command("respond");
const complete = command("complete");
const cancel = command("cancel");
const logout = command("logout");

export const agentAccountsRuntime: AgentAccountsRuntime = {
  read: (input) => invokeRendererQuery("agent-accounts:read", input),
  start: (input) => invokePlainCommand(start, input),
  respond: (input) => invokePlainCommand(respond, input),
  complete: (input) => invokePlainCommand(complete, input),
  cancel: (input) => invokePlainCommand(cancel, input),
  logout: (input) => invokePlainCommand(logout, input),
};

export const agentAccountCatalog = {
  read: agentRuntimeRuntime.knownCatalog,
  subscribe: (listener: () => void) =>
    resolveRendererTransport().subscribeAgentSettingsChanges(listener),
};

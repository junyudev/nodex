import { vi } from "vite-plus/test";
import type { AgentManagementResult } from "../../../shared/agent-management-result";
import type { AgentAccountState } from "../../../shared/agent-accounts-api";
import type { AgentAccountsRuntime } from "../../lib/agent-accounts-runtime";
import { isAgentAuthActive } from "./agent-account-owner";

type AccountInput<Method extends keyof AgentAccountsRuntime> = Parameters<
  AgentAccountsRuntime[Method]
>[0];

export const ok = <Value>(value: Value): AgentManagementResult<Value> => ({ ok: true, value });

/** A result a test settles when the step it holds back should finish. */
export const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => (resolve = done));
  return { promise, resolve };
};

/** Like the Runtime, only a live flow this window can see (it has a flow ID) is cancellable. */
export const authState = (patch: Partial<AgentAccountState> = {}): AgentAccountState => {
  const state: AgentAccountState = {
    instanceId: "qoder-main",
    runtimeGeneration: "runtime-1",
    configurationRevision: 1,
    revision: 1,
    cancellable: false,
    phase: "idle",
    flowId: null,
    authorizationUrl: null,
    expiresAt: null,
    message: null,
    methods: [],
    interaction: null,
    ...patch,
  };
  return {
    ...state,
    cancellable: patch.cancellable ?? (state.flowId !== null && isAgentAuthActive(state)),
  };
};

/** The Runtime's record that a real connection reported the Agent's capabilities. */
export function fakeAccountRuntime() {
  return {
    read: vi.fn(async (_input: AccountInput<"read">) => ok(authState())),
    start: vi.fn(async (_input: AccountInput<"start">) => ok(authState())),
    respond: vi.fn(async (_input: AccountInput<"respond">) => ok(authState())),
    cancel: vi.fn(async (_input: AccountInput<"cancel">) => ok(authState({ phase: "cancelled" }))),
    logout: vi.fn(async (_input: AccountInput<"logout">) => ok(authState())),
    complete: vi.fn(async (_input: AccountInput<"complete">) => ok(authState())),
  };
}

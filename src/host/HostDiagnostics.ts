import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export const AGENT_RUNTIME_START_OPERATION = "agent-runtime.start";

/** The public diagnostic line for each startup failure. Never interpolate process error text. */
export const agentRuntimeStartReasons = {
  "host-preparation-failed": "Host could not prepare Agent execution",
  "runtime-entrypoint-missing": "Agent execution bundle is missing",
  "process-spawn-failed": "Host could not spawn the Agent execution process",
  "bootstrap-rejected": "Agent execution rejected its startup configuration",
  "initialization-failed": "Agent execution could not initialize before readiness",
  "transport-failed": "Agent execution startup transport failed",
  "exited-before-ready": "Agent execution process exited before readiness",
  "host-activation-failed": "Host could not activate Agent execution",
  "startup-timeout": "Agent execution startup timed out",
} as const;

export type AgentRuntimeStartFailure = keyof typeof agentRuntimeStartReasons;

/** A Host can provide a diagnostics sink for the same lifecycle used by desktop and headless. */
export class HostDiagnostics extends Context.Service<
  HostDiagnostics,
  {
    readonly reportAgentRuntimeStartFailure: (
      failure: AgentRuntimeStartFailure,
    ) => Effect.Effect<void>;
  }
>()("nodex/host/HostDiagnostics") {}

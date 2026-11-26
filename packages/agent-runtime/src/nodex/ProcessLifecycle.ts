import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as OpenCodeServerLedger from "@nodex/provider-opencode/server/OpenCodeServerLedger";

export const AGENT_RUNTIME_STARTUP_FAILURE_REASONS = [
  "bootstrap-rejected",
  "initialization-failed",
] as const;

/** Only fixed categories cross the process boundary before readiness. */
export interface AgentRuntimeStartupFailureFrame {
  readonly type: "startup-failed";
  readonly reason: (typeof AGENT_RUNTIME_STARTUP_FAILURE_REASONS)[number];
}

// Provider release includes escalation and ledger cleanup; the host's graceful
// deadline must enclose it before the process spawner's separate force-kill budget.
export const AGENT_RUNTIME_SHUTDOWN_TIMEOUT_MS = 10_000;
export const AGENT_RUNTIME_FORCE_KILL_AFTER_MS = 5_000;

/** Reuse the execution ledger after physical exit, before admitting a replacement. */
export const reapAgentRuntimeServers = Effect.fn("AgentRuntimeProcess.reapServers")(function* (
  home: string,
  ownerPid: number,
) {
  const ledger = yield* OpenCodeServerLedger.make({ stateDir: join(home, "userdata") });
  yield* ledger.reapOrphans({ ownerPid });
});

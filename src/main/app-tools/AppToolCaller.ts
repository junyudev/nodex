import * as Effect from "effect/Effect";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";
import type { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";
import type { AgentBackendBinding } from "../../shared/agent-backend";

export interface AppToolCaller {
  readonly backend?: AgentBackendBinding["kind"];
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly isActive: () => boolean;
}

export type AppToolAuthorityCapture = (
  caller: AppToolCaller,
) => Effect.Effect<NodexAgentTurnContext | null>;

/** Product and engine identity issued by the Host; Core execution coordinates remain separate. */
export interface HostedAppToolSessionContext {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly runtimeId: string;
  readonly rootThreadId: string;
  readonly threadId: string;
  readonly runId: string | null;
  readonly cwd: string | null;
}

interface HostedClaim {
  readonly capture: Effect.Effect<NodexAgentTurnContext | null>;
  readonly sessionContext?: HostedAppToolSessionContext;
}

// Only a host-issued object is recognized. MCP metadata cannot mint or revive a claim.
const hostedClaims = new WeakMap<AppToolCaller, HostedClaim>();

/** The execution Host issues one immutable caller; copies and MCP metadata cannot issue it. */
export function createHostedAppToolCaller(input: {
  readonly backend: AppToolCaller["backend"];
  readonly authority: NodexAgentTurnContext;
  readonly callId: string;
  readonly generation: number;
  readonly isActive: () => boolean;
  readonly capture: Effect.Effect<NodexAgentTurnContext | null>;
  readonly sessionContext?: HostedAppToolSessionContext;
}): AppToolCaller {
  const caller: AppToolCaller = Object.freeze({
    ...(input.backend ? { backend: input.backend } : {}),
    threadId: input.authority.threadId,
    turnId: input.authority.turnId,
    hostId: "local",
    callId: input.callId,
    generation: input.generation,
    isActive: input.isActive,
  });
  hostedClaims.set(caller, {
    ...(input.sessionContext ? { sessionContext: Object.freeze({ ...input.sessionContext }) } : {}),
    capture: Effect.suspend(() => (input.isActive() ? input.capture : Effect.succeed(null))).pipe(
      Effect.map((authority) => (input.isActive() ? authority : null)),
    ),
  });
  return caller;
}

/** Metadata locates the product Session; every operation must still recapture Core authority. */
export const readHostedAppToolSessionContext = (
  caller: AppToolCaller,
): HostedAppToolSessionContext | null =>
  caller.isActive() ? (hostedClaims.get(caller)?.sessionContext ?? null) : null;

export const captureHostedAppToolAuthority = (
  caller: AppToolCaller,
): Effect.Effect<NodexAgentTurnContext | null> =>
  caller.isActive()
    ? (hostedClaims.get(caller)?.capture ?? Effect.succeed(null))
    : Effect.succeed(null);

/** Invocation identity and Core authority are verified separately for each native backend. */
export const captureAppToolAuthority = (
  caller: AppToolCaller,
  codex: Pick<CodexTurnAuthority["Service"], "capture">,
): Effect.Effect<NodexAgentTurnContext | null> => {
  if (!caller.isActive()) return Effect.succeed(null);
  const issued = hostedClaims.get(caller);
  if (issued) return issued.capture;
  // Core reserves these coordinates for Host-issued execution leases.
  if (caller.threadId.startsWith("runtime:") || caller.turnId.startsWith("runtime-run:"))
    return Effect.succeed(null);
  if (caller.backend && caller.backend !== "codex") return Effect.succeed(null);
  return codex
    .capture(caller.threadId, caller.turnId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
};

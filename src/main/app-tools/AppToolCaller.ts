import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { CodexTurnAuthority } from "../codex-application/CodexTurnAuthority";

export interface AppToolCaller {
  readonly backend?: "codex" | "claudeCode";
  readonly threadId: string;
  readonly turnId: string;
  readonly callId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly isActive: () => boolean;
}

interface NativeClaim {
  readonly capture: Effect.Effect<FrozenNodexAgentTurnAuthority | null>;
}

// Only a host-issued object is recognized. MCP metadata cannot mint or revive a claim.
const nativeClaims = new WeakMap<AppToolCaller, NativeClaim>();

export function createNativeAppToolClaimIssuer(input: {
  readonly threadId: string;
  readonly hostId: string;
  readonly generation: number;
  readonly capture: (authority: FrozenNodexAgentTurnAuthority) => Effect.Effect<boolean>;
}) {
  let open = true;
  let backgroundTasksPresent = false;
  let claimEpoch = 0;
  let active: { readonly authority: FrozenNodexAgentTurnAuthority; calls: number } | null = null;
  return {
    beginTurn(authority: FrozenNodexAgentTurnAuthority): boolean {
      if (!open || active || authority.threadId !== input.threadId || !authority.turnId)
        return false;
      active = { authority: structuredClone(authority), calls: 0 };
      return true;
    },
    endTurn(turnId: string): void {
      if (active?.authority.turnId === turnId) active = null;
    },
    close(): void {
      open = false;
      active = null;
    },
    /** Stdio carries no trustworthy actor ID; never attribute a live child's call to a newer turn. */
    setBackgroundTasks(taskIds: readonly string[]): void {
      const blocked = taskIds.length > 0;
      if (blocked === backgroundTasksPresent) return;
      backgroundTasksPresent = blocked;
      claimEpoch += 1;
    },
    claim(): AppToolCaller | null {
      const admitted = active;
      if (!open || backgroundTasksPresent || !admitted || admitted.calls >= 1024) return null;
      admitted.calls += 1;
      const epoch = claimEpoch;
      const isActive = () =>
        open && !backgroundTasksPresent && epoch === claimEpoch && active === admitted;
      const caller: AppToolCaller = {
        backend: "claudeCode",
        threadId: input.threadId,
        turnId: admitted.authority.turnId,
        callId: randomUUID(),
        hostId: input.hostId,
        generation: input.generation,
        isActive,
      };
      nativeClaims.set(caller, {
        capture: Effect.gen(function* () {
          if (!isActive()) return null;
          if (!(yield* input.capture(admitted.authority)) || !isActive()) return null;
          return admitted.authority;
        }),
      });
      return caller;
    },
  };
}

/** Invocation identity and Core authority are verified separately for each native backend. */
export const captureAppToolAuthority = (
  caller: AppToolCaller,
  codex: Pick<CodexTurnAuthority["Service"], "capture">,
): Effect.Effect<FrozenNodexAgentTurnAuthority | null> => {
  if (!caller.isActive()) return Effect.succeed(null);
  if (caller.backend === "claudeCode")
    return nativeClaims.get(caller)?.capture ?? Effect.succeed(null);
  return codex
    .capture(caller.threadId, caller.turnId)
    .pipe(Effect.catch(() => Effect.succeed(null)));
};

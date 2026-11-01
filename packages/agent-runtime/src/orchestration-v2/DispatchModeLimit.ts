import { ProviderInteractionMode, RUNTIME_MODE_RANK, RuntimeMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const DispatchModeLimitSchema = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type DispatchModes = typeof DispatchModeLimitSchema.Type;

/** Caller limits cross the Host boundary; the command owner checks them under its lock. */
export const DispatchModeLimit = Context.Reference<DispatchModes | undefined>(
  "nodex/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

export const exceededDispatchModeLimit = (limit: DispatchModes, modes: DispatchModes) =>
  RUNTIME_MODE_RANK[modes.runtimeMode] > RUNTIME_MODE_RANK[limit.runtimeMode]
    ? ("runtime_mode_escalation_denied" as const)
    : limit.interactionMode === "plan" && modes.interactionMode !== "plan"
      ? ("interaction_mode_escalation_denied" as const)
      : undefined;

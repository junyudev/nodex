import { ProviderInteractionMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";

export const DispatchModeLimitSchema = Schema.Struct({
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits", "auto", "full-access"]),
  interactionMode: ProviderInteractionMode,
});
export type DispatchModes = typeof DispatchModeLimitSchema.Type;

/** Caller limits cross the Host boundary; the command owner checks them under its lock. */
export const DispatchModeLimit = Context.Reference<DispatchModes | undefined>(
  "nodex/orchestration-v2/DispatchModeLimit",
  { defaultValue: () => undefined },
);

const runtimeRank = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
} as const;

export const exceededDispatchModeLimit = (limit: DispatchModes, modes: DispatchModes) =>
  runtimeRank[modes.runtimeMode] > runtimeRank[limit.runtimeMode]
    ? ("runtime_mode_escalation_denied" as const)
    : limit.interactionMode === "plan" && modes.interactionMode !== "plan"
      ? ("interaction_mode_escalation_denied" as const)
      : undefined;

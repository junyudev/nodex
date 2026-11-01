import {
  NARROWEST_RUNTIME_MODE,
  type ModelSelection,
  OrchestratorMcpFailure,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpRuntimeMode,
  type ProviderInteractionMode,
  RUNTIME_MODE_RANK,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** Inherited modes step down for provider support; explicit selections must be supported. */
export function resolveRuntimeMode(
  callerMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: {
    readonly modelSelection: ModelSelection;
    readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  },
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? callerMode : requested;
  if (RUNTIME_MODE_RANK[resolved] > RUNTIME_MODE_RANK[callerMode]) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "runtime_mode_escalation_denied",
        message: `Child runtime mode ${resolved} is broader than caller mode ${callerMode}.`,
      }),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "invalid_request",
        message: `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}. Use one of: ${supported.join(", ")}.`,
      }),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => RUNTIME_MODE_RANK[mode] <= RUNTIME_MODE_RANK[callerMode])
      .toSorted((left, right) => RUNTIME_MODE_RANK[right] - RUNTIME_MODE_RANK[left])[0] ??
      NARROWEST_RUNTIME_MODE,
  );
}

export function resolveInteractionMode(
  callerMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  const resolved = requested === undefined || requested === "inherit" ? callerMode : requested;
  if (callerMode === "plan" && resolved !== "plan") {
    return Effect.fail(
      new OrchestratorMcpFailure({
        code: "interaction_mode_escalation_denied",
        message: "A caller in Plan mode cannot start work outside Plan mode.",
      }),
    );
  }
  return Effect.succeed(resolved);
}

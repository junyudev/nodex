import type { RuntimeMode } from "@nodex/agent-runtime/contracts";
import { AgentRuntimeModeSchema } from "../../shared/schemas/agent-runtime-api";

/** Permission modes from narrowest to broadest native execution access. */
export const AGENT_RUNTIME_MODES: readonly RuntimeMode[] = AgentRuntimeModeSchema.options;

const rank = (mode: RuntimeMode) => AGENT_RUNTIME_MODES.indexOf(mode);

/** An absent or empty list means the Agent enforces every mode, as the Runtime resolves it. */
export function isAgentRuntimeModeSupported(
  mode: RuntimeMode,
  supported: readonly RuntimeMode[] | null | undefined,
): boolean {
  return !supported?.length || supported.includes(mode);
}

/** The mode an Agent actually runs: the broadest supported one not broader than the choice. */
export function resolveAgentRuntimeMode(
  selected: RuntimeMode,
  supported?: readonly RuntimeMode[] | null,
): RuntimeMode {
  if (isAgentRuntimeModeSupported(selected, supported)) return selected;
  return (
    AGENT_RUNTIME_MODES.filter(
      (mode) => rank(mode) <= rank(selected) && isAgentRuntimeModeSupported(mode, supported),
    ).at(-1) ?? AGENT_RUNTIME_MODES[0]!
  );
}

/** Only a step up to Full access needs explicit confirmation. */
export function requiresFullAccessConfirmation(from: RuntimeMode, to: RuntimeMode): boolean {
  return to === "full-access" && from !== "full-access";
}

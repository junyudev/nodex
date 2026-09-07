import type { components } from "@nodex/core-protocol";
import * as Context from "effect/Context";

/** Carries an Agent caller through existing application command owners to Core admission. */
export const CoreApplicationAgent = Context.Reference<
  components["schemas"]["AgentTurnProvenance"] | null
>("nodex/main/core-runtime/CoreApplicationAgent", { defaultValue: () => null });

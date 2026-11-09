import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AgentRuntimeActivityTransition } from "../main/agent-runtime/AgentRuntimeSessionActivity";

/** Optional desktop presentation of Runtime openings; a headless host has no Readback owner. */
export class ReadbackRuntime extends Context.Service<
  ReadbackRuntime,
  {
    readonly observe: (transition: AgentRuntimeActivityTransition) => Effect.Effect<void>;
  }
>()("nodex/host/ReadbackRuntime") {}

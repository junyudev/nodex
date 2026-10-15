import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivityChange,
  AgentRuntimeSessionActivitySnapshot,
} from "../../shared/agent-runtime-api";

/**
 * Live execution facts for Runtime-bound Sessions, keyed by product Session.
 * The Runtime owns the facts; Core never stores them; windows read one shared projection.
 */
export interface AgentRuntimeSessionActivityShape {
  /** Bounded snapshot of non-idle Sessions. Reading never starts an idle Runtime. */
  readonly read: Effect.Effect<AgentRuntimeSessionActivitySnapshot>;
  readonly connection: Effect.Effect<AgentRuntimeConnectionState>;
  /** Changes published after subscription; a `reset` requires a fresh snapshot. */
  readonly activityChanges: Stream.Stream<AgentRuntimeSessionActivityChange>;
  readonly connectionChanges: Stream.Stream<AgentRuntimeConnectionState>;
}

export class AgentRuntimeSessionActivity extends Context.Service<
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityShape
>()("nodex/main/agent-runtime/AgentRuntimeSessionActivity") {}

/** A Main graph without an execution owner reports no live work. */
export const inactive: AgentRuntimeSessionActivityShape = {
  read: Effect.succeed({ sequence: 0, items: [], complete: true }),
  connection: Effect.succeed({ status: "idle" }),
  activityChanges: Stream.never,
  connectionChanges: Stream.never,
};

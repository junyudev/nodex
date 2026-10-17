import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";

export class AgentRuntimeProviderConfigurationError extends Schema.TaggedError<AgentRuntimeProviderConfigurationError>()(
  "AgentRuntimeProviderConfigurationError",
  { cause: Schema.Defect() },
) {}

/** Refreshes a running engine; reading or saving settings never starts an idle engine. */
export class AgentRuntimeProviderConfiguration extends Context.Service<
  AgentRuntimeProviderConfiguration,
  { readonly refresh: Effect.Effect<void, AgentRuntimeProviderConfigurationError> }
>()("nodex/main/agent-runtime/AgentRuntimeProviderConfiguration") {}

/**
 * Applies changed provider settings to the execution process. A process that is starting read
 * its configuration before the change, so it is configured once it is ready rather than left
 * with the old providers; an idle process reads the new settings when it next starts.
 */
export const applyProviderSettings = <E, R>(input: {
  /** The current connection state followed by every transition. */
  readonly states: Stream.Stream<AgentRuntimeConnectionState>;
  readonly running: Effect.Effect<boolean>;
  readonly apply: Effect.Effect<void, E, R>;
}): Effect.Effect<void, E, R> =>
  input.states.pipe(
    Stream.filter((state) => state.status !== "starting" && state.status !== "restarting"),
    Stream.runHead,
    Effect.timeoutOption("1 minute"),
    Effect.andThen(input.running),
    Effect.flatMap((running) => (running ? input.apply : Effect.void)),
  );

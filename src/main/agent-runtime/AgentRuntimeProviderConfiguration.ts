import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class AgentRuntimeProviderConfigurationError extends Schema.TaggedError<AgentRuntimeProviderConfigurationError>()(
  "AgentRuntimeProviderConfigurationError",
  { cause: Schema.Defect() },
) {}

/** Refreshes a running engine; reading or saving settings never starts an idle engine. */
export class AgentRuntimeProviderConfiguration extends Context.Service<
  AgentRuntimeProviderConfiguration,
  { readonly refresh: Effect.Effect<void, AgentRuntimeProviderConfigurationError> }
>()("nodex/main/agent-runtime/AgentRuntimeProviderConfiguration") {}

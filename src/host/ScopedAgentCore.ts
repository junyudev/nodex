import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ScopedAgentCoreConnection {
  readonly endpoint: string;
  readonly credential: string;
}

/** A Turn can use content commands, with its execution re-proved on every request. */
export class ScopedAgentCore extends Context.Service<
  ScopedAgentCore,
  {
    readonly issue: (input: {
      readonly owner: string;
      readonly projectId: string | null;
      readonly attribution: string;
      readonly authorize: Effect.Effect<boolean>;
    }) => Effect.Effect<ScopedAgentCoreConnection, Error>;
  }
>()("nodex/host/ScopedAgentCore") {}

import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { AgentAttributionRequest } from "../main/core-client/types";
import type { CoreAuthorityIdentity } from "../main/core-runtime/CoreAuthority";

export type ScopedAgentAdmission = "allowed" | "turn_ended" | "session_unavailable";

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
      readonly attribution: AgentAttributionRequest;
      readonly identity: CoreAuthorityIdentity;
      readonly authorize: Effect.Effect<ScopedAgentAdmission>;
    }) => Effect.Effect<ScopedAgentCoreConnection, Error>;
  }
>()("nodex/host/ScopedAgentCore") {}

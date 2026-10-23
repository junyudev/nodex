import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { NODEX_ACCOUNT_ERROR_CODES, type NodexAccountIdentity } from "../../shared/nodex-account";

export class NodexAccountPlatformError extends Schema.TaggedError<NodexAccountPlatformError>()(
  "NodexAccountPlatformError",
  { code: Schema.Literals(NODEX_ACCOUNT_ERROR_CODES) },
) {}

export interface NodexAccountCredentials {
  readonly identity: NodexAccountIdentity;
  readonly accessToken: Redacted.Redacted;
  readonly refreshToken: Redacted.Redacted | null;
  readonly expiresAt: number;
}

/** New grants are revoked on Scope release unless the account owner accepts them. */
export interface NodexAccountCredentialLease {
  readonly credentials: NodexAccountCredentials;
  readonly retain: Effect.Effect<void>;
}

/** Rotation can succeed while identity verification is temporarily unavailable. */
export interface NodexAccountRefreshLease extends NodexAccountCredentialLease {
  readonly verified: boolean;
}

/** OAuth, private loopback and encrypted disk access are host capabilities, not renderer APIs. */
export class NodexAccountPlatform extends Context.Service<
  NodexAccountPlatform,
  {
    readonly configured: boolean;
    readonly configurationError: boolean;
    readonly load: Effect.Effect<NodexAccountCredentials | null, NodexAccountPlatformError>;
    readonly save: (
      credentials: NodexAccountCredentials,
    ) => Effect.Effect<"secure" | "memory", NodexAccountPlatformError>;
    readonly clear: Effect.Effect<void, NodexAccountPlatformError>;
    readonly login: Effect.Effect<
      NodexAccountCredentialLease,
      NodexAccountPlatformError,
      Scope.Scope
    >;
    readonly refresh: (
      credentials: NodexAccountCredentials,
    ) => Effect.Effect<NodexAccountRefreshLease, NodexAccountPlatformError, Scope.Scope>;
    readonly revoke: (
      credentials: NodexAccountCredentials,
    ) => Effect.Effect<void, NodexAccountPlatformError>;
  }
>()("nodex/main/platform/NodexAccountPlatform") {}

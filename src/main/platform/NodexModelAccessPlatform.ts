import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { NodexModelStatus } from "../../shared/nodex-account";

export interface NodexModelAccess {
  readonly apiKey: Redacted.Redacted;
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly protocol: "openai" | "anthropic";
  }[];
}
export class NodexModelAccessError extends Schema.TaggedError<NodexModelAccessError>()(
  "NodexModelAccessError",
  {
    code: Schema.Literals([
      "unauthenticated",
      "forbidden_client",
      "email_unverified",
      "unavailable",
      "tier_unavailable",
      "browser-open",
    ]),
  },
) {}
export class NodexModelAccessPlatform extends Context.Service<
  NodexModelAccessPlatform,
  {
    readonly exchange: (
      token: Redacted.Redacted,
    ) => Effect.Effect<NodexModelAccess, NodexModelAccessError>;
    readonly balance: (access: NodexModelAccess) => Effect.Effect<number, NodexModelAccessError>;
    readonly status: Effect.Effect<NodexModelStatus, NodexModelAccessError>;
    readonly checkout: (
      token: Redacted.Redacted,
      amount: number,
    ) => Effect.Effect<string, NodexModelAccessError>;
    readonly openCheckout: (url: string) => Effect.Effect<void, NodexModelAccessError>;
  }
>()("nodex/main/platform/NodexModelAccessPlatform") {}

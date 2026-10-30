import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface NodexModelAccess {
  readonly apiKey: Redacted.Redacted;
  readonly openaiBaseUrl: string;
  readonly anthropicBaseUrl: string;
  readonly models: readonly {
    readonly id: string;
    readonly label: string;
    readonly protocol: "openai" | "anthropic";
  }[];
  readonly consoleUrl: string;
  readonly topUpUrl: string;
}
export class NodexModelAccessError extends Schema.TaggedError<NodexModelAccessError>()(
  "NodexModelAccessError",
  {
    code: Schema.Literals([
      "unauthenticated",
      "forbidden_client",
      "email_unverified",
      "unavailable",
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
    readonly openTopUp: Effect.Effect<void, NodexModelAccessError>;
  }
>()("nodex/main/platform/NodexModelAccessPlatform") {}

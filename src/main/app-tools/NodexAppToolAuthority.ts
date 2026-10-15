import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { NodexAgentTurnContext } from "../../shared/nodex-agent-authority";

export interface AppToolAuthorityContext {
  readonly authority: NodexAgentTurnContext | null;
}
export interface BindAppToolAuthority {
  readonly authority: NodexAgentTurnContext | null;
  readonly isCurrent: Effect.Effect<boolean>;
}
export class NodexAppToolAuthority extends Context.Service<
  NodexAppToolAuthority,
  {
    readonly bind: (input: BindAppToolAuthority) => Effect.Effect<AppToolAuthorityContext>;
  }
>()("nodex/main/app-tools/NodexAppToolAuthority") {}

export const make = Effect.succeed(
  NodexAppToolAuthority.of({
    bind: Effect.fn("NodexAppToolAuthority.bind")(function* (input) {
      const current = input.authority !== null && (yield* input.isCurrent);
      return {
        authority: current ? input.authority : null,
      };
    }),
  }),
);
export const live = Layer.effect(NodexAppToolAuthority, make);

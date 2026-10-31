import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { NODEX_MODELS } from "../../shared/nodex-models";
import {
  NodexModelAccessError,
  type NodexModelAccess,
  type NodexModelAccessPlatform,
} from "../platform/NodexModelAccessPlatform";

export const modelAccessFixture: NodexModelAccess = {
  apiKey: Redacted.make("synthetic-gateway-key"),
  openaiBaseUrl: "https://api.jyu.app/v1",
  anthropicBaseUrl: "https://api.jyu.app",
  models: NODEX_MODELS,
};
export const modelStatusFixture = {
  models: NODEX_MODELS.map(({ id }) => ({ id, available: true })),
  topUp: {
    available: true,
    currency: "USD" as const,
    tiers: [
      { amount: 2, credit: 14, available: true },
      { amount: 5, credit: 35, available: false },
    ],
  },
};
export const unavailableModelAccessFixture: NodexModelAccessPlatform["Service"] = {
  exchange: () => Effect.fail(new NodexModelAccessError({ code: "unavailable" })),
  balance: () => Effect.succeed(12.5),
  status: Effect.succeed(modelStatusFixture),
  checkout: () => Effect.succeed("https://checkout.stripe.com/c/pay/synthetic"),
  openCheckout: () => Effect.void,
};

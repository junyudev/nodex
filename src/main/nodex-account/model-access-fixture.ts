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
const prices = (input: number, cacheRead: number, cacheWrite: number | null, output: number) => ({
  input,
  cacheRead,
  cacheWrite,
  output,
});
const PROVIDERS = { openai: "openai", anthropic: "anthropic" } as const;
const REFERENCE_PRICES = {
  "gpt-6.1-sol": prices(5, 0.5, null, 30),
  "gpt-6-luna": prices(0.75, 0.075, null, 4.5),
  "claude-opus-5-5": prices(4, 0.2, 5, 20),
  "claude-sonnet-5-5": prices(2, 0.2, 2.5, 10),
} as const;

export const modelPricingFixture = {
  currency: "USD" as const,
  perTokens: 1_000_000,
  notes: ["Standard speed and context."],
  groups: [
    {
      id: "nodex",
      label: "Nodex",
      description: null,
      available: true,
      models: NODEX_MODELS.map(({ id, label, protocol }) => ({
        id,
        label,
        provider: PROVIDERS[protocol],
        reference: REFERENCE_PRICES[id],
        effective: REFERENCE_PRICES[id],
        multiplier: 1,
      })),
    },
  ],
};

export const modelStatusFixture = {
  creditsPerUsd: 25,
  pricing: modelPricingFixture,
  models: NODEX_MODELS.map(({ id }) => ({ id, available: true })),
  topUp: {
    available: true,
    currency: "USD" as const,
    tiers: [
      { amount: 5, credit: 5, available: true },
      { amount: 10, credit: 11, available: true },
      { amount: 25, credit: 30, available: false },
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

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
  consoleUrl: "https://console.nodex.jyu.app",
  topUpUrl: "https://console.nodex.jyu.app/topup",
};
export const unavailableModelAccessFixture: NodexModelAccessPlatform["Service"] = {
  exchange: () => Effect.fail(new NodexModelAccessError({ code: "unavailable" })),
  balance: () => Effect.succeed(12.5),
  openTopUp: Effect.void,
};

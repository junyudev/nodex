import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import path from "node:path";
import { MainConfig } from "../app/MainConfig";
import { makeTemporaryAssets, type TemporaryAssetsService } from "./assets";

/** Profile-scoped temporary media; durable bytes belong to the Core Blob store. */
export class TemporaryAssets extends Context.Service<TemporaryAssets, TemporaryAssetsService>()(
  "nodex/main/local-store/TemporaryAssets",
) {}

export const live: Layer.Layer<TemporaryAssets, never, MainConfig> = Layer.effect(
  TemporaryAssets,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return TemporaryAssets.of(
      makeTemporaryAssets({ assetsRootPath: path.join(config.nodexHome, "cache", "media") }),
    );
  }),
);

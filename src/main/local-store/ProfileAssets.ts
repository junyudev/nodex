import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import path from "node:path";
import { MainConfig } from "../app/MainConfig";
import { makeProfileAssets, type ProfileAssetsService } from "./assets";

export class ProfileAssets extends Context.Service<ProfileAssets, ProfileAssetsService>()(
  "nodex/main/local-store/ProfileAssets",
) {}

export const live: Layer.Layer<ProfileAssets, never, MainConfig> = Layer.effect(
  ProfileAssets,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return ProfileAssets.of(
      makeProfileAssets({ assetsRootPath: path.join(config.nodexHome, "assets") }),
    );
  }),
);

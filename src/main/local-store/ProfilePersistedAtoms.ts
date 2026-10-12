import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../app/MainConfig";
import { makePersistedAtomStore, type PersistedAtomStore } from "./persisted-atoms";

/** One repository/cache/revision owner shared by all Profile-local atom consumers. */
export class ProfilePersistedAtoms extends Context.Service<
  ProfilePersistedAtoms,
  PersistedAtomStore
>()("nodex/main/local-store/ProfilePersistedAtoms") {}

export const live: Layer.Layer<ProfilePersistedAtoms, never, MainConfig> = Layer.effect(
  ProfilePersistedAtoms,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return makePersistedAtomStore(config.nodexHome);
  }),
);

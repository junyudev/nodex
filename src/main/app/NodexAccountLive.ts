import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodexAccount from "../nodex-account/NodexAccount";
import { NodexAccountPlatform, NodexAccountPlatformError } from "../platform/NodexAccountPlatform";
import * as NativeNodexAccount from "../platform/node/NodexAccountPlatform";
import * as SecretEncryption from "../platform/electron/SecretEncryption";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { MainConfig } from "./MainConfig";

const platform = Layer.effect(
  NodexAccountPlatform,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    return yield* NativeNodexAccount.make({
      home: config.nodexHome,
      isPackaged: config.isPackaged,
      environment: config.environment,
      openExternal: (url) =>
        Effect.tryPromise({
          try: () => desktop.shell.openExternal(url),
          catch: () => new NodexAccountPlatformError({ code: "browser-open" }),
        }),
    });
  }),
).pipe(Layer.provide(SecretEncryption.live));

export const live = NodexAccount.live.pipe(Layer.provide(platform));

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../../app/MainConfig";
import { LinkFavicons } from "../../link-favicons/LinkFavicons";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const favicons = yield* LinkFavicons;
    const ipc = yield* ElectronIpc;
    yield* ipc.handleQuery("links:favicon", (event, hostname) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "Website icons", config.rendererUrl),
        catch: (cause) => new Error("Could not authorize the website icon query", { cause }),
      }).pipe(Effect.andThen(favicons.read(hostname))),
    );
  }),
);

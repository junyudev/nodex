import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../../app/MainConfig";
import { ChangelogFeedRuntime } from "../../host-runtime/ChangelogFeedRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const changelog = yield* ChangelogFeedRuntime;
    const ipc = yield* ElectronIpc;
    yield* ipc.handleQuery("app:changelog:read", (event) =>
      Effect.try({
        try: () => requireTrustedAppRendererSender(event, "Changelog", config.rendererUrl),
        catch: (cause) => new Error("Could not authorize the changelog query.", { cause }),
      }).pipe(Effect.andThen(changelog.read)),
    );
  }),
);

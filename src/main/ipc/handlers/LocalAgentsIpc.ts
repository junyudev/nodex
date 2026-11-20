import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MainConfig } from "../../app/MainConfig";
import { LocalAgentDiscovery } from "../../host-runtime/LocalAgentDiscovery";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";

class LocalAgentsIpcError extends Schema.TaggedError<LocalAgentsIpcError>()("LocalAgentsIpcError", {
  cause: Schema.Defect(),
}) {}

export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const discovery = yield* LocalAgentDiscovery;
    const config = yield* MainConfig;
    const ipc = yield* ElectronIpc;

    yield* ipc.handleQuery("local-agents:scan", (event, options) =>
      Effect.try({
        try: () =>
          requireTrustedAppRendererSender(event, "Local Agent discovery", config.rendererUrl),
        catch: (cause) => new LocalAgentsIpcError({ cause }),
      }).pipe(Effect.andThen(() => discovery.scan({ fresh: options?.fresh === true }))),
    );
  }),
);

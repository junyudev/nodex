import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import type { CodexApplicationRequestInbox } from "./CodexApplicationRequestInbox";
import {
  CodexAppServerCapabilities,
  live as appServerCapabilitiesLive,
} from "./CodexAppServerCapabilities";
import { live as sessionLive, type CodexAppServerSessionOptions } from "./CodexAppServerSession";
import type { CodexEndpointConfig } from "./CodexEndpoint";
import { CodexEndpointMap, live as endpointMapLive } from "./CodexEndpointMap";
import { CodexEventHub, live as eventHubLive } from "./CodexEventHub";
import { CodexGateway, CodexThreadHostResolver, live as gatewayLive } from "./CodexGateway";

export interface CodexRuntimeOptions {
  readonly local: Omit<CodexAppServerSessionOptions, "generation">;
  readonly requestTimeout: Duration.Input;
  readonly retryBase?: Duration.Input;
  readonly retryCap?: Duration.Input;
  readonly jitter?: boolean;
}

export const localEndpointConfig = (options: CodexRuntimeOptions): CodexEndpointConfig => ({
  hostId: options.local.hostId,
  sessionLayer: (generation) => sessionLive({ ...options.local, generation }),
  ...(options.retryBase === undefined ? {} : { retryBase: options.retryBase }),
  ...(options.retryCap === undefined ? {} : { retryCap: options.retryCap }),
  ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
});

/** The complete process-scoped Codex transport graph; application Modules depend on CodexGateway. */
export const live = (
  options: CodexRuntimeOptions,
): Layer.Layer<
  CodexAppServerCapabilities | CodexGateway | CodexEndpointMap | CodexEventHub,
  never,
  CodexSessionTransport | CodexApplicationRequestInbox | CodexThreadHostResolver
> => {
  const events = eventHubLive;
  const endpoints = endpointMapLive({
    ...localEndpointConfig(options),
    kind: "local",
  }).pipe(Layer.provideMerge(events));
  const transport = Layer.merge(endpoints, events);
  return Layer.merge(
    gatewayLive({ requestTimeout: options.requestTimeout }),
    appServerCapabilitiesLive,
  ).pipe(Layer.provideMerge(transport));
};

import type * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import type { CodexApplicationRequestInbox } from "./CodexApplicationRequestInbox";
import {
  CodexAppServerCapabilities,
  live as appServerCapabilitiesLive,
} from "./CodexAppServerCapabilities";
import { live as sessionLive, type CodexAppServerSessionOptions } from "./CodexAppServerSession";
import type {
  CodexEndpointConfig,
  CodexEndpointInternalServerRequestHandler,
} from "./CodexEndpoint";
import { CodexEndpointMap, live as endpointMapLive } from "./CodexEndpointMap";
import { CodexEventHub, live as eventHubLive } from "./CodexEventHub";
import {
  CodexGateway,
  CodexThreadHostResolver,
  live as gatewayLive,
  type CodexGatewayOptions,
} from "./CodexGateway";
import { CodexRequestScheduler, live as requestSchedulerLive } from "./CodexRequestScheduler";
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
} from "./CodexExecutionHostAuthState";

export interface CodexRuntimeOptions {
  readonly local: Omit<CodexAppServerSessionOptions, "generation">;
  readonly localSessionLayer?: CodexEndpointConfig["sessionLayer"];
  readonly requestTimeout?: CodexGatewayOptions["requestTimeout"];
  readonly retryBase?: Duration.Input;
  readonly retryCap?: Duration.Input;
  readonly jitter?: boolean;
  readonly internalServerRequestHandler?: CodexEndpointInternalServerRequestHandler;
}

export const localEndpointConfig = (options: CodexRuntimeOptions): CodexEndpointConfig => ({
  hostId: options.local.hostId,
  hostKind: options.local.ssh ? "ssh" : "local",
  transportKind: options.local.ssh || options.local.localDaemon ? "websocket" : "stdio",
  sessionLayer:
    options.localSessionLayer ?? ((generation) => sessionLive({ ...options.local, generation })),
  ...(options.retryBase === undefined ? {} : { retryBase: options.retryBase }),
  ...(options.retryCap === undefined ? {} : { retryCap: options.retryCap }),
  ...(options.jitter === undefined ? {} : { jitter: options.jitter }),
});

/** The complete process-scoped Codex transport graph; application Modules depend on CodexGateway. */
export const live = (
  options: CodexRuntimeOptions,
): Layer.Layer<
  | CodexAppServerCapabilities
  | CodexGateway
  | CodexEndpointMap
  | CodexEventHub
  | CodexRequestScheduler
  | CodexExecutionHostAuthState,
  never,
  CodexSessionTransport | CodexApplicationRequestInbox | CodexThreadHostResolver
> => {
  const events = eventHubLive;
  const scheduler = requestSchedulerLive;
  const endpoints = endpointMapLive(
    {
      ...localEndpointConfig(options),
      kind: "local",
    },
    {
      ...(options.internalServerRequestHandler
        ? { internalServerRequestHandler: options.internalServerRequestHandler }
        : {}),
    },
  ).pipe(Layer.provide(Layer.merge(events, scheduler)));
  const transport = Layer.mergeAll(endpoints, events, scheduler);
  const gateway = gatewayLive({ requestTimeout: options.requestTimeout }).pipe(
    Layer.provideMerge(executionHostAuthStateLive),
  );
  return Layer.merge(gateway, appServerCapabilitiesLive).pipe(Layer.provideMerge(transport));
};

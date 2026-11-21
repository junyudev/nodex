import * as Layer from "effect/Layer";
import type { CodexSessionTransport } from "../platform/node/CodexSessionTransport";
import type { CodexApplicationRequestInbox } from "./CodexApplicationRequestInbox";
import {
  CodexAppServerCapabilities,
  live as appServerCapabilitiesLive,
} from "./CodexAppServerCapabilities";
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

export const localEndpointConfig = (
  options: Pick<CodexEndpointConfig, "sessionLayer" | "transportKind" | "checkAvailability">,
): CodexEndpointConfig => ({
  hostId: "local",
  hostKind: "local",
  startup: "on-demand",
  ...options,
});

/** The complete process-scoped Codex transport graph; application Modules depend on CodexGateway. */
export const live = (options: {
  readonly endpoint: CodexEndpointConfig;
  readonly requestTimeout?: CodexGatewayOptions["requestTimeout"];
  readonly internalServerRequestHandler?: CodexEndpointInternalServerRequestHandler;
}): Layer.Layer<
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
      ...options.endpoint,
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

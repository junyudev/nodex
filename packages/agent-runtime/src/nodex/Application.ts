import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Host from "./Host.ts";
import * as Runtime from "./Runtime.ts";
import * as Service from "./Service.ts";
import * as Bridge from "./HostBridge.ts";
import * as RuntimeHomeLease from "./RuntimeHomeLease.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentRuntimeConfiguration, AgentRuntimeNotification } from "./Interface.ts";

/** One host Layer reference guarantees one SQL writer, registry and provider request queue. */
export const layer = (
  configuration: AgentRuntimeConfiguration,
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
) => {
  const identity = Environment.layerIdentity.pipe(
    Layer.provide(Runtime.layerConfiguration(configuration)),
    Layer.provide(NodeServices.layer),
  );
  const bridge = Bridge.layer(configuration, notify).pipe(
    Layer.provide(identity),
    Layer.provide(NodeServices.layer),
  );
  const host = Host.layer(configuration).pipe(
    Layer.provide(Bridge.layerExecutionHost.pipe(Layer.provide(bridge))),
  );
  const startup = Layer.effectDiscard(Runtime.acquireExecution).pipe(Layer.provideMerge(host));
  return Service.layer(notify, configuration.providers).pipe(
    Layer.provide(startup),
    Layer.provideMerge(bridge),
    Layer.provide(Layer.effectDiscard(RuntimeHomeLease.acquire(configuration.home))),
  );
};

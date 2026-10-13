import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as Mcp from "./Mcp.ts";
import * as Runtime from "./Runtime.ts";
import * as HostTools from "./HostTools.ts";
import * as Projection from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecrets from "../auth/ServerSecretStore.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import type { AgentRuntimeConfiguration } from "./Interface.ts";

/** Loopback transport and session credentials share one process Scope with the engine. */
export const layer = (configuration: AgentRuntimeConfiguration) => {
  const engine = Runtime.layerEngine(configuration);
  const routes = HostTools.layer(configuration).pipe(
    Layer.provideMerge(Mcp.layer),
    Layer.provide(Projection.layer),
    Layer.provide(engine),
    Layer.provide(Secrets.layer.pipe(Layer.provide(engine))),
    Layer.provide(ProviderAdapters.layerFromProviderInstanceRegistry.pipe(Layer.provide(engine))),
  );
  return HttpRouter.serve(routes, { disableLogger: true }).pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(ServerEnvironment.layer),
    Layer.provideMerge(ServerSecrets.layer),
    Layer.provideMerge(Runtime.layerConfiguration(configuration)),
    Layer.provideMerge(
      NodeHttpServer.layer(() => NodeHttp.createServer(), {
        host: "127.0.0.1",
        port: 0,
        gracefulShutdownTimeout: 0,
      }),
    ),
  );
};

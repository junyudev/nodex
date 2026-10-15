import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as OrchestratorService from "../mcp/OrchestratorMcpService.ts";
import * as Handlers from "../mcp/toolkits/task/handlers.ts";
import { TaskToolkit } from "../mcp/toolkits/task/tools.ts";
import * as Ingress from "./Ingress.ts";

type Authenticate = (
  effect: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    Types.unhandled,
    Invocation.McpInvocationContext
  >,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

const makeAuthentication = Effect.gen(function* () {
  const sessions = yield* Sessions.McpSessionRegistry;
  const admit = yield* Ingress.make;
  return Effect.fn("AgentRuntime.authenticateMcp")(function* (requestEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const scope = token.length === 0 ? undefined : yield* sessions.resolve(token);
    if (scope === undefined) {
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_mcp_credential" },
        {
          status: 401,
          headers: { "cache-control": "no-store", "www-authenticate": "Bearer" },
        },
      );
    }
    return yield* admit(requestEffect, scope, request);
  }) satisfies Authenticate;
});
const layerAuthentication = HttpRouter.middleware<{
  provides: Invocation.McpInvocationContext;
}>()(makeAuthentication).layer;
const registration = McpServer.toolkit(TaskToolkit);
// The scoped credential middleware installs the caller for each request, never at registration.
const layerRegistration = registration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof registration>, Invocation.McpInvocationContext>
>;

/** Task tools register beside the host's Session and content tools on one server. */
export const layerToolkit = layerRegistration.pipe(
  Layer.provide(Access.HandlersLayer.layer(Handlers.layer)),
  Layer.provide(OrchestratorService.layer),
);

/** Only execution operations run here; desktop and content tools belong to their host. */
export const layer = layerToolkit.pipe(
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "Nodex",
      version: "0.3.0",
      path: "/mcp",
      protocols: [McpProtocol.v2025_06_18],
      allowSessionTermination: true,
    }).pipe(Layer.provide(layerAuthentication)),
  ),
);

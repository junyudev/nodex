import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Types from "effect/Types";
import { McpProtocol, McpServer, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Sessions from "../mcp/McpSessionRegistry.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import * as OrchestratorService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadMetadata from "../mcp/ThreadMetadataMcpService.ts";
import * as Handlers from "../mcp/toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
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
const tools = OrchestratorToolkit.tools;
const executionToolkit = Toolkit.make(
  tools.orchestrator_capabilities,
  tools.delegate_task,
  tools.task_status,
  tools.task_cancel,
  tools.t3_workflow_stop,
  tools.create_threads,
  tools.t3_thread_list,
  tools.t3_thread_read,
  tools.t3_thread_update,
  tools.t3_thread_send,
  tools.t3_thread_wait,
  tools.t3_thread_interrupt,
);
const registration = McpServer.toolkit(executionToolkit);
// The scoped credential middleware installs the caller for each request, never at registration.
const layerRegistration = registration as Layer.Layer<
  never,
  never,
  Exclude<Layer.Services<typeof registration>, Invocation.McpInvocationContext>
>;

/** Only execution operations run here; desktop and content tools belong to their host. */
export const layer = layerRegistration.pipe(
  Layer.provide(Access.HandlersLayer.layer(Handlers.layer)),
  Layer.provide(OrchestratorService.layer),
  Layer.provide(ThreadMetadata.layer),
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

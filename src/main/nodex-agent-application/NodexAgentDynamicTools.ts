import type { DynamicToolCallParams } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallParams";
import type { DynamicToolCallResponse } from "@nodex/codex-app-server-protocol/v2/DynamicToolCallResponse";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ToolFailure } from "../../shared/nodex-agent-tools/base-schemas";
import { NODEX_APP_TOOL_NAMESPACE } from "../../shared/nodex-agent-tools/identity";
import type { NodexAgentAccess } from "../../shared/nodex-agent-tools/read-runtime";
import type { FrozenNodexAgentTurnAuthority } from "../../shared/nodex-agent-authority";
import type { NodexAgentResourceAccessOverlay } from "../../shared/nodex-agent-resource-access";
import {
  NodexAgentDynamicToolFailure,
  type NodexAgentDynamicExecutionContext,
} from "./NodexAgentDynamicPolicy";
import { executeNodexAgentV3Tool } from "./NodexAgentDynamicExecution";
import { NodexAgentApplication } from "./NodexAgentApplication";
import { DynamicToolRegistryError } from "../codex/dynamic-tool-registry";
import { createOperationId, createStableOperationId } from "../core-runtime/operation-identity";
import {
  buildNodexAgentV3DynamicToolCatalog,
  validateNodexAgentV3DynamicToolCall,
  validateNodexAgentV3DynamicToolOutput,
} from "../codex/nodex-dynamic-tool-registry";

function buildFailure(
  code: ToolFailure["error"]["code"],
  message: string,
  recovery: ToolFailure["error"]["recovery"],
  retryable = false,
): ToolFailure {
  return {
    error: { code, message, retryable, recovery },
  };
}

function serializeFailure(failure: ToolFailure): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(failure) }],
    success: false,
  };
}

function serializeSuccess(output: unknown): DynamicToolCallResponse {
  return {
    contentItems: [{ type: "inputText", text: JSON.stringify(output) }],
    success: true,
  };
}

function mapRegistryFailure(error: DynamicToolRegistryError): ToolFailure {
  const issueSuffix = error.issues.length > 0 ? `: ${error.issues.join("; ")}` : "";
  if (error.code === "invalid_arguments") {
    return buildFailure("invalid_arguments", `${error.message}${issueSuffix}`, "none");
  }
  if (error.code === "tool_catalog_stale" || error.code === "tool_not_found") {
    return buildFailure("tool_catalog_stale", error.message, "start_new_task");
  }
  return buildFailure(
    "internal_error",
    "Nodex could not validate the dynamic tool result",
    "retry_same",
    true,
  );
}

export function buildNodexAgentDynamicToolSpecs() {
  return buildNodexAgentV3DynamicToolCatalog();
}

export const selectNodexAgentDynamicToolSpecs = (enabled: boolean) =>
  enabled ? buildNodexAgentDynamicToolSpecs() : [];

export const nodexDynamicToolsDisabledResponse = (): DynamicToolCallResponse =>
  serializeFailure({
    error: {
      code: "tool_catalog_stale",
      message: "Nodex dynamic tools are disabled in this instance.",
      retryable: false,
      recovery: "none",
      details: { domainCode: "NODEX_DYNAMIC_TOOLS_DISABLED" },
    },
  });

export interface NodexAgentDynamicToolCallContext {
  readonly toolsetRevision: number | null;
  readonly authority: FrozenNodexAgentTurnAuthority | null;
  readonly access: NodexAgentAccess;
  readonly resourceAccess?: NodexAgentResourceAccessOverlay;
  readonly resolveResourceAccess: NodexAgentDynamicExecutionContext["resolveResourceAccess"];
  readonly recordTaskResourceAccess?: NodexAgentDynamicExecutionContext["recordTaskResourceAccess"];
  readonly authorize: NodexAgentDynamicExecutionContext["authorize"];
}

export class NodexAgentDynamicTools extends Context.Service<
  NodexAgentDynamicTools,
  {
    readonly enabled: boolean;
    readonly execute: (
      params: DynamicToolCallParams,
      context: NodexAgentDynamicToolCallContext,
    ) => Effect.Effect<DynamicToolCallResponse>;
  }
>()("nodex/main/nodex-agent-application/NodexAgentDynamicTools") {}

const execute = (
  params: DynamicToolCallParams,
  input: NodexAgentDynamicToolCallContext,
): Effect.Effect<DynamicToolCallResponse, never, NodexAgentApplication> => {
  if (params.namespace !== NODEX_APP_TOOL_NAMESPACE) {
    return Effect.succeed(
      serializeFailure(
        buildFailure(
          "tool_catalog_stale",
          `Unsupported Nodex dynamic tool namespace: ${params.namespace ?? "<none>"}`,
          "start_new_task",
        ),
      ),
    );
  }
  if (input.toolsetRevision === null) {
    return Effect.succeed(
      serializeFailure(
        buildFailure(
          "tool_catalog_stale",
          "This task was not launched with the Nodex agent-tool catalog",
          "start_new_task",
        ),
      ),
    );
  }
  const toolsetRevision = input.toolsetRevision;

  return Effect.gen(function* () {
    const validated = yield* Effect.sync(() =>
      validateNodexAgentV3DynamicToolCall({
        toolsetRevision,
        tool: params.tool,
        arguments: params.arguments,
      }),
    );
    const output = yield* executeNodexAgentV3Tool(params.tool, validated.input, {
      threadId: params.threadId,
      callId: params.callId,
      operationId: input.authority
        ? createStableOperationId(`nodex-agent.${params.tool}`, input.authority.frozenAtMs, [
            params.threadId,
            params.turnId,
            params.callId,
            params.tool,
          ])
        : createOperationId(`nodex-agent.${params.tool}`),
      authority: input.authority,
      access: input.access,
      ...(input.resourceAccess ? { resourceAccess: input.resourceAccess } : {}),
      ...(input.recordTaskResourceAccess
        ? { recordTaskResourceAccess: input.recordTaskResourceAccess }
        : {}),
      resolveResourceAccess: input.resolveResourceAccess,
      authorize: input.authorize,
    });
    return serializeSuccess(
      yield* Effect.sync(() =>
        validateNodexAgentV3DynamicToolOutput({ tool: params.tool as never, output }),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (error instanceof NodexAgentDynamicToolFailure) {
        return Effect.succeed(serializeFailure(error.failure));
      }
      if (error instanceof DynamicToolRegistryError) {
        return Effect.succeed(serializeFailure(mapRegistryFailure(error)));
      }
      return Effect.succeed(
        serializeFailure(
          buildFailure(
            "internal_error",
            error instanceof Error ? error.message : "Nodex dynamic tool execution failed",
            "retry_same",
            true,
          ),
        ),
      );
    }),
  );
};

export const layer = (
  enabled: boolean,
): Layer.Layer<NodexAgentDynamicTools, never, NodexAgentApplication> =>
  Layer.effect(
    NodexAgentDynamicTools,
    Effect.gen(function* () {
      const application = yield* NodexAgentApplication;
      return NodexAgentDynamicTools.of({
        enabled,
        execute: (params, context) =>
          enabled
            ? execute(params, context).pipe(
                Effect.provideService(NodexAgentApplication, application),
              )
            : Effect.succeed(nodexDynamicToolsDisabledResponse()),
      });
    }),
  );

export const live = layer(false);

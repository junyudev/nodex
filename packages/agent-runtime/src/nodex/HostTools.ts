import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import { ThreadId } from "@t3tools/contracts";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import { HostBridge } from "./HostBridge.ts";
import { hostToolAuthorityRefusal } from "./HostToolAuthority.ts";
import type { AgentRuntimeConfiguration } from "./Interface.ts";

const decodeTool = Schema.decodeUnknownEffect(Schema.toCodecJson(McpSchema.Tool));
const decodeResult = Schema.decodeUnknownEffect(Schema.toCodecJson(McpSchema.CallToolResult));
const refusal = (message: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: message }],
  });

/** Host tools preserve authenticated execution identity and cancellation lifetime. */
export const layer = (configuration: AgentRuntimeConfiguration) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (configuration.host === undefined || configuration.host.tools.length === 0) return;
      const server = yield* McpServer.McpServer;
      const bridge = yield* HostBridge;
      const projections = yield* Projections.ProjectionStoreV2;
      for (const descriptor of configuration.host.tools) {
        const tool = yield* decodeTool(descriptor);
        if (server.tools.some((existing) => existing.tool.name === tool.name)) {
          return yield* Effect.fail(
            new Error(`Host tool '${tool.name}' conflicts with an execution tool.`),
          );
        }
        yield* server.addTool({
          tool,
          annotations: Context.empty(),
          handle: (input) =>
            Effect.withFiber((fiber) =>
              Effect.gen(function* () {
                const invocation = Context.getOption(
                  fiber.context,
                  Invocation.McpInvocationContext,
                );
                if (Option.isNone(invocation) || invocation.value.thread === undefined)
                  return refusal("A native execution credential is required.");
                const admission = yield* ExecutionHost.McpTurnAdmission;
                const prepared = admission?.actor;
                if (
                  prepared === undefined ||
                  prepared.providerInstanceId !== invocation.value.thread.providerInstanceId
                )
                  return refusal("No execution identity was captured for this caller.");
                yield* admission!.assertCurrent();
                const state = yield* projections.getHostToolAuthorityContext(
                  ThreadId.make(prepared.threadId),
                  prepared.runId,
                  prepared.providerThreadId,
                );
                if (!(yield* bridge.nativeSessionLive(prepared)))
                  return refusal("Native execution has ended.");
                const denied = hostToolAuthorityRefusal(state, prepared, prepared.nativeGeneration);
                if (denied !== undefined) return refusal(denied);
                const request = yield* McpSchema.McpRequestContext;
                const nativeTurn = state.providerTurns.findLast(
                  (turn) => turn.runAttemptId === prepared.attemptId,
                );
                const result = yield* bridge.callTool(
                  {
                    ...prepared,
                    ...(nativeTurn?.nativeTurnRef?.nativeId == null
                      ? {}
                      : { nativeTurnId: nativeTurn.nativeTurnRef.nativeId }),
                    mcpClientId: request.clientId,
                    ...(admission?.requestId === undefined
                      ? {}
                      : { mcpRequestId: admission.requestId }),
                    ...(request.requestMetadata === undefined
                      ? {}
                      : { requestMetadata: request.requestMetadata }),
                  },
                  descriptor.name,
                  Object.fromEntries(
                    Object.entries(input ?? {}).filter(
                      ([key]) => key !== "__nodexExecutionCall" && key !== "__nodexNativeExecution",
                    ),
                  ),
                );
                // Recheck after the host returns so a stale completion cannot be presented as a new Run's success.
                yield* admission!.assertCurrent();
                const latest = yield* projections.getHostToolAuthorityContext(
                  ThreadId.make(prepared.threadId),
                  prepared.runId,
                  prepared.providerThreadId,
                );
                if (!(yield* bridge.nativeSessionLive(prepared)))
                  return refusal("Native execution has ended.");
                const stale = hostToolAuthorityRefusal(latest, prepared, prepared.nativeGeneration);
                if (stale !== undefined) return refusal(stale);
                return yield* decodeResult(result);
              }).pipe(Effect.catchCause((cause) => Effect.succeed(refusal(String(cause))))),
            ),
        });
      }
    }),
  );

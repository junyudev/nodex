import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
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

/** Host-owned tools run only after Core admits the exact foreground actor. */
export const layer = (configuration: AgentRuntimeConfiguration) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if (configuration.host === undefined || configuration.host.tools.length === 0) return;
      const server = yield* McpServer.McpServer;
      const bridge = yield* HostBridge;
      const projections = yield* Projections.ProjectionStoreV2;
      const sessions = yield* Sessions.ProviderSessionManagerV2;
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
                  return refusal("No foreground Turn was admitted for this caller.");
                yield* admission!.assertCurrent();
                const state = yield* projections.getHostToolAuthorityContext(
                  invocation.value.thread.threadId,
                );
                const runtime = yield* sessions.get(
                  ProviderSessionId.make(prepared.providerSessionId),
                );
                const denied = hostToolAuthorityRefusal(
                  state,
                  prepared,
                  Option.isNone(runtime) ? undefined : runtime.value.nativeGeneration,
                );
                if (denied !== undefined) return refusal(denied);
                const nativeThread = state.providerThreads.find(
                  (thread) => thread.id === prepared.providerThreadId,
                )!;
                const background = Option.isSome(runtime)
                  ? (runtime.value.hasPendingBackgroundWorkForThread?.(nativeThread) ??
                    runtime.value.hasPendingBackgroundWork)
                  : undefined;
                if (background !== undefined && (yield* background))
                  return refusal("Native background work makes this tool caller ambiguous.");
                const request = yield* McpSchema.McpRequestContext;
                const nativeTurn = state.providerTurns.findLast(
                  (turn) => turn.runAttemptId === prepared.attemptId && turn.status === "running",
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
                  input,
                );
                // Recheck after the host returns so a stale completion cannot be presented as a new Run's success.
                const latest = yield* projections.getHostToolAuthorityContext(
                  ThreadId.make(prepared.threadId),
                );
                const latestRuntime = yield* sessions.get(
                  ProviderSessionId.make(prepared.providerSessionId),
                );
                const stale = hostToolAuthorityRefusal(
                  latest,
                  prepared,
                  Option.isNone(latestRuntime) ? undefined : latestRuntime.value.nativeGeneration,
                );
                if (stale !== undefined) return refusal(stale);
                return yield* decodeResult(result);
              }).pipe(Effect.catchCause((cause) => Effect.succeed(refusal(String(cause))))),
            ),
        });
      }
    }),
  );

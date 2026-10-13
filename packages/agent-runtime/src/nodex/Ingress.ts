import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import { HostBridge } from "./HostBridge.ts";
import { hostToolAuthorityRefusal } from "./HostToolAuthority.ts";

const Request = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  params: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);
const discovery = new Set([
  "orchestrator_capabilities",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_wait",
]);
type NativeSession = { readonly providerSessionId: string; readonly nativeGeneration: number };
const sameNativeSession = (left: NativeSession | undefined, right: NativeSession | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.providerSessionId === right.providerSessionId &&
  left.nativeGeneration === right.nativeGeneration;

/** Binds initialized MCP clients to their native incarnation and captures each Run at ingress. */
export const make = Effect.gen(function* () {
  const bridge = yield* HostBridge;
  const projections = yield* Projections.ProjectionStoreV2;
  const sessions = yield* Sessions.ProviderSessionManagerV2;
  const profiles = yield* Ref.make<ReadonlyMap<string, NativeSession>>(new Map());
  return Effect.fn("AgentRuntime.admitMcpRequest")(function* (
    requestEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      Invocation.McpInvocationContext
    >,
    scope: Invocation.McpInvocationScope,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const caller = scope.thread;
    const actor = caller === undefined ? undefined : yield* bridge.preparedTurn(caller.threadId);
    const incarnations =
      caller === undefined ? [] : yield* bridge.nativeSessions(caller.providerSessionId);
    const native = incarnations.length === 1 ? incarnations[0] : undefined;
    const profileId = request.headers["mcp-session-id"];
    const profile = profileId === undefined ? undefined : (yield* Ref.get(profiles)).get(profileId);
    const payload =
      request.method !== "POST"
        ? undefined
        : yield* request.json.pipe(
            Effect.flatMap(decodeRequest),
            Effect.orElseSucceed(() => undefined),
          );
    const guarded = payload?.method === "tools/call" && !discovery.has(payload.params?.name ?? "");
    const checkCurrent = Effect.fn("AgentRuntime.assertMcpAdmission")(function* () {
      const refuse = (message: string) =>
        new ExecutionHost.ExecutionHostError({ operation: "mcp.admission", message });
      if (
        caller === undefined ||
        actor === undefined ||
        actor.providerInstanceId !== caller.providerInstanceId ||
        !sameNativeSession(profile, native) ||
        actor.providerSessionId !== native?.providerSessionId ||
        actor.nativeGeneration !== native.nativeGeneration
      ) {
        return yield* Effect.fail(refuse("This MCP client has no admitted foreground Turn."));
      }
      const currentNative = yield* bridge.nativeSessions(caller.providerSessionId);
      if (currentNative.length !== 1 || !sameNativeSession(native, currentNative[0]))
        return yield* Effect.fail(refuse("Native MCP session generation changed."));
      const state = yield* projections
        .getHostToolAuthorityContext(ThreadId.make(actor.threadId))
        .pipe(Effect.mapError((error) => refuse(error.message)));
      const runtime = yield* sessions.get(ProviderSessionId.make(actor.providerSessionId));
      const denied = hostToolAuthorityRefusal(
        state,
        actor,
        Option.isNone(runtime) ? undefined : runtime.value.nativeGeneration,
      );
      if (denied !== undefined) return yield* Effect.fail(refuse(denied));
      const providerThread = state.providerThreads.find(
        (candidate) => candidate.id === actor.providerThreadId,
      );
      if (providerThread === undefined || Option.isNone(runtime))
        return yield* Effect.fail(refuse("Native foreground identity is unavailable."));
      const pending =
        runtime.value.hasPendingBackgroundWorkForThread?.(providerThread) ??
        runtime.value.hasPendingBackgroundWork;
      if (pending !== undefined && (yield* pending))
        return yield* Effect.fail(refuse("Native background work makes this caller ambiguous."));
    });
    const assertCurrent = () =>
      checkCurrent().pipe(
        Effect.mapError(
          (error) =>
            new ExecutionHost.ExecutionHostError({
              operation: "mcp.admission",
              message: error.message,
            }),
        ),
      );
    if (guarded) {
      const admitted = yield* assertCurrent().pipe(Effect.result);
      if (admitted._tag === "Failure")
        return HttpServerResponse.jsonUnsafe({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text", text: admitted.failure.message }],
          },
        });
    }
    const response = yield* requestEffect.pipe(
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.provideService(ExecutionHost.McpTurnAdmission, {
        actor,
        requestId: payload?.id,
        assertCurrent,
      }),
    );
    const openedProfileId = response.headers["mcp-session-id"];
    if (payload?.method === "initialize" && openedProfileId !== undefined && native !== undefined) {
      yield* Ref.update(profiles, (current) => new Map(current).set(openedProfileId, native));
    }
    if (request.method === "DELETE" && profileId !== undefined)
      yield* Ref.update(profiles, (current) => {
        const next = new Map(current);
        next.delete(profileId);
        return next;
      });
    return response;
  });
});

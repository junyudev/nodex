import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import { HostBridge } from "./HostBridge.ts";
import { hostToolAuthorityRefusal } from "./HostToolAuthority.ts";

const Request = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  params: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
      _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
});
const decodeRequest = Schema.decodeUnknownEffect(Request);
const decodeNativeExecution = Schema.decodeUnknownEffect(
  Schema.Struct({
    nativeThreadId: Schema.String,
    nativeTurnId: Schema.String,
    nativeCallId: Schema.String,
  }),
);
const discovery = new Set(["orchestrator_capabilities"]);
type NativeSession = { readonly providerSessionId: string; readonly nativeGeneration: number };
const MAX_MCP_PROFILES = 4096;
const sameNativeSession = (left: NativeSession | undefined, right: NativeSession | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.providerSessionId === right.providerSessionId &&
  left.nativeGeneration === right.nativeGeneration;

/** Transport source tags are captured here and never become semantic tool parameters. */
const isJsonObject = (value: Schema.Json | undefined): value is Schema.JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const semanticRequest = (
  request: HttpServerRequest.HttpServerRequest,
  body: Schema.Json | undefined,
): HttpServerRequest.HttpServerRequest => {
  if (!isJsonObject(body)) return request;
  if (body.method !== "tools/call") return request;
  const params = body.params;
  if (!isJsonObject(params)) return request;
  const args = params.arguments;
  if (!isJsonObject(args)) return request;
  if (!("__nodexExecutionCall" in args) && !("__nodexNativeExecution" in args)) return request;
  const cleanArgs = Object.fromEntries(
    Object.entries(args).filter(
      ([key]) => key !== "__nodexExecutionCall" && key !== "__nodexNativeExecution",
    ),
  );
  const cleanParams = Object.fromEntries([...Object.entries(params), ["arguments", cleanArgs]]);
  const clean = Object.fromEntries([...Object.entries(body), ["params", cleanParams]]);
  // Preserve the physical source used by HTTP response hooks, headers, and lifecycle ownership.
  return Object.create(request, {
    json: { value: Effect.succeed(clean) },
    text: { value: Effect.succeed(JSON.stringify(clean)) },
  });
};

/** Bind native incarnation, then capture the exact Run or truthful Session source at ingress. */
export const make = Effect.gen(function* () {
  const bridge = yield* HostBridge;
  const projections = yield* Projections.ProjectionStoreV2;
  const profiles = yield* Ref.make<ReadonlyMap<string, NativeSession>>(new Map());
  const watched = yield* Ref.make<ReadonlySet<string>>(new Set());
  return Effect.fn("AgentRuntime.admitMcpRequest")(function* (
    requestEffect: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      Invocation.McpInvocationContext | HttpServerRequest.HttpServerRequest
    >,
    scope: Invocation.McpInvocationScope,
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const caller = scope.thread;
    const profileId = request.headers["mcp-session-id"];
    const profile = profileId === undefined ? undefined : (yield* Ref.get(profiles)).get(profileId);
    const profileActor =
      caller === undefined ? undefined : yield* bridge.preparedTurn(caller.threadId, profile);
    const incarnations =
      caller === undefined ? [] : yield* bridge.nativeSessions(caller.providerSessionId);
    const capturedNative = incarnations.find((candidate) =>
      sameNativeSession(candidate, profile ?? profileActor),
    );
    const body =
      request.method !== "POST"
        ? undefined
        : yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
    const payload = yield* decodeRequest(body).pipe(Effect.orElseSucceed(() => undefined));
    // Native MCP initialization can precede the first prepared Run. Its bearer still
    // identifies one registered physical incarnation; ambiguity must stay unresolved.
    const native =
      capturedNative ??
      (payload?.method === "initialize" &&
      profileId === undefined &&
      profileActor === undefined &&
      incarnations.length === 1
        ? incarnations[0]
        : undefined);
    const token = payload?.params?.arguments?.__nodexExecutionCall;
    const tagged =
      typeof token === "string" ? yield* bridge.resolveNativeToolCall(token) : undefined;
    const meta = payload?.params?._meta;
    const metadata = meta?.["x-codex-turn-metadata"];
    const turnMetadata = yield* Schema.decodeUnknownEffect(
      Schema.Union([
        Schema.Struct({ turn_id: Schema.optional(Schema.String) }),
        Schema.fromJsonString(Schema.Struct({ turn_id: Schema.optional(Schema.String) })),
      ]),
    )(metadata).pipe(Effect.orElseSucceed(() => undefined));
    const nativeExecution = yield* decodeNativeExecution(
      payload?.params?.arguments?.__nodexNativeExecution,
    ).pipe(Effect.orElseSucceed(() => undefined));
    const codexCall =
      typeof meta?.callId === "string" &&
      typeof meta.threadId === "string" &&
      turnMetadata?.turn_id !== undefined
        ? {
            nativeCallId: meta.callId,
            nativeThreadId: meta.threadId,
            nativeTurnId: turnMetadata.turn_id,
          }
        : undefined;
    const driver = profileActor?.nativeDriver;
    const isOpenCode = driver === "opencode" || driver === "opencode2";
    const usesNativeMetadata = driver === "codex" || isOpenCode;
    const sourceCall = driver === "codex" ? codexCall : (nativeExecution ?? codexCall);
    // OpenCode publishes one native tool catalog per owned server. The namespace's bearer
    // authenticates this transport; the registered native tuple identifies the actual caller.
    const callLookup =
      native === undefined || caller === undefined || sourceCall === undefined
        ? undefined
        : isOpenCode
          ? { providerInstanceId: caller.providerInstanceId, ...sourceCall }
          : { threadId: caller.threadId, ...native, ...sourceCall };
    const nativeCall =
      callLookup === undefined ? undefined : yield* bridge.awaitNativeCallById(callLookup);
    // Stateless native clients attest through the exact registered call. An explicit
    // HTTP session ID must still resolve to its own live physical incarnation.
    const transportSource = profileId === undefined ? nativeCall : profile;
    const sourceLess =
      driver !== undefined &&
      !usesNativeMetadata &&
      driver !== "claudeAgent" &&
      driver !== "claude-code";
    const sessionActor =
      sourceLess && native !== undefined && caller !== undefined
        ? yield* bridge.nativeSessionActor(caller.threadId, native)
        : undefined;
    const actor = sourceLess
      ? sessionActor
      : usesNativeMetadata
        ? nativeCall
        : typeof token === "string"
          ? tagged
          : (nativeCall ?? profileActor);
    const guarded = payload?.method === "tools/call" && !discovery.has(payload.params?.name ?? "");
    const checkCurrent = Effect.fn("AgentRuntime.assertMcpAdmission")(function* () {
      const refuse = (message: string) =>
        new ExecutionHost.ExecutionHostError({ operation: "mcp.admission", message });
      if (
        caller === undefined ||
        actor === undefined ||
        native === undefined ||
        ((driver === "claudeAgent" || driver === "claude-code") && tagged === undefined) ||
        (driver === "codex" && (nativeCall === undefined || codexCall === undefined)) ||
        (isOpenCode && (nativeExecution === undefined || nativeCall === undefined)) ||
        (!isOpenCode && actor.threadId !== caller.threadId) ||
        actor.providerInstanceId !== caller.providerInstanceId ||
        !sameNativeSession(transportSource, native) ||
        (!isOpenCode && !sameNativeSession(actor, native))
      )
        return yield* Effect.fail(refuse("This MCP client has no captured execution identity."));
      const currentNative = yield* bridge.nativeSessions(caller.providerSessionId);
      if (
        !currentNative.some((candidate) => sameNativeSession(native, candidate)) ||
        !(yield* bridge.nativeSessionLive(actor))
      )
        return yield* Effect.fail(refuse("Native MCP session generation changed."));
      // Registration can end while the request is suspended in another service. Check it on
      // every mutation boundary rather than accepting a once-captured, now-retired call.
      const registered =
        actor.runId === null
          ? yield* bridge.nativeSessionActor(actor.threadId, actor)
          : usesNativeMetadata && callLookup !== undefined
            ? yield* bridge.resolveNativeCallById(callLookup)
            : typeof token === "string"
              ? yield* bridge.resolveNativeToolCall(token)
              : actor;
      if (
        registered === undefined ||
        registered.threadId !== actor.threadId ||
        registered.runId !== actor.runId ||
        registered.attemptId !== actor.attemptId ||
        !sameNativeSession(registered, actor) ||
        (actor.runId === null &&
          (registered.runId !== null || registered.incarnationId !== actor.incarnationId))
      )
        return yield* Effect.fail(refuse("The captured native call has ended."));
      const state = yield* projections
        .getHostToolAuthorityContext(
          ThreadId.make(actor.threadId),
          actor.runId,
          actor.providerThreadId,
        )
        .pipe(Effect.mapError((error) => refuse(error.message)));
      const denied = hostToolAuthorityRefusal(state, actor, actor.nativeGeneration);
      if (denied !== undefined) return yield* Effect.fail(refuse(denied));
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
      if (admitted._tag === "Failure") {
        return HttpServerResponse.jsonUnsafe({
          jsonrpc: "2.0",
          id: payload.id ?? null,
          result: {
            isError: true,
            content: [{ type: "text", text: admitted.failure.message }],
          },
        });
      }
    }
    const response = yield* requestEffect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, semanticRequest(request, body)),
      Effect.provideService(
        Invocation.McpInvocationContext,
        actor === undefined || scope.thread === undefined
          ? scope
          : {
              ...scope,
              requestNamespace: `native-thread:${actor.threadId}`,
              thread: { ...scope.thread, threadId: ThreadId.make(actor.threadId) },
            },
      ),
      Effect.provideService(ExecutionHost.McpTurnAdmission, {
        actor,
        requestId: payload?.id,
        assertCurrent,
      }),
    );
    if (payload?.method === "initialize" && native !== undefined) {
      // MCP adds its session header when the response is sent, after route middleware returns.
      HttpEffect.appendPreResponseHandlerUnsafe(request, (_request, emitted) => {
        const openedProfileId = emitted.headers["mcp-session-id"];
        if (openedProfileId === undefined) return Effect.succeed(emitted);
        return Effect.gen(function* () {
          const accepted = yield* Ref.modify(profiles, (current) =>
            current.size >= MAX_MCP_PROFILES && !current.has(openedProfileId)
              ? ([false, current] as const)
              : ([true, new Map(current).set(openedProfileId, native)] as const),
          );
          if (!accepted)
            return HttpServerResponse.jsonUnsafe(
              {
                jsonrpc: "2.0",
                id: payload.id ?? null,
                error: { code: -32000, message: "MCP client admission capacity is full." },
              },
              { status: 429 },
            );
          const identity = { ...native, credentialId: caller!.providerSessionId };
          const key = JSON.stringify([
            identity.credentialId,
            native.providerSessionId,
            native.nativeGeneration,
          ]);
          const watch = yield* Ref.modify(watched, (current) =>
            current.has(key)
              ? ([false, current] as const)
              : ([true, new Set(current).add(key)] as const),
          );
          if (!watch) return emitted;
          // One finalizer per native incarnation also bounds repeated initialize/delete cycles.
          yield* bridge.onNativeSessionClose(
            identity,
            Ref.update(
              profiles,
              (current) =>
                new Map([...current].filter(([, profile]) => !sameNativeSession(profile, native))),
            ).pipe(
              Effect.andThen(
                Ref.update(watched, (current) => {
                  const next = new Set(current);
                  next.delete(key);
                  return next;
                }),
              ),
            ),
          );
          return emitted;
        });
      });
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

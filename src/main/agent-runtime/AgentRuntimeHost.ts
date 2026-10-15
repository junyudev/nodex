import { isDeepStrictEqual } from "node:util";
import type {
  AgentHostRequest,
  AgentHostTurnIdentity,
  AgentHostExecutionIdentity,
  AgentNativeSessionAuthority,
  AgentRuntimeConfiguration,
  AgentProviderAuthentication,
  AgentThreadAuthority,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { createOperationId } from "../core-runtime/operation-identity";
import { createHostedAppToolCaller } from "../app-tools/AppToolCaller";
import { buildAgentRuntimeCliContext } from "../platform/node/NodexCliBootstrap";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import {
  make as makeAuthority,
  type AgentRuntimeAuthorityEvidence,
  type AgentRuntimeAuthorityIdentity,
} from "./AgentRuntimeAuthority";
import type { AgentRuntimeHostToolExecutor } from "./AgentRuntimeHostTools";
import { make as makeExecutionLeases } from "./AgentRuntimeExecutionLeases";

export class AgentRuntimeHostError extends Schema.TaggedError<AgentRuntimeHostError>()(
  "AgentRuntimeHostError",
  { operation: Schema.String, message: Schema.String },
) {}
const unavailable = (operation: string) =>
  new AgentRuntimeHostError({
    operation,
    message: "Nodex application authority is unavailable for this request",
  });

type ExecutionProof = AgentThreadAuthority | AgentNativeSessionAuthority;
const sameNativeFrame = (left: AgentHostExecutionIdentity, right: ExecutionProof) =>
  left.runtimeId === right.runtimeId &&
  left.runtimeGeneration === right.runtimeGeneration &&
  left.threadId === right.threadId &&
  left.runId === right.runId &&
  left.attemptId === right.attemptId &&
  left.providerInstanceId === right.providerInstanceId &&
  left.providerSessionId === right.providerSessionId &&
  left.providerThreadId === right.providerThreadId &&
  left.nativeGeneration === right.nativeGeneration &&
  (left.runId !== null || (right.runId === null && left.incarnationId === right.incarnationId)) &&
  isDeepStrictEqual(left.nativeThreadRef, right.nativeThreadRef);

export const make = Effect.fn("AgentRuntimeHost.make")(function* (
  connection: AgentRuntimeProcessConnection,
  options: {
    readonly projectlessId: string;
    readonly providers: AgentRuntimeConfiguration["providers"];
    readonly providerDriver?: (instanceId: string) => string | undefined;
    readonly execute: AgentRuntimeHostToolExecutor;
    readonly presentation?: Pick<
      CodexTurnPresentation["Service"],
      "observeRuntimeMessage" | "finishRuntimeSource" | "finishRuntimeLease" | "finish"
    >;
    readonly readProviderAuth?: (input: {
      readonly refresh: boolean;
      readonly previousAccountId: string | null;
      readonly isActive: () => boolean;
    }) => Effect.Effect<AgentProviderAuthentication, unknown>;
  },
) {
  const core = yield* CoreModules;
  const coreAuthority = yield* CoreAuthority;
  const config = yield* MainConfig;
  const { runtimeId, runtimeGeneration: leaseId } = connection.identity;
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
      options.presentation?.finishRuntimeLease(runtimeId, leaseId);
    }),
  );
  const host = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(Effect.provideService(CoreApplicationAgent, null));
  const projectIdOf = (value: string) => (value === options.projectlessId ? null : value);
  const evidenceOf = (proof: ExecutionProof): AgentRuntimeAuthorityEvidence => {
    const common = {
      runtimeId,
      leaseId,
      threadId: proof.threadId,
      projectId: projectIdOf(proof.projectId),
      rootThreadId: proof.rootThreadId,
      archived: proof.archived,
      providerSessionId: proof.providerSessionId,
      nativeGeneration: proof.nativeGeneration,
    };
    return proof.runId === null
      ? {
          ...common,
          runId: null,
          status: null,
          providerSessionId: proof.providerSessionId,
          nativeGeneration: proof.nativeGeneration,
          incarnationId: proof.incarnationId,
        }
      : { ...common, runId: proof.runId, status: proof.status };
  };
  const readProof = Effect.fn("AgentRuntimeHost.readProof")(function* (
    identity: AgentHostExecutionIdentity,
  ) {
    if (!open || identity.runtimeId !== runtimeId || identity.runtimeGeneration !== leaseId)
      return yield* unavailable("identity");
    const proof =
      identity.runId === null
        ? yield* connection.request("native-session.authority", {
            threadId: identity.threadId,
            providerSessionId: identity.providerSessionId,
            nativeGeneration: identity.nativeGeneration,
            incarnationId: identity.incarnationId,
          })
        : yield* connection.request("thread.authority", {
            threadId: identity.threadId,
            runId: identity.runId,
          });
    if (!proof || !sameNativeFrame(identity, proof)) return yield* unavailable("identity");
    return proof;
  });
  // A new physical process cannot leave old connection claims alive in Core.
  yield* host(
    core.workspace.apply({
      operationId: createOperationId("agent-runtime.clear-abandoned-authorities"),
      intent: { kind: "revoke_agent_runtime_authorities", runtime_id: runtimeId },
    }),
  );
  const authority = yield* makeAuthority({
    runtimeId,
    leaseId,
    observe: (request) =>
      Effect.gen(function* () {
        const proof =
          "run_id" in request.identity
            ? yield* connection.request("thread.authority", {
                threadId: request.identity.thread_id,
                runId: request.identity.run_id,
              })
            : yield* connection.request("native-session.authority", {
                threadId: request.identity.thread_id,
                providerSessionId: request.identity.provider_session_id,
                nativeGeneration: request.identity.native_generation,
                incarnationId: request.identity.incarnation_id,
              });
        if (!open || !proof || proof.runtimeId !== runtimeId || proof.runtimeGeneration !== leaseId)
          return null;
        if (
          request.phase === "capture" &&
          (!request.nativeCall ||
            request.nativeCall.providerThreadId !== proof.providerThreadId ||
            request.nativeCall.providerTurnId !== proof.nativeTurnId)
        )
          return null;
        return {
          ...evidenceOf(proof),
          ...(request.nativeCall ? { nativeCall: request.nativeCall } : {}),
        };
      }),
  });
  const leases = yield* makeExecutionLeases(
    connection,
    authority,
    Effect.sync(() => {
      open = false;
    }).pipe(
      Effect.andThen(authority.close),
      Effect.andThen(connection.request("shutdown", {})),
      Effect.catchCause(() => Effect.void),
      Effect.asVoid,
    ),
    options.presentation,
  );

  const prepare = Effect.fn("AgentRuntimeHost.prepare")(function* (
    identity: AgentHostTurnIdentity,
  ) {
    const proof = yield* readProof(identity);
    const evidence = evidenceOf(proof);
    if (evidence.runId === null) return yield* unavailable("turn.prepare");
    const prepared = yield* authority.prepareTurn({ evidence });
    if (proof.runId !== null && options.presentation)
      yield* options.presentation.observeRuntimeMessage(
        proof.threadId,
        proof.runId,
        proof.userMessageId,
        {
          runtimeId,
          runtimeGeneration: leaseId,
          providerSessionId: proof.providerSessionId,
          nativeGeneration: proof.nativeGeneration,
        },
      );
    yield* leases.track(prepared.identity, proof);
    const base = `You are working in Nodex Session ${prepared.sessionId}. Use the Nodex application tools for content operations.`;
    const cli = yield* buildAgentRuntimeCliContext(
      config,
      coreAuthority.identity,
      prepared.context,
    );
    return { instructions: cli ? `${base}\n\n${cli}` : base };
  });

  const execute = Effect.fn("AgentRuntimeHost.execute")(
    function* (request: AgentHostRequest) {
      if (request.operation === "provider.auth") {
        const provider = options.providers[request.identity.providerInstanceId];
        const settings = provider?.config;
        const isActive = () =>
          open &&
          request.identity.runtimeId === runtimeId &&
          request.identity.runtimeGeneration === leaseId;
        if (
          !isActive() ||
          provider?.driver !== "codex" ||
          !settings ||
          typeof settings !== "object" ||
          !("hostAuthentication" in settings) ||
          settings.hostAuthentication !== true ||
          !options.readProviderAuth
        )
          return yield* unavailable("provider.auth");
        return yield* options.readProviderAuth({
          refresh: request.refresh,
          previousAccountId: request.previousAccountId,
          isActive,
        });
      }
      if (request.operation === "turn.prepare") return yield* prepare(request.identity);
      const proof = yield* readProof(request.identity);
      const callId =
        (request.identity.nativeCallKey === undefined
          ? undefined
          : JSON.stringify([
              "native",
              request.identity.nativeCallKey,
              request.identity.mcpRequestId ?? null,
            ])) ??
        (request.identity.mcpRequestId === undefined
          ? request.id
          : JSON.stringify([
              "mcp",
              request.identity.mcpClientId ?? null,
              request.identity.mcpRequestId,
            ]));
      const nativeCall = {
        providerThreadId: proof.providerThreadId,
        providerTurnId: request.identity.nativeTurnId ?? null,
        callId,
      };
      const identity: AgentRuntimeAuthorityIdentity = {
        runtime_id: runtimeId,
        lease_id: leaseId,
        thread_id: proof.threadId,
        ...(proof.runId === null
          ? {
              provider_session_id: proof.providerSessionId,
              native_generation: proof.nativeGeneration,
              incarnation_id: proof.incarnationId,
            }
          : { run_id: proof.runId }),
      };
      if (proof.runId === null) {
        const evidence = evidenceOf(proof);
        if (evidence.runId !== null) return yield* unavailable("native-session.identity");
        const admitted = yield* authority.prepareNativeSession({ evidence });
        yield* leases.track(admitted.identity, proof);
      }
      const capture = readProof(request.identity).pipe(
        Effect.flatMap((current) =>
          authority.capture({ evidence: evidenceOf(current), identity, nativeCall }),
        ),
      );
      const prepared = yield* capture;
      const driver =
        options.providerDriver?.(proof.providerInstanceId) ??
        options.providers[proof.providerInstanceId]?.driver;
      const backend =
        driver === "codex"
          ? "codex"
          : driver === "claudeAgent"
            ? "claude"
            : driver === "opencode"
              ? "opencode"
              : driver === "acpRegistry"
                ? "acp"
                : null;
      if (
        !backend ||
        request.input === null ||
        Array.isArray(request.input) ||
        typeof request.input !== "object"
      )
        return yield* unavailable("tool.call");
      const caller = createHostedAppToolCaller({
        backend,
        authority: prepared.context,
        callId,
        generation: proof.nativeGeneration,
        sessionContext: {
          sessionId: prepared.sessionId,
          projectId: prepared.context.actorProjectId,
          runtimeId,
          rootThreadId: proof.rootThreadId,
          threadId: proof.threadId,
          runId: proof.runId,
          cwd: proof.cwd,
        },
        isActive: () => open,
        capture: capture.pipe(
          Effect.map((value) => value.context),
          Effect.catch(() => Effect.succeed(null)),
        ),
      });
      return yield* options.execute(caller, request.tool, request.input as Record<string, unknown>);
    },
    Effect.mapError(() => unavailable("host.request")),
  );
  return execute;
});

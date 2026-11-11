import { createHash } from "node:crypto";
import { inboundTextHash } from "./ChatMessageDelivery";
import { HostWorkspace } from "../../host/HostWorkspace";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { effectiveHolds } from "../../host/work-application/execution-holds";
import {
  COORDINATOR_INSTRUCTIONS,
  MANAGED_SESSION_INSTRUCTIONS,
} from "../../host/coordinator/coordinator-instructions";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentHostRequest,
  AgentHostTurnIdentity,
  AgentHostExecutionIdentity,
  AgentNativeSessionAuthority,
  AgentRuntimeConfiguration,
  AgentThreadAuthority,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { ScopedAgentCore } from "../../host/ScopedAgentCore";
import { HostAgentPolicy } from "../../host/HostAgentPolicy";
import type { CodexTurnPresentation } from "../../host/TurnPresentation";
import { MainConfig } from "../app/MainConfig";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import { createHostedAppToolCaller } from "../app-tools/AppToolCaller";
import { agentBackendKindOfRuntimeDriver } from "../../shared/agent-backend";
import { buildNodexCliBootstrap, nodexCliShellBinding } from "../platform/node/NodexCliBootstrap";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make as makeRuntimeAuthority } from "./AgentRuntimeAuthority";
import type { AgentRuntimeDesktopTools } from "./AgentRuntimeDesktopTools";
import type { AgentRuntimeHostToolExecutor } from "../../host/HostToolExecutor";
import { make as makePresentationRelease } from "./AgentRuntimePresentationRelease";

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
const isRevokedRun = (status: AgentThreadAuthority["status"] | null) =>
  status === "cancelled" || status === "interrupted" || status === "rolled_back";
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
    readonly desktop?: Pick<
      AgentRuntimeDesktopTools,
      "threadConfig" | "desktopTools" | "observeNativeTurn"
    >;
    /** What a workspace's Environment setup changed, for providers that start their own processes. */
    readonly workspaceEnvironment?: (cwd: string) => Effect.Effect<
      {
        readonly set: Readonly<Record<string, string>>;
        readonly exclude: readonly string[];
      } | null,
      unknown
    >;
    readonly presentation?: Pick<
      CodexTurnPresentation["Service"],
      "observeRuntimeMessage" | "finishRuntimeSource" | "finishRuntimeLease" | "finish"
    >;
  },
) {
  const coreAuthority = yield* CoreAuthority;
  const core = yield* CoreModules;
  const hostWorkspace = yield* HostWorkspace;
  const config = yield* MainConfig;
  const scopedCore = Option.getOrUndefined(yield* Effect.serviceOption(ScopedAgentCore));
  const hostPolicy = yield* Effect.serviceOption(HostAgentPolicy);
  if (Option.isSome(hostPolicy) && !scopedCore) return yield* unavailable("scoped-agent-core");
  const authorizeExecution = yield* makeRuntimeAuthority;
  const { runtimeId, runtimeGeneration: leaseId } = connection.identity;
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
      options.presentation?.finishRuntimeLease(runtimeId, leaseId);
    }),
  );
  const shellTaskId = (threadId: string) =>
    createHash("sha256")
      .update(JSON.stringify([runtimeId, leaseId, threadId]))
      .digest("hex");
  const projectIdOf = (value: string) => (value === options.projectlessId ? null : value);
  const isCurrentLease = (identity: {
    readonly runtimeId: string;
    readonly runtimeGeneration: string;
  }) => open && identity.runtimeId === runtimeId && identity.runtimeGeneration === leaseId;
  const driverOf = (providerInstanceId: string) =>
    options.providerDriver?.(providerInstanceId) ?? options.providers[providerInstanceId]?.driver;
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
    if (!open || !proof || !sameNativeFrame(identity, proof) || isRevokedRun(proof.status))
      return yield* unavailable("identity");
    return proof;
  });
  /** Every use re-proves the execution live; a tool call also proves its native Turn is current. */
  const authorize = Effect.fn("AgentRuntimeHost.authorize")(function* (
    identity: AgentHostExecutionIdentity,
    nativeTurnId?: string | null,
    pauseIfHeld = false,
  ) {
    const proof = yield* readProof(identity);
    if (nativeTurnId !== undefined && proof.nativeTurnId !== nativeTurnId)
      return yield* unavailable("identity");
    const authorized = yield* authorizeExecution(proof, projectIdOf(proof.projectId));
    if (!open) return yield* unavailable("identity");
    const holds = yield* effectiveHolds(core, {
      kind: "session",
      session_id: authorized.sessionId,
    });
    if (holds.length) {
      // A hold can commit after Runtime claims a start but before Host preparation.
      // Fence and queue that attempt before refusing its native authority.
      if (pauseIfHeld)
        yield* connection.request("thread.pause", {
          threadId: proof.rootThreadId,
          revision: holds.map((hold) => hold.revision).join(":"),
        });
      return yield* unavailable("identity");
    }
    return { ...authorized, proof };
  });
  const presentation = options.presentation
    ? yield* makePresentationRelease(connection, options.presentation)
    : null;

  const bindInbound = Effect.fn("AgentRuntimeHost.bindInbound")(function* (
    proof: ExecutionProof,
    sessionId: string,
    managedKnown = false,
  ) {
    if (proof.runId === null) return;
    if (!managedKnown) {
      const managed = yield* core.workspace.read(
        { kind: "read_managed_session", session_id: sessionId },
        undefined,
        null,
      );
      if (managed.value.kind !== "read_managed_session" || !managed.value.managed) return;
    }
    const message = yield* connection.request("thread.run-message", {
      threadId: proof.threadId,
      runId: proof.runId,
    });
    if (!message || message.id !== proof.userMessageId) return;
    yield* core.workspace
      .apply(
        {
          operationId: createOperationId("chat.inbound"),
          intent: {
            kind: "bind_chat_inbound",
            session_id: sessionId,
            run_id: proof.runId,
            delivery_id: proof.userMessageId,
            body_hash: inboundTextHash(message.text),
            attachment_count: message.attachments.filter(
              (attachment) => attachment.type === "image" || attachment.type === "file",
            ).length,
            author:
              message.createdBy === "user"
                ? { kind: "user" }
                : {
                    kind: "agent",
                    session_id: null,
                    thread_id: message.senderThreadId ?? null,
                    run_id: null,
                    project_id: null,
                    label: message.createdBy === "system" ? "Nodex" : "Agent",
                  },
          },
        },
        undefined,
        null,
      )
      .pipe(
        Effect.provideService(CoreApplicationAgent, null),
        Effect.catchIf(
          (error) =>
            error.cause instanceof CoreModuleResponseError &&
            error.cause.coreError.code === "not_found",
          () => Effect.void,
        ),
      );
  });

  const prepare = Effect.fn("AgentRuntimeHost.prepare")(function* (
    identity: AgentHostTurnIdentity,
  ) {
    const { proof, sessionId, context } = yield* authorize(identity, undefined, true);
    if (proof.runId === null) return yield* unavailable("turn.prepare");
    const project =
      context.actorProjectId === null
        ? null
        : yield* core.workspace.read(
            { kind: "project", project_id: context.actorProjectId },
            undefined,
            context.actorProjectId,
          );
    if (project !== null && project.value.kind !== "project")
      return yield* unavailable("turn.prepare");
    const sourceRoots =
      project?.value.kind === "project"
        ? yield* hostWorkspace
            .resolve(project.value.project.sources)
            .pipe(Effect.catch(() => unavailable("workspace")))
        : [];
    if (presentation) yield* presentation.observe(proof);
    const base = `You are working in Nodex Session ${sessionId}. Use the Nodex application tools for content operations.`;
    // Record the verified opening input before the provider can act or request approval.
    const backend = agentBackendKindOfRuntimeDriver(driverOf(proof.providerInstanceId));
    if (!backend) return yield* unavailable("turn.actor");
    const inputMessage = yield* connection.request("thread.run-message", {
      threadId: proof.threadId,
      runId: proof.runId,
    });
    yield* core.workspace.recordAgentRun({
      session_id: sessionId,
      run_id: proof.runId,
      ...(inputMessage?.id === proof.userMessageId && inputMessage.createdBy === "user"
        ? { message_id: proof.userMessageId }
        : {}),
      backend,
    });
    const driver = driverOf(proof.providerInstanceId);
    const nativeId =
      identity.nativeThreadRef?.driver === "codex" ? identity.nativeThreadRef.nativeId : null;
    const taskId = nativeId ?? shellTaskId(proof.threadId);
    const providerConfig = options.providers[proof.providerInstanceId]?.config;
    const serverUrl =
      typeof providerConfig === "object" && providerConfig !== null && "serverUrl" in providerConfig
        ? providerConfig.serverUrl
        : undefined;
    const externalOpenCode = typeof serverUrl === "string" && serverUrl.trim() !== "";
    const supportsCli =
      nativeId !== null || driver === "claudeAgent" || (driver === "opencode" && !externalOpenCode);
    const scopedConnection =
      scopedCore && supportsCli
        ? yield* scopedCore.issue({
            owner: taskId,
            identity: coreAuthority.identity,
            projectId: context.actorProjectId,
            attribution: {
              session_id: sessionId,
              run_id: proof.runId,
              backend,
            },
            authorize: Effect.gen(function* () {
              const current = yield* readProof(identity).pipe(Effect.orElseSucceed(() => null));
              if (current === null) return "turn_ended" as const;
              if (current.archived) return "session_unavailable" as const;
              if (
                current.status !== "starting" &&
                current.status !== "running" &&
                current.status !== "waiting"
              )
                return "turn_ended" as const;
              const binding = yield* authorizeExecution(
                current,
                projectIdOf(current.projectId),
              ).pipe(Effect.orElseSucceed(() => null));
              if (binding?.sessionId !== sessionId) return "session_unavailable" as const;
              const holds = yield* effectiveHolds(core, { kind: "session", session_id: sessionId });
              return open && holds.length === 0 ? ("allowed" as const) : ("turn_ended" as const);
            }).pipe(Effect.orElseSucceed(() => "turn_ended" as const)),
          })
        : undefined;
    const cli = scopedConnection
      ? yield* buildNodexCliBootstrap(config, {
          threadId: taskId,
          hostId: "local",
          scopedConnection,
          turnId: proof.runId,
        }).pipe(Effect.orElseSucceed(() => null))
      : null;
    const cliShell = cli?.routed ? nodexCliShellBinding(config, taskId, proof.runId) : undefined;
    const coordinator = yield* core.workspace.read({ kind: "read_coordinator" }, undefined, null);
    const managed = yield* core.workspace.read(
      { kind: "read_managed_session", session_id: sessionId },
      undefined,
      null,
    );
    if (managed.value.kind === "read_managed_session" && managed.value.managed)
      yield* bindInbound(proof, sessionId, true);
    const role =
      coordinator.value.kind === "read_coordinator" && coordinator.value.session_id === sessionId
        ? COORDINATOR_INSTRUCTIONS
        : managed.value.kind === "read_managed_session" && managed.value.managed
          ? MANAGED_SESSION_INSTRUCTIONS
          : null;
    return {
      instructions: [base, driver === "opencode" ? null : cli?.value, role]
        .filter(Boolean)
        .join("\n\n"),
      sourceRoots,
      ...(cliShell ? { cliShell } : {}),
    };
  });

  const execute = Effect.fn("AgentRuntimeHost.execute")(
    function* (request: AgentHostRequest) {
      if (request.operation === "turn.prepare") return yield* prepare(request.identity);
      if (request.operation === "thread.prepare") {
        const { identity } = request;
        if (!isCurrentLease(identity)) return yield* unavailable("thread.prepare");
        if (identity.nativeDriver === "codex" && driverOf(identity.providerInstanceId) === "codex")
          // Codex applies its worktree's Environment to its shells itself.
          return options.desktop
            ? { config: yield* options.desktop.threadConfig(request.cwd) }
            : {};
        const environment =
          request.cwd && options.workspaceEnvironment
            ? yield* options.workspaceEnvironment(request.cwd)
            : null;
        const prepared = environment ? { environment } : {};
        if (
          identity.nativeDriver !== "claudeAgent" ||
          driverOf(identity.providerInstanceId) !== "claudeAgent" ||
          !options.desktop
        )
          return prepared;
        const desktopTools = yield* options.desktop.desktopTools.pipe(
          Effect.catch(() =>
            // Preparation errors can contain launch environment values. Log no error payload.
            Effect.logWarning("Desktop tools are unavailable for a Claude thread").pipe(
              Effect.as(null),
            ),
          ),
        );
        return desktopTools ? { ...prepared, desktopTools } : prepared;
      }
      if (request.operation === "turn.native") {
        const { identity } = request;
        const nativeThreadId = identity.nativeThreadRef?.nativeId;
        if (!options.desktop || identity.runId === null || !nativeThreadId) return {};
        const turn = { nativeThreadId, nativeTurnId: request.nativeTurnId };
        // Ending only lets go of what the Turn held, so it needs the lease, not a live Run.
        if (request.phase === "ended") {
          if (!isCurrentLease(identity)) return yield* unavailable("turn.native");
          yield* options.desktop.observeNativeTurn({ ...turn, phase: "ended" });
          return {};
        }
        const { proof, sessionId, context } = yield* authorize(identity);
        if (proof.runId === null) return yield* unavailable("turn.native");
        yield* options.desktop.observeNativeTurn({
          ...turn,
          threadId: proof.threadId,
          runId: proof.runId,
          sessionId,
          projectId: context.actorProjectId,
          phase: "started",
        });
        return {};
      }
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
      const capture = authorize(request.identity, request.identity.nativeTurnId ?? null);
      const { proof, sessionId, context } = yield* capture;
      if (request.tool === "hand_back_message") yield* bindInbound(proof, sessionId);
      const backend = agentBackendKindOfRuntimeDriver(driverOf(proof.providerInstanceId));
      if (
        !backend ||
        request.input === null ||
        Array.isArray(request.input) ||
        typeof request.input !== "object"
      )
        return yield* unavailable("tool.call");
      const caller = createHostedAppToolCaller({
        backend,
        authority: context,
        callId,
        generation: proof.nativeGeneration,
        sessionContext: {
          sessionId,
          projectId: context.actorProjectId,
          runtimeId,
          rootThreadId: proof.rootThreadId,
          threadId: proof.threadId,
          runId: proof.runId,
          ...(proof.runId !== null ? { inboundMessageId: proof.userMessageId } : {}),
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

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
import { createHostedAppToolCaller } from "../app-tools/AppToolCaller";
import { buildAgentRuntimeCliContext } from "../platform/node/NodexCliBootstrap";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make as makeRuntimeAuthority } from "./AgentRuntimeAuthority";
import type { AgentRuntimeDesktopTools } from "./AgentRuntimeDesktopTools";
import type { AgentRuntimeHostToolExecutor } from "./AgentRuntimeHostTools";
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
    readonly desktop?: Pick<AgentRuntimeDesktopTools, "threadConfig" | "observeNativeTurn">;
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
    readonly readProviderAuth?: (input: {
      readonly refresh: boolean;
      readonly previousAccountId: string | null;
      readonly isActive: () => boolean;
    }) => Effect.Effect<AgentProviderAuthentication, unknown>;
  },
) {
  const coreAuthority = yield* CoreAuthority;
  const config = yield* MainConfig;
  const authorizeExecution = yield* makeRuntimeAuthority;
  const { runtimeId, runtimeGeneration: leaseId } = connection.identity;
  let open = true;
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      open = false;
      options.presentation?.finishRuntimeLease(runtimeId, leaseId);
    }),
  );
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
  ) {
    const proof = yield* readProof(identity);
    if (nativeTurnId !== undefined && proof.nativeTurnId !== nativeTurnId)
      return yield* unavailable("identity");
    const authorized = yield* authorizeExecution(proof, projectIdOf(proof.projectId));
    if (!open) return yield* unavailable("identity");
    return { ...authorized, proof };
  });
  const presentation = options.presentation
    ? yield* makePresentationRelease(connection, options.presentation)
    : null;

  const prepare = Effect.fn("AgentRuntimeHost.prepare")(function* (
    identity: AgentHostTurnIdentity,
  ) {
    const { proof, sessionId, context } = yield* authorize(identity);
    if (proof.runId === null) return yield* unavailable("turn.prepare");
    if (presentation) yield* presentation.observe(proof);
    const base = `You are working in Nodex Session ${sessionId}. Use the Nodex application tools for content operations.`;
    const cli = yield* buildAgentRuntimeCliContext(
      config,
      coreAuthority.identity,
      context,
      identity.nativeThreadRef?.driver === "codex"
        ? (identity.nativeThreadRef.nativeId ?? null)
        : null,
    );
    return { instructions: cli ? `${base}\n\n${cli}` : base };
  });

  const execute = Effect.fn("AgentRuntimeHost.execute")(
    function* (request: AgentHostRequest) {
      if (request.operation === "provider.auth") {
        const provider = options.providers[request.identity.providerInstanceId];
        const settings = provider?.config;
        const isActive = () => isCurrentLease(request.identity);
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
        return environment ? { environment } : {};
      }
      if (request.operation === "turn.native") {
        const { identity } = request;
        const nativeThreadId =
          identity.nativeThreadRef?.driver === "codex" ? identity.nativeThreadRef.nativeId : null;
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
      const driver = driverOf(proof.providerInstanceId);
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

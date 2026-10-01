import { nativeSessionCatalogTitle } from "../../shared/native-session-catalog";
import { ClaudeSessionManager } from "./claude/ClaudeSessionManager";
import type {
  NativeSessionAttachInput,
  NativeSessionAttachResult,
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
} from "../../shared/native-session-catalog";
import type { AgentSessionHandle, AgentSessionPermissionPolicy } from "./AgentSessionHandle";
import type { AgentInteractionResponse } from "../../shared/agent-conversation";
import type { AgentPromptImage } from "../../shared/agent-conversation";
import { NativePromptImages } from "./NativePromptImages";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { loadCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import { ProjectRuntimeLifecycleRuntime } from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import {
  NativeSessionWorkspace,
  type NativeSessionWorkspaceLease,
  type NativeSessionWorkspaceLocation,
} from "./NativeSessionWorkspace";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as RcMap from "effect/RcMap";
import * as Semaphore from "effect/Semaphore";
import type {
  AgentBackendAuthenticateInput,
  AgentBackendAuthenticateResult,
  AgentBackendConfigOptionInput,
  AgentBackendConfigOptionResult,
  AgentBackendModeInput,
  AgentBackendPromptInput,
  AgentBackendPromptResult,
  AgentBackendSessionOpenInput,
  AgentBackendThreadStartInput,
  NativePermissionMode,
  AgentBackendThreadStartResult,
  AgentBackendSessionChangedEvent,
  AgentBackendIntelligenceInput,
  AgentBackendControlInput,
  AgentBackendForkInput,
  AgentBackendHistoryImageInput,
  AgentBackendToolOutputInput,
} from "../../shared/agent-backend-api";
import type { AgentBackendSessionPresentation } from "../../shared/agent-conversation";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { createUuidV7 } from "../../shared/uuid-v7";
import type {
  CodexPermissionMode,
  ProjectSessionThreadLink,
  ProjectSessionThreadLinkInput,
} from "../../shared/types";
import { AgentBackendRegistry, type AgentBackendRegistryError } from "./AgentBackendRegistry";
import { AcpBackendSessionManager } from "./acp/AcpBackendSessionManager";
import { make as makeSessionDirectory } from "./AgentSessionDirectory";
import { agentRuntimeError, AgentRuntimeError } from "./AgentRuntimeError";
import { ProjectWorkspace, ProjectWorkspaceError } from "../project-application/ProjectWorkspace";
import {
  isClaudeEffortLevel,
  type ClaudeModelCatalogInput,
  type ClaudeDiscoveryInput,
  type ClaudeDiscovery,
  type ClaudeRuntimeDiagnostics,
} from "../../shared/claude-models";
import type { AgentSessionConfigSelectOption } from "../../shared/agent-conversation";
import {
  nativeHistoryFacts,
  nativeSelectionFromState,
  nativeStateFromSnapshot,
  remapNativeState,
} from "./NativeSessionState";
import { NativeTurnAuthority } from "./NativeTurnAuthority";
import {
  NativeAppToolSession,
  type NativeAppToolSessionLease,
} from "../app-tools/NativeAppToolSession";
import {
  NativeConversationBinding,
  type NativeConversationExtension,
  type NativeTurnOutcome,
} from "../app-tools/NativeConversationExtension";
import { CodexPlatform } from "../app/CodexApplicationLive";
import { MainConfig } from "../app/MainConfig";
import { appToolsEntrypoint } from "../codex/app-tools-launch-config";
import { ClaudeTextGeneration } from "./ClaudeTextGeneration";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import type { DesktopProjectWorkspaceExecutionContext } from "../core-client/project-workspace-adapter";
import type { CodexThreadExecutionLocation } from "../codex/codex-thread-handoff-journal";

export class AgentBackendApplicationError extends Schema.TaggedError<AgentBackendApplicationError>()(
  "AgentBackendApplicationError",
  {
    operation: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

type ExternalBinding = Exclude<AgentBackendBinding, { readonly kind: "codex" }>;
type SessionOpenError =
  | AgentBackendApplicationError
  | AgentRuntimeError
  | AgentBackendRegistryError
  | ProjectWorkspaceError;

export class AgentBackendApplication extends Context.Service<
  AgentBackendApplication,
  {
    readonly listClaudeNativeSessions: (
      input: NativeSessionCatalogInput,
    ) => Effect.Effect<NativeSessionCatalogPage, AgentBackendApplicationError>;
    readonly attachClaudeNativeSession: (
      input: NativeSessionAttachInput,
    ) => Effect.Effect<NativeSessionAttachResult, AgentBackendApplicationError>;
    readonly readNativePermissionMode: (
      projectId: string | null,
    ) => Effect.Effect<NativePermissionMode, AgentBackendApplicationError>;
    readonly setNativePermissionMode: (
      projectId: string | null,
      mode: NativePermissionMode,
    ) => Effect.Effect<NativePermissionMode, AgentBackendApplicationError>;
    readonly claudeModels: (
      input: ClaudeModelCatalogInput,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentBackendApplicationError>;
    readonly claudeDiscovery: (
      input: ClaudeDiscoveryInput,
    ) => Effect.Effect<ClaudeDiscovery, AgentBackendApplicationError>;
    readonly setAgentIntelligence: (
      input: AgentBackendIntelligenceInput,
    ) => Effect.Effect<AgentBackendSessionPresentation, AgentBackendApplicationError>;
    readonly withAgentExecutionLocation: <A, E, R>(
      threadId: string,
      location: CodexThreadExecutionLocation,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentBackendApplicationError, R>;
    readonly withAgentExecutionHandoff: <A, E, R>(
      threadId: string,
      use: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | AgentBackendApplicationError, R>;
    readonly setExecutionRecoveryRequired: (
      threadId: string,
      required: boolean,
    ) => Effect.Effect<void, AgentBackendApplicationError>;
    readonly controlAgentSession: (
      input: AgentBackendControlInput,
    ) => Effect.Effect<AgentBackendSessionPresentation, AgentBackendApplicationError>;
    readonly forkAgentSession: (
      input: AgentBackendForkInput,
    ) => Effect.Effect<AgentBackendThreadStartResult, AgentBackendApplicationError>;
    readonly inspectAgentSession: (
      threadId: string,
    ) => Effect.Effect<ClaudeRuntimeDiagnostics, AgentBackendApplicationError>;
    readonly readAgentHistoryImage: (
      input: AgentBackendHistoryImageInput,
    ) => Effect.Effect<string, AgentBackendApplicationError>;
    readonly readAgentToolOutput: (
      input: AgentBackendToolOutputInput,
    ) => Effect.Effect<
      import("../../shared/agent-tool-output").AgentToolOutput,
      AgentBackendApplicationError
    >;
    readonly generateAgentTitle: (
      threadId: string,
    ) => Effect.Effect<string | null, AgentBackendApplicationError>;
    readonly nativeConversations: NativeConversationExtension["Service"];
    readonly startAgentThread: (
      input: AgentBackendThreadStartInput,
    ) => Effect.Effect<AgentBackendThreadStartResult, AgentBackendApplicationError>;
    readonly openAgentSession: (
      input: AgentBackendSessionOpenInput,
    ) => Effect.Effect<AgentBackendSessionPresentation, AgentBackendApplicationError>;
    readonly readAgentSession: (
      threadId: string,
    ) => Effect.Effect<AgentBackendSessionPresentation | null, AgentBackendApplicationError>;
    readonly observeAgentSession: (threadId: string) => Effect.Effect<void>;
    readonly unobserveAgentSession: (threadId: string) => Effect.Effect<void>;
    readonly promptAgentSession: (
      input: AgentBackendPromptInput,
    ) => Effect.Effect<AgentBackendPromptResult, AgentBackendApplicationError>;
    readonly cancelAgentSession: (
      threadId: string,
    ) => Effect.Effect<AgentBackendSessionPresentation["snapshot"], AgentBackendApplicationError>;
    readonly setAgentMode: (
      input: AgentBackendModeInput,
    ) => Effect.Effect<AgentBackendSessionPresentation["snapshot"], AgentBackendApplicationError>;
    readonly setAgentConfigOption: (
      input: AgentBackendConfigOptionInput,
    ) => Effect.Effect<AgentBackendConfigOptionResult, AgentBackendApplicationError>;
    readonly authenticateAgentSession: (
      input: AgentBackendAuthenticateInput,
    ) => Effect.Effect<AgentBackendAuthenticateResult, AgentBackendApplicationError>;
    readonly closeAgentSession: (
      threadId: string,
    ) => Effect.Effect<void, AgentBackendApplicationError>;
    readonly respondToInteraction: (
      threadId: string,
      requestId: string,
      response: AgentInteractionResponse,
    ) => Effect.Effect<void, AgentBackendApplicationError>;
    readonly changes: Stream.Stream<AgentBackendSessionChangedEvent>;
  }
>()("nodex/main/agent-backend/AgentBackendApplication") {}

const sameBinding = (left: ExternalBinding, right: ExternalBinding): boolean =>
  left.kind === right.kind &&
  left.instanceConfigId === right.instanceConfigId &&
  (left.kind === "claude" ||
    (right.kind === "acp" && left.agentDefinitionId === right.agentDefinitionId));

const ACP_PERMISSION_POLICY_BY_MODE = {
  auto: "ask",
  "guardian-approvals": "approve-for-me",
  "full-access": "approve-for-me",
  custom: "ask",
} as const satisfies Readonly<Record<CodexPermissionMode, "approve-for-me" | "ask">>;

export const resolveAcpPermissionPolicy = (
  mode: CodexPermissionMode | null,
): "approve-for-me" | "ask" => (mode === null ? "ask" : ACP_PERMISSION_POLICY_BY_MODE[mode]);

/** Full access is a native execution policy, distinct from approving prompted requests. */
export const resolveClaudePermissionPolicy = (
  mode: CodexPermissionMode | null,
): AgentSessionPermissionPolicy =>
  mode === "full-access" ? "full-access" : resolveAcpPermissionPolicy(mode);

const resolveAgentPermissionPolicy = (
  binding: ExternalBinding,
  mode: CodexPermissionMode | null,
): AgentSessionPermissionPolicy =>
  binding.kind === "claude"
    ? resolveClaudePermissionPolicy(mode)
    : resolveAcpPermissionPolicy(mode);

const titleFromPrompt = (prompt: string): string => {
  const firstLine = prompt.trim().split(/\r?\n/u)[0]?.trim() ?? "";
  return firstLine ? firstLine.slice(0, 120) : "New Agent task";
};

const requestErrorCode = (cause: unknown, depth = 0): number | null => {
  if (depth > 8) return null;
  const value = cause as { readonly code?: unknown; readonly cause?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.code === "number") return value.code;
  return requestErrorCode(value.cause, depth + 1);
};

const runtimeFailureReason = (cause: unknown, depth = 0): string | null => {
  if (depth > 8) return null;
  const value = cause as { readonly reason?: unknown; readonly cause?: unknown } | null;
  if (!value || typeof value !== "object") return null;
  if (typeof value.reason === "string") return value.reason;
  return runtimeFailureReason(value.cause, depth + 1);
};

const isRecoverablePromptFailure = (cause: unknown): boolean => {
  const reason = runtimeFailureReason(cause);
  return (
    reason === "request" || reason === "request-cancelled" || reason === "authentication-required"
  );
};

const isInterruptedOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

export const make = Effect.gen(function* () {
  const backends = yield* AgentBackendRegistry;
  const acpSessions = yield* AcpBackendSessionManager;
  const claudeSessions = yield* ClaudeSessionManager;
  const sessions = yield* makeSessionDirectory;
  const workspace = yield* ProjectWorkspace;
  const ownerScope = yield* Scope.Scope;
  const nativeAuthority = Option.getOrNull(yield* Effect.serviceOption(NativeTurnAuthority));
  const nativeTools = Option.getOrNull(yield* Effect.serviceOption(NativeAppToolSession));
  const platform = Option.getOrNull(yield* Effect.serviceOption(CodexPlatform));
  const config = Option.getOrNull(yield* Effect.serviceOption(MainConfig));
  const textGeneration = Option.getOrNull(yield* Effect.serviceOption(ClaudeTextGeneration));
  const nativeImages = Option.getOrNull(yield* Effect.serviceOption(NativePromptImages));
  const nativeSessionWorkspace = Option.getOrNull(
    yield* Effect.serviceOption(NativeSessionWorkspace),
  );
  const git = Option.getOrNull(yield* Effect.serviceOption(CodexGitProbe));
  const projectLifecycle = Option.getOrNull(
    yield* Effect.serviceOption(ProjectRuntimeLifecycleRuntime),
  );
  const unattendedTurns = new Set<string>();
  const launchAuthorities = new WeakMap<
    AgentSessionHandle,
    {
      binding: ExternalBinding;
      workspaceRoot: string;
      projectId: string | null;
      nativeLocation?: NativeSessionWorkspaceLocation;
    }
  >();
  const nativeIdentityTransitions = new WeakMap<
    AgentSessionHandle,
    { previousSessionId: string; sessionId: string }
  >();
  const nativeExecutionTransitions = new WeakMap<
    AgentSessionHandle,
    {
      readonly source: NativeSessionWorkspaceLocation;
      readonly destination: NativeSessionWorkspaceLocation;
    }
  >();
  const nativeExecutionHandoffs = new Set<string>();
  const nativeExecutionRecoveryRequired = new Set<string>();
  const nativeExecutionRecoveryLocations = new WeakMap<
    AgentSessionHandle,
    readonly NativeSessionWorkspaceLocation[]
  >();
  const pendingSessionOpens = new Map<
    string,
    Deferred.Deferred<AgentBackendSessionPresentation, SessionOpenError>
  >();
  const controlLanes = yield* RcMap.make({ lookup: (_threadId: string) => Semaphore.make(1) });
  const serializeControl = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const lane = yield* RcMap.get(controlLanes, threadId);
        return yield* lane.withPermits(1)(effect);
      }),
    );
  const turnReceipts = new Map<
    string,
    {
      readonly admitted: Deferred.Deferred<void, AgentBackendApplicationError>;
      readonly outcome: Deferred.Deferred<NativeTurnOutcome, AgentBackendApplicationError>;
      settled: boolean;
    }
  >();
  const receiptKey = (threadId: string, turnId: string) => `${threadId}:${turnId}`;
  const nativeOperations = new Map<
    string,
    {
      fingerprint: string;
      admitted: Deferred.Deferred<{ turnId: string }, AgentBackendApplicationError>;
      settled: boolean;
    }
  >();
  const ensureReceipt = Effect.fn("AgentBackendApplication.ensureReceipt")(function* (
    threadId: string,
    turnId: string,
  ) {
    const key = receiptKey(threadId, turnId);
    const current = turnReceipts.get(key);
    if (current) return current;
    if (turnReceipts.size >= 128) {
      const oldest = [...turnReceipts].find(([, entry]) => entry.settled);
      if (oldest) turnReceipts.delete(oldest[0]);
    }
    if (turnReceipts.size >= 128)
      return yield* new AgentBackendApplicationError({
        operation: "turn.admit",
        cause: new Error("Too many active Agent operations"),
        threadId,
      });
    const next = {
      admitted: yield* Deferred.make<void, AgentBackendApplicationError>(),
      outcome: yield* Deferred.make<NativeTurnOutcome, AgentBackendApplicationError>(),
      settled: false,
    };
    turnReceipts.set(key, next);
    return next;
  });

  const fail = (
    operation: string,
    cause: unknown,
    identity?: { threadId?: string; sessionId?: string },
  ) => new AgentBackendApplicationError({ operation, cause, ...identity });
  const ownFailure = <A, E, R>(
    operation: string,
    effect: Effect.Effect<A, E, R>,
    identity?: { readonly threadId?: string; readonly sessionId?: string },
  ): Effect.Effect<A, AgentBackendApplicationError, R> =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof AgentBackendApplicationError ? cause : fail(operation, cause, identity),
      ),
    );
  const requireExecutionAdmission = (threadId: string) =>
    Effect.suspend(() =>
      nativeExecutionHandoffs.has(threadId) || nativeExecutionRecoveryRequired.has(threadId)
        ? Effect.fail(
            fail(
              "session.execution",
              new Error(
                nativeExecutionRecoveryRequired.has(threadId)
                  ? "Recover this task's execution location before continuing"
                  : "Wait for this task's execution handoff to finish",
              ),
              {
                threadId,
              },
            ),
          )
        : Effect.void,
    );

  const presentation = (handle: AgentSessionHandle) =>
    SubscriptionRef.get(handle.snapshot).pipe(
      Effect.map((snapshot) => ({
        snapshot,
        capabilities: snapshot.metadata?.capabilities ?? handle.capabilities,
        modes: snapshot.metadata?.modes ?? handle.modes,
        configOptions: snapshot.metadata?.configOptions ?? handle.configOptions,
      })),
    );

  const projectNativePermissionMode = (mode: CodexPermissionMode | null): NativePermissionMode =>
    mode === "guardian-approvals" || mode === "full-access" ? mode : "auto";
  const readNativePermissionMode = Effect.fn("AgentBackendApplication.readNativePermissionMode")(
    function* (projectId: string | null) {
      if (projectId && !(yield* workspace.getProject(projectId)))
        return yield* fail("permission.read", new Error("Project was not found"));
      return projectNativePermissionMode(
        projectId
          ? yield* workspace.readProjectPermissionMode(projectId)
          : yield* workspace.readProjectlessPermissionMode,
      );
    },
  );
  const setNativePermissionMode = Effect.fn("AgentBackendApplication.setNativePermissionMode")(
    function* (projectId: string | null, mode: NativePermissionMode) {
      if (mode !== "auto" && mode !== "guardian-approvals" && mode !== "full-access")
        return yield* fail(
          "permission.mode",
          new Error("This native permission mode is unavailable"),
        );
      if (projectId) {
        const project = yield* workspace.getProject(projectId);
        if (!project || project.lifecycle !== "active")
          return yield* fail("permission.write", new Error("An active Project is required"));
      }
      return projectNativePermissionMode(
        projectId
          ? yield* workspace.setProjectPermissionMode(projectId, mode)
          : yield* workspace.setProjectlessPermissionMode(mode),
      );
    },
  );

  const resolveThreadAuthority = Effect.fn("AgentBackendApplication.resolveThreadAuthority")(
    function* (threadId: string) {
      const thread = yield* workspace.getThread(threadId);
      if (!thread)
        return yield* fail("thread.read", new Error("Agent Thread was not found"), { threadId });
      if (thread.backendBinding.kind === "codex") {
        return yield* fail(
          "thread.backend",
          new Error("Thread is owned by the native Codex backend"),
          {
            threadId,
          },
        );
      }
      const resolution = yield* backends.resolve(thread.backendBinding);
      if (resolution.kind === "codex") {
        return yield* fail("thread.backend", new Error("Agent binding resolved to Codex"), {
          threadId,
        });
      }
      const project = thread.projectId ? yield* workspace.getProject(thread.projectId) : null;
      if (
        (thread.projectId !== null && (!project || project.lifecycle !== "active")) ||
        (thread.projectId === null && resolution.kind !== "claude") ||
        thread.archived ||
        (thread.executionHostId && thread.executionHostId !== "local")
      ) {
        return yield* fail(
          "thread.workspace",
          new Error("Agent execution requires an active local workspace and task"),
          { threadId },
        );
      }
      const workspaceRoot = thread.cwd?.trim() || project?.primaryWorkspaceRoot?.trim();
      if (!workspaceRoot) {
        return yield* fail(
          "thread.workspace",
          new Error("Agent Threads require a local Project workspace"),
          { threadId },
        );
      }
      const mode = thread.projectId
        ? yield* workspace.readProjectPermissionMode(thread.projectId)
        : yield* workspace.readProjectlessPermissionMode;
      return {
        thread,
        binding: resolution.binding,
        workspaceRoot,
        permissionMode: mode,
        permissionPolicy: resolveAgentPermissionPolicy(resolution.binding, mode),
      };
    },
  );

  const nativeExecutionLocation = (
    thread: Pick<
      ProjectSessionThreadLink,
      "managedWorktreePath" | "projectlessOutputDirectory" | "projectlessWorkspaceBrowserRoot"
    >,
    workspaceRoot: string,
    context: DesktopProjectWorkspaceExecutionContext,
  ): NativeSessionWorkspaceLocation => ({
    cwd: workspaceRoot,
    workspaceRoots: context.workspaceState?.applied?.runtimeWorkspaceRoots ?? context.writableRoots,
    managedWorktreePath: thread.managedWorktreePath ?? null,
    projectlessOutputDirectory: thread.projectlessOutputDirectory ?? null,
    projectlessWorkspaceBrowserRoot: thread.projectlessWorkspaceBrowserRoot ?? null,
  });

  const worktreeEnvironment = Effect.fn("AgentBackendApplication.worktreeEnvironment")(function* (
    cwd: string,
    managedWorktreePath: string | null | undefined,
  ) {
    if (!managedWorktreePath) return null;
    if (!git)
      return yield* fail(
        "session.environment",
        new Error("The worktree environment runtime is unavailable"),
      );
    const gitPath = yield* git
      .readPath(cwd, ["rev-parse", "--git-path", "codex-shell-environment.json"])
      .pipe(Effect.mapError((cause) => fail("session.environment", cause)));
    if (!gitPath)
      return yield* fail(
        "session.environment",
        new Error("The worktree environment location is unavailable"),
      );
    return yield* Effect.tryPromise({
      try: () => loadCodexWorktreeShellEnvironmentAtGitPath({ cwd, gitPath }),
      catch: (cause) => fail("session.environment", cause),
    });
  });

  // A trusted reset/rollback commits Core before the manager publishes its new identity.
  // Controls wait for that handoff; unrelated Core rebinding closes the stale native owner.
  const assertNativeSessionIdentity = Effect.fn(
    "AgentBackendApplication.assertNativeSessionIdentity",
  )(function* (handle: AgentSessionHandle, allowRecovery = true) {
    const durable = yield* workspace.readThreadBackendSession(handle.threadId);
    if (
      durable?.backendBinding.kind === "claude" &&
      durable.nativeHome &&
      (yield* claudeSessions.nativeHome(durable.backendBinding.instanceConfigId)) !==
        durable.nativeHome
    ) {
      yield* sessions.close(handle.threadId);
      return yield* fail(
        "session.profile",
        new Error("The Claude profile changed. Restore this conversation's original profile."),
      );
    }
    const transition = nativeIdentityTransitions.get(handle);
    if (
      transition &&
      handle.sessionId === transition.previousSessionId &&
      (durable?.backendSessionId === transition.previousSessionId ||
        durable?.backendSessionId === transition.sessionId)
    )
      return yield* fail("session.identity", new Error("The native session identity is changing"), {
        threadId: handle.threadId,
      });
    if (!durable || durable.backendSessionId !== handle.sessionId) {
      yield* sessions.close(handle.threadId);
      return yield* fail(
        "session.identity",
        new Error("The native session was rebound. Reopen this task."),
        { threadId: handle.threadId },
      );
    }
    if (nativeExecutionTransitions.has(handle))
      return yield* fail(
        "session.workspace",
        new Error("The native execution context is changing"),
      );
    const launched = launchAuthorities.get(handle);
    if (launched?.nativeLocation) {
      const current = yield* resolveThreadAuthority(handle.threadId);
      const context = yield* workspace.readThreadExecutionContext(handle.threadId);
      const currentLocation = context
        ? nativeExecutionLocation(current.thread, current.workspaceRoot, context)
        : null;
      const recovering =
        allowRecovery &&
        nativeExecutionRecoveryRequired.has(handle.threadId) &&
        nativeExecutionRecoveryLocations
          .get(handle)
          ?.some((location) => isDeepStrictEqual(currentLocation, location));
      if (
        !context ||
        context.projectId !== current.thread.projectId ||
        current.thread.projectId !== launched.projectId ||
        !sameBinding(current.binding, launched.binding) ||
        (!isDeepStrictEqual(currentLocation, launched.nativeLocation) && !recovering)
      ) {
        if (!nativeExecutionRecoveryRequired.has(handle.threadId))
          yield* sessions.close(handle.threadId);
        return yield* fail("session.workspace", new Error("The native execution context changed"));
      }
    }
    nativeIdentityTransitions.delete(handle);
    return durable;
  });

  const prepareAgentSession: (
    input: AgentBackendSessionOpenInput,
  ) => Effect.Effect<AgentBackendSessionPresentation, SessionOpenError> = Effect.fn(
    "AgentBackendApplication.prepareAgentSession",
  )(function* (input: AgentBackendSessionOpenInput) {
    const cached = yield* sessions.get(input.threadId);
    if (cached) return yield* presentation(yield* requireOpenedHandle(input.threadId));
    if (
      nativeExecutionRecoveryRequired.has(input.threadId) &&
      !nativeExecutionHandoffs.has(input.threadId)
    )
      return yield* fail(
        "session.execution",
        new Error("Recover this task's execution location before reopening"),
        { threadId: input.threadId },
      );
    const authority = yield* resolveThreadAuthority(input.threadId);
    const durable = yield* workspace.readThreadBackendSession(input.threadId);
    const nativeHome =
      authority.binding.kind === "claude"
        ? yield* claudeSessions.nativeHome(authority.binding.instanceConfigId)
        : null;
    if (durable?.nativeHome && durable.nativeHome !== nativeHome)
      return yield* fail(
        "session.profile",
        new Error("The Claude profile changed. Restore this conversation's original profile."),
      );
    if (durable && !sameBinding(durable.backendBinding, authority.binding)) {
      return yield* fail(
        "session.binding",
        new Error("Durable Agent session belongs to a stale backend binding"),
        { threadId: input.threadId },
      );
    }
    const selection = nativeSelectionFromState(durable?.nativeState ?? null);
    const initialContext =
      authority.binding.kind === "claude"
        ? yield* workspace.readThreadExecutionContext(input.threadId)
        : null;
    if (
      authority.binding.kind === "claude" &&
      (!initialContext || initialContext.projectId !== authority.thread.projectId)
    )
      return yield* fail(
        "session.workspace",
        new Error("The native execution context is unavailable"),
      );
    let nativeLocation = initialContext
      ? nativeExecutionLocation(authority.thread, authority.workspaceRoot, initialContext)
      : undefined;
    const workspaceEnvironment =
      authority.binding.kind === "claude"
        ? yield* worktreeEnvironment(authority.workspaceRoot, authority.thread.managedWorktreePath)
        : null;
    let lease: NativeAppToolSessionLease | null = null;
    let leaseGeneration = 0;
    let nativeHandle: AgentSessionHandle | null = null;
    const runtimeHook = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          agentRuntimeError({
            operation: "Claude durable lifecycle",
            reason: "authorization",
            retryable: false,
            cause,
          }),
        ),
      );
    const readPermissionPolicy = runtimeHook(
      resolveThreadAuthority(input.threadId).pipe(
        Effect.map((current) => current.permissionPolicy),
      ),
    );
    const acquireLaunchContext = (workspaceRoot: string) =>
      Effect.gen(function* () {
        const transition = nativeHandle ? nativeExecutionTransitions.get(nativeHandle) : undefined;
        const provisional = transition
          ? workspaceRoot === transition.destination.cwd
            ? transition.destination
            : workspaceRoot === transition.source.cwd
              ? transition.source
              : undefined
          : undefined;
        if (transition && !provisional)
          return yield* agentRuntimeError({
            operation: "Claude execution location",
            reason: "authorization",
            retryable: false,
            cause: new Error("The native Query requested an unrelated working directory"),
          });
        if (provisional) nativeLocation = provisional;
        const browser = platform?.runtime.browserRuntime;
        if (!nativeTools || !nativeAuthority || !config) return {};
        const context = yield* runtimeHook(workspace.readThreadExecutionContext(input.threadId));
        const additionalDirectories =
          provisional?.workspaceRoots ??
          context?.workspaceState?.applied?.runtimeWorkspaceRoots ??
          context?.writableRoots ??
          [];
        if (browser?.status !== "available")
          return yield* agentRuntimeError({
            operation: "Claude app tools",
            reason: "capability",
            retryable: false,
            cause: new Error("The bundled Nodex tool runtime is unavailable"),
          });
        lease = yield* runtimeHook(
          nativeTools.acquire({
            threadId: input.threadId,
            hostId: "local",
            generation: ++leaseGeneration,
            isCurrent: Effect.gen(function* () {
              if (!nativeHandle || (yield* claudeSessions.get(input.threadId)) !== nativeHandle)
                return false;
              const current = yield* resolveThreadAuthority(input.threadId);
              const currentSession = yield* workspace.readThreadBackendSession(input.threadId);
              const executionContext = yield* workspace.readThreadExecutionContext(input.threadId);
              const pending = nativeExecutionTransitions.get(nativeHandle);
              const currentLocation = executionContext
                ? nativeExecutionLocation(current.thread, current.workspaceRoot, executionContext)
                : null;
              return Boolean(
                currentSession &&
                executionContext &&
                currentSession.backendSessionId === nativeHandle.sessionId &&
                sameBinding(currentSession.backendBinding, authority.binding) &&
                sameBinding(current.binding, authority.binding) &&
                current.thread.projectId === authority.thread.projectId &&
                executionContext.projectId === current.thread.projectId &&
                nativeLocation &&
                (pending
                  ? isDeepStrictEqual(currentLocation, pending.source) ||
                    isDeepStrictEqual(currentLocation, pending.destination)
                  : isDeepStrictEqual(currentLocation, nativeLocation)),
              );
            }).pipe(Effect.catch(() => Effect.succeed(false))),
            runtime: { runtime: browser.bundle, entrypoint: appToolsEntrypoint(config) },
          }),
        );
        return { ...lease.launchContext, additionalDirectories };
      });
    const nativeHooks = {
      acquireLaunchContext,
      readPermissionPolicy,
      onBackgroundTasksChanged: (liveTaskIds: readonly string[]) =>
        Effect.sync(() => lease?.setBackgroundTasks(liveTaskIds)),
      isUnattended: Effect.gen(function* () {
        const handle = yield* claudeSessions.get(input.threadId);
        const snapshot = handle ? yield* SubscriptionRef.get(handle.snapshot) : null;
        const turnId = snapshot?.turns.findLast((turn) => !turn.stopReason)?.clientUserMessageId;
        return Boolean(turnId && unattendedTurns.has(turnId));
      }),
      onTurnAdmitted: (admitted: { sequence: number; clientUserMessageId: string; text: string }) =>
        runtimeHook(
          Effect.gen(function* () {
            const current = yield* resolveThreadAuthority(input.threadId);
            const handle = yield* claudeSessions.get(input.threadId);
            if (!handle || handle !== nativeHandle)
              return yield* fail("turn.identity", new Error("The native session owner changed"));
            yield* assertNativeSessionIdentity(handle);
            const snapshot = yield* SubscriptionRef.get(handle.snapshot);
            if (nativeAuthority && lease) {
              const frozen = yield* nativeAuthority.freeze({
                threadId: input.threadId,
                turnId: admitted.clientUserMessageId,
                projectId: current.thread.projectId,
                readOnly: snapshot?.metadata?.requestedMode === "plan",
              });
              yield* assertNativeSessionIdentity(handle);
              if (frozen && !(yield* lease.beginTurn(frozen)))
                return yield* fail(
                  "turn.authority",
                  new Error("Native turn authority was rejected"),
                  { threadId: input.threadId },
                );
            }
            yield* setThreadStatus(input.threadId, "active");
            const receipt = yield* ensureReceipt(input.threadId, admitted.clientUserMessageId);
            yield* Deferred.succeed(receipt.admitted, undefined);
          }).pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Effect.sync(() => lease?.endTurn(admitted.clientUserMessageId))
                : Effect.void,
            ),
          ),
        ),
      onTurnSettled: (settled: {
        sequence: number;
        clientUserMessageIds: readonly string[];
        stopReason: string;
        status: "completed" | "cancelled" | "failed";
        error?: string;
        nativeSessionId: string;
        everSaved: boolean;
      }) =>
        runtimeHook(
          Effect.gen(function* () {
            for (const id of settled.clientUserMessageIds) lease?.endTurn(id);
            const currentHandle = yield* claudeSessions.get(input.threadId);
            if (!nativeHandle || (currentHandle && currentHandle !== nativeHandle))
              return yield* fail("turn.identity", new Error("The native session owner changed"));
            const handle = nativeHandle;
            yield* assertNativeSessionIdentity(handle);
            yield* persistClaudeIntelligence(handle, settled.everSaved);
            yield* setThreadStatus(
              input.threadId,
              settled.status === "failed" ? "systemError" : "idle",
            );
            const snapshot = handle ? yield* SubscriptionRef.get(handle.snapshot) : null;
            const assistantText =
              snapshot?.turns
                .find((turn) => turn.sequence === settled.sequence)
                ?.updates.filter(
                  (update) =>
                    update.kind === "message" && update.role === "agent" && !update.actor?.taskId,
                )
                .map((update) => (update.kind === "message" ? update.text : ""))
                .join("\n") ?? "";
            for (const id of settled.clientUserMessageIds) {
              const receipt = yield* ensureReceipt(input.threadId, id);
              receipt.settled = true;
              const outcome: NativeTurnOutcome = {
                turnId: id,
                outcome: settled.status === "cancelled" ? "interrupted" : settled.status,
                assistantText,
              };
              yield* Deferred.succeed(receipt.outcome, outcome);
            }
          }),
        ),
      onSessionIdentityChanged: (changed: {
        previousSessionId: string;
        sessionId: string;
        reason: "reset" | "rollback";
        everSaved?: boolean;
        messageIdMap?: Readonly<Record<string, string>>;
      }) =>
        runtimeHook(
          Effect.gen(function* () {
            const handle = yield* claudeSessions.get(input.threadId);
            if (
              !handle ||
              handle !== nativeHandle ||
              handle.sessionId !== changed.previousSessionId
            )
              return yield* fail(
                "session.identity",
                new Error("The native identity callback is stale"),
              );
            yield* assertNativeSessionIdentity(handle);
            const current = yield* workspace.readThreadBackendSession(input.threadId);
            nativeIdentityTransitions.set(handle, {
              previousSessionId: changed.previousSessionId,
              sessionId: changed.sessionId,
            });
            yield* workspace
              .bindThreadBackendSession({
                threadId: input.threadId,
                backendBinding: authority.binding,
                backendSessionId: changed.sessionId,
                expectedBackendSessionId: changed.previousSessionId,
                ...(current?.nativeState
                  ? {
                      nativeState: {
                        ...remapNativeState(current.nativeState, changed.messageIdMap ?? {}),
                        ever_saved: changed.everSaved ?? changed.reason === "rollback",
                      },
                    }
                  : {}),
              })
              .pipe(
                Effect.tapError(() => Effect.sync(() => nativeIdentityTransitions.delete(handle))),
              );
          }),
        ),
    };
    const handle = yield* (
      authority.binding.kind === "claude"
        ? claudeSessions.open({
            threadId: input.threadId,
            instanceConfigId: authority.binding.instanceConfigId,
            ...(nativeHome ? { expectedHome: nativeHome } : {}),
            workspaceRoot: authority.workspaceRoot,
            workspaceEnvironment,
            permissionPolicy: authority.permissionPolicy,
            ...selection,
            interactionMode: durable?.nativeState?.preferences.interaction_mode ?? "default",
            everSaved: durable?.nativeState?.ever_saved ?? Boolean(durable),
            executionRecoveryRequired: nativeExecutionRecoveryRequired.has(input.threadId),
            historyFacts: nativeHistoryFacts(durable?.nativeState ?? null),
            ...nativeHooks,
            ...(durable ? { sessionId: durable.backendSessionId } : {}),
          })
        : acpSessions
            .open({
              threadId: input.threadId,
              agentDefinitionId: authority.binding.agentDefinitionId,
              instanceConfigId: authority.binding.instanceConfigId!,
              workspaceRoot: authority.workspaceRoot,
              permissionPolicy: resolveAcpPermissionPolicy(authority.permissionMode),
              open: durable
                ? { kind: "load", sessionId: durable.backendSessionId }
                : { kind: "new" },
            })
            .pipe(Effect.map(sessions.adaptAcp))
    ).pipe(
      Effect.catch(
        (cause): Effect.Effect<never, AgentRuntimeError | AgentBackendApplicationError> => {
          if (!durable || requestErrorCode(cause) !== -32002) return Effect.fail(cause);
          return ownFailure(
            "session.restore.clear",
            workspace.clearThreadBackendSession({
              threadId: input.threadId,
              backendBinding: authority.binding,
            }),
            { threadId: input.threadId },
          ).pipe(
            Effect.andThen(
              Effect.fail(
                fail(
                  "session.restore",
                  new Error(
                    "The ACP Agent no longer has the durable session. Start a new task instead of replaying the previous prompt.",
                    { cause },
                  ),
                  { threadId: input.threadId },
                ),
              ),
            ),
          );
        },
      ),
    );
    if (authority.binding.kind === "claude") nativeHandle = handle;
    if (authority.binding.kind === "claude") {
      const current = yield* resolveThreadAuthority(input.threadId);
      const currentDurable = yield* workspace.readThreadBackendSession(input.threadId);
      const currentContext = yield* workspace.readThreadExecutionContext(input.threadId);
      if (
        !sameBinding(current.binding, authority.binding) ||
        current.thread.projectId !== authority.thread.projectId ||
        current.workspaceRoot !== authority.workspaceRoot ||
        (currentDurable?.backendSessionId ?? null) !== (durable?.backendSessionId ?? null) ||
        !currentContext ||
        currentContext.projectId !== authority.thread.projectId ||
        !isDeepStrictEqual(
          nativeExecutionLocation(current.thread, current.workspaceRoot, currentContext),
          nativeLocation,
        )
      ) {
        yield* sessions.close(input.threadId);
        return yield* fail(
          "session.open",
          new Error("The native session or execution context changed while opening"),
        );
      }
    }
    launchAuthorities.set(handle, {
      binding: authority.binding,
      workspaceRoot: authority.workspaceRoot,
      projectId: authority.thread.projectId,
      ...(nativeLocation ? { nativeLocation } : {}),
    });
    const openedSessionId = handle.sessionId;
    if (durable && openedSessionId !== null && durable.backendSessionId !== openedSessionId) {
      yield* sessions.close(input.threadId);
      return yield* fail(
        "session.identity",
        new Error("Live Agent session does not match the durable protocol identity"),
        { threadId: input.threadId },
      );
    }
    if (
      (!durable || (authority.binding.kind === "claude" && !durable.nativeHome)) &&
      openedSessionId !== null
    ) {
      yield* workspace.bindThreadBackendSession({
        threadId: input.threadId,
        backendBinding: authority.binding,
        backendSessionId: openedSessionId,
        ...(durable ? { expectedBackendSessionId: durable.backendSessionId } : {}),
        ...(nativeHome ? { nativeHome } : {}),
        ...(authority.binding.kind === "claude"
          ? {
              nativeState: nativeStateFromSnapshot(
                yield* SubscriptionRef.get(handle.snapshot),
                durable?.nativeState ?? null,
                durable?.nativeState?.ever_saved ?? Boolean(durable),
              ),
            }
          : {}),
      });
    }
    if (
      authority.binding.kind === "claude" &&
      authority.thread.statusType === "active" &&
      (yield* SubscriptionRef.get(handle.snapshot)).status !== "running"
    )
      yield* setThreadStatus(input.threadId, "idle");
    return yield* presentation(handle);
  });

  const requireOpenedHandle = Effect.fn("AgentBackendApplication.requireOpenedHandle")(function* (
    threadId: string,
  ) {
    const existing = yield* sessions.get(threadId);
    if (existing) {
      const authority = yield* resolveThreadAuthority(threadId);
      const launched = launchAuthorities.get(existing);
      const snapshot = yield* SubscriptionRef.get(existing.snapshot);
      const durable =
        snapshot.backend === "claude"
          ? yield* assertNativeSessionIdentity(existing)
          : yield* workspace.readThreadBackendSession(threadId);
      if (
        snapshot.backend !== authority.binding.kind ||
        (durable && !sameBinding(durable.backendBinding, authority.binding)) ||
        (launched &&
          (launched.projectId !== authority.thread.projectId ||
            !sameBinding(launched.binding, authority.binding) ||
            (launched.workspaceRoot !== authority.workspaceRoot &&
              !nativeExecutionRecoveryRequired.has(threadId))))
      ) {
        yield* sessions.close(threadId);
        return yield* fail(
          "session.binding",
          new Error("The Agent profile or workspace changed. Reopen this task."),
          { threadId },
        );
      }
      if (existing.setPermissionPolicy && !nativeExecutionRecoveryRequired.has(threadId))
        yield* existing.setPermissionPolicy(authority.permissionPolicy);
      return existing;
    }
    return yield* fail("session.open", new Error("Agent session did not become available"), {
      threadId,
    });
  });

  // A manager can expose its handle before Core commits the initial identity. Keep
  // every Application caller behind that publication, without weakening identity checks.
  const openAgentSession = Effect.fn("AgentBackendApplication.openAgentSession")(
    (input: AgentBackendSessionOpenInput) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const pending = pendingSessionOpens.get(input.threadId);
          if (pending) return yield* restore(Deferred.await(pending));
          const completion = yield* Deferred.make<
            AgentBackendSessionPresentation,
            SessionOpenError
          >();
          pendingSessionOpens.set(input.threadId, completion);
          let existing: AgentSessionHandle | null = null;
          return yield* restore(
            Effect.gen(function* () {
              existing = yield* sessions.get(input.threadId);
              return yield* prepareAgentSession(input);
            }),
          ).pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (Exit.isFailure(exit) && !existing) yield* sessions.close(input.threadId);
              }).pipe(
                Effect.ensuring(
                  Effect.gen(function* () {
                    yield* Deferred.done(completion, exit);
                    pendingSessionOpens.delete(input.threadId);
                  }),
                ),
              ),
            ),
          );
        }),
      ),
  );

  const requireHandle = Effect.fn("AgentBackendApplication.requireHandle")(function* (
    threadId: string,
  ) {
    const pending = pendingSessionOpens.get(threadId);
    if (pending) yield* Deferred.await(pending);
    const existing = yield* sessions.get(threadId);
    if (
      !existing &&
      nativeExecutionRecoveryRequired.has(threadId) &&
      !nativeExecutionHandoffs.has(threadId)
    )
      return yield* fail(
        "session.execution",
        new Error("Recover this task's execution location before reopening"),
        { threadId },
      );
    if (!existing) yield* openAgentSession({ threadId });
    return yield* requireOpenedHandle(threadId);
  });

  const persistClaudeIntelligence = Effect.fn("AgentBackendApplication.persistClaudeIntelligence")(
    function* (handle: AgentSessionHandle, everSaved?: boolean) {
      const snapshot = yield* SubscriptionRef.get(handle.snapshot);
      if (snapshot.backend !== "claude" || !handle.sessionId) return;
      const authority = yield* resolveThreadAuthority(handle.threadId);
      const durable = yield* assertNativeSessionIdentity(handle);
      const launched = launchAuthorities.get(handle);
      if (
        authority.binding.kind !== "claude" ||
        (durable && !sameBinding(durable.backendBinding, authority.binding)) ||
        (launched &&
          (launched.projectId !== authority.thread.projectId ||
            !sameBinding(launched.binding, authority.binding) ||
            launched.workspaceRoot !== authority.workspaceRoot))
      ) {
        yield* sessions.close(handle.threadId);
        return yield* fail("session.binding", new Error("The Agent profile or workspace changed"), {
          threadId: handle.threadId,
        });
      }
      yield* workspace
        .bindThreadBackendSession({
          threadId: handle.threadId,
          backendBinding: authority.binding,
          backendSessionId: handle.sessionId,
          expectedBackendSessionId: handle.sessionId,
          nativeState: nativeStateFromSnapshot(snapshot, durable?.nativeState ?? null, everSaved),
        })
        .pipe(Effect.tapError(() => sessions.close(handle.threadId)));
    },
  );

  const setThreadStatus = (threadId: string, statusType: "active" | "idle" | "systemError") =>
    workspace
      .updateThread(threadId, {
        status: { statusType, activeFlags: [] },
        updatedAt: Date.now(),
        recencyAt: Date.now(),
      })
      .pipe(Effect.asVoid);

  const promptAgentSession = Effect.fn("AgentBackendApplication.promptAgentSession")(function* (
    input: AgentBackendPromptInput & { readonly preparedImages?: readonly AgentPromptImage[] },
  ) {
    const text = input.prompt.trim();
    if (!text && !input.images?.length && !input.preparedImages?.length)
      return yield* fail("prompt.validate", new Error("Prompt is required"), {
        threadId: input.threadId,
      });
    yield* requireExecutionAdmission(input.threadId);
    const handle = yield* requireHandle(input.threadId);
    if ((yield* SubscriptionRef.get(handle.snapshot)).backend === "claude") {
      const images =
        input.preparedImages ??
        (input.images?.length && nativeImages ? yield* nativeImages.prepare(input.images) : []);
      if (input.images?.length && !nativeImages)
        return yield* fail("prompt.images", new Error("Image preparation is unavailable"));
      const response = yield* handle.prompt(text, {
        clientUserMessageId: input.clientUserMessageId ?? createUuidV7(),
        images,
      });
      return {
        stopReason: response.stopReason,
        snapshot: yield* SubscriptionRef.get(handle.snapshot),
      };
    }
    if ((yield* SubscriptionRef.get(handle.snapshot)).status === "running")
      return yield* fail("prompt.admit", new Error("A turn is already running"), {
        threadId: input.threadId,
      });
    const response = yield* Effect.uninterruptibleMask((restore) =>
      setThreadStatus(input.threadId, "active").pipe(
        Effect.andThen(
          restore(
            handle.prompt(
              text,
              input.clientUserMessageId
                ? { clientUserMessageId: input.clientUserMessageId }
                : undefined,
            ),
          ),
        ),
        Effect.onExit((exit) =>
          Effect.uninterruptible(
            setThreadStatus(
              input.threadId,
              Exit.isSuccess(exit) ||
                isInterruptedOnly(exit.cause) ||
                isRecoverablePromptFailure(Cause.squash(exit.cause))
                ? "idle"
                : "systemError",
            ),
          ),
        ),
      ),
    );
    const snapshot = yield* SubscriptionRef.get(handle.snapshot);
    return { stopReason: response.stopReason, snapshot };
  });

  const launchInitialPrompt = (
    threadId: string,
    prompt: string,
    clientUserMessageId: string,
    images?: readonly AgentPromptImage[],
  ) =>
    Effect.yieldNow.pipe(
      Effect.andThen(
        promptAgentSession({ threadId, prompt, clientUserMessageId, preparedImages: images }),
      ),
      Effect.catchCause((cause) =>
        isInterruptedOnly(cause)
          ? Effect.void
          : Effect.logError("Agent initial prompt failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause), threadId }),
            ),
      ),
      Effect.forkIn(ownerScope, { startImmediately: true }),
      Effect.asVoid,
    );

  const admitNativeThread = Effect.fn("AgentBackendApplication.admitNativeThread")(
    (input: ProjectSessionThreadLinkInput, lease: NativeSessionWorkspaceLease) =>
      workspace.upsertProjectSessionThreadLink(input).pipe(
        Effect.flatMap((linked) =>
          linked.threadId === input.threadId &&
          linked.cwd === lease.location.cwd &&
          (linked.managedWorktreePath ?? null) === lease.location.managedWorktreePath
            ? Effect.succeed(linked)
            : fail(
                "thread.start.admit",
                new Error("The Thread execution location changed during admission"),
              ),
        ),
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isSuccess(exit)) {
              yield* lease.attach(input.threadId);
              return;
            }
            const failure = Cause.squash(exit.cause);
            if (
              failure instanceof ProjectWorkspaceError &&
              failure.threadAdmissionOutcome === "rejected"
            )
              return;
            // A lost response or failed readback never proves the Core mutation was rejected.
            yield* lease.retain;
            const linked = yield* workspace.getProjectSession(input.sessionId).pipe(
              Effect.timeout("5 seconds"),
              Effect.catchCause(() => Effect.succeed(null)),
            );
            if (
              linked?.thread?.threadId === input.threadId &&
              linked.thread.cwd === lease.location.cwd &&
              (linked.thread.managedWorktreePath ?? null) === lease.location.managedWorktreePath
            ) {
              yield* lease.attach(input.threadId);
              return;
            }
            yield* Effect.logWarning(
              "Native workspace retained after uncertain Thread admission",
            ).pipe(Effect.annotateLogs({ sessionId: input.sessionId, threadId: input.threadId }));
          }),
        ),
      ),
  );

  const startAgentThread = Effect.fn("AgentBackendApplication.startAgentThread")(function* (
    input: AgentBackendThreadStartInput,
  ) {
    if (
      input.runInTarget !== undefined &&
      input.runInTarget !== "localProject" &&
      input.runInTarget !== "newWorktree"
    )
      return yield* fail("thread.start.workspace", new Error("Choose a local execution location"));
    if (input.backendKind === "acp" && input.runInEnvironmentPath)
      return yield* fail(
        "thread.start.environment",
        new Error("This Agent does not support worktree Environment configurations"),
      );
    if (!nativeSessionWorkspace)
      return yield* fail(
        "thread.start.workspace",
        new Error("The native workspace runtime is unavailable"),
      );
    if (!input.prompt.trim() && !input.images?.length)
      return yield* fail("thread.start.validate", new Error("Attach an image or enter a message"));
    if (input.images?.length && (input.backendKind !== "claude" || !nativeImages))
      return yield* fail("thread.images", new Error("This Agent cannot accept image input"));
    const images =
      input.images?.length && nativeImages ? yield* nativeImages.prepare(input.images) : undefined;
    const session = yield* workspace.getProjectSession(input.sessionId);
    if (!session || session.thread) {
      return yield* fail(
        "thread.start.admit",
        new Error("Project Session is missing or already owns a Thread"),
        { sessionId: input.sessionId },
      );
    }
    if (!session.projectId) {
      return yield* fail(
        "thread.start.workspace",
        new Error("Agent Threads currently require a local Project"),
        { sessionId: input.sessionId },
      );
    }
    const project = yield* workspace.getProject(session.projectId);
    const workspaceRoot = project?.primaryWorkspaceRoot?.trim();
    if (!project || project.lifecycle !== "active" || !workspaceRoot) {
      return yield* fail(
        "thread.start.workspace",
        new Error("Agent Threads require an active Project with a primary workspace"),
        { sessionId: input.sessionId },
      );
    }
    const resolution = yield* input.backendKind === "claude"
      ? backends.resolve({ kind: "claude", instanceConfigId: input.instanceConfigId })
      : backends.resolveAcpInstance(input.instanceConfigId);
    const threadId = createUuidV7();
    const now = Date.now();
    const linked = yield* Effect.scoped(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const lease = yield* restore(
            nativeSessionWorkspace.prepare({
              projectId: project.id,
              targetId: threadId,
              title: titleFromPrompt(input.prompt),
              prompt: input.prompt,
              sourceCwd: workspaceRoot,
              sourceRoots: project.sources.map(({ root }) => root),
              runInTarget: input.runInTarget ?? "localProject",
              worktreeStartingState: input.worktreeStartingState,
              localEnvironmentConfigPath: input.runInEnvironmentPath,
              operationId: `native-thread:${input.firstSubmission.launchId}`,
            }),
          );
          const admit = Effect.gen(function* () {
            const currentSession = yield* workspace.getProjectSession(session.id);
            const currentProject = yield* workspace.getProject(project.id);
            if (
              !currentSession ||
              currentSession.projectId !== project.id ||
              currentSession.thread ||
              !currentProject ||
              currentProject.lifecycle !== "active" ||
              currentProject.primaryWorkspaceRoot?.trim() !== workspaceRoot ||
              !isDeepStrictEqual(currentProject.sources, project.sources)
            )
              return yield* fail(
                "thread.start.admit",
                new Error("The Project or Session changed while preparing its workspace"),
              );
            return yield* admitNativeThread(
              {
                sessionId: session.id,
                projectId: project.id,
                threadId,
                threadName: titleFromPrompt(input.prompt),
                threadPreview: input.prompt.trim().slice(0, 512),
                backendBinding: resolution.binding,
                executionHostId: "local",
                runtimeWorkspaceRoots: [...lease.location.workspaceRoots],
                cwd: lease.location.cwd,
                managedWorktreePath: lease.location.managedWorktreePath,
                projectlessOutputDirectory: lease.location.projectlessOutputDirectory,
                projectlessWorkspaceBrowserRoot: lease.location.projectlessWorkspaceBrowserRoot,
                statusType: "idle",
                statusActiveFlags: [],
                archived: false,
                createdAt: now,
                updatedAt: now,
                recencyAt: now,
              },
              lease,
            );
          });
          return yield* projectLifecycle
            ? projectLifecycle.runExclusive(project.id, Effect.uninterruptible(admit))
            : admit;
        }),
      ),
    );
    const opened = yield* openAgentSession({ threadId });
    const currentSession = yield* workspace.getProjectSession(input.sessionId);
    const thread: ProjectSessionThreadLink = currentSession?.thread ?? linked;
    const handle = yield* requireHandle(threadId);
    const modelConfig = handle.configOptions.find((option) => option.category === "model");
    if (input.backendKind === "claude" && handle.setIntelligence) {
      yield* handle.setIntelligence(
        input.selection ?? { model: input.model ?? "default", effort: input.effort ?? "default" },
      );
    }
    if (
      input.backendKind !== "claude" &&
      input.model &&
      modelConfig &&
      modelConfig.type === "select" &&
      modelConfig.currentValue !== input.model
    ) {
      yield* handle.setConfigOption(modelConfig.id, input.model);
    }
    const mode = handle.modes?.availableModes.find((candidate) =>
      input.mode === "plan"
        ? candidate.id === "plan"
        : candidate.id === "code" || candidate.id === "default",
    );
    if (input.mode && mode && handle.modes?.currentModeId !== mode.id)
      yield* handle.setMode(mode.id);
    yield* persistClaudeIntelligence(handle);
    const result = { thread, presentation: yield* presentation(handle) };
    // The first prompt remains process-owned and single-consume. Interactive authentication may
    // defer its first submission, but a Main restart never replays it and risks a duplicate.
    if (opened.snapshot.status === "authentication-required") {
      const defer = yield* requireControl(
        handle.deferInitialPrompt,
        "deferred authentication",
        threadId,
      );
      yield* defer({
        prompt: input.prompt,
        clientUserMessageId: input.firstSubmission.clientUserMessageId,
        ...(images ? { images } : {}),
      });
    } else {
      yield* launchInitialPrompt(
        threadId,
        input.prompt,
        input.firstSubmission.clientUserMessageId,
        images,
      );
    }
    return result;
  });

  const readAgentSession = (threadId: string) =>
    sessions
      .get(threadId)
      .pipe(
        Effect.flatMap((handle) =>
          handle
            ? requireHandle(threadId).pipe(Effect.flatMap(presentation))
            : Effect.succeed(null),
        ),
      );

  const requireControl = <A>(
    value: A | undefined,
    name: string,
    threadId: string,
  ): Effect.Effect<A, AgentBackendApplicationError> =>
    value
      ? Effect.succeed(value)
      : Effect.fail(
          fail("session.capability", new Error(`This Agent does not support ${name}`), {
            threadId,
          }),
        );
  const withAgentExecutionHandoff = <A, E, R>(
    threadId: string,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AgentBackendApplicationError, R> =>
    Effect.acquireUseRelease(
      Effect.suspend(() => {
        if (nativeExecutionHandoffs.has(threadId))
          return Effect.fail(
            fail("session.execution", new Error("A native execution handoff is already active"), {
              threadId,
            }),
          );
        nativeExecutionHandoffs.add(threadId);
        return Effect.void;
      }),
      () =>
        Effect.gen(function* () {
          const authority = yield* ownFailure(
            "session.execution",
            resolveThreadAuthority(threadId),
          );
          if (authority.binding.kind !== "claude")
            return yield* fail("session.execution", new Error("Native execution is unavailable"), {
              threadId,
            });
          const previous = yield* claudeSessions.get(threadId);
          if (previous && nativeExecutionRecoveryRequired.has(threadId)) {
            const state = yield* SubscriptionRef.get(previous.snapshot);
            if (state.status === "failed" || state.status === "closed")
              yield* sessions.close(threadId);
          }
          const handle = yield* ownFailure("session.execution", requireHandle(threadId));
          const handoff = yield* requireControl(
            handle.withExecutionHandoff,
            "execution handoff",
            threadId,
          );
          return yield* handoff(use).pipe(
            Effect.mapError((cause) =>
              Schema.is(AgentRuntimeError)(cause)
                ? fail("session.execution", cause, { threadId })
                : cause,
            ),
          );
        }),
      () =>
        Effect.gen(function* () {
          nativeExecutionHandoffs.delete(threadId);
          if (nativeExecutionRecoveryRequired.has(threadId)) return;
          const handle = yield* claudeSessions.get(threadId);
          if (handle) nativeExecutionRecoveryLocations.delete(handle);
        }),
    );
  const setExecutionRecoveryRequired = (threadId: string, required: boolean) =>
    ownFailure(
      "session.execution.recovery",
      Effect.gen(function* () {
        if (required) nativeExecutionRecoveryRequired.add(threadId);
        const handle = yield* claudeSessions.get(threadId);
        if (!handle) {
          if (!required) nativeExecutionRecoveryRequired.delete(threadId);
          return;
        }
        if (!required) yield* assertNativeSessionIdentity(handle, false);
        const setRequired = yield* requireControl(
          handle.setExecutionRecoveryRequired,
          "execution recovery",
          threadId,
        );
        yield* setRequired(required);
        if (required) return;
        nativeExecutionRecoveryRequired.delete(threadId);
        nativeExecutionRecoveryLocations.delete(handle);
      }),
      { threadId },
    );
  const withAgentExecutionLocation = <A, E, R>(
    threadId: string,
    location: CodexThreadExecutionLocation,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | AgentBackendApplicationError, R> =>
    serializeControl(
      threadId,
      Effect.gen(function* () {
        const authority = yield* ownFailure("session.execution", resolveThreadAuthority(threadId));
        if (
          authority.binding.kind !== "claude" ||
          location.hostId !== "local" ||
          location.projectId !== authority.thread.projectId ||
          !isAbsolute(location.cwd)
        )
          return yield* fail(
            "session.execution",
            new Error("Native execution relocation requires the same local Claude Project."),
            { threadId },
          );
        const handle = yield* ownFailure("session.execution", requireHandle(threadId));
        const move = yield* requireControl(
          handle.withExecutionLocation,
          "execution relocation",
          threadId,
        );
        const launched = launchAuthorities.get(handle);
        if (!launched?.nativeLocation)
          return yield* fail(
            "session.execution",
            new Error("The native execution authority is unavailable"),
            { threadId },
          );
        const destination: NativeSessionWorkspaceLocation = {
          cwd: location.cwd,
          workspaceRoots: location.workspaceRoots,
          managedWorktreePath: location.managedWorktreePath,
          projectlessOutputDirectory: location.projectlessOutputDirectory,
          projectlessWorkspaceBrowserRoot: location.projectlessWorkspaceBrowserRoot,
        };
        const recoveryLocations = nativeExecutionRecoveryLocations.get(handle);
        if (
          nativeExecutionRecoveryRequired.has(threadId) &&
          recoveryLocations &&
          !recoveryLocations.some((known) => isDeepStrictEqual(known, destination))
        )
          return yield* fail(
            "session.execution",
            new Error("Recover the recorded source or destination before moving elsewhere"),
            { threadId },
          );
        if (
          destination.cwd === launched.nativeLocation.cwd &&
          !isDeepStrictEqual(destination, launched.nativeLocation)
        )
          return yield* fail(
            "session.execution",
            new Error(
              "A native relocation must name a distinct working directory or retain its exact execution roots",
            ),
            { threadId },
          );
        const nativeSessionId = handle.sessionId;
        const workspaceEnvironment = yield* worktreeEnvironment(
          location.cwd,
          location.managedWorktreePath,
        );
        nativeExecutionTransitions.set(handle, { source: launched.nativeLocation, destination });
        nativeExecutionRecoveryLocations.set(
          handle,
          recoveryLocations ?? [launched.nativeLocation, destination],
        );
        return yield* move(
          { workspaceRoot: location.cwd, workspaceEnvironment },
          use.pipe(
            Effect.flatMap((value) =>
              Effect.gen(function* () {
                const current = yield* ownFailure(
                  "session.execution",
                  resolveThreadAuthority(threadId),
                );
                const durable = yield* ownFailure(
                  "session.execution",
                  workspace.readThreadBackendSession(threadId),
                );
                const context = yield* ownFailure(
                  "session.execution",
                  workspace.readThreadExecutionContext(threadId),
                );
                const nativeHome = yield* ownFailure(
                  "session.execution",
                  claudeSessions.nativeHome(authority.binding.instanceConfigId),
                );
                if (
                  (yield* claudeSessions.get(threadId)) !== handle ||
                  handle.sessionId !== nativeSessionId ||
                  durable?.backendSessionId !== nativeSessionId ||
                  durable.backendBinding.kind !== "claude" ||
                  !sameBinding(durable.backendBinding, authority.binding) ||
                  (durable.nativeHome && durable.nativeHome !== nativeHome) ||
                  !sameBinding(current.binding, authority.binding) ||
                  current.thread.projectId !== authority.thread.projectId ||
                  !context ||
                  context.projectId !== current.thread.projectId ||
                  !isDeepStrictEqual(
                    nativeExecutionLocation(current.thread, current.workspaceRoot, context),
                    destination,
                  )
                )
                  return yield* fail(
                    "session.execution",
                    new Error(
                      "The committed native execution location or identity did not match the prepared destination",
                    ),
                    { threadId },
                  );
                launchAuthorities.set(handle, {
                  ...launched,
                  workspaceRoot: location.cwd,
                  nativeLocation: destination,
                });
                return value;
              }),
            ),
          ),
        ).pipe(
          Effect.mapError((cause) =>
            Schema.is(AgentRuntimeError)(cause)
              ? fail("session.execution", cause, { threadId })
              : cause,
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (Exit.isFailure(exit)) launchAuthorities.set(handle, launched);
              nativeExecutionTransitions.delete(handle);
              if (
                !nativeExecutionHandoffs.has(threadId) &&
                !nativeExecutionRecoveryRequired.has(threadId)
              )
                nativeExecutionRecoveryLocations.delete(handle);
            }),
          ),
        );
      }),
    );
  const applyAgentIntelligence = (input: AgentBackendIntelligenceInput) =>
    Effect.gen(function* () {
      yield* requireExecutionAdmission(input.threadId);
      const handle = yield* requireHandle(input.threadId);
      const apply = yield* requireControl(
        handle.setIntelligence,
        "intelligence selection",
        input.threadId,
      );
      yield* apply(input.selection);
      yield* persistClaudeIntelligence(handle);
      return yield* presentation(handle);
    });
  const setAgentIntelligence = (input: AgentBackendIntelligenceInput) =>
    requireExecutionAdmission(input.threadId).pipe(
      Effect.andThen(serializeControl(input.threadId, applyAgentIntelligence(input))),
    );
  const controlAgentSession = (input: AgentBackendControlInput) =>
    (input.kind !== "stop-task" && input.kind !== "load-older"
      ? requireExecutionAdmission(input.threadId)
      : Effect.void
    ).pipe(
      Effect.andThen(
        serializeControl(
          input.threadId,
          Effect.gen(function* () {
            if (input.kind !== "stop-task" && input.kind !== "load-older")
              yield* requireExecutionAdmission(input.threadId);
            const handle = yield* requireHandle(input.threadId);
            switch (input.kind) {
              case "steer": {
                if (!input.prompt.trim() && !input.images?.length)
                  return yield* fail(
                    "steer.validate",
                    new Error("Attach an image or enter a message"),
                  );
                if (input.images?.length && !nativeImages)
                  return yield* fail("steer.images", new Error("Image preparation is unavailable"));
                const images =
                  input.images?.length && nativeImages
                    ? yield* nativeImages.prepare(input.images)
                    : undefined;
                yield* (yield* requireControl(handle.steer, "steering", input.threadId))(
                  input.prompt,
                  {
                    clientUserMessageId: input.clientUserMessageId,
                    images,
                  },
                );
                break;
              }
              case "stop-task":
                yield* (yield* requireControl(handle.stopTask, "stopping tasks", input.threadId))(
                  input.taskId,
                );
                break;
              case "rollback":
                yield* (yield* requireControl(handle.rollback, "rollback", input.threadId))(
                  input.numTurns,
                );
                yield* persistClaudeIntelligence(handle);
                break;
              case "compact":
                yield* yield* requireControl(handle.compact, "compaction", input.threadId);
                break;
              case "permission-mode": {
                const authority = yield* resolveThreadAuthority(input.threadId);
                const requestedMode = input.mode;
                if (authority.binding.kind !== "claude" || requestedMode === "custom")
                  return yield* fail(
                    "permission.mode",
                    new Error("This native permission mode is unavailable"),
                  );
                const setPolicy = yield* requireControl(
                  handle.setPermissionPolicy,
                  "permission selection",
                  input.threadId,
                );
                let persistenceStarted = false;
                let synchronized = false;
                yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    yield* restore(
                      setPolicy(resolveAgentPermissionPolicy(authority.binding, requestedMode)),
                    );
                    yield* restore(assertNativeSessionIdentity(handle));
                    persistenceStarted = true;
                    // A write may commit before its following read returns. Finish this handoff
                    // before honoring caller cancellation; uncertain commits close the owner.
                    yield* Effect.gen(function* () {
                      const selected = yield* setNativePermissionMode(
                        authority.thread.projectId,
                        requestedMode,
                      );
                      yield* assertNativeSessionIdentity(handle);
                      if (selected !== requestedMode)
                        yield* setPolicy(resolveAgentPermissionPolicy(authority.binding, selected));
                    }).pipe(
                      Effect.timeoutOrElse({
                        duration: "10 seconds",
                        orElse: () =>
                          fail(
                            "permission.commit",
                            new Error("Permission persistence did not finish"),
                          ),
                      }),
                    );
                    synchronized = true;
                  }),
                ).pipe(
                  Effect.onExit((exit) =>
                    Exit.isFailure(exit) && !synchronized
                      ? (persistenceStarted
                          ? Effect.gen(function* () {
                              if ((yield* sessions.get(input.threadId)) === handle)
                                yield* sessions.close(input.threadId);
                            })
                          : setPolicy(authority.permissionPolicy)
                        ).pipe(
                          Effect.catch(() =>
                            Effect.gen(function* () {
                              if ((yield* sessions.get(input.threadId)) === handle)
                                yield* sessions.close(input.threadId);
                            }),
                          ),
                        )
                      : Effect.void,
                  ),
                );
                break;
              }
              case "load-older":
                yield* (yield* requireControl(
                  handle.loadHistory,
                  "history pagination",
                  input.threadId,
                ))({ before: input.before, limit: input.limit });
                break;
            }
            return yield* presentation(handle);
          }),
        ),
      ),
    );
  const createNativeThread = Effect.fn("AgentBackendApplication.createNativeThread")(
    function* (input: {
      projectId: string | null;
      binding: ExternalBinding;
      title: string;
      cwd: string;
      parentThreadId?: string;
      location?: NativeSessionWorkspaceLocation;
      lease?: NativeSessionWorkspaceLease;
    }) {
      const sessionId = createUuidV7();
      yield* workspace.createProjectSession({
        operationId: `native-session:${sessionId}`,
        payload: {
          sessionId,
          input: {
            projectId: input.projectId,
            noThreadFallbackTitle: input.title,
            initialPageIds: [],
          },
        },
      });
      const threadId = createUuidV7();
      const now = Date.now();
      const threadInput: ProjectSessionThreadLinkInput = {
        sessionId,
        projectId: input.projectId,
        threadId,
        threadName: input.title,
        threadPreview: "",
        backendBinding: input.binding,
        executionHostId: "local",
        runtimeWorkspaceRoots: [...(input.location?.workspaceRoots ?? [input.cwd])],
        cwd: input.cwd,
        ...(input.location
          ? {
              managedWorktreePath: input.location.managedWorktreePath,
              projectlessOutputDirectory: input.location.projectlessOutputDirectory,
              projectlessWorkspaceBrowserRoot: input.location.projectlessWorkspaceBrowserRoot,
            }
          : {}),
        statusType: "idle",
        statusActiveFlags: [],
        archived: false,
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
      };
      const thread = yield* input.lease
        ? admitNativeThread(threadInput, input.lease)
        : workspace.upsertProjectSessionThreadLink(threadInput);
      if (input.parentThreadId)
        yield* workspace.updateThread(threadId, { forkedFromId: input.parentThreadId });
      return thread;
    },
  );
  const forkAgentSession = Effect.fn("AgentBackendApplication.forkAgentSession")(function* (
    input: AgentBackendForkInput,
  ) {
    yield* requireExecutionAdmission(input.threadId);
    const authority = yield* resolveThreadAuthority(input.threadId);
    const handle = yield* requireHandle(input.threadId);
    const sourceSessionId = handle.sessionId;
    const context = yield* workspace.readThreadExecutionContext(input.threadId);
    if (!context || context.projectId !== authority.thread.projectId)
      return yield* fail("session.fork", new Error("The source execution context is unavailable"));
    const location = nativeExecutionLocation(authority.thread, authority.workspaceRoot, context);
    const fork = yield* requireControl(handle.forkAt, "forking", input.threadId);
    const forked = yield* fork(input.nativeMessageId);
    const current = yield* resolveThreadAuthority(input.threadId);
    const currentContext = yield* workspace.readThreadExecutionContext(input.threadId);
    if (
      (yield* requireHandle(input.threadId)) !== handle ||
      handle.sessionId !== sourceSessionId ||
      !sameBinding(current.binding, authority.binding) ||
      current.thread.projectId !== authority.thread.projectId ||
      current.workspaceRoot !== authority.workspaceRoot ||
      !isDeepStrictEqual(currentContext, context) ||
      current.thread.managedWorktreePath !== authority.thread.managedWorktreePath ||
      current.thread.projectlessOutputDirectory !== authority.thread.projectlessOutputDirectory ||
      current.thread.projectlessWorkspaceBrowserRoot !==
        authority.thread.projectlessWorkspaceBrowserRoot
    )
      return yield* fail(
        "session.fork",
        new Error("The source session or execution context changed"),
      );
    const durable = yield* workspace.readThreadBackendSession(input.threadId);
    const thread = yield* createNativeThread({
      projectId: authority.thread.projectId,
      binding: authority.binding,
      title: authority.thread.threadName ?? "Forked task",
      cwd: authority.workspaceRoot,
      parentThreadId: input.threadId,
      location,
    });
    yield* workspace.bindThreadBackendSession({
      threadId: thread.threadId,
      backendBinding: authority.binding,
      backendSessionId: forked.sessionId,
      ...(durable?.nativeHome ? { nativeHome: durable.nativeHome } : {}),
      nativeState: remapNativeState(
        nativeStateFromSnapshot(
          yield* SubscriptionRef.get(handle.snapshot),
          durable?.nativeState ?? null,
          true,
        ),
        forked.messageIdMap ?? {},
      ),
    });
    return { thread, presentation: yield* openAgentSession({ threadId: thread.threadId }) };
  });
  const nativeConversations: NativeConversationExtension["Service"] = {
    withExecutionLocation: withAgentExecutionLocation,
    withExecutionHandoff: withAgentExecutionHandoff,
    setExecutionRecoveryRequired,
    stopExecution: (threadId) =>
      ownFailure(
        "native.execution.stop",
        Effect.gen(function* () {
          const handle = yield* requireHandle(threadId);
          yield* handle.cancel;
          if (!nativeExecutionHandoffs.has(threadId)) return;
          yield* yield* requireControl(handle.suspendExecution, "execution suspension", threadId);
        }),
      ),
    read: (threadId) =>
      Effect.gen(function* () {
        const thread = yield* workspace.getThread(threadId);
        if (!thread || thread.backendBinding.kind !== "claude") return null;
        const handle = yield* claudeSessions.get(threadId);
        if (handle) yield* assertNativeSessionIdentity(handle);
        const snapshot = handle ? yield* SubscriptionRef.get(handle.snapshot) : null;
        return {
          threadId,
          backendBinding: thread.backendBinding,
          busy: snapshot?.status === "running" || Boolean(snapshot?.requests?.length),
          archived: thread.archived,
          updatedAt: thread.updatedAt,
          title: thread.threadName ?? "",
        };
      }).pipe(Effect.mapError((cause) => fail("native.read", cause))),
    submit: (input) =>
      Effect.gen(function* () {
        yield* requireExecutionAdmission(input.threadId);
        const operationKey = receiptKey(input.threadId, input.operationId);
        const fingerprint = JSON.stringify([
          input.prompt,
          input.model,
          input.effort,
          input.unattended,
        ]);
        const existingOperation = nativeOperations.get(operationKey);
        if (existingOperation) {
          if (existingOperation.fingerprint !== fingerprint)
            return yield* fail(
              "native.submit",
              new Error("The operation ID was reused with different input"),
            );
          return yield* Deferred.await(existingOperation.admitted);
        }
        const admitted = yield* Deferred.make<{ turnId: string }, AgentBackendApplicationError>();
        const concurrent = nativeOperations.get(operationKey);
        if (concurrent) {
          if (concurrent.fingerprint !== fingerprint)
            return yield* fail(
              "native.submit",
              new Error("The operation ID was reused with different input"),
            );
          return yield* Deferred.await(concurrent.admitted);
        }
        if (nativeOperations.size >= 128) {
          const oldest = [...nativeOperations].find(([, operation]) => operation.settled);
          if (oldest) nativeOperations.delete(oldest[0]);
        }
        if (nativeOperations.size >= 128)
          return yield* fail("native.submit", new Error("Too many active Agent operations"));
        const operation = { fingerprint, admitted, settled: false };
        nativeOperations.set(operationKey, operation);
        // Keep a submission's requested intelligence and its admission in the same lane.
        // The running turn releases the lane as soon as its lifecycle acknowledges admission.
        const result = yield* serializeControl(
          input.threadId,
          Effect.gen(function* () {
            yield* requireExecutionAdmission(input.threadId);
            const handle = yield* requireHandle(input.threadId);
            if (!handle.setIntelligence)
              return yield* fail("native.submit", new Error("Native execution is unavailable"));
            const snapshot = yield* SubscriptionRef.get(handle.snapshot);
            if (snapshot.status !== "idle" || snapshot.requests?.length)
              return yield* fail(
                "native.submit",
                new Error("The native task is busy or unavailable"),
              );
            if (input.model || input.effort) {
              const durable = yield* workspace.readThreadBackendSession(input.threadId);
              const selection = nativeSelectionFromState(durable?.nativeState ?? null);
              if (input.effort && input.effort !== "default" && !isClaudeEffortLevel(input.effort))
                return yield* fail("native.submit", new Error("Unsupported Claude effort"));
              yield* applyAgentIntelligence({
                threadId: input.threadId,
                selection: {
                  ...selection,
                  ...(input.model ? { model: input.model } : {}),
                  ...(input.effort
                    ? { effort: isClaudeEffortLevel(input.effort) ? input.effort : "default" }
                    : {}),
                },
              });
            }
            const turnId = createUuidV7();
            const receipt = yield* ensureReceipt(input.threadId, turnId);
            if (input.unattended) unattendedTurns.add(turnId);
            yield* promptAgentSession({
              threadId: input.threadId,
              prompt: input.prompt,
              clientUserMessageId: turnId,
            }).pipe(
              Effect.catch((cause) =>
                Deferred.fail(
                  receipt.admitted,
                  cause instanceof AgentBackendApplicationError
                    ? cause
                    : fail("native.submit", cause),
                ).pipe(
                  Effect.andThen(Deferred.fail(receipt.outcome, fail("native.turn", cause))),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      receipt.settled = true;
                    }),
                  ),
                ),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  unattendedTurns.delete(turnId);
                  operation.settled = true;
                }),
              ),
              Effect.forkIn(ownerScope),
            );
            yield* Deferred.await(receipt.admitted);
            return { turnId };
          }),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit)
              ? Deferred.fail(
                  operation.admitted,
                  fail("native.submit", Cause.squash(exit.cause)),
                ).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      operation.settled = true;
                      if (nativeOperations.get(operationKey) === operation)
                        nativeOperations.delete(operationKey);
                    }),
                  ),
                )
              : Effect.void,
          ),
        );
        yield* Deferred.succeed(operation.admitted, result);
        return result;
      }).pipe(Effect.mapError((cause) => fail("native.submit", cause))),
    wait: (threadId, turnId) =>
      Effect.gen(function* () {
        const receipt = turnReceipts.get(receiptKey(threadId, turnId));
        if (!receipt)
          return yield* fail("native.wait", new Error("The requested turn receipt is unavailable"));
        return yield* Deferred.await(receipt.outcome);
      }).pipe(Effect.mapError((cause) => fail("native.wait", cause))),
    cancel: (threadId, turnId) =>
      Effect.gen(function* () {
        const handle = yield* claudeSessions.get(threadId);
        if (!handle) return;
        const snapshot = yield* SubscriptionRef.get(handle.snapshot);
        if (!snapshot.turns.some((turn) => turn.clientUserMessageId === turnId && !turn.stopReason))
          return;
        yield* handle.cancel;
      }).pipe(Effect.mapError((cause) => fail("native.cancel", cause))),
    createAutomationSession: (input) =>
      Effect.gen(function* () {
        yield* nativeConversations.validateAutomation(input.definition);
        const binding = input.definition.backendBinding;
        if (binding.kind !== "claude")
          return yield* fail("automation.create", new Error("Select a Claude profile"));
        const project = input.definition.projectId
          ? yield* workspace.getProject(input.definition.projectId)
          : null;
        if (input.definition.projectId && (!project || project.lifecycle !== "active"))
          return yield* fail("automation.create", new Error("Project workspace is unavailable"));
        const cwd = input.cwd ?? project?.primaryWorkspaceRoot ?? null;
        if (!nativeSessionWorkspace)
          return yield* fail(
            "automation.create",
            new Error("Native automation workspace runtime is unavailable"),
          );
        return yield* Effect.scoped(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const lease = yield* restore(
                nativeSessionWorkspace.prepare({
                  projectId: input.definition.projectId,
                  targetId: input.definition.id,
                  title: input.definition.name,
                  prompt: input.definition.prompt,
                  sourceCwd: cwd,
                  sourceRoots: project?.sources.map(({ root }) => root),
                  runInTarget:
                    input.definition.projectId &&
                    input.definition.executionEnvironment === "worktree"
                      ? "newWorktree"
                      : "localProject",
                  localEnvironmentConfigPath: input.definition.localEnvironmentConfigPath,
                  operationId: input.operationId,
                }),
              );
              const thread = yield* createNativeThread({
                projectId: input.definition.projectId,
                binding,
                title: input.definition.name,
                cwd: lease.location.cwd,
                location: lease.location,
                lease,
              });
              return { threadId: thread.threadId };
            }),
          ),
        );
      }).pipe(Effect.mapError((cause) => fail("automation.create", cause))),
    validateAutomation: (definition) =>
      Effect.gen(function* () {
        if (definition.backendBinding.kind !== "claude")
          return yield* fail("automation.backend", new Error("Select a native Claude profile"));
        if (definition.serviceTier)
          return yield* fail(
            "automation.settings",
            new Error("Codex service tiers are unavailable for Claude"),
          );
        if (definition.localEnvironmentConfigPath && definition.executionEnvironment !== "worktree")
          return yield* fail(
            "automation.settings",
            new Error("A Claude Environment requires a managed Project worktree"),
          );
        yield* backends.resolve(definition.backendBinding);
        if (
          definition.reasoningEffort &&
          definition.reasoningEffort !== "default" &&
          !isClaudeEffortLevel(definition.reasoningEffort)
        )
          return yield* fail("automation.settings", new Error("Unsupported Claude effort"));
      }).pipe(Effect.mapError((cause) => fail("automation.validate", cause))),
  };

  const nativeBinding = Option.getOrNull(yield* Effect.serviceOption(NativeConversationBinding));
  if (nativeBinding) yield* nativeBinding.bind(nativeConversations).pipe(Effect.orDie);
  return AgentBackendApplication.of({
    listClaudeNativeSessions: (input) =>
      ownFailure(
        "native.sessions.list",
        Effect.gen(function* () {
          if (input.backendKind !== "claude" || !input.instanceConfigId)
            return yield* fail("native.sessions.list", new Error("Choose a Claude profile"));
          yield* backends.resolve({ kind: "claude", instanceConfigId: input.instanceConfigId });
          const page = yield* claudeSessions.nativeCatalog({
            instanceConfigId: input.instanceConfigId,
            ...(input.cursor ? { cursor: input.cursor } : {}),
          });
          const bindings = yield* workspace.readNativeSessionBindings({
            backendKind: "claude",
            nativeHome: page.nativeHome,
            nativeSessionIds: page.entries.map((entry) => entry.nativeSessionId),
          });
          const attached = new Map(bindings.map((binding) => [binding.nativeSessionId, binding]));
          return {
            ...page,
            entries: page.entries.map((entry) => {
              const binding = attached.get(entry.nativeSessionId);
              return {
                ...entry,
                ...(binding
                  ? {
                      attachedThreadId: binding.threadId,
                      ...(binding.sessionId ? { attachedSessionId: binding.sessionId } : {}),
                    }
                  : {}),
              };
            }),
          };
        }),
      ),
    attachClaudeNativeSession: (input) =>
      ownFailure(
        "native.sessions.attach",
        Effect.gen(function* () {
          if (input.backendKind !== "claude" || !input.instanceConfigId)
            return yield* fail("native.sessions.attach", new Error("Choose a Claude profile"));
          yield* backends.resolve({ kind: "claude", instanceConfigId: input.instanceConfigId });
          const info = yield* claudeSessions.nativeSessionInfo({
            instanceConfigId: input.instanceConfigId,
            nativeSessionId: input.nativeSessionId,
            expectedHome: input.expectedHome,
          });
          return yield* workspace.attachNativeSession({
            backendKind: "claude",
            instanceConfigId: input.instanceConfigId,
            nativeSessionId: info.sessionId,
            nativeHome: info.nativeHome,
            projectId: input.projectId,
            title: nativeSessionCatalogTitle(
              info.customTitle || info.summary,
              "Claude conversation",
            ),
            cwd: info.cwd,
            createdAt: info.createdAt ?? info.lastModified,
            updatedAt: info.lastModified,
          });
        }),
      ),
    nativeConversations,
    readNativePermissionMode: (projectId) =>
      ownFailure("permission.read", readNativePermissionMode(projectId)),
    setNativePermissionMode: (projectId, mode) =>
      ownFailure("permission.write", setNativePermissionMode(projectId, mode)),
    readAgentHistoryImage: (input) =>
      ownFailure(
        "session.history-image",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          if (handle.sessionId !== input.expectedSessionId || !nativeImages)
            return yield* fail(
              "session.history-image",
              new Error("The native image belongs to an unavailable session"),
            );
          const read = yield* requireControl(
            handle.readHistoryImage,
            "history images",
            input.threadId,
          );
          const image = yield* read(input.nativeMessageId, input.index);
          if (
            (yield* requireHandle(input.threadId)) !== handle ||
            handle.sessionId !== input.expectedSessionId
          )
            return yield* fail("session.history-image", new Error("The native session changed"));
          return yield* nativeImages.materialize(image);
        }),
      ),
    readAgentToolOutput: (input) =>
      ownFailure(
        "session.tool-output",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          if (handle.sessionId !== input.expectedSessionId)
            return yield* fail(
              "session.tool-output",
              new Error("The tool output belongs to an unavailable session"),
            );
          const read = yield* requireControl(
            handle.readHistoryToolOutput,
            "tool output history",
            input.threadId,
          );
          const output = yield* read(input.nativeMessageId, input.toolUseId);
          if (
            (yield* requireHandle(input.threadId)) !== handle ||
            handle.sessionId !== input.expectedSessionId
          )
            return yield* fail("session.tool-output", new Error("The native session changed"));
          return output;
        }),
      ),
    claudeDiscovery: (input) =>
      ownFailure(
        "claude.discover",
        Effect.gen(function* () {
          const scope = input.scope;
          if (scope.kind === "thread") {
            yield* requireExecutionAdmission(scope.threadId);
            const authority = yield* resolveThreadAuthority(scope.threadId);
            if (authority.binding.kind !== "claude")
              return yield* fail("claude.discover", new Error("Thread is not owned by Claude"));
            const workspaceEnvironment = yield* worktreeEnvironment(
              authority.workspaceRoot,
              authority.thread.managedWorktreePath,
            );
            const discovery = yield* claudeSessions.discover(
              authority.binding.instanceConfigId,
              { workspaceRoot: authority.workspaceRoot, workspaceEnvironment },
              input.forceReload,
            );
            yield* requireExecutionAdmission(scope.threadId);
            const current = yield* resolveThreadAuthority(scope.threadId);
            if (
              current.binding.kind !== "claude" ||
              current.binding.instanceConfigId !== authority.binding.instanceConfigId ||
              current.workspaceRoot !== authority.workspaceRoot ||
              current.thread.managedWorktreePath !== authority.thread.managedWorktreePath ||
              current.thread.projectId !== authority.thread.projectId
            )
              return yield* fail(
                "claude.discover",
                new Error("The task's execution location changed"),
              );
            return discovery;
          }
          const project = scope.projectId ? yield* workspace.getProject(scope.projectId) : null;
          if (
            scope.projectId &&
            (!project || project.lifecycle !== "active" || !project.primaryWorkspaceRoot)
          )
            return yield* fail("claude.discover", new Error("Choose an active local Project"));
          const cwd = project?.primaryWorkspaceRoot ?? config?.homeDirectory;
          if (!cwd)
            return yield* fail(
              "claude.discover",
              new Error("The host configuration is unavailable"),
            );
          yield* backends.resolve({ kind: "claude", instanceConfigId: scope.instanceConfigId });
          return yield* claudeSessions.discover(
            scope.instanceConfigId,
            { workspaceRoot: cwd },
            input.forceReload,
          );
        }),
      ),
    setAgentIntelligence: (input) =>
      ownFailure("session.intelligence", setAgentIntelligence(input)),
    withAgentExecutionLocation,
    withAgentExecutionHandoff,
    setExecutionRecoveryRequired,
    controlAgentSession: (input) => ownFailure("session.control", controlAgentSession(input)),
    forkAgentSession: (input) => ownFailure("session.fork", forkAgentSession(input)),
    inspectAgentSession: (threadId) =>
      ownFailure(
        "session.inspect",
        Effect.gen(function* () {
          const handle = yield* requireHandle(threadId);
          const sessionId = handle.sessionId;
          const result = yield* yield* requireControl(
            handle.inspectRuntime,
            "runtime diagnostics",
            threadId,
          );
          if ((yield* requireHandle(threadId)) !== handle || handle.sessionId !== sessionId)
            return yield* fail("session.inspect", new Error("The native session changed"));
          return result;
        }),
      ),
    generateAgentTitle: (threadId) =>
      ownFailure(
        "session.title",
        Effect.gen(function* () {
          const authority = yield* resolveThreadAuthority(threadId);
          if (authority.binding.kind !== "claude" || !textGeneration) return null;
          const handle = yield* requireHandle(threadId);
          const snapshot = yield* SubscriptionRef.get(handle.snapshot);
          const sessionId = handle.sessionId;
          const prompt = snapshot.turns.find((turn) => turn.promptText)?.promptText;
          if (!prompt || snapshot.status === "running") return null;
          const selected = snapshot.metadata?.requestedSelection;
          const title = yield* textGeneration.title({
            instanceConfigId: authority.binding.instanceConfigId,
            cwd: authority.workspaceRoot,
            prompt,
            ...(selected?.model !== "default" ? { model: selected?.model } : {}),
            ...(isClaudeEffortLevel(selected?.effort) ? { effort: selected.effort } : {}),
          });
          if ((yield* requireHandle(threadId)) !== handle || handle.sessionId !== sessionId)
            return yield* fail("session.title", new Error("The native session changed"));
          if (title) yield* workspace.updateThread(threadId, { threadName: title });
          return title;
        }),
      ),
    claudeModels: (input) =>
      ownFailure(
        "claude.models",
        Effect.gen(function* () {
          const project = input.projectId ? yield* workspace.getProject(input.projectId) : null;
          const root = project?.primaryWorkspaceRoot?.trim() ?? config?.homeDirectory;
          if (!root || (input.projectId && (!project || project.lifecycle !== "active")))
            return yield* fail(
              "claude.models",
              new Error("Choose an active local Project to load Claude models"),
            );
          yield* backends.resolve({ kind: "claude", instanceConfigId: input.instanceConfigId });
          return yield* claudeSessions.models(input.instanceConfigId, root, input.forceReload);
        }),
      ),
    startAgentThread: (input) =>
      ownFailure(
        "thread.start",
        serializeControl(`start:${input.sessionId}`, startAgentThread(input)),
        { sessionId: input.sessionId },
      ),
    openAgentSession: (input) =>
      ownFailure("session.open", openAgentSession(input), { threadId: input.threadId }),
    readAgentSession: (threadId) =>
      ownFailure("session.read", readAgentSession(threadId), { threadId }),
    observeAgentSession: sessions.observe,
    unobserveAgentSession: sessions.unobserve,
    promptAgentSession: (input) =>
      ownFailure("session.prompt", promptAgentSession(input), { threadId: input.threadId }),
    cancelAgentSession: (threadId) =>
      ownFailure(
        "session.cancel",
        Effect.gen(function* () {
          const handle = yield* requireHandle(threadId);
          yield* handle.cancel;
          return yield* SubscriptionRef.get(handle.snapshot);
        }),
        { threadId },
      ),
    setAgentMode: (input) =>
      ownFailure(
        "session.set-mode",
        serializeControl(
          input.threadId,
          Effect.gen(function* () {
            yield* requireExecutionAdmission(input.threadId);
            const handle = yield* requireHandle(input.threadId);
            yield* handle.setMode(input.modeId);
            yield* persistClaudeIntelligence(handle);
            return yield* SubscriptionRef.get(handle.snapshot);
          }),
        ),
        { threadId: input.threadId },
      ),
    setAgentConfigOption: (input) =>
      ownFailure(
        "session.set-config-option",
        serializeControl(
          input.threadId,
          Effect.gen(function* () {
            yield* requireExecutionAdmission(input.threadId);
            const handle = yield* requireHandle(input.threadId);
            const configOptions = yield* handle.setConfigOption(input.configId, input.value);
            yield* persistClaudeIntelligence(handle);
            return {
              configOptions,
              snapshot: yield* SubscriptionRef.get(handle.snapshot),
            };
          }),
        ),
        { threadId: input.threadId },
      ),
    authenticateAgentSession: (input) =>
      ownFailure(
        "session.authenticate",
        Effect.gen(function* () {
          yield* requireExecutionAdmission(input.threadId);
          const handle = yield* requireHandle(input.threadId);
          if (
            (yield* SubscriptionRef.get(handle.snapshot)).backend === "claude" &&
            input.methodId === "reconnect"
          ) {
            yield* claudeSessions.close(input.threadId);
            const reopened = yield* openAgentSession({ threadId: input.threadId });
            return { snapshot: reopened.snapshot };
          }
          const authenticate = yield* requireControl(
            handle.authenticate,
            "authentication",
            input.threadId,
          );
          yield* authenticate(input.methodId);
          const authority = yield* resolveThreadAuthority(input.threadId);
          const sessionId = handle.sessionId;
          if (sessionId === null) {
            return yield* fail(
              "session.authenticate",
              new Error("ACP authentication completed without opening a session"),
              { threadId: input.threadId },
            );
          }
          const durable = yield* workspace.readThreadBackendSession(input.threadId);
          if (durable && durable.backendSessionId !== sessionId) {
            yield* sessions.close(input.threadId);
            return yield* fail(
              "session.identity",
              new Error("Authenticated ACP session does not match the durable protocol identity"),
              { threadId: input.threadId },
            );
          }
          if (!durable) {
            yield* workspace.bindThreadBackendSession({
              threadId: input.threadId,
              backendBinding: authority.binding,
              backendSessionId: sessionId,
            });
          }
          const initialPrompt = handle.takeDeferredInitialPrompt
            ? yield* handle.takeDeferredInitialPrompt
            : null;
          if (initialPrompt !== null) {
            yield* launchInitialPrompt(
              input.threadId,
              initialPrompt.prompt,
              initialPrompt.clientUserMessageId,
              initialPrompt.images,
            );
          }
          return { snapshot: yield* SubscriptionRef.get(handle.snapshot) };
        }),
        { threadId: input.threadId },
      ),
    closeAgentSession: (threadId) =>
      ownFailure(
        "session.close",
        requireExecutionAdmission(threadId).pipe(Effect.andThen(sessions.close(threadId))),
        { threadId },
      ),
    respondToInteraction: (threadId, requestId, response) =>
      ownFailure(
        "session.respond",
        Effect.gen(function* () {
          const handle = yield* requireHandle(threadId);
          if (!handle.respond)
            return yield* fail(
              "session.respond",
              new Error("This Agent has no pending interactive controls"),
              { threadId },
            );
          yield* handle.respond(requestId, response);
        }),
        { threadId },
      ),
    changes: sessions.changes,
  });
});

export const live: Layer.Layer<
  AgentBackendApplication,
  never,
  AgentBackendRegistry | AcpBackendSessionManager | ClaudeSessionManager | ProjectWorkspace
> = Layer.effect(AgentBackendApplication, make);

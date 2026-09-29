import { ClaudeSessionManager } from "./claude/ClaudeSessionManager";
import type { AgentSessionHandle } from "./AgentSessionHandle";
import type { AgentInteractionResponse } from "../../shared/agent-conversation";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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
  AgentBackendThreadStartResult,
  AgentBackendSessionChangedEvent,
} from "../../shared/agent-backend-api";
import type {
  AgentBackendSessionPresentation,
  AgentSessionConfigOption,
  AgentSessionModeState,
} from "../../shared/agent-conversation";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { CodexPermissionMode, ProjectSessionThreadLink } from "../../shared/types";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  AcpBackendSessionManager,
  type AcpBackendSessionHandle,
} from "./acp/AcpBackendSessionManager";
import type { AgentRuntimeError } from "./AgentRuntimeError";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import type { ClaudeModelCatalogInput } from "../../shared/claude-models";
import type { AgentSessionConfigSelectOption } from "../../shared/agent-conversation";

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

export class AgentBackendApplication extends Context.Service<
  AgentBackendApplication,
  {
    readonly claudeModels: (
      input: ClaudeModelCatalogInput,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentBackendApplicationError>;
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

export const projectAgentSessionModes = (
  modes: AcpBackendSessionHandle["modes"],
): AgentSessionModeState | null =>
  modes
    ? {
        currentModeId: modes.currentModeId,
        availableModes: modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? null,
        })),
      }
    : null;

export const projectAgentSessionConfigOptions = (
  options: AcpBackendSessionHandle["configOptions"],
): readonly AgentSessionConfigOption[] =>
  options.map((option): AgentSessionConfigOption => {
    const common = {
      id: option.id,
      name: option.name,
      description: option.description ?? null,
      category: option.category ?? null,
    };
    if (option.type === "boolean") {
      return { ...common, type: "boolean", currentValue: option.currentValue };
    }
    return {
      ...common,
      type: "select",
      currentValue: option.currentValue,
      options: option.options.map((candidate) =>
        "group" in candidate
          ? {
              group: candidate.group,
              name: candidate.name,
              options: candidate.options.map((entry) => ({
                value: entry.value,
                name: entry.name,
                description: entry.description ?? null,
              })),
            }
          : {
              value: candidate.value,
              name: candidate.name,
              description: candidate.description ?? null,
            },
      ),
    };
  });

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
  const adaptAcp = (handle: AcpBackendSessionHandle): AgentSessionHandle => ({
    ...handle,
    get sessionId() {
      return handle.sessionId;
    },
    get modes() {
      return projectAgentSessionModes(handle.modes);
    },
    get configOptions() {
      return projectAgentSessionConfigOptions(handle.configOptions);
    },
    prompt: (text, options) => handle.prompt([{ type: "text", text }], options),
    setConfigOption: (id, value) =>
      handle.setConfigOption(id, value).pipe(Effect.map(projectAgentSessionConfigOptions)),
  });
  const sessions = {
    get: (id: string) =>
      claudeSessions
        .get(id)
        .pipe(
          Effect.flatMap((native) =>
            native
              ? Effect.succeed(native)
              : acpSessions
                  .get(id)
                  .pipe(Effect.map((handle) => (handle ? adaptAcp(handle) : null))),
          ),
        ),
    observe: (id: string) =>
      acpSessions.observe(id).pipe(Effect.andThen(claudeSessions.observe(id))),
    unobserve: (id: string) =>
      acpSessions.unobserve(id).pipe(Effect.andThen(claudeSessions.unobserve(id))),
    close: (id: string) => acpSessions.close(id).pipe(Effect.andThen(claudeSessions.close(id))),
    changes: Stream.merge(acpSessions.changes, claudeSessions.changes),
  };
  const workspace = yield* ProjectWorkspace;
  const ownerScope = yield* Scope.Scope;

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

  const presentation = (handle: AgentSessionHandle) =>
    SubscriptionRef.get(handle.snapshot).pipe(
      Effect.map((snapshot) => ({
        snapshot,
        capabilities: handle.capabilities,
        modes: handle.modes,
        configOptions: handle.configOptions,
      })),
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
        !project ||
        project.lifecycle !== "active" ||
        thread.archived ||
        (thread.executionHostId && thread.executionHostId !== "local")
      ) {
        return yield* fail(
          "thread.workspace",
          new Error("Agent execution requires an active local Project and task"),
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
        permissionPolicy: resolveAcpPermissionPolicy(mode),
      };
    },
  );

  const openAgentSession = Effect.fn("AgentBackendApplication.openAgentSession")(function* (
    input: AgentBackendSessionOpenInput,
  ) {
    const authority = yield* resolveThreadAuthority(input.threadId);
    const durable = yield* workspace.readThreadBackendSession(input.threadId);
    if (durable && !sameBinding(durable.backendBinding, authority.binding)) {
      return yield* fail(
        "session.binding",
        new Error("Durable Agent session belongs to a stale backend binding"),
        { threadId: input.threadId },
      );
    }
    const handle = yield* (
      authority.binding.kind === "claude"
        ? claudeSessions.open({
            threadId: input.threadId,
            instanceConfigId: authority.binding.instanceConfigId,
            workspaceRoot: authority.workspaceRoot,
            permissionPolicy: authority.permissionPolicy,
            model: authority.thread.executionProfile?.modelId,
            effort: authority.thread.executionProfile?.reasoningEffort,
            ...(durable ? { sessionId: durable.backendSessionId } : {}),
          })
        : acpSessions
            .open({
              threadId: input.threadId,
              agentDefinitionId: authority.binding.agentDefinitionId,
              instanceConfigId: authority.binding.instanceConfigId!,
              workspaceRoot: authority.workspaceRoot,
              permissionPolicy: authority.permissionPolicy,
              open: durable
                ? { kind: "load", sessionId: durable.backendSessionId }
                : { kind: "new" },
            })
            .pipe(Effect.map(adaptAcp))
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
    const openedSessionId = handle.sessionId;
    if (durable && openedSessionId !== null && durable.backendSessionId !== openedSessionId) {
      yield* sessions.close(input.threadId);
      return yield* fail(
        "session.identity",
        new Error("Live ACP session does not match the durable protocol identity"),
        { threadId: input.threadId },
      );
    }
    if (!durable && openedSessionId !== null) {
      yield* workspace.bindThreadBackendSession({
        threadId: input.threadId,
        backendBinding: authority.binding,
        backendSessionId: openedSessionId,
      });
    }
    return yield* presentation(handle);
  });

  const requireHandle = Effect.fn("AgentBackendApplication.requireHandle")(function* (
    threadId: string,
  ) {
    const existing = yield* sessions.get(threadId);
    if (existing) return existing;
    yield* openAgentSession({ threadId });
    const opened = yield* sessions.get(threadId);
    if (opened) return opened;
    return yield* fail("session.open", new Error("Agent session did not become available"), {
      threadId,
    });
  });

  const persistClaudeIntelligence = Effect.fn("AgentBackendApplication.persistClaudeIntelligence")(
    function* (handle: AgentSessionHandle) {
      if ((yield* SubscriptionRef.get(handle.snapshot)).backend !== "claude") return;
      const value = (id: string) => {
        const option = handle.configOptions.find((entry) => entry.id === id);
        return option?.type === "select" ? option.currentValue : null;
      };
      const effort = value("effort");
      yield* workspace
        .updateThread(handle.threadId, {
          executionProfile: {
            modelId: value("model") ?? "default",
            reasoningEffort: effort === "default" ? null : effort,
            serviceTier: null,
          },
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
    input: AgentBackendPromptInput,
  ) {
    const text = input.prompt.trim();
    if (!text)
      return yield* fail("prompt.validate", new Error("Prompt is required"), {
        threadId: input.threadId,
      });
    const handle = yield* requireHandle(input.threadId);
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

  const launchInitialPrompt = (threadId: string, prompt: string, clientUserMessageId: string) =>
    Effect.yieldNow.pipe(
      Effect.andThen(promptAgentSession({ threadId, prompt, clientUserMessageId })),
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

  const startAgentThread = Effect.fn("AgentBackendApplication.startAgentThread")(function* (
    input: AgentBackendThreadStartInput,
  ) {
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
    const linked = yield* workspace.upsertProjectSessionThreadLink({
      sessionId: session.id,
      projectId: project.id,
      threadId,
      threadName: titleFromPrompt(input.prompt),
      threadPreview: input.prompt.trim().slice(0, 512),
      backendBinding: resolution.binding,
      executionHostId: "local",
      runtimeWorkspaceRoots: project.sources.map(({ root }) => root),
      cwd: workspaceRoot,
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: now,
      updatedAt: now,
      recencyAt: now,
    });
    const opened = yield* openAgentSession({ threadId });
    const currentSession = yield* workspace.getProjectSession(input.sessionId);
    const thread: ProjectSessionThreadLink = currentSession?.thread ?? linked;
    const handle = yield* requireHandle(threadId);
    const modelConfig = handle.configOptions.find((option) => option.category === "model");
    if (
      input.model &&
      modelConfig &&
      modelConfig.type === "select" &&
      modelConfig.currentValue !== input.model
    ) {
      yield* handle.setConfigOption(modelConfig.id, input.model);
    }
    if (input.backendKind === "claude" && input.effort)
      yield* handle.setConfigOption("effort", input.effort);
    yield* persistClaudeIntelligence(handle);
    const mode = handle.modes?.availableModes.find((candidate) =>
      input.mode === "plan"
        ? candidate.id === "plan"
        : candidate.id === "code" || candidate.id === "default",
    );
    if (input.mode && mode && handle.modes?.currentModeId !== mode.id)
      yield* handle.setMode(mode.id);
    const result = { thread, presentation: yield* presentation(handle) };
    // The first prompt remains process-owned and single-consume. Interactive authentication may
    // defer its first submission, but a Main restart never replays it and risks a duplicate.
    if (opened.snapshot.status === "authentication-required") {
      yield* handle.deferInitialPrompt({
        prompt: input.prompt,
        clientUserMessageId: input.firstSubmission.clientUserMessageId,
      });
    } else {
      yield* launchInitialPrompt(threadId, input.prompt, input.firstSubmission.clientUserMessageId);
    }
    return result;
  });

  const readAgentSession = (threadId: string) =>
    sessions
      .get(threadId)
      .pipe(Effect.flatMap((handle) => (handle ? presentation(handle) : Effect.succeed(null))));

  return AgentBackendApplication.of({
    claudeModels: (input) =>
      ownFailure(
        "claude.models",
        Effect.gen(function* () {
          const project = yield* workspace.getProject(input.projectId);
          const root = project?.primaryWorkspaceRoot?.trim();
          if (!project || project.lifecycle !== "active" || !root)
            return yield* fail(
              "claude.models",
              new Error("Choose an active local Project to load Claude models"),
            );
          yield* backends.resolve({ kind: "claude", instanceConfigId: input.instanceConfigId });
          return yield* claudeSessions.models(input.instanceConfigId, root);
        }),
      ),
    startAgentThread: (input) =>
      ownFailure("thread.start", startAgentThread(input), { sessionId: input.sessionId }),
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
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          yield* handle.setMode(input.modeId);
          return yield* SubscriptionRef.get(handle.snapshot);
        }),
        { threadId: input.threadId },
      ),
    setAgentConfigOption: (input) =>
      ownFailure(
        "session.set-config-option",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          const configOptions = yield* handle.setConfigOption(input.configId, input.value);
          yield* persistClaudeIntelligence(handle);
          return {
            configOptions,
            snapshot: yield* SubscriptionRef.get(handle.snapshot),
          };
        }),
        { threadId: input.threadId },
      ),
    authenticateAgentSession: (input) =>
      ownFailure(
        "session.authenticate",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          yield* handle.authenticate(input.methodId);
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
          const initialPrompt = yield* handle.takeDeferredInitialPrompt;
          if (initialPrompt !== null) {
            yield* launchInitialPrompt(
              input.threadId,
              initialPrompt.prompt,
              initialPrompt.clientUserMessageId,
            );
          }
          return { snapshot: yield* SubscriptionRef.get(handle.snapshot) };
        }),
        { threadId: input.threadId },
      ),
    closeAgentSession: (threadId) =>
      ownFailure("session.close", sessions.close(threadId), { threadId }),
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

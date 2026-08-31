import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  AcpBackendAuthenticateInput,
  AcpBackendAuthenticateResult,
  AcpBackendConfigOptionInput,
  AcpBackendConfigOptionResult,
  AcpBackendModeInput,
  AcpBackendPromptInput,
  AcpBackendPromptResult,
  AcpBackendSessionOpenInput,
  AcpBackendThreadStartInput,
  AcpBackendThreadStartResult,
  AcpBackendSessionChangedEvent,
} from "../../shared/agent-backend-api";
import type {
  AcpBackendSessionPresentation,
  AcpSessionConfigOption,
  AcpSessionModeState,
} from "../../shared/acp-conversation";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import { createUuidV7 } from "../../shared/uuid-v7";
import type { CodexPermissionMode, ProjectSessionThreadLink } from "../../shared/types";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import {
  AcpBackendSessionManager,
  type AcpBackendSessionHandle,
} from "./acp/AcpBackendSessionManager";
import type { AcpRuntimeError } from "./acp/AcpRuntimeError";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";

export class AgentBackendApplicationError extends Schema.TaggedError<AgentBackendApplicationError>()(
  "AgentBackendApplicationError",
  {
    operation: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

type AcpBinding = Extract<AgentBackendBinding, { readonly kind: "acp" }>;

export class AgentBackendApplication extends Context.Service<
  AgentBackendApplication,
  {
    readonly startAcpThread: (
      input: AcpBackendThreadStartInput,
    ) => Effect.Effect<AcpBackendThreadStartResult, AgentBackendApplicationError>;
    readonly openAcpSession: (
      input: AcpBackendSessionOpenInput,
    ) => Effect.Effect<AcpBackendSessionPresentation, AgentBackendApplicationError>;
    readonly readAcpSession: (
      threadId: string,
    ) => Effect.Effect<AcpBackendSessionPresentation | null, AgentBackendApplicationError>;
    readonly observeAcpSession: (threadId: string) => Effect.Effect<void>;
    readonly unobserveAcpSession: (threadId: string) => Effect.Effect<void>;
    readonly promptAcpSession: (
      input: AcpBackendPromptInput,
    ) => Effect.Effect<AcpBackendPromptResult, AgentBackendApplicationError>;
    readonly cancelAcpSession: (
      threadId: string,
    ) => Effect.Effect<AcpBackendSessionPresentation["snapshot"], AgentBackendApplicationError>;
    readonly setAcpMode: (
      input: AcpBackendModeInput,
    ) => Effect.Effect<AcpBackendSessionPresentation["snapshot"], AgentBackendApplicationError>;
    readonly setAcpConfigOption: (
      input: AcpBackendConfigOptionInput,
    ) => Effect.Effect<AcpBackendConfigOptionResult, AgentBackendApplicationError>;
    readonly authenticateAcpSession: (
      input: AcpBackendAuthenticateInput,
    ) => Effect.Effect<AcpBackendAuthenticateResult, AgentBackendApplicationError>;
    readonly closeAcpSession: (
      threadId: string,
    ) => Effect.Effect<void, AgentBackendApplicationError>;
    readonly changes: Stream.Stream<AcpBackendSessionChangedEvent>;
  }
>()("nodex/main/agent-backend/AgentBackendApplication") {}

const sameBinding = (left: AcpBinding, right: AcpBinding): boolean =>
  left.agentDefinitionId === right.agentDefinitionId &&
  left.instanceConfigId === right.instanceConfigId;

const ACP_PERMISSION_POLICY_BY_MODE = {
  auto: "ask",
  "guardian-approvals": "approve-for-me",
  "full-access": "approve-for-me",
  custom: "ask",
} as const satisfies Readonly<Record<CodexPermissionMode, "approve-for-me" | "ask">>;

export const resolveAcpPermissionPolicy = (
  mode: CodexPermissionMode | null,
): "approve-for-me" | "ask" => (mode === null ? "ask" : ACP_PERMISSION_POLICY_BY_MODE[mode]);

export const projectAcpSessionModes = (
  modes: AcpBackendSessionHandle["modes"],
): AcpSessionModeState | null =>
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

export const projectAcpSessionConfigOptions = (
  options: AcpBackendSessionHandle["configOptions"],
): readonly AcpSessionConfigOption[] =>
  options.map((option): AcpSessionConfigOption => {
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
  const sessions = yield* AcpBackendSessionManager;
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

  const presentation = (handle: AcpBackendSessionHandle) =>
    SubscriptionRef.get(handle.snapshot).pipe(
      Effect.map((snapshot) => ({
        snapshot,
        capabilities: handle.capabilities,
        modes: projectAcpSessionModes(handle.modes),
        configOptions: projectAcpSessionConfigOptions(handle.configOptions),
      })),
    );

  const resolveThreadAuthority = Effect.fn("AgentBackendApplication.resolveThreadAuthority")(
    function* (threadId: string) {
      const thread = yield* workspace.getThread(threadId);
      if (!thread)
        return yield* fail("thread.read", new Error("Agent Thread was not found"), { threadId });
      if (thread.backendBinding.kind !== "acp") {
        return yield* fail(
          "thread.backend",
          new Error("Thread is owned by the native Codex backend"),
          {
            threadId,
          },
        );
      }
      const resolution = yield* backends.resolve(thread.backendBinding);
      if (resolution.kind !== "acp") {
        return yield* fail(
          "thread.backend",
          new Error("ACP binding resolved to the native backend"),
          {
            threadId,
          },
        );
      }
      const project = thread.projectId ? yield* workspace.getProject(thread.projectId) : null;
      const workspaceRoot = thread.cwd?.trim() || project?.primaryWorkspaceRoot?.trim();
      if (!workspaceRoot) {
        return yield* fail(
          "thread.workspace",
          new Error("ACP Threads require a local Project workspace"),
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

  const openAcpSession = Effect.fn("AgentBackendApplication.openAcpSession")(function* (
    input: AcpBackendSessionOpenInput,
  ) {
    const authority = yield* resolveThreadAuthority(input.threadId);
    const durable = yield* workspace.readThreadBackendSession(input.threadId);
    if (durable && !sameBinding(durable.backendBinding, authority.binding)) {
      return yield* fail(
        "session.binding",
        new Error("Durable ACP session belongs to a stale backend binding"),
        { threadId: input.threadId },
      );
    }
    const handle = yield* sessions
      .open({
        threadId: input.threadId,
        agentDefinitionId: authority.binding.agentDefinitionId,
        instanceConfigId: authority.binding.instanceConfigId,
        workspaceRoot: authority.workspaceRoot,
        permissionPolicy: authority.permissionPolicy,
        open: durable ? { kind: "load", sessionId: durable.backendSessionId } : { kind: "new" },
      })
      .pipe(
        Effect.catch(
          (cause): Effect.Effect<never, AcpRuntimeError | AgentBackendApplicationError> => {
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
    yield* openAcpSession({ threadId });
    const opened = yield* sessions.get(threadId);
    if (opened) return opened;
    return yield* fail("session.open", new Error("ACP session did not become available"), {
      threadId,
    });
  });

  const setThreadStatus = (threadId: string, statusType: "active" | "idle" | "systemError") =>
    workspace
      .updateThread(threadId, {
        status: { statusType, activeFlags: [] },
        updatedAt: Date.now(),
        recencyAt: Date.now(),
      })
      .pipe(Effect.asVoid);

  const promptAcpSession = Effect.fn("AgentBackendApplication.promptAcpSession")(function* (
    input: AcpBackendPromptInput,
  ) {
    const text = input.prompt.trim();
    if (!text)
      return yield* fail("prompt.validate", new Error("Prompt is required"), {
        threadId: input.threadId,
      });
    const handle = yield* requireHandle(input.threadId);
    const response = yield* Effect.uninterruptibleMask((restore) =>
      setThreadStatus(input.threadId, "active").pipe(
        Effect.andThen(restore(handle.prompt([{ type: "text", text }]))),
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

  const launchInitialPrompt = (threadId: string, prompt: string) =>
    Effect.yieldNow.pipe(
      Effect.andThen(promptAcpSession({ threadId, prompt })),
      Effect.catchCause((cause) =>
        isInterruptedOnly(cause)
          ? Effect.void
          : Effect.logError("ACP initial prompt failed").pipe(
              Effect.annotateLogs({ cause: Cause.pretty(cause), threadId }),
            ),
      ),
      Effect.forkIn(ownerScope, { startImmediately: true }),
      Effect.asVoid,
    );

  const startAcpThread = Effect.fn("AgentBackendApplication.startAcpThread")(function* (
    input: AcpBackendThreadStartInput,
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
        new Error("ACP Threads currently require a local Project"),
        { sessionId: input.sessionId },
      );
    }
    const project = yield* workspace.getProject(session.projectId);
    const workspaceRoot = project?.primaryWorkspaceRoot?.trim();
    if (!project || project.lifecycle !== "active" || !workspaceRoot) {
      return yield* fail(
        "thread.start.workspace",
        new Error("ACP Threads require an active Project with a primary workspace"),
        { sessionId: input.sessionId },
      );
    }
    const resolution = yield* backends.resolveAcpInstance(input.instanceConfigId);
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
    const opened = yield* openAcpSession({ threadId });
    const currentSession = yield* workspace.getProjectSession(input.sessionId);
    const thread: ProjectSessionThreadLink = currentSession?.thread ?? linked;
    const handle = yield* requireHandle(threadId);
    const result = { thread, presentation: yield* presentation(handle) };
    // The first prompt remains process-owned and single-consume. Interactive authentication may
    // defer its first submission, but a Main restart never replays it and risks a duplicate.
    if (opened.snapshot.status === "authentication-required") {
      yield* handle.deferInitialPrompt(input.prompt);
    } else {
      yield* launchInitialPrompt(threadId, input.prompt);
    }
    return result;
  });

  const readAcpSession = (threadId: string) =>
    sessions
      .get(threadId)
      .pipe(Effect.flatMap((handle) => (handle ? presentation(handle) : Effect.succeed(null))));

  return AgentBackendApplication.of({
    startAcpThread: (input) =>
      ownFailure("thread.start", startAcpThread(input), { sessionId: input.sessionId }),
    openAcpSession: (input) =>
      ownFailure("session.open", openAcpSession(input), { threadId: input.threadId }),
    readAcpSession: (threadId) =>
      ownFailure("session.read", readAcpSession(threadId), { threadId }),
    observeAcpSession: sessions.observe,
    unobserveAcpSession: sessions.unobserve,
    promptAcpSession: (input) =>
      ownFailure("session.prompt", promptAcpSession(input), { threadId: input.threadId }),
    cancelAcpSession: (threadId) =>
      ownFailure(
        "session.cancel",
        Effect.gen(function* () {
          const handle = yield* requireHandle(threadId);
          yield* handle.cancel;
          return yield* SubscriptionRef.get(handle.snapshot);
        }),
        { threadId },
      ),
    setAcpMode: (input) =>
      ownFailure(
        "session.set-mode",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          yield* handle.setMode(input.modeId);
          return yield* SubscriptionRef.get(handle.snapshot);
        }),
        { threadId: input.threadId },
      ),
    setAcpConfigOption: (input) =>
      ownFailure(
        "session.set-config-option",
        Effect.gen(function* () {
          const handle = yield* requireHandle(input.threadId);
          const configOptions = yield* handle.setConfigOption(input.configId, input.value);
          return {
            configOptions: projectAcpSessionConfigOptions(configOptions),
            snapshot: yield* SubscriptionRef.get(handle.snapshot),
          };
        }),
        { threadId: input.threadId },
      ),
    authenticateAcpSession: (input) =>
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
          if (initialPrompt !== null) yield* launchInitialPrompt(input.threadId, initialPrompt);
          return { snapshot: yield* SubscriptionRef.get(handle.snapshot) };
        }),
        { threadId: input.threadId },
      ),
    closeAcpSession: (threadId) =>
      ownFailure("session.close", sessions.close(threadId), { threadId }),
    changes: sessions.changes,
  });
});

export const live: Layer.Layer<
  AgentBackendApplication,
  never,
  AgentBackendRegistry | AcpBackendSessionManager | ProjectWorkspace
> = Layer.effect(AgentBackendApplication, make);

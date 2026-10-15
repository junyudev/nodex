import { isDeepStrictEqual } from "node:util";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { AgentBackendRegistry } from "./AgentBackendRegistry";
import { ClaudeNativeCatalog } from "./claude/ClaudeNativeCatalog";
import { OpenCodeModelCatalog } from "./opencode/OpenCodeModelCatalog";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { MainConfig } from "../app/MainConfig";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { loadCodexWorktreeShellEnvironmentAtGitPath } from "../codex/codex-worktree-shell-environment";
import { nativeSessionCatalogTitle } from "../../shared/native-session-catalog";
import { projectNativeModelOption } from "../../shared/native-model-option";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import type { AgentBackendBinding } from "../../shared/agent-backend";
import type { AgentModelCatalog, AgentModelCatalogInput } from "../../shared/agent-model-catalog";
import type {
  NativeSessionCatalogInput,
  NativeSessionCatalogPage,
  NativeSessionAttachInput,
  NativeSessionAttachResult,
} from "../../shared/native-session-catalog";
import type {
  ClaudeModelCatalogInput,
  ClaudeDiscoveryInput,
  ClaudeDiscovery,
} from "../../shared/claude-models";
import type {
  AgentSessionConfigSelectOption,
  AgentConversationSnapshot,
} from "../../shared/agent-conversation";
import type {
  AgentBackendHistoryReadInput,
  AgentBackendHistoryImageInput,
  AgentBackendToolOutputInput,
  AgentNativeHistoryInspection,
} from "../../shared/agent-backend-api";
import { make as makeNativeSessionHistory } from "./NativeSessionHistory";

export class AgentBackendApplicationError extends Schema.TaggedError<AgentBackendApplicationError>()(
  "AgentBackendApplicationError",
  {
    operation: Schema.String,
    threadId: Schema.optionalKey(Schema.String),
    sessionId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class AgentBackendApplication extends Context.Service<
  AgentBackendApplication,
  {
    readonly listClaudeNativeSessions: (
      input: NativeSessionCatalogInput,
    ) => Effect.Effect<NativeSessionCatalogPage, AgentBackendApplicationError>;
    readonly attachClaudeNativeSession: (
      input: NativeSessionAttachInput,
    ) => Effect.Effect<NativeSessionAttachResult, AgentBackendApplicationError>;
    readonly modelCatalog: (
      input: AgentModelCatalogInput,
    ) => Effect.Effect<AgentModelCatalog, AgentBackendApplicationError>;
    readonly claudeModels: (
      input: ClaudeModelCatalogInput,
    ) => Effect.Effect<readonly AgentSessionConfigSelectOption[], AgentBackendApplicationError>;
    readonly claudeDiscovery: (
      input: ClaudeDiscoveryInput,
    ) => Effect.Effect<ClaudeDiscovery, AgentBackendApplicationError>;
    readonly readAgentHistory: (
      input: AgentBackendHistoryReadInput,
    ) => Effect.Effect<AgentConversationSnapshot, AgentBackendApplicationError>;
    readonly inspectAgentSession: (
      threadId: string,
    ) => Effect.Effect<AgentNativeHistoryInspection, AgentBackendApplicationError>;
    readonly readAgentHistoryImage: (
      input: AgentBackendHistoryImageInput,
    ) => Effect.Effect<string, AgentBackendApplicationError>;
    readonly readAgentToolOutput: (
      input: AgentBackendToolOutputInput,
    ) => Effect.Effect<
      import("../../shared/agent-tool-output").AgentToolOutput,
      AgentBackendApplicationError
    >;
  }
>()("nodex/main/agent-backend/AgentBackendApplication") {}

const sameBinding = (left: AgentBackendBinding, right: AgentBackendBinding): boolean =>
  isDeepStrictEqual(left, right);

/** Provider discovery and imported history do not acquire an execution owner. */
export const make = Effect.gen(function* () {
  const backends = yield* AgentBackendRegistry;
  const claudeSessions = yield* ClaudeNativeCatalog;
  const openCodeSessions = yield* OpenCodeModelCatalog;
  const applicationSettings = yield* ApplicationSettings;
  const workspace = yield* ProjectWorkspace;
  const config = yield* MainConfig;
  const runtime = yield* AgentRuntimeApplication;
  const history = yield* makeNativeSessionHistory;
  const git = Option.getOrNull(yield* Effect.serviceOption(CodexGitProbe));
  const fail = (operation: string, cause: unknown) =>
    new AgentBackendApplicationError({ operation, cause });
  const ownFailure = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof AgentBackendApplicationError ? cause : fail(operation, cause),
      ),
    );
  const readThreadMetadata = Effect.fn("AgentBackendApplication.readThreadMetadata")(function* (
    threadId: string,
  ) {
    const thread = yield* workspace.getThread(threadId);
    if (!thread || thread.backendBinding.kind === "codex")
      return yield* fail("thread.read", new Error("The native Agent descriptor is unavailable"));
    const project = thread.projectId ? yield* workspace.getProject(thread.projectId) : null;
    const workspaceRoot =
      thread.cwd?.trim() || project?.primaryWorkspaceRoot?.trim() || config.homeDirectory;
    const resolution = yield* backends.resolve(thread.backendBinding);
    if (resolution.kind === "codex")
      return yield* fail("thread.binding", new Error("The configured native Agent changed"));
    return { thread, binding: resolution.binding, workspaceRoot };
  });
  const worktreeEnvironment = Effect.fn("AgentBackendApplication.worktreeEnvironment")(function* (
    cwd: string,
    managedWorktreePath?: string | null,
  ) {
    if (!managedWorktreePath) return null;
    if (!git)
      return yield* fail(
        "history.environment",
        new Error("The worktree environment is unavailable"),
      );
    const gitPath = yield* git.readPath(cwd, [
      "rev-parse",
      "--git-path",
      "codex-shell-environment.json",
    ]);
    if (!gitPath)
      return yield* fail(
        "history.environment",
        new Error("The worktree environment is unavailable"),
      );
    return yield* Effect.tryPromise({
      try: () => loadCodexWorktreeShellEnvironmentAtGitPath({ cwd, gitPath }),
      catch: (cause) => fail("history.environment", cause),
    });
  });
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
    modelCatalog: (input) =>
      ownFailure(
        "model-catalog.read",
        Effect.gen(function* () {
          const scope = input.scope;
          const settingsRevision = (yield* applicationSettings.snapshot()).revision;
          const authority =
            scope.kind === "thread" ? yield* readThreadMetadata(scope.threadId) : null;
          const project =
            scope.kind === "project" && scope.projectId
              ? yield* workspace.getProject(scope.projectId)
              : null;
          if (
            scope.kind === "project" &&
            scope.projectId &&
            (!project || project.lifecycle !== "active" || !project.primaryWorkspaceRoot)
          )
            return yield* fail("model-catalog.scope", new Error("Choose an active local Project"));
          const binding = authority?.binding ?? (scope.kind === "project" ? scope.binding : null);
          const root =
            authority?.workspaceRoot ?? project?.primaryWorkspaceRoot ?? config?.homeDirectory;
          if (!binding || !root)
            return yield* fail(
              "model-catalog.scope",
              new Error("The execution scope is unavailable"),
            );
          yield* backends.resolve(binding);
          let catalog: AgentModelCatalog;
          if (binding.kind === "opencode") {
            catalog = yield* openCodeSessions.discover({
              instanceConfigId: binding.instanceConfigId,
              workspaceRoot: root,
              workspaceEnvironment: authority
                ? yield* worktreeEnvironment(root, authority.thread.managedWorktreePath)
                : null,
              forceReload: input.forceReload,
            });
          } else if (binding.kind === "claude") {
            const workspaceEnvironment = authority
              ? yield* worktreeEnvironment(root, authority.thread.managedWorktreePath)
              : null;
            const discovery = yield* claudeSessions.discover(
              binding.instanceConfigId,
              { workspaceRoot: root, workspaceEnvironment },
              input.forceReload,
            );
            catalog = {
              binding,
              models: discovery.models.map((option) =>
                projectNativeModelOption(
                  option,
                  option.value === discovery.intelligence.model,
                  true,
                ),
              ),
              configOptions: [],
              modes: null,
              defaultModel: discovery.intelligence.model,
              claudeDiscovery: discovery,
              health: {
                status: discovery.health.error ? "unavailable" : "ready",
                error: discovery.health.error,
              },
            };
          } else {
            const providers = yield* runtime.catalog({ refresh: input.forceReload === true });
            const provider = providers.find(
              (value) => value.instanceId === agentRuntimeProviderId(binding),
            );
            if (!provider)
              return yield* fail(
                "model-catalog.read",
                new Error("The configured Agent is unavailable"),
              );
            catalog = {
              binding,
              models: provider.models.map((value) =>
                projectNativeModelOption(
                  { value: value.slug, name: value.name, description: null },
                  value.isDefault === true,
                  false,
                ),
              ),
              configOptions: [],
              modes: null,
              defaultModel: provider.models.find((value) => value.isDefault)?.slug ?? null,
              health: {
                status:
                  provider.auth.status === "unauthenticated"
                    ? "authentication-required"
                    : provider.status === "ready"
                      ? "ready"
                      : "unavailable",
                error: provider.message ?? null,
              },
            };
          }
          if ((yield* applicationSettings.snapshot()).revision !== settingsRevision)
            return yield* fail(
              "model-catalog.scope",
              new Error("Agent settings changed while loading models"),
            );
          if (authority && scope.kind === "thread") {
            const current = yield* readThreadMetadata(scope.threadId);
            if (
              !sameBinding(current.binding, authority.binding) ||
              current.workspaceRoot !== authority.workspaceRoot ||
              current.thread.projectId !== authority.thread.projectId ||
              current.thread.managedWorktreePath !== authority.thread.managedWorktreePath
            )
              return yield* fail(
                "model-catalog.scope",
                new Error("The task's execution location changed while loading models"),
              );
          } else if (project) {
            const current = yield* workspace.getProject(project.id);
            if (
              !current ||
              current.lifecycle !== "active" ||
              current.primaryWorkspaceRoot !== project.primaryWorkspaceRoot
            )
              return yield* fail(
                "model-catalog.scope",
                new Error("The Project changed while loading models"),
              );
          }
          return catalog;
        }),
      ),
    claudeDiscovery: (input) =>
      ownFailure(
        "claude.discover",
        Effect.gen(function* () {
          const scope = input.scope;
          if (scope.kind === "thread") {
            const authority = yield* readThreadMetadata(scope.threadId);
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
            const current = yield* readThreadMetadata(scope.threadId);
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
    readAgentHistory: (input) => ownFailure("history.read", history.read(input)),
    readAgentHistoryImage: (input) => ownFailure("history.image", history.image(input)),
    readAgentToolOutput: (input) => ownFailure("history.tool-output", history.toolOutput(input)),
    inspectAgentSession: (threadId) => ownFailure("history.inspect", history.inspect(threadId)),
  });
});
export const live = Layer.effect(AgentBackendApplication, make);

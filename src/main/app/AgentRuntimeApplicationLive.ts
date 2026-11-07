import { modelPolicyCatalog } from "../agent-runtime/model-policy-catalog";
import { isProviderOn } from "../../shared/model-policy";
import { NodexAccount } from "../nodex-account/NodexAccount";
import {
  managedNodexProviders,
  projectManagedNodexCatalog,
} from "../nodex-account/managed-providers";
import { acpProviderStorageScopes } from "../platform/node/AcpProfilePaths";
import { CodexVisualizationState } from "../codex-application/CodexVisualizationState";
import { CodexConversations } from "../codex-application/CodexConversations";
import { projectCodexConversationThreadSettings } from "../codex-application/CodexConversationSnapshotProjection";
import { codexVisualizationPassiveParts } from "../../shared/codex-visualization-passive-context";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import * as NodeServices from "../platform/node/NodeServices";
import type {
  AgentRuntimeConfiguration,
  AgentRuntimeOperations,
  AgentRuntimeIdentity,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { codexCliAppServerArgs } from "../../shared/codex-app-server-launch";
import type { ClaudeAgentInstanceConfig } from "../../shared/types";
import { acpProviderConfiguration } from "../agent-runtime/AcpProviderConfiguration";
import {
  NativePromptImages,
  layer as promptImagesLayer,
} from "../agent-backend/NativePromptImages";
import { live as imageFittingLayer } from "../platform/electron/ElectronImageFitting";
import {
  NativeSessionWorkspace,
  layer as sessionWorkspaceLayer,
} from "../agent-backend/NativeSessionWorkspace";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
  make as makeApplication,
  type AgentRuntimeApplicationConnection,
} from "../agent-runtime/AgentRuntimeApplication";
import { AgentChatWorktrees } from "../codex-application/AgentChatWorktrees";
import { make as makeHost } from "../agent-runtime/AgentRuntimeHost";
import { make as makeDesktopTools } from "../agent-runtime/AgentRuntimeDesktopTools";
import { make as makeProviderCatalog } from "../agent-runtime/AgentRuntimeProviderCatalog";
import {
  AgentRuntimeClaudeUsage,
  make as makeClaudeUsage,
} from "../agent-runtime/AgentRuntimeClaudeUsage";
import {
  make as makeHostTools,
  runtimeHostToolCatalog,
  type AgentRuntimeHostToolExecutor,
} from "../agent-runtime/AgentRuntimeHostTools";
import {
  AgentRuntimeSupervisor,
  make as makeSupervisor,
} from "../agent-runtime/AgentRuntimeSupervisor";
import * as SessionActivity from "../agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import {
  AgentRuntimeProviderConfiguration,
  AgentRuntimeProviderConfigurationError,
  confirmModelRetirement,
  makeProviderSettingsRefresh,
} from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { CoreModules } from "../core-runtime/CoreModules";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { subscribe as subscribeExecutionChanges } from "../agent-runtime/AgentRuntimeExecutionChanges";
import {
  insightsUsageSources,
  nativeImportSources,
} from "../agent-runtime/AgentRuntimeNativeImportSources";
import { WorktreeShellEnvironmentRuntime } from "../host-runtime/WorktreeShellEnvironmentRuntime";
import {
  agentRuntimeEntrypoint,
  agentRuntimeNodeExecutable,
} from "../platform/node/AgentRuntimeEntrypoint";
import { acquireAgentRuntimeProcess } from "../platform/node/AgentRuntimeProcess";
import { codexAccountHistoryEnvironment } from "../platform/node/CodexAccountHome";
import { canonicalNativeSessionHome } from "../platform/node/NativeSessionCatalogPaths";
import { shellQuote } from "../platform/node/NodexCliShell";
import { openCodeExecutableEnvironment } from "../platform/node/OpenCodeExecutable";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexRendererPresentationRegistry } from "../codex-application/CodexRendererPresentationRegistry";
import { createOperationId } from "../core-runtime/operation-identity";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { run as runSessionNotifications } from "../agent-runtime/AgentRuntimeSessionNotifications";
import { make as makeUserInputAutoResolution } from "../agent-runtime/AgentRuntimeUserInputAutoResolution";
import { run as runSessionPredictions } from "../agent-runtime/AgentRuntimeSessionPredictions";
import { readCodexComposerPredictionEnvironment } from "../codex-application/CodexComposerPrediction";
import { resolveComposerPredictionConfiguration } from "../codex-application/CodexComposerPredictionDefaults";
import { make as makeQuiescence, reportsNoWork } from "../agent-runtime/AgentRuntimeQuiescence";
import { CodexLocalLaunch, CodexPlatform } from "./CodexApplicationLive";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { MainApplicationError } from "./MainApplication";
import { MainConfig } from "./MainConfig";
import {
  AGENT_RUNTIME_STARTUP_PROBE_ENV,
  AGENT_RUNTIME_STARTUP_EVIDENCE_FILE,
  type AgentRuntimeStartupEvidence,
} from "../../shared/agent-runtime-startup-evidence";

/** A quiet execution process with no live or pending work stops after this period. */
const AGENT_RUNTIME_IDLE_AFTER = "3 minutes";

/** Custom capabilities use the execution catalog's option IDs. */
export function runtimeClaudeModels(instance: ClaudeAgentInstanceConfig) {
  return instance.customModels.map(({ id, displayName, traits }) => ({
    slug: id,
    name: displayName,
    capabilities: {
      optionDescriptors: [
        ...(traits.effortLevels?.length
          ? [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: traits.effortLevels.map((effort) => ({ id: effort, label: effort })),
              },
            ]
          : []),
        ...(traits.fastMode ? [{ id: "fastMode", label: "Fast", type: "boolean" as const }] : []),
        ...(traits.adaptiveThinking || traits.disableThinking
          ? [{ id: "thinking", label: "Thinking", type: "boolean" as const }]
          : []),
        ...(traits.contextWindows?.length
          ? [
              {
                id: "contextWindow",
                label: "Context",
                type: "select" as const,
                options: traits.contextWindows.map((window) => ({ id: window, label: window })),
              },
            ]
          : []),
      ],
    },
  }));
}

class HostActivation extends Context.Service<
  HostActivation,
  {
    readonly activate: (execute: AgentRuntimeHostToolExecutor) => Effect.Effect<void>;
    readonly resume: Effect.Effect<void, unknown>;
  }
>()("nodex/main/app/AgentRuntimeHostActivation") {}

const supervisor = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const platform = yield* CodexPlatform;
    const codexLaunch = yield* CodexLocalLaunch;
    const settings = yield* ApplicationSettings;
    const nodexAccount = yield* NodexAccount;
    const shell = yield* WorktreeShellEnvironmentRuntime;
    const core = yield* CoreAuthority;
    const images = yield* NativePromptImages;
    const workspace = yield* NativeSessionWorkspace;
    const presentation = yield* CodexTurnPresentation;
    const visualizationState = yield* CodexVisualizationState;
    const conversations = yield* CodexConversations;
    const desktop = makeDesktopTools({
      tools: yield* DesktopToolRuntime,
      browserUse: yield* BrowserUseRuntime,
      windows: yield* WindowRuntime,
      presentation,
    });
    const fs = yield* FileSystem.FileSystem;
    const database = yield* DatabaseNotifierRuntime;
    const ready = yield* Deferred.make<AgentRuntimeSupervisor["Service"]>();
    const toolsReady = yield* Deferred.make<AgentRuntimeHostToolExecutor>();
    const executionChanges = Deferred.await(ready).pipe(
      Effect.flatMap((runtime) => subscribeExecutionChanges(runtime.get())),
      Effect.map((events) =>
        events.pipe(
          Stream.merge(database.projectSessionInvalidations.pipe(Stream.map(() => undefined))),
        ),
      ),
    );
    const keptProviderCatalog = yield* makeProviderCatalog({
      home: join(config.nodexHome, "agent-runtime"),
      // Everything the engine reads to declare providers, except secrets and probe results.
      identity: Effect.gen(function* () {
        const engine = yield* fs.stat(agentRuntimeEntrypoint(config));
        const snapshot = yield* settings.snapshot();
        const declaration = {
          engine: [String(engine.size), Option.getOrNull(engine.mtime)?.getTime() ?? null],
          codex: [
            platform.runtime.binaryPath,
            platform.accountHome.effectiveHome,
            codexCliAppServerArgs(config.environment),
            codexLaunch.configOverrides,
          ],
          providers: [snapshot.claudeAgents, snapshot.openCodeAgents, snapshot.acpAgents],
          modelPolicy: snapshot.modelPolicy,
          nodex: (yield* nodexAccount.managed)?.identity ?? null,
        };
        return createHash("sha256").update(JSON.stringify(declaration)).digest("hex");
      }),
      running: Deferred.await(ready).pipe(
        Effect.flatMap((runtime) => runtime.inspect),
        Effect.map((identity) => identity !== null),
      ),
    });
    const providerCatalog = {
      ...keptProviderCatalog,
      project: (providers: AgentRuntimeOperations["providers.read"]["output"]) =>
        Effect.gen(function* () {
          const managed = yield* nodexAccount.managed;
          const { modelPolicy } = yield* settings.snapshot().pipe(Effect.orDie);
          return modelPolicyCatalog(
            projectManagedNodexCatalog(providers, managed),
            modelPolicy,
            managed?.identity ?? null,
          );
        }),
    };
    // Projectless work and Agent execution's own working directory share one Profile directory;
    // the app path is never a working directory (packaged, it is a file inside the archive).
    const projectlessWorkspaceRoot = join(config.nodexHome, "tasks");
    const ensureProjectlessWorkspaceRoot = fs.makeDirectory(projectlessWorkspaceRoot, {
      recursive: true,
    });
    // Keyed by generation identity: callers hold the supervisor's usage-tracking view of a process.
    const prepared = new WeakMap<AgentRuntimeIdentity, AgentRuntimeConfiguration>();
    const preparedEnvironment = new WeakMap<
      AgentRuntimeIdentity,
      Readonly<Record<string, string | undefined>>
    >();
    const physicalNativeImportSources = (connection: AgentRuntimeApplicationConnection) =>
      Effect.try(() => {
        const configuration = prepared.get(connection.identity);
        const environment = preparedEnvironment.get(connection.identity);
        if (!configuration || !environment)
          throw new Error("Physical provider configuration is unavailable");
        return nativeImportSources({
          configuration,
          environment,
          homeDirectory: config.homeDirectory,
          codexHome: platform.accountHome.sharedHome,
        });
      });
    const product = yield* makeApplication({
      connect: Deferred.await(ready).pipe(Effect.flatMap((runtime) => runtime.get())),
      currentConnection: Deferred.await(ready).pipe(
        Effect.flatMap((runtime) => runtime.currentConnection),
      ),
      insightsUsageSources: (connection) =>
        Effect.try(() => {
          const configuration = prepared.get(connection.identity);
          const environment = preparedEnvironment.get(connection.identity);
          if (!configuration || !environment)
            throw new Error("Physical provider configuration is unavailable");
          return insightsUsageSources({
            configuration,
            environment,
            homeDirectory: config.homeDirectory,
            codexHome: platform.accountHome.sharedHome,
          });
        }),
      nativeImportSourceHome: (connection, input) =>
        Effect.gen(function* () {
          const histories = yield* physicalNativeImportSources(connection);
          const providerId =
            input.backendKind === "codex"
              ? agentRuntimeProviderId({ kind: "codex" })
              : input.instanceConfigId
                ? agentRuntimeProviderId({
                    kind: "claude",
                    instanceConfigId: input.instanceConfigId,
                  })
                : null;
          const source = histories.find((history) => history.providerInstanceId === providerId);
          const expectedDriver = input.backendKind === "codex" ? "codex" : "claudeAgent";
          const sourceHome = source?.driver === expectedDriver ? source.homePath : null;
          if (!sourceHome)
            return yield* new AgentRuntimeApplicationError({
              operation: "import",
              message: "Native history configuration is unavailable",
              admissionRejected: true,
            });
          // Active account homes are fixed for this physical generation, so
          // provider refresh cannot replace this source after import admission.
          return yield* Effect.tryPromise(() => canonicalNativeSessionHome(sourceHome));
        }),
      nativeCodexSettings: (threadId) => {
        const view = conversations.read(threadId);
        const current = view?.canonicalState;
        const settings =
          (current ? projectCodexConversationThreadSettings(current) : null) ??
          view?.snapshot?.latestThreadSettings;
        if (!settings) return null;
        return {
          ...settings,
          collaborationMode:
            current?.latestCollaborationMode ??
            view?.snapshot?.latestCollaborationMode ??
            settings.collaborationMode,
        };
      },
      providerCatalog,
      whileRunning: (effect) =>
        Deferred.await(ready).pipe(
          Effect.flatMap((runtime) =>
            runtime.retained(
              Effect.gen(function* () {
                if ((yield* runtime.connectionState).status !== "ready") return null;
                return yield* effect;
              }),
            ),
          ),
        ),
      projectless: {
        engineProjectId: `nodex:projectless:${core.identity.profileId}`,
        workspaceRoot: projectlessWorkspaceRoot,
        ensureWorkspaceRoot: ensureProjectlessWorkspaceRoot,
      },
      prepareImages: images.prepare,
      interactiveState: {
        unsent: (threadId) =>
          visualizationState
            .readUnsentPassiveContext({ hostId: "local", threadId })
            .pipe(
              Effect.map((context) =>
                context
                  ? { key: context.key, parts: codexVisualizationPassiveParts(context) }
                  : undefined,
              ),
            ),
        // A lost mark only means the same state is offered once more.
        sent: (threadId, key) =>
          visualizationState
            .markPassiveContextSent({ hostId: "local", threadId }, key)
            .pipe(Effect.ignore),
      },
      prepareWorkspace: workspace.prepare,
      presentation,
      releaseDesktopSession: desktop.releaseSession,
      reconcileWorkspace: workspace.reconcile,
      // Product writers span Core admission through execution acknowledgement; hold the process.
      writing: (operation) =>
        Deferred.await(ready).pipe(Effect.flatMap((runtime) => runtime.writing(operation))),
      runtimeExists: fs.exists(join(config.nodexHome, "agent-runtime", "agent-runtime.sqlite")),
      subscribeExecutionChanges: executionChanges,
    });
    const execute: AgentRuntimeHostToolExecutor = (caller, name, input) =>
      Deferred.await(toolsReady).pipe(Effect.flatMap((tools) => tools(caller, name, input)));
    const projectlessId = `nodex:projectless:${core.identity.profileId}`;
    const activity = yield* SessionActivity.make({
      resolveSessions: yield* SessionActivity.coreSessionResolver,
    });
    const userInputAutoResolution = yield* makeUserInputAutoResolution({
      transitions: activity.transitions,
    });
    const presented = yield* CodexRendererPresentationRegistry;
    const applicationEvents = yield* CodexApplicationEventHub;
    const projects = yield* ProjectWorkspace;
    const modules = yield* CoreModules;
    const readSessionBinding = (sessionId: string) =>
      modules.workspace.read({ kind: "agent_runtime_session_binding", session_id: sessionId }).pipe(
        Effect.provideService(CoreApplicationAgent, null),
        Effect.map((snapshot) =>
          snapshot.value.kind === "agent_runtime_session_binding" ? snapshot.value.binding : null,
        ),
      );
    yield* runSessionNotifications({
      transitions: activity.transitions,
      isPresentedInForeground: presented.isPresentedInForeground,
      readSession: Effect.fn("AgentRuntimeSessionNotifications.readSession")(function* (
        sessionId: string,
      ) {
        const session = yield* projects.getProjectSession(sessionId);
        if (!session) return null;
        const binding = yield* readSessionBinding(sessionId);
        const sourceSessionId = binding?.side_chat_source_session_id;
        const source = sourceSessionId ? yield* projects.getProjectSession(sourceSessionId) : null;
        const sideChatSource = sourceSessionId
          ? {
              sessionId: sourceSessionId,
              // An archived Session cannot be opened, so its side chats have nowhere to return.
              rootThreadId: (source && !source.archived && source.executionRef?.threadId) || null,
            }
          : null;
        return {
          title: session.displayTitle,
          archived: session.archived,
          unread: session.unread,
          sideChatSource,
        };
      }),
      markUnread: (sessionId) =>
        projects.markProjectSessionUnread({
          operationId: createOperationId("agent-runtime.session.unread"),
          payload: { sessionId, unread: true },
        }),
      turnMayShow: settings.snapshot().pipe(
        Effect.map(
          ({ notifications }) =>
            notifications.turnMode === "always" ||
            (notifications.turnMode === "unfocused" && !presented.hasForegroundClient()),
        ),
        Effect.orElseSucceed(() => true),
      ),
      publish: (event) => {
        applicationEvents.publish({ kind: "threadNotification", value: event });
        // Session notifications finish their unread write before publishing read activity.
        if (event.type === "turn-completed" || event.type === "user-input-requested")
          applicationEvents.publish({
            kind: "hostMessage",
            value: {
              type: "threadReadActivity",
              hostId: event.hostId,
              conversationId: event.conversation.conversationId,
              activity:
                event.type === "turn-completed"
                  ? { type: "turn-completed", turnId: event.turnId }
                  : { type: "request" },
            },
          });
      },
    }).pipe(Effect.forkScoped);
    const predictionHosts = yield* readCodexComposerPredictionEnvironment(config.environment);
    yield* runSessionPredictions({
      transitions: activity.transitions,
      configuration: settings.snapshot().pipe(
        Effect.map(({ composerPredictions }) =>
          resolveComposerPredictionConfiguration(
            predictionHosts,
            composerPredictions.enabled,
            "local",
          ),
        ),
        Effect.orElseSucceed(() => null),
      ),
      configurationChanges: settings.composerPredictionSettingsChanges,
    }).pipe(Effect.forkScoped);
    const drivers = new Map<string, string>();
    const readConfiguration = Effect.gen(function* () {
      const executable = yield* Effect.try({
        try: () =>
          agentRuntimeNodeExecutable({
            isPackaged: config.isPackaged,
            environment: config.environment,
            nodeRuntime: platform.runtime.nodeRuntime,
          }),
        catch: (cause) => cause,
      });
      const snapshot = yield* settings.snapshot();
      const loginEnvironment = yield* shell.load;
      const environment = {
        ...config.environment,
        ...loginEnvironment,
        PATH: [
          ...platform.runtime.additionalSearchPaths.map((directory) => resolve(directory)),
          loginEnvironment.PATH ?? config.environmentPath ?? "",
        ]
          .filter(Boolean)
          .join(config.platform === "win32" ? ";" : ":"),
      };
      const providers: Record<string, AgentRuntimeConfiguration["providers"][string]> = {
        codex: {
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          // The app's own local Codex launch, so both read one account and one history.
          environment: Object.entries(
            codexAccountHistoryEnvironment(platform.accountHome, environment),
          ).map(([name, value]) => ({ name, value, sensitive: false })),
          config: {
            setupMode: "existing",
            binaryPath: resolve(platform.runtime.binaryPath),
            homePath: platform.accountHome.effectiveHome,
            launchArgs: [
              ...codexCliAppServerArgs(config.environment).filter((arg) => arg !== "app-server"),
              ...codexLaunch.configOverrides,
            ]
              .map(shellQuote)
              .join(" "),
          },
        },
      };
      for (const configured of snapshot.claudeAgents.instances) {
        const id = agentRuntimeProviderId({ kind: "claude", instanceConfigId: configured.id });
        if (!id) continue;
        const launch = configured.enabled
          ? yield* settings.claudeLaunchConfiguration(configured.id)
          : null;
        const historyDirectory = configured.environment.find(
          (entry) => entry.name === "CLAUDE_CONFIG_DIR" && !entry.sensitive,
        );
        providers[id] = {
          driver: "claudeAgent",
          displayName: configured.displayName,
          enabled: configured.enabled,
          environment: Object.entries(launch?.environment ?? {}).map(([name, value]) => ({
            name,
            value,
            sensitive: configured.environment.some(
              (entry) => entry.name === name && entry.sensitive,
            ),
          })),
          config: {
            binaryPath: configured.binaryPath,
            homePath:
              configured.configDirectory ||
              (historyDirectory && !historyDirectory.sensitive ? historyDirectory.value : ""),
            customModels: runtimeClaudeModels(configured),
            modelTraits: Object.fromEntries(
              configured.customModels.map(({ id, traits }) => [id, traits]),
            ),
          },
        };
      }
      for (const configured of snapshot.openCodeAgents.instances) {
        const id = agentRuntimeProviderId({ kind: "opencode", instanceConfigId: configured.id });
        if (!id) continue;
        const launch = configured.enabled
          ? yield* settings.openCodeLaunchConfiguration(configured.id)
          : null;
        const profile = launch?.profileDirectory;
        const variables = {
          ...openCodeExecutableEnvironment({
            binaryPath: configured.binaryPath,
            inheritedEnvironment: environment,
            environment: launch?.environment ?? {},
            homeDirectory: config.homeDirectory,
            platform: config.platform,
          }),
          ...(profile
            ? {
                XDG_DATA_HOME: join(profile, "data"),
                XDG_CONFIG_HOME: join(profile, "config"),
                XDG_CACHE_HOME: join(profile, "cache"),
                XDG_STATE_HOME: join(profile, "state"),
                OPENCODE_CONFIG_DIR: join(profile, "config", "opencode"),
                OPENCODE_TEST_HOME: profile,
              }
            : {}),
        };
        providers[id] = {
          driver: "opencode",
          displayName: configured.displayName,
          enabled: configured.enabled,
          environment: Object.entries(variables).map(([name, value]) => ({
            name,
            value,
            sensitive: configured.environment.some(
              (entry) => entry.name === name && entry.sensitive,
            ),
          })),
          config: {
            binaryPath: configured.binaryPath,
            serverUrl: configured.serverUrl ?? "",
            serverPassword: launch?.environment.OPENCODE_SERVER_PASSWORD ?? "",
          },
        };
      }
      for (const configured of snapshot.acpAgents.instances) {
        const id = agentRuntimeProviderId({
          kind: "acp",
          agentDefinitionId: configured.agentDefinitionId,
          instanceConfigId: configured.id,
        });
        if (!id) continue;
        const launch = configured.enabled
          ? yield* settings.acpLaunchConfiguration(configured.id)
          : null;
        const provider = acpProviderConfiguration({
          instance: configured,
          inheritedEnvironment: environment,
          environment: launch?.environment ?? {},
          homeDirectory: config.homeDirectory,
        });
        const storageScopes = yield* Effect.tryPromise(() =>
          acpProviderStorageScopes({
            environment: provider.environment ?? [],
            homeDirectory: config.homeDirectory,
            platform: config.platform,
          }),
        );
        providers[id] = { ...provider, config: { ...provider.config, ...storageScopes } };
      }
      const managed = managedNodexProviders({
        home: config.nodexHome,
        codexBinary: resolve(platform.runtime.binaryPath),
        environment,
        managed: isProviderOn(snapshot.modelPolicy, {
          instanceId: "nodex",
          driver: "codex",
          source: "nodex",
        })
          ? yield* nodexAccount.managed
          : null,
      });
      Object.assign(providers, managed);
      for (const provider of Object.values(managed)) {
        const home = (provider.config as { homePath: string }).homePath;
        yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      }
      const configuration: AgentRuntimeConfiguration = {
        home: join(config.nodexHome, "agent-runtime"),
        cwd: projectlessWorkspaceRoot,
        providers,
        modelPolicy: snapshot.modelPolicy,
        host: { tools: runtimeHostToolCatalog },
      };
      for (const [id, provider] of Object.entries(providers)) drivers.set(id, provider.driver);
      return { configuration, environment, executable };
    });
    const quiescence = yield* makeQuiescence(join(config.nodexHome, "agent-runtime"));
    const runtime = yield* makeSupervisor<
      Exclude<
        | Effect.Services<ReturnType<typeof makeHost>>
        | Effect.Services<ReturnType<typeof acquireAgentRuntimeProcess>>,
        Scope.Scope
      >
    >({
      acquire: (host) =>
        Effect.gen(function* () {
          const { configuration, environment, executable } = yield* readConfiguration;
          yield* ensureProjectlessWorkspaceRoot;
          const entryPath = agentRuntimeEntrypoint(config);
          // A development build can lack the bundle; say so instead of a bare process exit.
          if (!(yield* fs.exists(entryPath)))
            return yield* Effect.fail(
              new Error(
                `Agent execution is not built: ${entryPath} is missing (vp run build:agent-runtime)`,
              ),
            );
          const connection = yield* acquireAgentRuntimeProcess({
            executable,
            entryPath,
            configuration,
            environment,
            host,
          });
          prepared.set(connection.identity, configuration);
          preparedEnvironment.set(connection.identity, environment);
          return connection;
        }),
      activate: (connection) => {
        const configuration = prepared.get(connection.identity);
        if (!configuration) return Effect.fail(new Error("Execution configuration is unavailable"));
        return makeHost(connection, {
          desktop,
          workspaceEnvironment: workspace.environment,
          presentation,
          projectlessId,
          providers: configuration.providers,
          providerDriver: (id) => drivers.get(id),
          execute,
        }).pipe(
          Effect.tap(() =>
            userInputAutoResolution
              .attach(connection)
              .pipe(
                Effect.catchCause(() =>
                  Effect.logWarning(
                    "Question deadlines are unavailable for this execution process",
                  ),
                ),
              ),
          ),
          Effect.tap(() =>
            activity
              .attach(connection)
              .pipe(
                Effect.catchCause(() =>
                  Effect.logWarning("Session activity is unavailable for this execution process"),
                ),
              ),
          ),
          Effect.tap(() => product.discardOrphanSideChats(connection.identity.runtimeId)),
          Effect.tap(() => product.reconcileSessionActivity(connection).pipe(Effect.forkScoped)),
          Effect.tap(() =>
            Deferred.await(toolsReady).pipe(
              Effect.andThen(
                // Its own failure must not block cleanup or live reconciliation below.
                product
                  .reconcileStore(
                    connection,
                    `${core.identity.profileId}:${core.identity.storeEpoch}`,
                  )
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning(
                        "Session reconciliation will retry after the next connection",
                      ).pipe(
                        Effect.annotateLogs({ cause, runtimeId: connection.identity.runtimeId }),
                      ),
                    ),
                  ),
              ),
              Effect.andThen(product.cleanupDeletedSessions),
              Effect.andThen(product.reconcileLiveExecutions()),
              Effect.catchCause((cause) =>
                Effect.logWarning(
                  "Agent execution reconciliation will retry after the next connection",
                ).pipe(Effect.annotateLogs({ cause, runtimeId: connection.identity.runtimeId })),
              ),
              Effect.forkScoped,
            ),
          ),
        );
      },
      idle: { after: AGENT_RUNTIME_IDLE_AFTER, quiescent: reportsNoWork },
      quiescence,
    });
    const refresh = (yield* makeProviderSettingsRefresh({
      states: runtime.connectionChanges,
      current: runtime.currentConnection,
      apply: (connection) =>
        Effect.gen(function* () {
          const { configuration } = yield* readConfiguration;
          const result = yield* connection.request("providers.configure", {
            providers: configuration.providers,
            modelPolicy: configuration.modelPolicy,
          });
          prepared.set(connection.identity, configuration);
          return result;
        }),
    })).pipe(
      Effect.mapError((cause) => new AgentRuntimeProviderConfigurationError({ cause })),
      Effect.map((result) => result ?? { applied: true, deferredInstanceIds: [] }),
    );
    yield* settings.modelPolicyChanges.pipe(
      Stream.drop(1),
      Stream.runForEach(() =>
        confirmModelRetirement({ refresh, stop: runtime.withStopped(Effect.void) }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Deferred.succeed(ready, runtime);
    yield* nodexAccount.onModelsChanged(
      confirmModelRetirement({
        refresh,
        stop: runtime
          .withStopped(
            Effect.logWarning(
              "Agent execution stopped because Nodex model retirement could not be confirmed",
            ),
          )
          .pipe(Effect.orDie),
      }),
    );
    const claudeUsage = yield* makeClaudeUsage({
      meterEnabled: (yield* settings.snapshot()).usageMeters.claude,
      meterEnabledChanges: settings.usageMeterSettingsChanges.pipe(
        Stream.map((value) => value.claude),
      ),
      declared: settings.snapshot().pipe(
        Effect.map((snapshot) =>
          snapshot.claudeAgents.instances.flatMap((configured) => {
            const id = configured.enabled
              ? agentRuntimeProviderId({ kind: "claude", instanceConfigId: configured.id })
              : null;
            return id ? [id] : [];
          }),
        ),
      ),
      known: product.knownCatalog(),
      refresh: (instanceIds) => product.catalog({ instanceIds, refresh: true }),
      refreshWhileRunning: (instanceIds) =>
        product.catalogWhileRunning({ instanceIds, refresh: true }),
      logout: product.logoutProviders,
      served: providerCatalog.served,
      connectionChanges: runtime.connectionChanges,
      activityChanges: activity.activityChanges,
    });
    // Managed worktree listing and retention learn about Agent chats from here on.
    yield* (yield* AgentChatWorktrees).register(product.worktreeChats);
    return Context.make(AgentRuntimeSupervisor, runtime).pipe(
      Context.add(AgentRuntimeSessionActivity, {
        read: activity.read,
        activityChanges: activity.activityChanges,
        connection: runtime.connectionState,
        connectionChanges: runtime.connectionChanges,
      }),
      // Changed Agent settings change which Claude accounts there are.
      Context.add(AgentRuntimeProviderConfiguration, {
        refresh: refresh.pipe(Effect.ensuring(claudeUsage.reread)),
      }),
      Context.add(AgentRuntimeClaudeUsage, claudeUsage),
      Context.add(AgentRuntimeApplication, product),
      Context.add(HostActivation, {
        activate: (tools) => Deferred.succeed(toolsReady, tools).pipe(Effect.asVoid),
        resume: runtime.getUnlessQuiet.pipe(Effect.asVoid),
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MainApplicationError({ phase: "startup", operation: "agent-runtime-host", cause }),
    ),
  ),
).pipe(Layer.provide(NodeServices.layer));

/** Execution lifecycle depends only on Core and native filesystem capabilities. */
export const runtime = supervisor.pipe(
  Layer.provideMerge(
    Layer.mergeAll(promptImagesLayer.pipe(Layer.provide(imageFittingLayer)), sessionWorkspaceLayer),
  ),
);

/** Product tool semantics activate after Session, Workbench and automation Modules exist. */
export const hostTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const activation = yield* HostActivation;
    const execute = yield* makeHostTools;
    yield* activation.activate(execute);
    const config = yield* MainConfig;
    const runId = config.isolatedRunId;
    if (config.environment[AGENT_RUNTIME_STARTUP_PROBE_ENV] === "1" && runId) {
      // Only an explicitly supervised disposable launch forces the otherwise lazy runtime.
      const runtime = yield* AgentRuntimeSupervisor;
      const connection = yield* runtime.get();
      const platform = yield* CodexPlatform;
      const node = platform.runtime.nodeRuntime;
      if (node.status !== "available") return yield* Effect.fail(new Error(node.message));
      const fs = yield* FileSystem.FileSystem;
      const directory = join(config.nodexHome, "run");
      const file = join(directory, AGENT_RUNTIME_STARTUP_EVIDENCE_FILE);
      const evidence: AgentRuntimeStartupEvidence = {
        schemaVersion: 1,
        runId,
        hostPid: process.pid,
        runtimeId: connection.identity.runtimeId,
        runtimeGeneration: connection.identity.runtimeGeneration,
        nodeSource: node.source,
        nodeVersion: node.version,
      };
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(`${file}.tmp`, JSON.stringify(evidence), { mode: 0o600 });
      yield* fs.rename(`${file}.tmp`, file);
      return;
    }
    yield* activation.resume.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Agent execution will resume on the next operation"),
      ),
      Effect.forkScoped,
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MainApplicationError({
          phase: "startup",
          operation: "agent-runtime-startup-probe",
          cause,
        }),
    ),
  ),
);

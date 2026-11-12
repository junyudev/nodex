import { CodexPluginDelivery } from "./agent-plugins/CodexPluginDelivery";
import { SessionFolders } from "../main/agent-backend/SessionFolders";
import { makeSessionReader } from "./RuntimeNotificationSessions";
import { ReadbackRuntime } from "./ReadbackRuntime";
import { heldThreadIds } from "./work-application/execution-holds";
import { modelPolicyCatalog } from "../main/agent-runtime/model-policy-catalog";
import { isProviderOn } from "../shared/model-policy";
import { NodexAccount } from "../main/nodex-account/NodexAccount";
import { ProductAnalytics } from "../main/product-analytics/ProductAnalytics";
import {
  managedNodexProviders,
  projectManagedNodexCatalog,
} from "../main/nodex-account/managed-providers";
import { acpProviderStorageScopes } from "../main/platform/node/AcpProfilePaths";
import { CodexVisualizationState } from "../main/codex-application/CodexVisualizationState";
import { CodexConversations } from "../main/codex-application/CodexConversations";
import { projectCodexConversationThreadSettings } from "../main/codex-application/CodexConversationSnapshotProjection";
import { codexVisualizationPassiveParts } from "../shared/codex-visualization-passive-context";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import * as NodeServices from "../main/platform/node/NodeServices";
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
import * as Schedule from "effect/Schedule";
import { make as makePageWorkspaces } from "../main/agent-backend/PageWorkspaceApplication";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { agentRuntimeProviderId } from "../shared/agent-runtime-provider";
import { codexCliAppServerArgs } from "../shared/codex-app-server-launch";
import type { ClaudeAgentInstanceConfig } from "../shared/types";
import { acpProviderConfiguration } from "../main/agent-runtime/AcpProviderConfiguration";
import {
  NativePromptImages,
  layer as promptImagesLayer,
} from "../main/agent-backend/NativePromptImages";
import {
  NativeSessionWorkspace,
  layer as sessionWorkspaceLayer,
} from "../main/agent-backend/NativeSessionWorkspace";
import {
  AgentRuntimeApplication,
  AgentRuntimeApplicationError,
  make as makeApplication,
  type AgentRuntimeApplicationConnection,
} from "../main/agent-runtime/AgentRuntimeApplication";
import { AgentChatWorktrees } from "../main/codex-application/AgentChatWorktrees";
import { PluginInstallation } from "./agent-plugins/PluginInstallation";
import { live as pluginInstallation } from "./agent-plugins/PluginInstallationLive";
import { PluginMcpBroker } from "./agent-plugins/broker";
import { make as makeHost } from "../main/agent-runtime/AgentRuntimeHost";
import { HostDesktopTools } from "./HostDesktopTools";
import {
  HostAgentPolicy,
  isAgentProviderVariable,
  scrubHostAgentEnvironment,
} from "./HostAgentPolicy";
import { make as makeProviderCatalog } from "../main/agent-runtime/AgentRuntimeProviderCatalog";
import {
  AgentRuntimeClaudeUsage,
  make as makeClaudeUsage,
} from "../main/agent-runtime/AgentRuntimeClaudeUsage";
import {
  HostToolExecutor,
  HostAppToolCatalog,
  type AgentRuntimeHostToolExecutor,
} from "./HostToolExecutor";
import {
  AgentRuntimeSupervisor,
  make as makeSupervisor,
} from "../main/agent-runtime/AgentRuntimeSupervisor";
import * as SessionActivity from "../main/agent-runtime/AgentRuntimeSessionActivity";
import { AgentRuntimeSessionActivity } from "../main/agent-runtime/AgentRuntimeSessionActivity";
import {
  AgentRuntimeProviderConfiguration,
  AgentRuntimeProviderConfigurationError,
  confirmModelRetirement,
  makeProviderSettingsRefresh,
} from "../main/agent-runtime/AgentRuntimeProviderConfiguration";
import { CoreAuthority } from "../main/core-runtime/CoreAuthority";
import { readAutomationTurnPolicy } from "./automation-application/AutomationTurnPolicy";
import { quietAutomationTurnReason } from "../shared/codex-thread-notification";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../main/host-runtime/DatabaseNotifierRuntime";
import { subscribe as subscribeExecutionChanges } from "../main/agent-runtime/AgentRuntimeExecutionChanges";
import {
  insightsUsageSources,
  nativeImportSources,
} from "../main/agent-runtime/AgentRuntimeNativeImportSources";
import { WorktreeShellEnvironmentRuntime } from "../main/host-runtime/WorktreeShellEnvironmentRuntime";
import {
  agentRuntimeEntrypoint,
  agentRuntimeNodeExecutable,
} from "../main/platform/node/AgentRuntimeEntrypoint";
import { acquireAgentRuntimeProcess } from "../main/platform/node/AgentRuntimeProcess";
import { codexAccountHistoryEnvironment } from "../main/platform/node/CodexAccountHome";
import { canonicalNativeSessionHome } from "../main/platform/node/NativeSessionCatalogPaths";
import { shellQuote } from "../main/platform/node/NodexCliShell";
import { openCodeExecutableEnvironment } from "../main/platform/node/OpenCodeExecutable";
import { ApplicationSettings } from "../main/settings/ApplicationSettings";
import { CodexApplicationEventHub } from "../main/codex-application/CodexApplicationEventHub";
import { UserPresence } from "./UserPresence";
import { createOperationId } from "../main/core-runtime/operation-identity";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import { run as runSessionNotifications } from "../main/agent-runtime/AgentRuntimeSessionNotifications";
import { make as makeUserInputAutoResolution } from "../main/agent-runtime/AgentRuntimeUserInputAutoResolution";
import { run as runSessionPredictions } from "../main/agent-runtime/AgentRuntimeSessionPredictions";
import { readCodexComposerPredictionEnvironment } from "../main/codex-application/CodexComposerPrediction";
import { resolveComposerPredictionConfiguration } from "../main/codex-application/CodexComposerPredictionDefaults";
import {
  make as makeQuiescence,
  reportsNoWork,
} from "../main/agent-runtime/AgentRuntimeQuiescence";
import { CodexLocalLaunch, CodexPlatform } from "./ProviderPlatform";
import { CodexTurnPresentation } from "./TurnPresentation";
import { MainApplicationError } from "../main/app/MainApplication";
import { MainConfig } from "../main/app/MainConfig";
import {
  AGENT_RUNTIME_STARTUP_PROBE_ENV,
  AGENT_RUNTIME_STARTUP_EVIDENCE_FILE,
  type AgentRuntimeStartupEvidence,
} from "../shared/agent-runtime-startup-evidence";

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
    const codexPlugins = yield* CodexPluginDelivery;
    const platform = yield* CodexPlatform;
    const codexLaunch = yield* CodexLocalLaunch;
    const settings = yield* ApplicationSettings;
    const nodexAccount = Option.getOrUndefined(yield* Effect.serviceOption(NodexAccount));
    const managedAccount = nodexAccount?.managed ?? Effect.succeed(null);
    const shell = yield* WorktreeShellEnvironmentRuntime;
    const core = yield* CoreAuthority;
    const images = yield* NativePromptImages;
    const workspace = yield* NativeSessionWorkspace;
    const folders = yield* SessionFolders;
    const pageWorkspaces = yield* makePageWorkspaces;
    const presentation = Option.getOrUndefined(yield* Effect.serviceOption(CodexTurnPresentation));
    const visualizationState = Option.getOrUndefined(
      yield* Effect.serviceOption(CodexVisualizationState),
    );
    const conversations = Option.getOrUndefined(yield* Effect.serviceOption(CodexConversations));
    const desktop = yield* HostDesktopTools;
    const installations = yield* PluginInstallation;
    const broker = yield* PluginMcpBroker;
    const pip = desktop.pip;
    const appToolCatalog = yield* HostAppToolCatalog;
    const hostPolicy = Option.getOrUndefined(yield* Effect.serviceOption(HostAgentPolicy));
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
          nodex: (yield* managedAccount)?.identity ?? null,
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
          const managed = yield* managedAccount;
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
        const view = conversations?.read(threadId);
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
      interactiveState: visualizationState
        ? {
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
          }
        : undefined,
      prepareWorkspace: workspace.prepare,
      cleanDeletedChatFolders: folders.cleanDeleted,
      pageWorkspaces,
      refreshPageWorkspace: pageWorkspaces.refresh,
      pageWorkspaceThreads: pageWorkspaces.threadsAtPath,
      presentation,
      releaseDesktopSession: desktop.releaseSession,
      ...(pip
        ? {
            retireDesktopTask: (taskId, action) =>
              pip.retireTasks({ action, threadIds: [taskId] }).pipe(Effect.ignoreCause),
          }
        : {}),
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
    const presence = yield* UserPresence;
    const applicationEvents = yield* CodexApplicationEventHub;
    const projects = yield* ProjectWorkspace;
    const modules = yield* CoreModules;
    const readSession = yield* makeSessionReader;
    const readbacks = yield* Effect.serviceOption(ReadbackRuntime);
    if (Option.isSome(readbacks))
      yield* activity.transitions.pipe(
        Stream.runForEach(readbacks.value.observe),
        Effect.forkScoped({ startImmediately: true }),
      );
    yield* runSessionNotifications({
      transitions: activity.transitions,
      isSeen: ({ rootThreadId, sessionId }) =>
        presence.isSeen({ conversationId: rootThreadId, sessionId }),
      readAutomationNotificationPolicy: (messageId) => readAutomationTurnPolicy(modules, messageId),
      readSession,
      markUnread: (sessionId) =>
        projects.markProjectSessionUnread({
          operationId: createOperationId("agent-runtime.session.unread"),
          payload: { sessionId, unread: true },
        }),
      publish: (event) => {
        applicationEvents.publish({ kind: "threadNotification", value: event });
        // Session notifications finish their unread write before publishing read activity.
        if (
          event.type === "user-input-requested" ||
          (event.type === "turn-completed" && !quietAutomationTurnReason(event))
        )
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
      const inheritedEnvironment = {
        ...config.environment,
        ...loginEnvironment,
        PATH: [
          ...platform.runtime.additionalSearchPaths.map((directory) => resolve(directory)),
          loginEnvironment.PATH ?? config.environmentPath ?? "",
        ]
          .filter(Boolean)
          .join(config.platform === "win32" ? ";" : ":"),
      };
      const environment = hostPolicy
        ? scrubHostAgentEnvironment(inheritedEnvironment, hostPolicy.coreHome)
        : inheritedEnvironment;
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
          ? yield* managedAccount
          : null,
      });
      Object.assign(providers, managed);
      const admittedProviders = hostPolicy
        ? Object.fromEntries(
            Object.entries(providers).map(([id, provider]) => [
              id,
              {
                ...provider,
                environment: provider.environment?.filter(({ name, value }) =>
                  isAgentProviderVariable(name, value, hostPolicy.coreHome),
                ),
              },
            ]),
          )
        : providers;
      for (const provider of Object.values(managed)) {
        const home = (provider.config as { homePath: string }).homePath;
        yield* fs.makeDirectory(home, { recursive: true, mode: 0o700 });
      }
      const configuration: AgentRuntimeConfiguration = {
        home: join(config.nodexHome, "agent-runtime"),
        cwd: projectlessWorkspaceRoot,
        providers: admittedProviders,
        automaticWorkAtOnce: snapshot.agentRuntime.automaticWorkAtOnce,
        pausedThreadIds: yield* heldThreadIds(modules),
        modelPolicy: snapshot.modelPolicy,
        host: { tools: appToolCatalog, codexPlugins: true },
      };
      for (const [id, provider] of Object.entries(providers)) drivers.set(id, provider.driver);
      return { configuration, environment, executable };
    });
    const quiescence = yield* makeQuiescence(join(config.nodexHome, "agent-runtime"));
    const analytics = yield* ProductAnalytics;
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
            profileHome: config.nodexHome,
            agentRunner: hostPolicy?.agentRunner,
            host,
            productEvent: analytics.recordFromRuntime,
          });
          prepared.set(connection.identity, configuration);
          preparedEnvironment.set(connection.identity, environment);
          return connection;
        }),
      activate: (connection) => {
        const configuration = prepared.get(connection.identity);
        if (!configuration) return Effect.fail(new Error("Execution configuration is unavailable"));
        return makeHost(connection, {
          claudePlugins: { installations, broker },
          codexPlugins,
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
            automaticWorkAtOnce: configuration.automaticWorkAtOnce,
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
    if (nodexAccount)
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
    yield* Stream.mergeAll(
      [
        database.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("15 seconds")).pipe(Stream.map(() => undefined)),
        activity.activityChanges.pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() =>
        runtime.currentConnection.pipe(
          Effect.flatMap((connection) =>
            connection
              ? Effect.succeed(connection)
              : pageWorkspaces.cleanupPending.pipe(
                  Effect.flatMap((pending) => (pending ? runtime.get() : Effect.succeed(null))),
                ),
          ),
          Effect.flatMap(pageWorkspaces.reconcile),
          Effect.catchCause((cause) =>
            Effect.logWarning("Page Workspace reconciliation deferred").pipe(
              Effect.annotateLogs({ cause }),
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
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

/** Execution and its Host-owned capabilities acquire before product tools activate. */
export const runtime = supervisor.pipe(
  Layer.provideMerge(Layer.mergeAll(promptImagesLayer, sessionWorkspaceLayer, pluginInstallation)),
);

/** Product tool semantics activate after Session, Workbench and automation Modules exist. */
export const hostTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const activation = yield* HostActivation;
    const { execute } = yield* HostToolExecutor;
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

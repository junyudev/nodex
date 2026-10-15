import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient } from "effect/http";
import { ProviderInstanceConfigMap } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectEnrichment from "../project/ProjectEnrichmentService.ts";
import * as ProjectFavicon from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentity from "../project/RepositoryIdentityResolver.ts";
import * as ProjectFiles from "../project/T3ProjectFileLoader.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderHost from "../provider/ProviderHostLive.ts";
import * as ProviderInstances from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ResetCredits from "../provider/resetCreditCoordinator.ts";
import { CodexDriver, type CodexDriverEnv } from "../provider/Drivers/CodexDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "../provider/Drivers/ClaudeDriver.ts";
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@t3tools/provider-acp-registry/server";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@t3tools/provider-opencode/server";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ClaudeAdapter from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ResourceCleanup from "../orchestration-v2/ResourceCleanupService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Recovery from "../orchestration-v2/ProviderRuntimeRecoveryService.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as ServerActivation from "../serverActivation.ts";
import * as ProviderConfiguration from "./ProviderConfiguration.ts";
import type { AgentRuntimeConfiguration } from "./Interface.ts";

const layerPlatform = Layer.merge(NodeServices.layer, FetchHttpClient.layer);
const drivers: ReadonlyArray<
  AnyProviderDriver<CodexDriverEnv | ClaudeDriverEnv | AcpRegistryDriverEnv | OpenCodeDriverEnv>
> = [CodexDriver, ClaudeDriver, AcpRegistryDriver, OpenCodeDriver];
const decodeProviderConfiguration = Schema.decodeUnknownEffect(ProviderInstanceConfigMap);

/** Configuration derives every writable path beneath the dedicated runtime home. */
export const layerConfiguration = (configuration: AgentRuntimeConfiguration) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (!path.isAbsolute(configuration.home)) {
        return yield* Effect.fail(new Error("Agent Runtime home must be an absolute path."));
      }
      const derived = yield* ServerConfig.deriveServerPaths(configuration.home, undefined, {
        baseDirIsExplicit: true,
      });
      const paths = { ...derived, dbPath: path.join(configuration.home, "agent-runtime.sqlite") };
      yield* ServerConfig.ensureServerDirectories(paths);
      return ServerConfig.make({
        ...paths,
        cwd: configuration.cwd,
        baseDir: configuration.home,
        logLevel: "Error",
        traceMinLevel: "Info",
        traceTimingEnabled: false,
        traceBatchWindowMs: 200,
        traceMaxBytes: 10 * 1024 * 1024,
        traceMaxFiles: 10,
        otlpTracesUrl: undefined,
        otlpMetricsUrl: undefined,
        otlpLogsUrl: undefined,
        otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
        otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
        otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
        otelEnvironment: OtelEnvironment.none,
        mode: "desktop",
        port: 0,
        host: "127.0.0.1",
        staticDir: undefined,
        devUrl: undefined,
        devAllowedOrigins: [],
        noBrowser: true,
        startupPresentation: "headless",
        desktopBootstrapToken: undefined,
        autoBootstrapProjectFromCwd: false,
        logWebSocketEvents: false,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      });
    }),
  ).pipe(Layer.provide(layerPlatform));

const layerStoredSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(Sqlite.layerConfig),
);
const layerSettings = Layer.effect(
  ServerSettings.ServerSettingsService,
  Effect.gen(function* () {
    return ProviderConfiguration.effectiveSettings(
      yield* ServerSettings.ServerSettingsService,
      yield* ProviderConfiguration.ProviderPolicy,
    );
  }),
).pipe(Layer.provide(layerStoredSettings), Layer.provideMerge(Sqlite.layerConfig));
const layerPower = Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make());
const layerBackground = BackgroundPolicy.layer.pipe(
  Layer.provide(layerPower),
  Layer.provide(layerSettings),
);
const layerProjectEnrichment = ProjectEnrichment.layer.pipe(
  Layer.provide(
    ProjectFavicon.layer.pipe(
      Layer.provide(ProjectFiles.layer),
      Layer.provide(WorkspacePaths.layer),
    ),
  ),
  Layer.provide(RepositoryIdentity.layer),
);
const layerProviderInfrastructure = Layer.mergeAll(
  CodexAdapter.layerAppServerClientFactory,
  ClaudeAdapter.layerQueryRunner,
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderContinuationRequests.layer,
  ProviderLatestVersions.layer,
  ResetCredits.layer,
  ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
  CodexInstallation.CodexInstallation.layer,
  AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHost.layer)),
  OpenCodeRuntime.layer.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const configuration = yield* ServerConfig.ServerConfig;
          return OpenCodeServerLedger.layer({ stateDir: configuration.stateDir });
        }),
      ),
    ),
  ),
).pipe(
  Layer.provideMerge(ModelManifest.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provideMerge(ServerSecretStore.layer),
);

/** Parked background workers start only after startup recovery admits commands. */
class ExecutionActivation extends Context.Service<ExecutionActivation, Deferred.Deferred<void>>()(
  "nodex/agent-runtime/ExecutionActivation",
) {}
const layerActivation = Layer.effect(ExecutionActivation, Deferred.make<void>());
const layerServerActivation = Layer.effect(
  ServerActivation.ServerActivation,
  ExecutionActivation.useSync((activation) => Deferred.await(activation)),
);

/**
 * The engine is the orchestration production composition. Nodex supplies only platform
 * capabilities and its explicit policy overrides; HTTP/MCP credentials come from the scoped
 * transport host, never from a renderer.
 */
export const layerEngine = (configuration: AgentRuntimeConfiguration) => {
  const layerPolicy = Layer.unwrap(
    decodeProviderConfiguration(configuration.providers).pipe(
      Effect.map(ProviderConfiguration.layerPolicy),
    ),
  );
  const layerInstances = Layer.unwrap(
    Effect.gen(function* () {
      const configMap = yield* decodeProviderConfiguration(configuration.providers);
      return ProviderInstances.layer({ drivers, configMap }).pipe(
        Layer.provide(ProviderHost.layer),
        Layer.provide(layerProviderInfrastructure),
      );
    }),
  );
  return Layer.mergeAll(
    RuntimeLayer.layerProduction,
    RuntimeLayer.layerEventSink,
    RuntimeLayer.layerStores,
  ).pipe(
    Layer.provide(ResourceCleanup.layer),
    Layer.provide(layerServerActivation),
    Layer.provideMerge(layerActivation),
    Layer.provideMerge(ProjectionStore.layer),
    Layer.provideMerge(layerProjectEnrichment),
    Layer.provideMerge(WorkspacePaths.layer),
    // Rewind anchors on Run ordinals; nothing is written into user repositories.
    Layer.provideMerge(CheckpointStore.layerWithoutWorkspaceState),
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(TextGeneration.layer),
    Layer.provideMerge(ProviderRegistry.layer),
    Layer.provideMerge(layerInstances),
    Layer.provideMerge(layerProviderInfrastructure),
    Layer.provideMerge(layerBackground),
    Layer.provideMerge(layerSettings),
    Layer.provideMerge(layerPolicy),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(layerConfiguration(configuration)),
    Layer.provideMerge(layerPlatform),
  );
};

/**
 * Recovery finishes before external command admission, the outbox worker and parked
 * production workers start.
 */
export const acquireExecution = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const recovery = yield* Recovery.ProviderRuntimeRecoveryService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessions.ProviderSessionManagerV2;
  yield* settings.start;
  yield* recovery.recover;
  yield* orchestrator.recoverDelegatedTasks;
  const worker = yield* EffectWorker.runDaemon.pipe(Effect.forkScoped);
  yield* Deferred.succeed(yield* ExecutionActivation, undefined);
  yield* Effect.addFinalizer(() =>
    Fiber.interrupt(worker).pipe(
      Effect.andThen(recovery.prepareForShutdown),
      Effect.ensuring(sessions.shutdown),
      Effect.andThen(recovery.reconcile("shutdown")),
      Effect.ignoreCause,
    ),
  );
  return { orchestrator, recovery };
});

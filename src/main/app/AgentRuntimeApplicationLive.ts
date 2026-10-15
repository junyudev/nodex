import { join, resolve } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AgentRuntimeConfiguration } from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FileSystem from "effect/FileSystem";
import type * as Scope from "effect/Scope";
import { z } from "zod";
import { agentRuntimeProviderId } from "../../shared/agent-runtime-provider";
import { codexCliAppServerArgs } from "../../shared/codex-app-server-launch";
import type { ClaudeAgentInstanceConfig } from "../../shared/types";
import { CLAUDE_ACP_AGENT_DEFINITION } from "../../shared/acp-agent-definitions";
import { selectClaudeAcpEnvironment } from "../platform/node/ClaudeAcpEnvironment";
import {
  NativePromptImages,
  layer as promptImagesLayer,
} from "../agent-backend/NativePromptImages";
import {
  NativeSessionWorkspace,
  layer as sessionWorkspaceLayer,
} from "../agent-backend/NativeSessionWorkspace";
import {
  AgentRuntimeApplication,
  make as makeApplication,
} from "../agent-runtime/AgentRuntimeApplication";
import { make as makeHost } from "../agent-runtime/AgentRuntimeHost";
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
} from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { subscribe as subscribeExecutionChanges } from "../agent-runtime/AgentRuntimeExecutionChanges";
import { make as makeSnapshotAdmission } from "../agent-runtime/AgentRuntimeSnapshotAdmission";
import {
  AgentRuntimeProfileSnapshot,
  make as makeProfileSnapshot,
} from "../agent-runtime/AgentRuntimeProfileSnapshot";
import { nativeHistorySources } from "../agent-runtime/AgentRuntimeSnapshotSources";
import { make as makeProviderAuthentication } from "../agent-runtime/AgentRuntimeProviderAuthentication";
import { readAgentRuntimeNativeHistory } from "../platform/node/AgentRuntimeNativeHistory";
import { materializeRestoredCodexConfiguration } from "../platform/node/AgentRuntimeNativeConfiguration";
import { WorktreeShellEnvironmentRuntime } from "../host-runtime/WorktreeShellEnvironmentRuntime";
import {
  agentRuntimeEntrypoint,
  agentRuntimeNodeExecutable,
} from "../platform/node/AgentRuntimeEntrypoint";
import {
  acquireAgentRuntimeProcess,
  type AgentRuntimeProcessConnection,
} from "../platform/node/AgentRuntimeProcess";
import { AcpAgentLaunchProbe, live as acpProbeLayer } from "../platform/node/AcpAgentLaunchProbe";
import { shellQuote } from "../platform/node/NodexCliShell";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { CodexPlatform } from "./CodexApplicationLive";
import { CodexTurnPresentation } from "../codex-application/CodexTurnPresentation";
import { MainApplicationError } from "./MainApplication";
import { MainConfig } from "./MainConfig";

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
    readonly subscribeExecutionChanges: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("nodex/main/app/AgentRuntimeHostActivation") {}

const supervisor = Layer.effectContext(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const platform = yield* CodexPlatform;
    const settings = yield* ApplicationSettings;
    const shell = yield* WorktreeShellEnvironmentRuntime;
    const core = yield* CoreAuthority;
    const images = yield* NativePromptImages;
    const workspace = yield* NativeSessionWorkspace;
    const presentation = yield* CodexTurnPresentation;
    const fs = yield* FileSystem.FileSystem;
    const database = yield* DatabaseNotifierRuntime;
    const admission = yield* makeSnapshotAdmission();
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
    const product = yield* makeApplication({
      connect: Deferred.await(ready).pipe(Effect.flatMap((runtime) => runtime.get())),
      projectless: {
        engineProjectId: `nodex:projectless:${core.identity.profileId}`,
        workspaceRoot: join(config.nodexHome, "tasks"),
        ensureWorkspaceRoot: fs.makeDirectory(join(config.nodexHome, "tasks"), { recursive: true }),
      },
      prepareImages: images.prepare,
      prepareWorkspace: workspace.prepare,
      presentation,
      reconcileWorkspace: workspace.reconcile,
      withWriter: admission.withWriter,
      runtimeExists: fs.exists(join(config.nodexHome, "agent-runtime", "agent-runtime.sqlite")),
      subscribeExecutionChanges: executionChanges,
    });
    const execute: AgentRuntimeHostToolExecutor = (caller, name, input) =>
      Deferred.await(toolsReady).pipe(Effect.flatMap((tools) => tools(caller, name, input)));
    const acpProbe = yield* AcpAgentLaunchProbe;
    const projectlessId = `nodex:projectless:${core.identity.profileId}`;
    const prepared = new WeakMap<AgentRuntimeProcessConnection, AgentRuntimeConfiguration>();
    const preparedEnvironment = new WeakMap<
      AgentRuntimeProcessConnection,
      Readonly<Record<string, string | undefined>>
    >();
    const drivers = new Map<string, string>();
    const readProviderAuth = yield* makeProviderAuthentication();
    const restoredHistories = yield* Effect.cached(
      Effect.tryPromise(() => readAgentRuntimeNativeHistory(config.nodexHome)),
    );
    const readConfiguration = Effect.gen(function* () {
      const executable = yield* Effect.try({
        try: () =>
          agentRuntimeNodeExecutable({
            isPackaged: config.isPackaged,
            environment: config.environment,
            bundledExecutable:
              platform.runtime.browserRuntime.status === "available"
                ? platform.runtime.browserRuntime.bundle.paths.node
                : null,
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
          config: {
            setupMode: "existing",
            binaryPath: resolve(platform.runtime.binaryPath),
            homePath: platform.accountHome.effectiveHome,
            launchArgs: codexCliAppServerArgs(config.environment)
              .filter((arg) => arg !== "app-server")
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
          ...(launch?.environment ?? {}),
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
        const definition = CLAUDE_ACP_AGENT_DEFINITION;
        const compatible =
          configured.enabled && configured.agentDefinitionId === definition.id
            ? yield* acpProbe
                .probeUserManagedNodePackage({
                  packageRoot: configured.packageRoot,
                  nodeExecutable: configured.nodeExecutable,
                  expectedPackageName: definition.packageName,
                  expectedPackageVersion: definition.packageVersion,
                  entryRelativePath: definition.entryRelativePath,
                  minimumNodeMajor: definition.minimumNodeMajor,
                })
                .pipe(Effect.catch(() => Effect.succeed(null)))
            : null;
        const isolatedHome =
          compatible && configured.credentials.kind === "isolated-home"
            ? yield* acpProbe.canonicalDirectory(configured.credentials.home)
            : null;
        const variables = selectClaudeAcpEnvironment(
          environment,
          {
            credentials: configured.credentials,
            proxy: configured.proxy,
          },
          isolatedHome,
        );
        providers[id] = {
          driver: "acpRegistry",
          displayName: definition.title,
          enabled: configured.enabled && compatible !== null,
          environment: Object.entries(variables).flatMap(([name, value]) =>
            value === undefined
              ? []
              : [
                  {
                    name,
                    value,
                    sensitive: /^(?:ANTHROPIC_|CLAUDE_|AWS_|GOOGLE_|CLOUD_ML_)/u.test(name),
                  },
                ],
          ),
          config: {
            source: "local",
            commandPath: compatible?.nodeExecutable ?? configured.nodeExecutable,
            commandArgs: [
              compatible?.entryPath ?? join(configured.packageRoot, definition.entryRelativePath),
            ],
            inheritEnvironment: false,
          },
        };
      }
      const configuration: AgentRuntimeConfiguration = {
        home: join(config.nodexHome, "agent-runtime"),
        cwd: config.projectRootPath,
        providers,
        host: { tools: runtimeHostToolCatalog },
      };
      const histories = yield* restoredHistories;
      for (const [id, history] of histories) {
        const provider = providers[id];
        if (!provider) continue;
        if (provider.driver !== history.driver)
          return yield* Effect.fail(
            new Error("Restored native history does not match its configured provider"),
          );
        const providerConfig = yield* Effect.try(() =>
          z.record(z.string(), z.unknown()).parse(provider.config),
        );
        providers[id] = {
          ...provider,
          config:
            history.driver === "codex"
              ? {
                  ...providerConfig,
                  homePath: history.homePath,
                  hostAuthentication: true,
                  launchArgs: `${String(providerConfig.launchArgs ?? "")} -c 'cli_auth_credentials_store="ephemeral"' -c ${shellQuote(`sqlite_home=${JSON.stringify(history.homePath)}`)}`,
                }
              : { ...providerConfig, restoredHistoryPath: history.homePath },
        };
      }
      for (const [id, provider] of Object.entries(providers)) drivers.set(id, provider.driver);
      return { configuration, environment, executable };
    });
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
          for (const history of (yield* restoredHistories).values()) {
            if (history.driver !== "codex") continue;
            yield* Effect.tryPromise(() =>
              materializeRestoredCodexConfiguration({
                configuredHome: platform.accountHome.sharedHome,
                historyHome: history.homePath,
              }),
            );
          }
          const connection = yield* acquireAgentRuntimeProcess({
            executable,
            entryPath: agentRuntimeEntrypoint(config),
            configuration,
            environment,
            host,
          });
          prepared.set(connection, configuration);
          preparedEnvironment.set(connection, environment);
          return connection;
        }),
      activate: (connection) => {
        const configuration = prepared.get(connection);
        if (!configuration) return Effect.fail(new Error("Execution configuration is unavailable"));
        return makeHost(connection, {
          presentation,
          projectlessId,
          providers: configuration.providers,
          providerDriver: (id) => drivers.get(id),
          execute,
          readProviderAuth,
        }).pipe(
          Effect.tap(() =>
            Deferred.await(toolsReady).pipe(
              Effect.andThen(product.cleanupDeletedSessions),
              Effect.catchCause(() =>
                Effect.logWarning("Agent execution cleanup will retry after the next connection"),
              ),
              Effect.forkScoped,
            ),
          ),
        );
      },
    });
    const refresh = Effect.gen(function* () {
      if (!(yield* runtime.inspect)) return;
      const connection = yield* runtime.get();
      const { configuration } = yield* readConfiguration;
      yield* connection.request("providers.configure", { providers: configuration.providers });
      prepared.set(connection, configuration);
    }).pipe(
      Effect.mapError((cause) => new AgentRuntimeProviderConfigurationError({ cause })),
      Effect.asVoid,
    );
    yield* Deferred.succeed(ready, runtime);
    const profileSnapshot = yield* makeProfileSnapshot(runtime, admission, {
      isUnused: fs
        .exists(join(config.nodexHome, "agent-runtime", "agent-runtime.sqlite"))
        .pipe(Effect.map((exists) => !exists)),
      prepareRestore: (source) =>
        Effect.gen(function* () {
          const root = join(config.nodexHome, "runtime", "snapshots");
          yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
          const directory = yield* fs.makeTempDirectoryScoped({
            directory: root,
            prefix: "restore-",
          });
          const databasePath = join(directory, "agent-runtime.sqlite");
          // The source is an already completed online backup held by the exact engine lease.
          yield* fs.copyFile(source.databasePath, databasePath);
          return { ...source, databasePath };
        }),
      nativeHistories: (connection) =>
        Effect.try(() => {
          const configuration = prepared.get(connection);
          const environment = preparedEnvironment.get(connection);
          if (!configuration || !environment)
            throw new Error("Physical provider configuration is unavailable");
          return nativeHistorySources({
            configuration,
            environment,
            homeDirectory: config.homeDirectory,
            codexHome: platform.accountHome.sharedHome,
          });
        }),
    });
    return Context.make(AgentRuntimeSupervisor, runtime).pipe(
      Context.add(AgentRuntimeSessionActivity, SessionActivity.inactive),
      Context.add(AgentRuntimeProviderConfiguration, { refresh }),
      Context.add(AgentRuntimeApplication, product),
      Context.add(AgentRuntimeProfileSnapshot, profileSnapshot),
      Context.add(HostActivation, {
        activate: (tools) => Deferred.succeed(toolsReady, tools).pipe(Effect.asVoid),
        resume: fs
          .exists(join(config.nodexHome, "agent-runtime", "agent-runtime.sqlite"))
          .pipe(
            Effect.flatMap((exists) => (exists ? runtime.get().pipe(Effect.asVoid) : Effect.void)),
          ),
        subscribeExecutionChanges: executionChanges,
      }),
    );
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MainApplicationError({ phase: "startup", operation: "agent-runtime-host", cause }),
    ),
  ),
).pipe(Layer.provide(NodeServices.layer));

/** Execution and Profile coordination depend only on Core and native filesystem capabilities. */
export const runtime = supervisor.pipe(
  Layer.provideMerge(Layer.mergeAll(promptImagesLayer, sessionWorkspaceLayer, acpProbeLayer)),
);

/** Product tool semantics activate after Session, Workbench and automation Modules exist. */
export const hostTools = Layer.effectDiscard(
  Effect.gen(function* () {
    const activation = yield* HostActivation;
    const execute = yield* makeHostTools({
      subscribeExecutionChanges: activation.subscribeExecutionChanges,
    });
    yield* activation.activate(execute);
    yield* activation.resume.pipe(
      Effect.catchCause(() =>
        Effect.logWarning("Agent execution will resume on the next operation"),
      ),
      Effect.forkScoped,
    );
  }),
);

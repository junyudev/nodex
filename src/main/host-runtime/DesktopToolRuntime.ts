import { isWslWorkspacePath } from "../../shared/codex-workspace-paths";
import type { HostDesktopTools } from "@nodex/agent-runtime/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type { ConfigRequirementsReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigRequirementsReadResponse";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { PluginInstalledResponse } from "@nodex/codex-app-server-protocol/v2/PluginInstalledResponse";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import {
  BrowserPluginReconcileError,
  makeBrowserPluginReconciler,
  materializeHostDesktopToolPlugins,
  type BrowserPluginReconciler,
  type BrowserPluginReconcileResult,
} from "../codex/browser-plugin-reconciler";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import { DISABLED_DESKTOP_TOOL_REPL_CONFIG } from "../codex/codex-thread-config";
import { reapCodexReplScratch } from "../codex/desktop-tool-environment";
import type { NodeExecutionRuntime } from "../platform/node/NodeExecutionRuntime";
import {
  BrowserUseThreadConfigBuilder,
  type WindowsDesktopToolServerOptions,
  buildDesktopToolPluginOverrides,
} from "../codex/browser-use-thread-config";
import { isForeignDesktopToolPlugin } from "../codex/bundled-desktop-tool-marketplace";
import {
  buildArtifactTemplatePickerConfig,
  flattenArtifactTemplateSkills,
  resolveArtifactTemplatePickerRuntime,
  type ArtifactTemplatePickerRuntime,
} from "../codex/artifact-template-picker";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { BrowserUseRuntime } from "./BrowserUseRuntime";
import { ComputerUseRuntime, type ComputerUseRuntimeResult } from "./ComputerUseRuntime";

export class DesktopToolRuntimeError extends Schema.TaggedError<DesktopToolRuntimeError>()(
  "DesktopToolRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface DesktopToolRuntimeSnapshot {
  readonly browserPluginReady: boolean;
  readonly computerUsePluginReady: boolean;
  readonly computerUse: ComputerUseRuntimeResult | null;
  readonly plugins: BrowserPluginReconcileResult | null;
}

export class DesktopToolRuntime extends Context.Service<
  DesktopToolRuntime,
  {
    readonly browserRuntime: BrowserRuntimeAvailability;
    readonly ensureComputerUse: Effect.Effect<ComputerUseRuntimeResult, DesktopToolRuntimeError>;
    readonly ensureReady: Effect.Effect<DesktopToolRuntimeSnapshot, DesktopToolRuntimeError>;
    readonly readConfigRequirements: Effect.Effect<
      ConfigRequirementsReadResponse,
      DesktopToolRuntimeError
    >;
    readonly desktopTools: Effect.Effect<HostDesktopTools | null, DesktopToolRuntimeError>;
    readonly threadConfig: (
      cwd?: string | null,
    ) => Effect.Effect<NonNullable<ThreadStartParams["config"]> | null, DesktopToolRuntimeError>;
  }
>()("nodex/main/host-runtime/DesktopToolRuntime") {}

interface DesktopToolRuntimeOptions {
  readonly windows?: WindowsDesktopToolServerOptions & { readonly ready: Effect.Effect<void> };
  readonly platform?: string;
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly codexDesktopToolsCompatible?: () => boolean;
  readonly nodeRuntime: NodeExecutionRuntime;
  readonly codexHome: string;
  readonly isPackaged: boolean;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
  readonly runtimeStateHome: string;
}

interface DesktopToolRuntimeLayerOptions {
  readonly windows?: DesktopToolRuntimeOptions["windows"];
  readonly platform?: string;
  readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  readonly preferredExtensionInstanceId?: Effect.Effect<string | undefined>;
  readonly codexDesktopToolsCompatible?: () => boolean;
  readonly hostPlugins?: (
    computerUseAvailable: boolean,
  ) => Effect.Effect<BrowserPluginReconcileResult, DesktopToolRuntimeError>;
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly codexHome: string;
  readonly artifactTemplatePickerEnabled?: Effect.Effect<boolean, DesktopToolRuntimeError>;
  readonly artifactTemplatePickerRuntime?: ArtifactTemplatePickerRuntime | null;
  readonly computerUse: ComputerUseRuntime["Service"];
  readonly plugins: (
    availableBackends: () => readonly BrowserRuntimeBackend[],
  ) => Effect.Effect<BrowserPluginReconciler>;
  readonly readConfigRequirements: Effect.Effect<
    ConfigRequirementsReadResponse,
    DesktopToolRuntimeError
  >;
  readonly listSkills?: (
    cwd?: string | null,
  ) => Effect.Effect<SkillsListResponse, DesktopToolRuntimeError>;
  readonly listPlugins?: (
    cwd?: string | null,
  ) => Effect.Effect<PluginInstalledResponse, DesktopToolRuntimeError>;
  readonly runtimeStateHome: string;
}

const make = (options: DesktopToolRuntimeLayerOptions) =>
  Effect.gen(function* () {
    if (options.platform === "darwin") {
      yield* Effect.tryPromise(() => reapCodexReplScratch(options.runtimeStateHome)).pipe(
        Effect.catch((cause) => Effect.logWarning("Could not reap Desktop Tool scratch", cause)),
      );
    }
    const plugins = yield* options.plugins(options.availableBackends);
    const hostMaterialization = yield* Semaphore.make(1);
    const snapshot = Effect.gen(function* () {
      const computerUse = options.computerUse.current();
      const pluginResult = yield* plugins.result;
      return {
        browserPluginReady: pluginResult?.status === "ready" && pluginResult.enabled,
        computerUsePluginReady:
          pluginResult?.status === "ready" &&
          pluginResult.computerUse.status === "ready" &&
          computerUse?.status === "available",
        computerUse,
        plugins: pluginResult,
      } satisfies DesktopToolRuntimeSnapshot;
    });
    const ensureComputerUse = options.computerUse.ensureReady.pipe(
      Effect.mapError(
        (cause) => new DesktopToolRuntimeError({ operation: "computer-use-ready", cause }),
      ),
    );
    const ensureReady = (options.windows?.ready ?? Effect.void).pipe(
      Effect.andThen(ensureComputerUse),
      Effect.andThen(
        Effect.suspend(() =>
          options.codexDesktopToolsCompatible?.() === false
            ? Effect.void
            : plugins.ensureInstalled.pipe(Effect.asVoid),
        ),
      ),
      Effect.mapError(
        (cause) => new DesktopToolRuntimeError({ operation: "reconcile-plugins", cause }),
      ),
      Effect.andThen(snapshot),
    );
    const artifactTemplatePickerConfig = (cwd?: string | null) =>
      Effect.gen(function* () {
        if (!(yield* options.artifactTemplatePickerEnabled ?? Effect.succeed(false))) return null;
        const runtime = options.artifactTemplatePickerRuntime ?? null;
        if (!runtime) return null;
        const base = buildArtifactTemplatePickerConfig({ runtime });
        if (!base) return null;
        const skills = yield* (
          options.listSkills?.(cwd) ??
          Effect.fail(
            new DesktopToolRuntimeError({
              operation: "artifact-template-picker.skills",
              cause: new Error("Skill discovery is unavailable"),
            }),
          )
        ).pipe(Effect.option);
        if (skills._tag === "None") return base;
        return (
          buildArtifactTemplatePickerConfig({
            runtime,
            skills: flattenArtifactTemplateSkills(skills.value),
          }) ?? base
        );
      });
    return DesktopToolRuntime.of({
      get browserRuntime() {
        return options.browserRuntime;
      },
      ensureComputerUse,
      ensureReady,
      readConfigRequirements: ensureReady.pipe(
        Effect.andThen(options.readConfigRequirements),
        Effect.mapError(
          (cause) => new DesktopToolRuntimeError({ operation: "config-requirements", cause }),
        ),
      ),
      desktopTools: (options.windows?.ready ?? Effect.void).pipe(
        Effect.andThen(ensureComputerUse),
        Effect.andThen(
          Effect.gen(function* () {
            const computerUse = options.computerUse.current();
            const hostPlugins = options.hostPlugins
              ? yield* options
                  .hostPlugins(computerUse?.status === "available")
                  .pipe(hostMaterialization.withPermits(1))
              : yield* plugins.ensureInstalled;
            const preferredExtensionInstanceId = yield* (
              options.preferredExtensionInstanceId ?? Effect.succeed(undefined)
            );
            return yield* Effect.try({
              try: () =>
                new BrowserUseThreadConfigBuilder({
                  availableBackends: options.availableBackends,
                  preferredExtensionInstanceId,
                  browserRuntime: options.browserRuntime,
                  windows: options.windows,
                  codexHome: options.codexHome,
                  computerUsePluginReady: () =>
                    hostPlugins.status === "ready" && hostPlugins.computerUse.status === "ready",
                  computerUseRuntime: () => computerUse,
                  runtimeStateHome: options.runtimeStateHome,
                }).buildDesktopTools(hostPlugins),
              catch: (cause) => new DesktopToolRuntimeError({ operation: "desktop-tools", cause }),
            });
          }),
        ),
      ),
      // A Thread asking for desktop tools is itself the readiness boundary. Callers must not
      // depend on a Settings screen (or another earlier request) having reconciled plugins.
      threadConfig: (cwd) =>
        Effect.suspend(() =>
          isWslWorkspacePath(cwd) || options.codexDesktopToolsCompatible?.() === false
            ? Effect.succeed(DISABLED_DESKTOP_TOOL_REPL_CONFIG)
            : ensureReady.pipe(
                Effect.flatMap((current) =>
                  Effect.gen(function* () {
                    const inventory = yield* options.listPlugins?.(cwd) ?? Effect.succeed(null);
                    const preferredExtensionInstanceId = yield* (
                      options.preferredExtensionInstanceId ?? Effect.succeed(undefined)
                    );
                    return yield* Effect.try({
                      try: () => {
                        const disabledDesktopPluginIds =
                          inventory?.marketplaces
                            .flatMap((marketplace) => marketplace.plugins)
                            .filter((plugin) =>
                              isForeignDesktopToolPlugin(plugin.id, options.runtimeStateHome),
                            )
                            .map((plugin) => plugin.id) ?? [];
                        const result = new BrowserUseThreadConfigBuilder({
                          availableBackends: () =>
                            current.browserPluginReady ? options.availableBackends() : [],
                          browserRuntime: options.browserRuntime,
                          preferredExtensionInstanceId,
                          windows: options.windows,
                          codexHome: options.codexHome,
                          disabledDesktopPluginIds,
                          computerUsePluginReady: () => current.computerUsePluginReady,
                          computerUseRuntime: () => current.computerUse,
                          runtimeStateHome: options.runtimeStateHome,
                        }).buildResult();
                        if (result.status === "available") return result.config;
                        if (options.platform === "win32") {
                          return {
                            ...buildDesktopToolPluginOverrides(disabledDesktopPluginIds),
                            ...DISABLED_DESKTOP_TOOL_REPL_CONFIG,
                          };
                        }
                        return disabledDesktopPluginIds.length > 0
                          ? buildDesktopToolPluginOverrides(disabledDesktopPluginIds)
                          : null;
                      },
                      catch: (cause) =>
                        new DesktopToolRuntimeError({ operation: "thread-config", cause }),
                    });
                  }),
                ),
                Effect.zipWith(artifactTemplatePickerConfig(cwd), (desktop, artifactTemplates) => {
                  if (!desktop) return artifactTemplates;
                  if (!artifactTemplates) return desktop;
                  return { ...desktop, ...artifactTemplates };
                }),
              ),
        ),
    });
  });

const fromPorts = (options: DesktopToolRuntimeLayerOptions): Layer.Layer<DesktopToolRuntime> =>
  Layer.effect(DesktopToolRuntime, make(options));

export const live = (
  options: DesktopToolRuntimeOptions,
): Layer.Layer<DesktopToolRuntime, never, BrowserUseRuntime | CodexGateway | ComputerUseRuntime> =>
  Layer.effect(
    DesktopToolRuntime,
    Effect.gen(function* () {
      const computerUse = yield* ComputerUseRuntime;
      const browserUse = yield* BrowserUseRuntime;
      const gateway = yield* CodexGateway;
      const artifactTemplatePickerRuntime = resolveArtifactTemplatePickerRuntime({
        nodePath:
          options.nodeRuntime.status === "available" ? options.nodeRuntime.executable : null,
        isPackaged: options.isPackaged,
        projectRootPath: options.projectRootPath,
        resourcesPath: options.resourcesPath,
      });
      return yield* make({
        availableBackends: browserUse.availableBackends,
        preferredExtensionInstanceId: browserUse.preferredExtensionInstanceId,
        get browserRuntime() {
          return options.browserRuntime;
        },
        codexDesktopToolsCompatible: options.codexDesktopToolsCompatible,
        hostPlugins: (computerUseAvailable) =>
          materializeHostDesktopToolPlugins({
            runtimeStateHome: options.runtimeStateHome,
            browserRuntime: options.browserRuntime,
            availableBackends: browserUse.availableBackends,
            computerUseAvailable,
          }).pipe(
            Effect.mapError(
              (cause) => new DesktopToolRuntimeError({ operation: "prepare-host-plugins", cause }),
            ),
          ),
        windows: options.windows,
        platform: options.platform,
        codexHome: options.codexHome,
        artifactTemplatePickerEnabled: Effect.succeed(true),
        artifactTemplatePickerRuntime,
        computerUse,
        plugins: (availableBackends) =>
          makeBrowserPluginReconciler({
            availableBackends,
            codexHome: options.codexHome,
            get browserRuntime() {
              return options.browserRuntime;
            },
            client: {
              request: (method, params) =>
                gateway.requestLocal(method, params).pipe(
                  Effect.mapError(
                    (cause) =>
                      new BrowserPluginReconcileError({
                        operation: `request.${method}`,
                        cause,
                      }),
                  ),
                ),
            },
            computerUseAvailable: () => computerUse.current()?.status === "available",
            runtimeStateHome: options.runtimeStateHome,
          }),
        readConfigRequirements: gateway.requestLocal("configRequirements/read", undefined).pipe(
          Effect.map((response) => response as unknown as ConfigRequirementsReadResponse),
          Effect.mapError(
            (cause) =>
              new DesktopToolRuntimeError({ operation: "config-requirements.request", cause }),
          ),
        ),
        listSkills: (cwd) =>
          gateway.requestLocal("skills/list", cwd == null ? {} : { cwds: [cwd] }).pipe(
            Effect.map((response) => response as unknown as SkillsListResponse),
            Effect.mapError(
              (cause) =>
                new DesktopToolRuntimeError({
                  operation: "artifact-template-picker.skills",
                  cause,
                }),
            ),
          ),
        listPlugins: (cwd) =>
          gateway
            .requestLocal("plugin/installed", {
              cwds: cwd == null ? null : [cwd],
              installSuggestionPluginNames: [],
            })
            .pipe(
              Effect.map((response) => response as unknown as PluginInstalledResponse),
              Effect.mapError(
                (cause) =>
                  new DesktopToolRuntimeError({ operation: "desktop-plugins.list", cause }),
              ),
            ),
        runtimeStateHome: options.runtimeStateHome,
      });
    }),
  );

export const testLayer = fromPorts;

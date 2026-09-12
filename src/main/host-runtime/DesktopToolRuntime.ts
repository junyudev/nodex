import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type { ConfigRequirementsReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigRequirementsReadResponse";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import {
  BrowserPluginReconcileError,
  makeBrowserPluginReconciler,
  type BrowserPluginReconciler,
  type BrowserPluginReconcileResult,
} from "../codex/browser-plugin-reconciler";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import { BrowserUseThreadConfigBuilder } from "../codex/browser-use-thread-config";
import {
  buildArtifactTemplatePickerConfig,
  flattenArtifactTemplateSkills,
  resolveArtifactTemplatePickerRuntime,
  type ArtifactTemplatePickerRuntime,
} from "../codex/artifact-template-picker";
import { CodexExecutionAssignments } from "../codex-application/CodexExecutionAssignments";
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
    readonly threadConfig: (
      cwd?: string | null,
    ) => Effect.Effect<NonNullable<ThreadStartParams["config"]> | null, DesktopToolRuntimeError>;
  }
>()("nodex/main/host-runtime/DesktopToolRuntime") {}

interface DesktopToolRuntimeOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly isPackaged: boolean;
  readonly projectRootPath: string;
  readonly resourcesPath: string;
  readonly runtimeStateHome: string;
}

interface DesktopToolRuntimeLayerOptions {
  readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  readonly browserRuntime: BrowserRuntimeAvailability;
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
  readonly runtimeStateHome: string;
}

const make = (options: DesktopToolRuntimeLayerOptions) =>
  Effect.gen(function* () {
    const plugins = yield* options.plugins(options.availableBackends);
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
    const ensureReady = ensureComputerUse.pipe(
      Effect.andThen(plugins.ensureInstalled),
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
      browserRuntime: options.browserRuntime,
      ensureComputerUse,
      ensureReady,
      readConfigRequirements: ensureReady.pipe(
        Effect.andThen(options.readConfigRequirements),
        Effect.mapError(
          (cause) => new DesktopToolRuntimeError({ operation: "config-requirements", cause }),
        ),
      ),
      // A Thread asking for desktop tools is itself the readiness boundary. Callers must not
      // depend on a Settings screen (or another earlier request) having reconciled plugins.
      threadConfig: (cwd) =>
        ensureReady.pipe(
          Effect.flatMap((current) =>
            Effect.try({
              try: () => {
                const result = new BrowserUseThreadConfigBuilder({
                  availableBackends: () =>
                    current.browserPluginReady ? options.availableBackends() : [],
                  browserRuntime: options.browserRuntime,
                  computerUsePluginReady: () => current.computerUsePluginReady,
                  computerUseRuntime: () => current.computerUse,
                  runtimeStateHome: options.runtimeStateHome,
                }).buildResult();
                return result.status === "available" ? result.config : null;
              },
              catch: (cause) => new DesktopToolRuntimeError({ operation: "thread-config", cause }),
            }),
          ),
          Effect.zipWith(artifactTemplatePickerConfig(cwd), (desktop, artifactTemplates) => {
            if (!desktop) return artifactTemplates;
            if (!artifactTemplates) return desktop;
            return { ...desktop, ...artifactTemplates };
          }),
        ),
    });
  });

const fromPorts = (options: DesktopToolRuntimeLayerOptions): Layer.Layer<DesktopToolRuntime> =>
  Layer.effect(DesktopToolRuntime, make(options));

export const live = (
  options: DesktopToolRuntimeOptions,
): Layer.Layer<
  DesktopToolRuntime,
  never,
  BrowserUseRuntime | CodexExecutionAssignments | CodexGateway | ComputerUseRuntime
> =>
  Layer.effect(
    DesktopToolRuntime,
    Effect.gen(function* () {
      const computerUse = yield* ComputerUseRuntime;
      const browserUse = yield* BrowserUseRuntime;
      const gateway = yield* CodexGateway;
      const executionAssignments = yield* CodexExecutionAssignments;
      const artifactTemplatePickerRuntime = resolveArtifactTemplatePickerRuntime({
        browserNodePath:
          options.browserRuntime.status === "available"
            ? options.browserRuntime.bundle.paths.node
            : null,
        isPackaged: options.isPackaged,
        projectRootPath: options.projectRootPath,
        resourcesPath: options.resourcesPath,
      });
      return yield* make({
        availableBackends: browserUse.availableBackends,
        browserRuntime: options.browserRuntime,
        artifactTemplatePickerEnabled: executionAssignments.readExecutionAssignments().pipe(
          Effect.map((assignments) => assignments?.values.artifactTemplatePicker === true),
          Effect.mapError(
            (cause) =>
              new DesktopToolRuntimeError({ operation: "artifact-template-picker-gate", cause }),
          ),
        ),
        artifactTemplatePickerRuntime,
        computerUse,
        plugins: (availableBackends) =>
          makeBrowserPluginReconciler({
            availableBackends,
            browserRuntime: options.browserRuntime,
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
        runtimeStateHome: options.runtimeStateHome,
      });
    }),
  );

export const testLayer = fromPorts;

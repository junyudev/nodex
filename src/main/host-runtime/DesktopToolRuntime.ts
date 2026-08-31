import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { ThreadStartParams } from "@nodex/codex-app-server-protocol/v2/ThreadStartParams";
import type { ConfigRequirementsReadResponse } from "@nodex/codex-app-server-protocol/v2/ConfigRequirementsReadResponse";
import type { BrowserRuntimeBackend } from "../../shared/browser-runtime-metadata";
import {
  BrowserPluginReconcileError,
  makeBrowserPluginReconciler,
  type BrowserPluginReconciler,
  type BrowserPluginReconcileResult,
} from "../codex/browser-plugin-reconciler";
import type { BrowserRuntimeAvailability } from "../codex/browser-runtime-bundle";
import { BrowserUseThreadConfigBuilder } from "../codex/browser-use-thread-config";
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
    readonly threadConfig: Effect.Effect<
      NonNullable<ThreadStartParams["config"]> | null,
      DesktopToolRuntimeError
    >;
  }
>()("nodex/main/host-runtime/DesktopToolRuntime") {}

interface DesktopToolRuntimeOptions {
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly runtimeStateHome: string;
}

interface DesktopToolRuntimeLayerOptions {
  readonly availableBackends: () => readonly BrowserRuntimeBackend[];
  readonly browserRuntime: BrowserRuntimeAvailability;
  readonly computerUse: ComputerUseRuntime["Service"];
  readonly plugins: (
    availableBackends: () => readonly BrowserRuntimeBackend[],
  ) => Effect.Effect<BrowserPluginReconciler>;
  readonly readConfigRequirements: Effect.Effect<
    ConfigRequirementsReadResponse,
    DesktopToolRuntimeError
  >;
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
      threadConfig: ensureReady.pipe(
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
      return yield* make({
        availableBackends: browserUse.availableBackends,
        browserRuntime: options.browserRuntime,
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
        runtimeStateHome: options.runtimeStateHome,
      });
    }),
  );

export const testLayer = fromPorts;

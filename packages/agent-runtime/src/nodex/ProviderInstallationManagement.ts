import {
  AntigravitySettings,
  ProviderInstanceId,
  type ProviderInstallState,
} from "@nodex/runtime-contracts";
import { mergeProviderInstanceEnvironment } from "@nodex/provider-core/server/instanceEnvironment";
import { resolveCommandPath } from "@nodex/runtime-shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
} from "../provider/AntigravityInstallation.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderPolicy } from "./ProviderConfiguration.ts";
import { makeManagedOperations } from "./ManagedOperations.ts";
import type {
  AgentProviderInstallationFailure,
  AgentProviderInstallationOperation,
  AgentProviderInstallationState,
} from "./ProviderInstallationManagementContract.ts";

const Id = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const Driver = Schema.Literal("antigravity");
const request = <M extends string, S extends Schema.Constraint>(method: M, input: S) =>
  Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
export const Request = Schema.Union([
  request(
    "providers.install.read",
    Schema.Struct({ driver: Driver, refresh: Schema.optional(Schema.Boolean) }),
  ),
  request("providers.install.start", Schema.Struct({ driver: Driver, operationId: Id })),
  request("providers.install.remove", Schema.Struct({ driver: Driver, operationId: Id })),
  request("providers.install.operation.read", Schema.Struct({ operationId: Id })),
  request("providers.install.operation.cancel", Schema.Struct({ operationId: Id })),
]);

export class ProviderInstallationManagementError extends Schema.TaggedError<ProviderInstallationManagementError>()(
  "ProviderInstallationManagementError",
  {
    reason: Schema.Literals([
      "invalid_request",
      "operation_expired",
      "busy",
      "unsupported_platform",
      "inspection_failed",
      "download_failed",
      "verification_failed",
      "installation_failed",
      "removal_failed",
    ]),
    message: Schema.String,
  },
) {}
const failure = (reason: AgentProviderInstallationFailure["reason"], message: string) =>
  new ProviderInstallationManagementError({ reason, message });
const publicFailure = (error: unknown): AgentProviderInstallationFailure => {
  if (Schema.is(ProviderInstallationManagementError)(error))
    return { reason: error.reason, message: error.message };
  if (!Schema.is(AntigravityInstallationError)(error))
    return {
      reason: "installation_failed",
      message: "The provider installation could not finish. Retry after checking its state.",
    };
  const reason =
    error.operation === "remove"
      ? "removal_failed"
      : error.operation === "download"
        ? "download_failed"
        : error.operation === "verify"
          ? "verification_failed"
          : error.operation === "inspect"
            ? "inspection_failed"
            : "installation_failed";
  // The installation owner supplies product messages; nested causes, executable output and environment stay private.
  return { reason, message: error.detail };
};
const hasBinaryPath = Schema.is(Schema.Struct({ binaryPath: Schema.String }));

export const make = Effect.fn("ProviderInstallationManagement.make")(function* (
  runtimeGeneration: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installation = yield* AntigravityInstallation;
  const policy = yield* ProviderPolicy;
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const operations = yield* makeManagedOperations<
    AgentProviderInstallationOperation,
    ProviderInstallationManagementError
  >({
    failure,
    mapError: publicFailure,
    conflicts: (active, next) => active.driver === next.driver,
  });
  const choices = Effect.gen(function* () {
    const current = yield* policy.current;
    const desired = yield* policy.desired;
    const instances = yield* Effect.forEach(
      Object.entries(current).filter(([, entry]) => entry.driver === "antigravity"),
      ([id, entry]) =>
        Effect.gen(function* () {
          const config = yield* Schema.decodeUnknownEffect(AntigravitySettings)(
            entry.config ?? {},
          ).pipe(Effect.option);
          return {
            instanceId: id,
            binaryPath: Option.isSome(config) ? config.value.binaryPath : "",
            environment: yield* mergeProviderInstanceEnvironment(entry.environment),
          };
        }),
    );
    const protectedPaths = yield* Effect.forEach(
      [...Object.values(current), ...Object.values(desired)],
      (entry) =>
        Effect.gen(function* () {
          if (!hasBinaryPath(entry.config) || !entry.config.binaryPath.trim()) return [];
          const binaryPath = entry.config.binaryPath.trim();
          const resolved = yield* resolveCommandPath(binaryPath, {
            env: yield* mergeProviderInstanceEnvironment(entry.environment),
          }).pipe(Effect.option);
          return Option.isSome(resolved) ? [binaryPath, resolved.value] : [binaryPath];
        }),
    );
    return { instances, protectedPaths: [...new Set(protectedPaths.flat())] };
  }).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const read = (refresh = false) =>
    Effect.gen(function* () {
      const configured = yield* choices;
      if (refresh) {
        yield* installation.check(configured.instances);
        yield* Effect.forEach(
          configured.instances,
          ({ instanceId }) => providers.refreshInstance(ProviderInstanceId.make(instanceId)),
          { concurrency: "unbounded", discard: true },
        );
      }
      const inspected = yield* installation.inspect(
        configured.instances,
        configured.protectedPaths,
      );
      const { choices: selected, ...state } = inspected;
      return {
        ...state,
        runtimeGeneration,
        instances: configured.instances.map((instance, index) => ({
          ...selected[index]!,
          instanceId: instance.instanceId,
          configuredBinaryPath: instance.binaryPath || null,
        })),
      } satisfies AgentProviderInstallationState;
    });
  const progress = (operationId: string, state: ProviderInstallState) =>
    operations.progress(operationId, {
      phase:
        state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying"
          ? state.phase
          : "installing",
      downloadedBytes: state.downloadedBytes,
      totalBytes: state.totalBytes,
    });
  const refreshManagedInstances = Effect.gen(function* () {
    const configured = (yield* choices).instances;
    for (const instance of yield* instances.listInstances) {
      const selection = configured.find((choice) => choice.instanceId === instance.instanceId);
      if (!selection || selection.binaryPath || !instance.enabled || !instance.refreshModels)
        continue;
      yield* instance.refreshModels().pipe(Effect.ignore({ log: true }));
      yield* providers.refreshInstance(instance.instanceId).pipe(Effect.ignore({ log: true }));
    }
  });
  const install = (operationId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const before = yield* read();
        if (!before.platform.supported)
          return yield* failure(
            "unsupported_platform",
            "Google does not publish Antigravity for this platform. Choose a custom executable.",
          );
        const started = yield* Effect.acquireRelease(installation.start, (state) =>
          state.operationId === null
            ? Effect.void
            : installation.cancel(state.operationId).pipe(Effect.ignore),
        );
        if (started.operationId === null)
          return yield* failure(
            "installation_failed",
            "The installation did not start. Refresh its state and retry.",
          );
        const terminal = yield* installation.changes.pipe(
          Stream.filter((state) => state.operationId === started.operationId),
          Stream.tap((state) => progress(operationId, state)),
          Stream.filter(
            (state) =>
              state.phase === "succeeded" ||
              state.phase === "failed" ||
              state.phase === "cancelled",
          ),
          Stream.runHead,
        );
        if (Option.isNone(terminal))
          return yield* failure(
            "installation_failed",
            "The installation stopped before it finished.",
          );
        if (terminal.value.phase === "cancelled") return yield* Effect.interrupt;
        if (terminal.value.phase === "failed")
          return yield* failure(
            "installation_failed",
            terminal.value.message ??
              "The installation did not finish. Retry after checking its state.",
          );
        yield* refreshManagedInstances;
        return yield* read();
      }),
    );

  const remove = Effect.gen(function* () {
    const configured = yield* choices;
    const inspected = yield* installation.inspect(configured.instances, configured.protectedPaths);
    if (inspected.removalBlockedBy.length > 0)
      return yield* failure(
        "busy",
        "Stop provider sessions and setup flows, and clear custom paths inside the managed runtime, before removing it.",
      );
    yield* installation.remove(configured.protectedPaths);
    return yield* read();
  });
  return {
    execute: Effect.fn("ProviderInstallationManagement.execute")(function* (
      request: typeof Request.Type,
    ) {
      switch (request.method) {
        case "providers.install.read":
          return yield* read(request.input.refresh);
        case "providers.install.operation.read":
          return yield* operations.read(request.input.operationId);
        case "providers.install.operation.cancel":
          return yield* operations.cancel(request.input.operationId);
        case "providers.install.start":
        case "providers.install.remove": {
          const kind =
            request.method === "providers.install.start"
              ? ("install" as const)
              : ("remove" as const);
          return yield* operations.start(
            {
              operationId: request.input.operationId,
              runtimeGeneration,
              driver: "antigravity",
              kind,
              revision: 1,
              cancellable: kind === "install",
              phase: "running",
              result: null,
              error: null,
            },
            `${request.input.driver}:${kind}`,
            kind === "install" ? install(request.input.operationId) : remove,
          );
        }
      }
    }),
  };
});

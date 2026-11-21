import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ProviderInstanceConfigMap,
} from "@nodex/runtime-contracts";
import { ProviderDriverError } from "@nodex/provider-core/server/errors";
import type { ProviderInstance } from "@nodex/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import {
  AntigravityInstallation,
  AntigravityInstallationError,
  type AntigravityInstallationInspection,
} from "../provider/AntigravityInstallation.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderPolicy, makePolicy } from "./ProviderConfiguration.ts";
import * as Management from "./ProviderInstallationManagement.ts";
import type { AgentProviderInstallationOperation } from "./ProviderInstallationManagementContract.ts";

const driver = ProviderDriverKind.make("antigravity");
const instanceId = ProviderInstanceId.make("personal");
const nativeState: ProviderInstallState = {
  driver,
  operationId: "native-install",
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: "1.5.13",
  installedVersion: null,
  canRemove: false,
  message: null,
};
const inspection: AntigravityInstallationInspection = {
  driver: "antigravity",
  platform: { os: "darwin", arch: "arm64", supported: true },
  managedDirectory: "/managed/antigravity",
  managed: null,
  managedIssue: null,
  path: null,
  choices: [],
  compatibility: null,
  minimumVersion: "1.5.0",
  recommendedVersion: null,
  recommendedRange: ">=1.5.12 <2",
  supportedRanges: [">=1.5.0 <2"],
  latestKnownVersion: null,
  updateAvailable: null,
  leaseCount: 0,
  inUse: false,
  installing: false,
  canRemove: false,
  removalBlockedBy: [],
  managedLock: "clear",
  leaseScope: "runtime",
};
const asOperation = (value: unknown) => {
  if (typeof value !== "object" || value === null || !("phase" in value))
    throw new Error("Expected an installation operation.");
  return value as AgentProviderInstallationOperation;
};
const makeHarness = Effect.fn("ProviderInstallationManagement.test.harness")(function* (
  input: {
    readonly config?: ProviderInstanceConfigMap;
    readonly instances?: ReadonlyArray<ProviderInstance>;
    readonly inUse?: boolean;
    readonly startFailure?: AntigravityInstallationError;
  } = {},
) {
  const started = yield* Deferred.make<void>();
  const removed = yield* Deferred.make<void>();
  const state = yield* SubscriptionRef.make<ProviderInstallState>(nativeState);
  const calls: string[] = [];
  let protectedPaths: ReadonlyArray<string> = [];
  const policy = yield* makePolicy(input.config ?? {});
  const management = yield* Management.make("runtime-test").pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(ProviderPolicy, policy),
        Layer.mock(ProviderInstanceRegistry)({
          listInstances: Effect.succeed(input.instances ?? []),
        }),
        Layer.mock(ProviderRegistry)({
          refreshInstance: (id) =>
            Effect.sync(() => {
              calls.push(`refresh:${id}`);
              return [];
            }),
        }),
        Layer.mock(AntigravityInstallation)({
          managedDirectory: inspection.managedDirectory,
          inspect: (choices = [], paths = []) =>
            Effect.sync(() => {
              protectedPaths = paths;
              return {
                ...inspection,
                inUse: input.inUse ?? false,
                leaseCount: input.inUse ? 1 : 0,
                removalBlockedBy: input.inUse ? ["in_use" as const] : [],
                choices: choices.map((choice) => ({
                  source: choice.binaryPath ? ("custom" as const) : ("unavailable" as const),
                  executablePath: choice.binaryPath || null,
                  version: null,
                  issue: null,
                })),
              };
            }),
          start: Effect.gen(function* () {
            calls.push("install");
            if (input.startFailure) return yield* input.startFailure;
            const next = { ...nativeState, phase: "downloading" as const };
            yield* SubscriptionRef.set(state, next);
            yield* Deferred.succeed(started, undefined);
            return next;
          }),
          changes: SubscriptionRef.changes(state),
          cancel: () =>
            Effect.gen(function* () {
              const current = yield* SubscriptionRef.get(state);
              if (
                current.phase === "downloading" ||
                current.phase === "verifying" ||
                current.phase === "extracting"
              ) {
                calls.push("cancel");
                yield* SubscriptionRef.set(state, { ...current, phase: "cancelled" as const });
              }
              return yield* SubscriptionRef.get(state);
            }),
          remove: (paths) =>
            Effect.sync(() => {
              protectedPaths = paths ?? [];
              calls.push("remove");
            }).pipe(Effect.andThen(Deferred.succeed(removed, undefined)), Effect.asVoid),
        }),
      ),
    ),
  );
  const execute = management.execute;
  const start = (operationId = "host-install") =>
    execute({
      id: operationId,
      method: "providers.install.start",
      input: { driver: "antigravity", operationId },
    });
  const read = (operationId = "host-install") =>
    execute({
      id: "read-operation",
      method: "providers.install.operation.read",
      input: { operationId },
    }).pipe(Effect.map(asOperation));
  const cancel = (operationId = "host-install") =>
    execute({
      id: "cancel-operation",
      method: "providers.install.operation.cancel",
      input: { operationId },
    }).pipe(Effect.map(asOperation));
  return {
    execute,
    start,
    read,
    cancel,
    started,
    removed,
    state,
    calls,
    policy,
    protectedPaths: () => protectedPaths,
  };
});

it.layer(NodeServices.layer)("driver installation management", (it) => {
  it.effect("inspects a driver before any account exists without starting work", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(
        yield* harness.execute({
          id: "read",
          method: "providers.install.read",
          input: { driver: "antigravity" },
        }),
      ).toMatchObject({
        runtimeGeneration: "runtime-test",
        driver: "antigravity",
        instances: [],
        latestKnownVersion: null,
        updateAvailable: null,
        minimumVersion: "1.5.0",
      });
      expect(harness.calls).toEqual([]);
    }),
  );

  it.effect(
    "joins install requests and preserves host identity, progress and cancellation after request scope closes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const first = asOperation(yield* harness.start().pipe(Effect.scoped));
        yield* Deferred.await(harness.started);
        const joined = asOperation(yield* harness.start("another-host-request"));
        expect(joined.operationId).toBe(first.operationId);
        yield* SubscriptionRef.set(harness.state, {
          ...nativeState,
          phase: "verifying",
          downloadedBytes: 100,
          totalBytes: 100,
        });
        yield* TestClock.adjust("1 millis");
        const progress = yield* harness.read();
        expect(progress).toMatchObject({
          phase: "running",
          runtimeGeneration: "runtime-test",
          progress: { phase: "verifying", downloadedBytes: 100, totalBytes: 100 },
        });
        expect(progress.revision).toBeGreaterThan(first.revision);
        expect(yield* harness.cancel()).toMatchObject({ phase: "cancelled", cancellable: false });
        expect(harness.calls).toEqual(["install", "cancel"]);
        expect(yield* harness.read().pipe(Effect.map((value) => value.revision))).toBeGreaterThan(
          progress.revision,
        );
      }),
  );

  it.effect(
    "rejects conflicting work and operation-ID reuse, then permits work after cancellation",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.start();
        yield* Deferred.await(harness.started);
        const remove = (operationId: string) =>
          harness.execute({
            id: operationId,
            method: "providers.install.remove",
            input: { driver: "antigravity", operationId },
          });
        expect(yield* remove("host-install").pipe(Effect.flip)).toMatchObject({
          reason: "invalid_request",
        });
        expect(yield* remove("remove").pipe(Effect.flip)).toMatchObject({ reason: "busy" });
        yield* harness.cancel();
        yield* remove("remove");
        yield* TestClock.adjust("1 millis");
        expect(harness.calls).toEqual(["install", "cancel", "remove"]);
        expect(yield* harness.read("missing").pipe(Effect.flip)).toMatchObject({
          reason: "operation_expired",
        });
      }),
  );

  it.effect("keeps unsafe causes out of public installation failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        startFailure: new AntigravityInstallationError({
          operation: "download",
          detail: "Could not download Antigravity.",
          cause: { stderr: "private-token", environment: { KEY: "private-key" } },
        }),
      });
      yield* harness.start();
      yield* TestClock.adjust("1 millis");
      expect((yield* harness.read()).error).toEqual({
        reason: "download_failed",
        message: "Could not download Antigravity.",
      });
    }),
  );

  it.effect("refuses removal while the managed release has a process lease", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ inUse: true });
      const pending = asOperation(
        yield* harness.execute({
          id: "remove",
          method: "providers.install.remove",
          input: { driver: "antigravity", operationId: "remove" },
        }),
      );
      expect(pending.cancellable).toBe(false);
      yield* TestClock.adjust("1 millis");
      expect(yield* harness.read("remove")).toMatchObject({
        phase: "failed",
        error: { reason: "busy" },
      });
      expect(harness.calls).toEqual([]);
    }),
  );

  it.effect.each([
    { phase: "succeeded", enabled: true, checkFails: false, checks: 1 },
    { phase: "succeeded", enabled: true, checkFails: true, checks: 1 },
    { phase: "succeeded", enabled: false, checkFails: false, checks: 0 },
    { phase: "cancelled", enabled: true, checkFails: false, checks: 0 },
    { phase: "failed", enabled: true, checkFails: false, checks: 0 },
  ] as const)(
    "refreshes managed accounts after $phase, enabled=$enabled, checkFails=$checkFails",
    ({ phase, enabled, checkFails, checks }) =>
      Effect.gen(function* () {
        let refreshed = 0;
        const account: ProviderInstance = {
          instanceId,
          driverKind: driver,
          enabled,
          displayName: undefined,
          continuationIdentity: { driverKind: driver, continuationKey: instanceId },
          get orchestrationAdapter(): never {
            throw new Error("Install routing cannot open sessions.");
          },
          get snapshot(): never {
            throw new Error("Install routing cannot probe status implicitly.");
          },
          get textGeneration(): never {
            throw new Error("Install routing cannot generate text.");
          },
          refreshModels: () =>
            Effect.sync(() => {
              refreshed++;
            }).pipe(
              Effect.andThen(
                checkFails
                  ? Effect.fail(
                      new ProviderDriverError({ driver, instanceId, detail: "No account" }),
                    )
                  : Effect.void,
              ),
            ),
        };
        const harness = yield* makeHarness({
          config: { [instanceId]: { driver, enabled } },
          instances: [account],
        });
        yield* harness.start();
        yield* Deferred.await(harness.started);
        yield* SubscriptionRef.set(harness.state, { ...nativeState, phase });
        yield* TestClock.adjust("1 millis");
        expect(refreshed).toBe(checks);
        expect(harness.calls.filter((call) => call.startsWith("refresh:"))).toHaveLength(checks);
      }),
  );

  it.effect("protects another instance's executable resolved through its environment", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-install-protected-" });
      const executable = path.join(
        directory,
        process.platform === "win32" ? "custom-agy.exe" : "custom-agy",
      );
      yield* fs.writeFileString(executable, "test", { mode: 0o755 });
      const harness = yield* makeHarness({
        config: {
          [instanceId]: {
            driver,
            enabled: false,
            config: { binaryPath: path.basename(executable) },
            environment: [{ name: "PATH", value: directory, sensitive: false }],
          },
        },
      });
      yield* harness.execute({
        id: "remove",
        method: "providers.install.remove",
        input: { driver: "antigravity", operationId: "remove" },
      });
      yield* Deferred.await(harness.removed);
      expect(harness.protectedPaths()).toContain(executable);
      expect(harness.calls).toEqual(["remove"]);
    }),
  );
});

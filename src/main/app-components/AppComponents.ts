import { join } from "node:path";
import type { Done } from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  EMPTY_APP_COMPONENTS_STATE,
  type AppComponentId,
  type AppComponentInstallation,
  type AppComponentState,
  type AppComponentFailureReason,
  type AppComponentsState,
  type SetAppComponentEnabledInput,
} from "../../shared/app-components";
import { WorktreeShellEnvironmentRuntime } from "../host-runtime/WorktreeShellEnvironmentRuntime";
import { MainConfig } from "../app/MainConfig";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { codexSeedArtifactSizes } from "./definitions/codex";
import { AppComponentActivation } from "./AppComponentActivation";
import {
  appComponentCatalog,
  appComponentHome,
  type AppComponentDefinition,
  type AppComponentTarget,
} from "./AppComponentCatalog";
import { AppComponentInstallError, type ComponentFetch } from "./AppComponentDownload";
import {
  componentNetworkRetryDelay,
  installComponent,
  makeAppComponentPrefetch,
  makeComponentInstaller,
  type AppComponentUpdate,
} from "./AppComponentPrefetch";
import {
  appComponentRoot,
  hasAppComponentWanted,
  installedAppComponentBytes,
  removeAppComponentFiles,
  removeAppComponentRoot,
  setAppComponentTombstone,
  setAppComponentWanted,
} from "./AppComponentStore";

export class AppComponentFetch extends Context.Service<
  AppComponentFetch,
  { readonly fetch: ComponentFetch }
>()("nodex/main/app-components/AppComponentFetch") {}

export class AppComponentsError extends Schema.TaggedError<AppComponentsError>()(
  "AppComponentsError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export type AppComponentAvailability =
  | { readonly status: "installed"; readonly root: string }
  | {
      readonly status: "unavailable";
      readonly reason: "not-offered" | "turned-off" | "failed";
      readonly message: string;
    };

export class AppComponents extends Context.Service<
  AppComponents,
  {
    readonly read: Effect.Effect<AppComponentsState>;
    readonly setEnabled: (
      input: SetAppComponentEnabledInput,
    ) => Effect.Effect<AppComponentsState, AppComponentsError>;
    readonly retry: (id: AppComponentId) => Effect.Effect<AppComponentsState>;
    /** Mark wanted and wait for activation, a terminal failure, or removal. */
    readonly ensure: (id: AppComponentId) => Effect.Effect<AppComponentAvailability>;
    /** Mark wanted and queue installation without waiting for it. */
    readonly request: (id: AppComponentId) => Effect.Effect<void>;
    readonly changes: Stream.Stream<AppComponentsState>;
    readonly prefetchUpdate: (update: AppComponentUpdate) => Effect.Effect<void>;
  }
>()("nodex/main/app-components/AppComponents") {}

const settingsError = (cause: unknown) =>
  new AppComponentsError({ message: "Nodex could not save the component preference.", cause });
const storeError = (cause: unknown) =>
  new AppComponentsError({ message: "Nodex could not update the component store.", cause });
const store = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: storeError });

/** Reconcile the startup settings snapshot before resolving any published component. */
export const reconcileDisabledAppComponents = Effect.fnUntraced(function* (
  input: AppComponentTarget & { readonly nodexHome: string },
  disabled: readonly AppComponentId[],
) {
  yield* Effect.forEach(
    appComponentCatalog(input).filter(({ id }) => disabled.includes(id)),
    ({ id }) => store(() => setAppComponentTombstone(appComponentHome(input), id, true)),
    { discard: true },
  );
});

const notInstalled = { status: "not-installed" } as const;
const onDemand = { status: "on-demand" } as const;
const queued = { status: "queued" } as const;
const notOffered = {
  status: "unavailable",
  reason: "not-offered",
  message: "This build of Nodex does not offer this component.",
} as const;
const unavailable = (reason: "turned-off" | "failed", message: string) =>
  ({ status: "unavailable", reason, message }) as const;
const noComponents = AppComponents.of({
  read: Effect.succeed(EMPTY_APP_COMPONENTS_STATE),
  setEnabled: () => Effect.succeed(EMPTY_APP_COMPONENTS_STATE),
  retry: () => Effect.succeed(EMPTY_APP_COMPONENTS_STATE),
  ensure: () => Effect.succeed(notOffered),
  request: () => Effect.void,
  changes: Stream.empty,
  prefetchUpdate: () => Effect.void,
});

export const make = Effect.gen(function* () {
  const config = yield* MainConfig;
  const catalog = appComponentCatalog(config);
  if (catalog.length === 0) return noComponents;
  const home = appComponentHome(config);
  const settings = yield* ApplicationSettings;
  const activation = yield* AppComponentActivation;
  const { fetch } = yield* AppComponentFetch;
  const state = yield* SubscriptionRef.make<AppComponentsState>(EMPTY_APP_COMPONENTS_STATE);
  const tasks = yield* FiberMap.make<AppComponentId, void>();
  const commands = yield* Semaphore.make(1);
  const installer = yield* makeComponentInstaller;
  const shell = Option.getOrUndefined(yield* Effect.serviceOption(WorktreeShellEnvironmentRuntime));
  const isolated = Boolean(config.isolatedRunId);

  const read = SubscriptionRef.get(state);
  const changes = SubscriptionRef.changes(state);
  const definitions = new Map(catalog.map((definition) => [definition.id, definition]));
  const publish = (
    id: AppComponentId,
    patch: Partial<Pick<AppComponentState, "enabled" | "installation" | "removalPending">>,
  ) =>
    SubscriptionRef.modify(state, (previous) => {
      const snapshot = {
        revision: previous.revision + 1,
        components: previous.components.map((component) =>
          component.id === id ? { ...component, ...patch } : component,
        ),
      };
      return [snapshot, snapshot];
    });
  const updateInstallation = (id: AppComponentId, installation: AppComponentInstallation) =>
    publish(id, { installation });
  const logFailure = (
    id: AppComponentId,
    reason: AppComponentFailureReason,
    retryAt: number | null,
  ) =>
    Effect.logWarning("Component installation failed").pipe(
      Effect.annotateLogs({ component: id, reason, retryAt }),
    );

  const download = Effect.fnUntraced(function* (definition: AppComponentDefinition) {
    const { id, archive } = definition;
    // Progress is a latest-wins signal: a slow reader skips stale byte counts, never the newest.
    const events = yield* Queue.sliding<AppComponentInstallation, Done>(16);
    const resolvedShell =
      id === "codex" && shell && !isolated
        ? yield* shell.load.pipe(Effect.orElseSucceed(() => config.environment))
        : config.environment;
    const operation = installComponent({
      home,
      definition,
      fetch,
      codexSeedSearch:
        id === "codex"
          ? {
              home: config.homeDirectory,
              artifactSizes: codexSeedArtifactSizes,
              searchPath: [resolvedShell.PATH, config.environmentPath].filter(Boolean).join(":"),
              isolated,
            }
          : undefined,
      codexNoticesDirectory: config.isPackaged
        ? join(config.resourcesPath, "third-party", "codex")
        : join(config.projectRootPath, "resources", "third-party", "codex"),
      onProgress: (receivedBytes) => {
        Queue.offerUnsafe(events, {
          status: "downloading",
          receivedBytes,
          totalBytes: archive.size,
        });
      },
      onInstalling: () => {
        Queue.offerUnsafe(events, { status: "installing" });
      },
    }).pipe(Effect.result, Effect.ensuring(Queue.end(events)));
    // Drain earlier progress before publishing the terminal snapshot, even on a fast failure.
    const [result] = yield* Effect.all(
      [
        operation,
        Stream.fromQueue(events).pipe(
          Stream.runForEach((status) => updateInstallation(id, status)),
        ),
      ],
      { concurrency: 2 },
    );
    return yield* Effect.fromResult(result);
  });

  /** Hand published files to the running app, or delete the ones this build refuses. */
  const admit = (definition: AppComponentDefinition, installedBytes: number) =>
    // Commit activation or rejection before allowing a disable command to inspect activity.
    Effect.uninterruptible(
      Effect.gen(function* () {
        const { id } = definition;
        const result = (yield* activation.isActive(id))
          ? { status: "active" as const }
          : yield* activation.activate(id);
        if (result.status === "rejected") {
          yield* store(() => removeAppComponentFiles(home, definition, false));
          return result;
        }
        yield* updateInstallation(id, { status: "installed", installedBytes });
        yield* Effect.logInfo("Component installed").pipe(Effect.annotateLogs({ component: id }));
        return result;
      }),
    );

  const attempt = Effect.fn("AppComponents.install")(function* (
    definition: AppComponentDefinition,
  ) {
    const existingBytes = yield* store(() => installedAppComponentBytes(home, definition));
    if (existingBytes !== null && (yield* admit(definition, existingBytes)).status === "active")
      return;
    if (existingBytes === null) yield* store(() => removeAppComponentRoot(home, definition));
    // Files found on disk that this build refused are gone; a clean download replaces them.
    const result = yield* admit(definition, yield* download(definition));
    if (result.status === "rejected")
      return yield* Effect.fail(new AppComponentInstallError("rejected", result.message));
  });

  const run = Effect.fnUntraced(function* (definition: AppComponentDefinition) {
    const { id } = definition;
    let networkFailures = 0;
    let integrityRetried = false;
    for (;;) {
      const result = yield* installer.foreground(attempt(definition)).pipe(Effect.result);
      if (result._tag === "Success") return;
      const error = result.failure;
      const reason = error instanceof AppComponentInstallError ? error.reason : "unknown";
      let delay: number | null = null;
      if (reason === "network") {
        delay = yield* componentNetworkRetryDelay(networkFailures);
        networkFailures += 1;
      }
      if (reason === "integrity" && !integrityRetried) {
        integrityRetried = true;
        delay = 0;
      }
      const retryAt = delay === null ? null : (yield* Clock.currentTimeMillis) + delay;
      yield* updateInstallation(id, { status: "failed", reason, message: error.message, retryAt });
      yield* logFailure(id, reason, retryAt);
      if (delay === null) return;
      yield* Effect.sleep(delay);
      yield* updateInstallation(id, queued);
    }
  });
  const start = (definition: AppComponentDefinition) =>
    FiberMap.run(tasks, definition.id, run(definition).pipe(Effect.interruptible), {
      startImmediately: false,
    });
  const changePreference = (input: SetAppComponentEnabledInput) =>
    settings.update({ type: "update-app-component", input }).pipe(Effect.mapError(settingsError));
  const failToPrepare = (id: AppComponentId, error: AppComponentsError) =>
    updateInstallation(id, {
      status: "failed",
      reason: "unknown",
      message: error.message,
      retryAt: null,
    }).pipe(Effect.andThen(logFailure(id, "unknown", null)));

  const queue = Effect.fnUntraced(function* (definition: AppComponentDefinition) {
    yield* updateInstallation(definition.id, queued);
    yield* start(definition);
  });

  const markWanted = (definition: AppComponentDefinition) =>
    definition.install === "on-first-use"
      ? store(() => setAppComponentWanted(home, definition.id, true))
      : Effect.void;

  const disable = Effect.fnUntraced(function* (
    definition: AppComponentDefinition,
    persist: boolean,
  ) {
    const { id } = definition;
    // Write the marker first so a shutdown between the preference write and removal is safe.
    const mark = (pending: boolean) => store(() => setAppComponentTombstone(home, id, pending));
    yield* mark(true);
    if (persist) {
      yield* changePreference({ id, enabled: false }).pipe(
        Effect.onError(() => mark(false).pipe(Effect.ignore)),
      );
      // Stop admitting callers as soon as the preference is saved, even if an in-flight
      // activation has cleanup to finish before the removal state is known.
      yield* publish(id, { enabled: false });
    }
    yield* FiberMap.remove(tasks, id);
    const active = yield* activation.isActive(id);
    const bytes = active ? yield* store(() => installedAppComponentBytes(home, definition)) : null;
    yield* store(() => setAppComponentWanted(home, id, false));
    yield* store(() => removeAppComponentFiles(home, definition, active));
    yield* Effect.logInfo(active ? "Component removal scheduled" : "Component removed").pipe(
      Effect.annotateLogs({ component: id }),
    );
    return yield* publish(id, {
      enabled: false,
      removalPending: bytes !== null,
      installation: bytes === null ? notInstalled : { status: "installed", installedBytes: bytes },
    });
  });

  const initialize = Effect.gen(function* () {
    const preferences = yield* settings.snapshot().pipe(Effect.result);
    if (preferences._tag === "Failure") {
      yield* Effect.logWarning("Could not read component preferences");
      return;
    }
    const disabled = preferences.success.disabledAppComponents;
    // A component startup already loaded reads as installed from the first snapshot.
    const loaded = yield* Effect.forEach(catalog, (definition) =>
      Effect.gen(function* () {
        if (disabled.includes(definition.id) || !(yield* activation.isActive(definition.id)))
          return null;
        return yield* store(() => installedAppComponentBytes(home, definition)).pipe(
          Effect.orElseSucceed(() => null),
        );
      }),
    );
    yield* SubscriptionRef.set(state, {
      revision: 1,
      components: catalog.map(({ id, archive, install }, index) => {
        const installedBytes = loaded[index] ?? null;
        return {
          id,
          enabled: !disabled.includes(id),
          downloadBytes: archive.size,
          installation: disabled.includes(id)
            ? notInstalled
            : installedBytes === null
              ? install === "at-startup"
                ? queued
                : onDemand
              : { status: "installed" as const, installedBytes },
          removalPending: false,
        };
      }),
    });
    for (const definition of catalog) {
      const { id } = definition;
      yield* Effect.gen(function* () {
        if (disabled.includes(id)) return yield* disable(definition, false);
        yield* store(() => setAppComponentTombstone(home, id, false));
        if (definition.install === "on-first-use") {
          if (id === "codex" && preferences.success.codexExecutable?.activeExecutable) return;
          const wanted = yield* store(() => hasAppComponentWanted(home, id));
          if (!wanted) return;
          const component = (yield* read).components.find((entry) => entry.id === id);
          if (component?.installation.status !== "installed") yield* updateInstallation(id, queued);
        }
        return yield* start(definition);
      }).pipe(Effect.catch((error) => failToPrepare(id, error)));
    }
  });
  const initialization = yield* initialize.pipe(Effect.forkScoped({ startImmediately: false }));
  const afterInitialization = Fiber.join(initialization);
  const command = <A, E>(effect: Effect.Effect<A, E>) =>
    afterInitialization.pipe(
      Effect.andThen(commands.withPermits(1)(effect.pipe(Effect.uninterruptible))),
    );
  const request = Effect.fn("AppComponents.request")(function* (id: AppComponentId) {
    const definition = definitions.get(id);
    const component = (yield* read).components.find((entry) => entry.id === id);
    if (!definition || !component?.enabled || component.installation.status !== "on-demand") return;
    yield* markWanted(definition).pipe(
      Effect.andThen(queue(definition)),
      Effect.catch((error) => failToPrepare(id, error)),
    );
  }, command);
  const ensure = Effect.fn("AppComponents.ensure")(function* (id: AppComponentId) {
    const definition = definitions.get(id);
    if (!definition) return notOffered;
    yield* request(id);
    const result = yield* changes.pipe(
      Stream.filterMap((snapshot): Result.Result<AppComponentAvailability, void> => {
        const component = snapshot.components.find((entry) => entry.id === id);
        if (!component)
          return Result.succeed(
            unavailable("failed", "Nodex could not read component preferences."),
          );
        if (!component.enabled)
          return Result.succeed(
            unavailable(
              "turned-off",
              "This component is turned off in Settings → General → Components.",
            ),
          );
        const { installation } = component;
        if (installation.status === "installed")
          return Result.succeed({
            status: "installed",
            root: appComponentRoot(home, definition),
          } as const);
        if (installation.status === "failed" && installation.retryAt === null)
          return Result.succeed(unavailable("failed", installation.message));
        return Result.failVoid;
      }),
      Stream.runHead,
    );
    return Option.getOrThrow(result);
  });

  const prefetch = yield* makeAppComponentPrefetch({
    store: { home, target: config },
    appBuildVersion: config.appBuildVersion,
    catalog,
    fetch,
    installer,
    read,
    changes,
    initialized: afterInitialization,
  });

  return AppComponents.of({
    read,
    prefetchUpdate: prefetch.schedule,
    setEnabled: Effect.fn("AppComponents.setEnabled")(function* (
      input: SetAppComponentEnabledInput,
    ) {
      const snapshot = yield* read;
      const definition = definitions.get(input.id);
      const component = snapshot.components.find(({ id }) => id === input.id);
      if (!definition || !component || component.enabled === input.enabled) return snapshot;
      if (!input.enabled) {
        const disabled = yield* disable(definition, true);
        yield* prefetch
          .remove(input.id)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not remove staged component", { cause }),
            ),
          );
        return disabled;
      }
      yield* changePreference(input);
      yield* store(() => setAppComponentTombstone(home, input.id, false));
      if (component.removalPending && (yield* activation.isActive(input.id))) {
        yield* markWanted(definition);
        return yield* publish(input.id, { enabled: true, removalPending: false });
      }
      if (definition.install === "on-first-use") {
        return yield* publish(input.id, {
          enabled: true,
          installation: onDemand,
          removalPending: false,
        });
      }
      yield* publish(input.id, { enabled: true, installation: queued, removalPending: false });
      yield* start(definition);
      return yield* read;
    }, command),
    retry: Effect.fn("AppComponents.retry")(function* (id: AppComponentId) {
      const snapshot = yield* read;
      const definition = definitions.get(id);
      const component = snapshot.components.find((entry) => entry.id === id);
      if (!definition || !component?.enabled || component.installation.status !== "failed")
        return snapshot;
      yield* FiberMap.remove(tasks, id);
      yield* markWanted(definition).pipe(
        Effect.andThen(queue(definition)),
        Effect.catch((error) => failToPrepare(id, error)),
      );
      return yield* read;
    }, command),
    ensure,
    request,
    changes,
  });
});

export const live = Layer.effect(AppComponents, make);

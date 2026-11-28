import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  appComponentManifestName,
  appComponentManifestSchema,
  appComponentManifestTarget,
  type AppComponentManifestTarget,
  appComponentReleaseVersion,
} from "../../shared/app-component-manifest";
import { appBuildOrdinal } from "../../shared/app-version";
import type { AppComponentId, AppComponentsState } from "../../shared/app-components";
import type { AppUpdaterEvent } from "../app-updater";
import type { AppComponentDefinition } from "./AppComponentCatalog";
import {
  AppComponentInstallError,
  fetchComponentManifest,
  type ComponentFetch,
} from "./AppComponentDownload";
import {
  installAppComponent,
  installedAppComponentBytes,
  updateNextAppComponents,
  type AppComponentStoreInput,
} from "./AppComponentStore";

type ReadyEvent = Extract<AppUpdaterEvent, { type: "update-ready" }>;
export type AppComponentUpdate = {
  readonly target: AppComponentManifestTarget;
  readonly version: string;
  readonly buildVersion: string;
  readonly manifestUrl: string;
};

/** Full and delta enclosures use the same immutable release tag. */
export function appComponentUpdate(
  event: ReadyEvent,
  channel: "stable" | "nightly",
  hostTarget: string,
): AppComponentUpdate | null {
  const target = appComponentManifestTarget.safeParse(hostTarget).data;
  if (!target) return null;
  const { version, buildVersion, verifiedEnclosureUrl } = event;
  const ordinal = appBuildOrdinal(buildVersion);
  if (!verifiedEnclosureUrl || !appComponentReleaseVersion.safeParse(version).success || !ordinal)
    return null;
  const url = URL.parse(verifiedEnclosureUrl);
  if (
    url?.origin !== "https://github.com" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return null;
  const path = /^\/junyudev\/nodex\/releases\/download\/(v[^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (!path) return null;
  const [, tag, asset] = path;
  const stableTag = `v${version}`;
  const nightlyDate = tag.slice(stableTag.length + "-nightly.".length).split(".")[0];
  const channelTag =
    channel === "stable" ? stableTag : `${stableTag}-nightly.${nightlyDate}.${ordinal}`;
  if (tag !== channelTag || (channel === "nightly" && !/^\d{8}$/u.test(nightlyDate))) return null;
  const matchesTarget =
    target === "win32-x64"
      ? asset === `Nodex-${version}-windows-x64.exe`
      : asset === `Nodex-${version}-arm64.tar.xz` ||
        asset === `Nodex-${version}-arm64.zip` ||
        (asset.startsWith("Nodex-") && asset.endsWith(`-to-${version}-arm64.delta`));
  if (!matchesTarget) return null;
  return {
    target,
    version,
    buildVersion,
    manifestUrl: new URL(appComponentManifestName(version, target), url).href,
  };
}

export const componentNetworkRetryDelay = (failures: number) =>
  Random.nextBetween(0.75, 1).pipe(
    Effect.map((jitter) =>
      Math.round(Math.min(5 * 60_000, 2_000 * 2 ** Math.min(failures, 8)) * jitter),
    ),
  );

/** Both foreground and speculative installs use the same cancellable filesystem adapter. */
export function installComponent(input: Omit<Parameters<typeof installAppComponent>[0], "signal">) {
  return Effect.callback<number, AppComponentInstallError>((resume, signal) => {
    const finished = installAppComponent({ ...input, signal }).then(
      (bytes) => resume(Effect.succeed(bytes)),
      (cause: unknown) =>
        resume(
          Effect.fail(
            cause instanceof AppComponentInstallError
              ? cause
              : new AppComponentInstallError("unknown", "Nodex could not install this component.", {
                  cause,
                }),
          ),
        ),
    );
    // Join adapter cleanup before releasing the install permit or removing partial files.
    return Effect.promise(() => finished);
  });
}

export const makeComponentInstaller = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  // Count contenders as well as the current holder, so prefetch yields through the whole queue.
  const foregroundCount = yield* SubscriptionRef.make(0);
  const waitForForeground = (busy: boolean) =>
    SubscriptionRef.changes(foregroundCount).pipe(
      Stream.filter((count) => count > 0 === busy),
      Stream.runHead,
    );
  const foreground = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      SubscriptionRef.update(foregroundCount, (count) => count + 1),
      () => semaphore.withPermit(operation),
      () => SubscriptionRef.update(foregroundCount, (count) => count - 1),
    );
  const background = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      for (;;) {
        yield* waitForForeground(false);
        const result = yield* Effect.raceFirst(
          semaphore.withPermit(
            SubscriptionRef.get(foregroundCount).pipe(
              Effect.flatMap((count) =>
                count > 0 ? Effect.succeed(Option.none()) : Effect.asSome(operation),
              ),
            ),
          ),
          waitForForeground(true).pipe(Effect.as(Option.none())),
        );
        if (Option.isSome(result)) return result.value;
      }
    });
  return { foreground, background };
});

export const makeAppComponentPrefetch = Effect.fnUntraced(function* (input: {
  readonly store: AppComponentStoreInput;
  readonly appBuildVersion: string | undefined;
  readonly catalog: readonly AppComponentDefinition[];
  readonly fetch: ComponentFetch;
  readonly installer: Effect.Success<typeof makeComponentInstaller>;
  readonly read: Effect.Effect<AppComponentsState>;
  readonly changes: Stream.Stream<AppComponentsState>;
  readonly initialized: Effect.Effect<void>;
}) {
  const { catalog, store, fetch, installer, changes } = input;
  const updates = yield* SubscriptionRef.make<AppComponentUpdate | null>(null);
  const currentBuild = appBuildOrdinal(input.appBuildVersion);
  const record = yield* Semaphore.make(1);
  const stages = new Map(catalog.map(({ id }) => [id, Semaphore.makeUnsafe(1)]));
  const updateRecord = (update: Parameters<typeof updateNextAppComponents>[1]) =>
    Effect.tryPromise(() => updateNextAppComponents(store, update)).pipe(Effect.uninterruptible);
  const remove = (id: AppComponentId) => {
    const stageGate = stages.get(id);
    if (!stageGate) return Effect.void;
    // Join this Component's aborted staging before deleting its files.
    return stageGate.withPermit(
      record.withPermit(
        updateRecord((previous) => {
          if (!previous?.components.some((entry) => entry.id === id)) return previous;
          return {
            ...previous,
            components: previous.components.filter((entry) => entry.id !== id),
          };
        }),
      ),
    );
  };

  const stage = Effect.fnUntraced(function* (definition: AppComponentDefinition) {
    const { id } = definition;
    const stageGate = stages.get(id);
    if (!stageGate) return;
    const disabled = changes.pipe(
      Stream.filter((state) => state.components.some((entry) => entry.id === id && !entry.enabled)),
      Stream.runHead,
    );
    const download = stageGate.withPermit(
      installer.background(
        Effect.gen(function* () {
          const component = (yield* input.read).components.find((entry) => entry.id === id);
          if (!component?.enabled || component.installation.status !== "installed") return;
          if (
            (yield* Effect.tryPromise(() => installedAppComponentBytes(store, definition))) !== null
          )
            return;
          yield* installComponent({
            ...store,
            definition,
            fetch,
            onProgress: () => {},
            onInstalling: () => {},
            prefetch: true,
          });
          yield* Effect.logInfo("Component staged for the next Nodex build").pipe(
            Effect.annotateLogs({ component: id }),
          );
        }),
      ),
    );
    const retry = Effect.gen(function* () {
      for (let failures = 0; ; failures += 1) {
        const result = yield* Effect.result(download);
        if (result._tag === "Success") return;
        if (
          result.failure instanceof AppComponentInstallError &&
          result.failure.reason === "disk-space"
        )
          return;
        if (
          !(result.failure instanceof AppComponentInstallError) ||
          result.failure.reason !== "network"
        )
          return yield* Effect.fail(result.failure);
        yield* Effect.sleep(yield* componentNetworkRetryDelay(failures));
      }
    });
    yield* Effect.raceFirst(retry, disabled);
  });

  const prefetch = Effect.fnUntraced(function* (update: AppComponentUpdate) {
    yield* input.initialized;
    const manifest = yield* Effect.tryPromise((signal) =>
      fetchComponentManifest(update.manifestUrl, fetch, signal),
    ).pipe(
      Effect.timeout("30 seconds"),
      Effect.map((raw) => appComponentManifestSchema.safeParse(raw).data),
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !manifest ||
      manifest.target !== update.target ||
      manifest.version !== update.version ||
      manifest.buildVersion !== update.buildVersion
    ) {
      yield* record.withPermit(
        updateRecord((previous) =>
          previous?.buildVersion === update.buildVersion ? previous : null,
        ),
      );
      yield* Effect.logDebug("Component manifest is unavailable or does not match the app update");
      return;
    }
    const definitions = yield* installer.background(
      record.withPermit(
        Effect.gen(function* () {
          const { components } = yield* input.read;
          const desired = manifest.components.filter(
            (next) =>
              catalog.some((current) => current.id === next.id) &&
              !catalog.some((current) => current.archive.sha256 === next.archive.sha256) &&
              components.some(
                (current) =>
                  current.id === next.id &&
                  current.enabled &&
                  current.installation.status === "installed",
              ),
          );
          yield* updateRecord(() =>
            desired.length
              ? {
                  buildVersion: update.buildVersion,
                  components: desired.map(({ id, archive }) => ({ id, sha256: archive.sha256 })),
                }
              : null,
          );
          return desired;
        }).pipe(Effect.uninterruptible),
      ),
    );
    yield* Effect.forEach(definitions, stage, { discard: true });
  });

  yield* SubscriptionRef.changes(updates).pipe(
    Stream.changesWith(
      (left, right) =>
        left?.target === right?.target &&
        left?.manifestUrl === right?.manifestUrl &&
        left?.buildVersion === right?.buildVersion,
    ),
    Stream.switchMap((update) =>
      update === null
        ? Stream.empty
        : Stream.fromEffect(
            prefetch(update).pipe(
              Effect.catch((cause) => Effect.logDebug("Component prefetch stopped", { cause })),
            ),
          ),
    ),
    Stream.runDrain,
    Effect.interruptible,
    Effect.forkScoped({ startImmediately: false }),
  );
  return {
    remove,
    schedule: (update: AppComponentUpdate) => {
      const nextBuild = appBuildOrdinal(update.buildVersion);
      if (currentBuild === null || nextBuild === null || nextBuild <= currentBuild)
        return Effect.void;
      return SubscriptionRef.set(updates, update);
    },
  };
});

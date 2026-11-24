import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { PluginCatalogSnapshot } from "./PluginCatalog";

/** How long one authoritative read of the installed plugins may take before it is abandoned. */
export const PLUGIN_CATALOG_LOAD_DEADLINE = "60 seconds";

export interface LoadedPluginCatalog {
  readonly snapshot: PluginCatalogSnapshot;
  readonly isCurrent: Effect.Effect<boolean>;
}

/**
 * The latest installed plugins the Host has read for each Project. Readers never wait on the
 * plugin inventory for longer than they ask: a reread runs once per Project in the background
 * whenever plugin state may have changed, and a failed reread keeps the last good catalog.
 */
export interface PluginCatalogCache {
  /**
   * Waits at most `maxWait` for a reread in progress, then answers with the latest catalog, or
   * null before the first one. `freshOnly` answers null rather than with a catalog that a
   * change has made stale.
   */
  readonly read: (
    projectId: string | null,
    options: { readonly maxWait: Duration.Input; readonly freshOnly?: boolean },
  ) => Effect.Effect<PluginCatalogSnapshot | null>;
  /** The latest loaded revision, without waiting for a catalog read or publication. */
  readonly latestRevision: (projectId: string | null) => string | null;
  /** Emits when a Project's catalog revision changes. */
  readonly published: Stream.Stream<{
    readonly projectId: string | null;
    readonly revision: string | null;
  }>;
}

interface CatalogCell {
  latest: LoadedPluginCatalog | null;
  stale: boolean;
  reloadRequested: boolean;
  inFlight: Deferred.Deferred<void> | null;
}

export const makePluginCatalogCache = Effect.fn("PluginCatalogCache.make")(function* (input: {
  readonly load: (projectId: string | null) => Effect.Effect<LoadedPluginCatalog | null, unknown>;
  readonly invalidations: Stream.Stream<unknown>;
}): Effect.fn.Return<PluginCatalogCache, never, Scope.Scope> {
  const owner = yield* Effect.scope;
  const cells = new Map<string | null, CatalogCell>();
  // Revocation follows publications, so a slow subscriber holds up the reread instead of
  // missing a revision.
  const publications = yield* PubSub.bounded<Stream.Success<PluginCatalogCache["published"]>>(64);
  yield* Effect.addFinalizer(() => PubSub.shutdown(publications));

  const reload = Effect.fnUntraced(function* (projectId: string | null, cell: CatalogCell) {
    while (cell.inFlight) {
      const completed = cell.inFlight;
      const previous = cell.latest?.snapshot.revision ?? null;
      const started = yield* Clock.currentTimeMillis;
      const result = yield* Effect.suspend(() => input.load(projectId)).pipe(
        Effect.timeout(PLUGIN_CATALOG_LOAD_DEADLINE),
        Effect.exit,
      );
      if (Exit.isFailure(result)) {
        const now = yield* Clock.currentTimeMillis;
        yield* Effect.logWarning("Could not refresh the plugin catalog").pipe(
          Effect.annotateLogs({ elapsedMs: now - started, hadSnapshot: previous !== null }),
        );
      } else {
        cell.latest = result.value;
      }

      const revision = cell.latest?.snapshot.revision ?? null;
      if (revision !== previous) yield* PubSub.publish(publications, { projectId, revision });
      // Read the follow-up request and hand over the in-flight marker in one synchronous step.
      const next = yield* Deferred.make<void>();
      const followUp = cell.reloadRequested;
      cell.stale = followUp || Exit.isFailure(result);
      cell.inFlight = followUp ? next : null;
      cell.reloadRequested = false;
      yield* Deferred.succeed(completed, undefined);
      if (!followUp) return;
    }
  });

  const ensureLoad = Effect.fnUntraced(function* (projectId: string | null, cell: CatalogCell) {
    const pending = yield* Deferred.make<void>();
    if (cell.inFlight) return cell.inFlight;
    cell.stale = true;
    cell.inFlight = pending;
    // A reply can stop waiting while the Host finishes refreshing the catalog.
    yield* reload(projectId, cell).pipe(Effect.forkIn(owner, { uninterruptible: false }));
    return pending;
  }, Effect.uninterruptible);

  yield* input.invalidations.pipe(
    Stream.runForEach(() =>
      Effect.gen(function* () {
        for (const cell of cells.values()) {
          cell.stale = true;
          if (cell.inFlight) cell.reloadRequested = true;
        }
        yield* Effect.forEach(cells, ([projectId, cell]) => ensureLoad(projectId, cell), {
          discard: true,
        });
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  );

  const read: PluginCatalogCache["read"] = Effect.fnUntraced(function* (
    projectId,
    { maxWait, freshOnly },
  ) {
    const cell = cells.get(projectId) ?? {
      latest: null,
      stale: true,
      reloadRequested: false,
      inFlight: null,
    };
    cells.set(projectId, cell);
    const observed = cell.stale ? null : cell.latest;
    const pending = observed ? null : yield* ensureLoad(projectId, cell);
    let validating = false;
    const snapshot = yield* Effect.gen(function* () {
      if (observed) {
        validating = true;
        const current = yield* observed.isCurrent.pipe(
          Effect.catchDefect(() => Effect.succeed(false)),
        );
        validating = false;
        if (observed === cell.latest && !current) cell.stale = true;
        if (!cell.stale) return cell.latest?.snapshot ?? null;
      }
      yield* Deferred.await(pending ?? (yield* ensureLoad(projectId, cell)));
      if (freshOnly) {
        while (cell.stale && cell.inFlight) yield* Deferred.await(cell.inFlight);
        if (cell.stale) return null;
      }
      return cell.latest?.snapshot ?? null;
    }).pipe(Effect.timeoutOption(maxWait));

    if (Option.isSome(snapshot)) return snapshot.value;
    if (validating && observed === cell.latest) yield* ensureLoad(projectId, cell);
    return freshOnly && cell.stale ? null : (cell.latest?.snapshot ?? null);
  });

  return {
    read,
    latestRevision: (projectId) => cells.get(projectId)?.latest?.snapshot.revision ?? null,
    published: Stream.fromPubSub(publications),
  };
});

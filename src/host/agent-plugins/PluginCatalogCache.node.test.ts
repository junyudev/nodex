import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vitest";
import {
  makePluginCatalogCache,
  PLUGIN_CATALOG_LOAD_DEADLINE,
  type LoadedPluginCatalog,
  type PluginCatalogCache,
} from "./PluginCatalogCache";

const wait = { maxWait: "5 seconds" } as const;
const fresh = { maxWait: PLUGIN_CATALOG_LOAD_DEADLINE, freshOnly: true } as const;
const loaded = (revision: string, isCurrent = Effect.succeed(true)): LoadedPluginCatalog => ({
  snapshot: { revision, entries: [] },
  isCurrent,
});

const harness = Effect.gen(function* () {
  const invalidations = yield* PubSub.unbounded<void>();
  const pending = yield* Queue.unbounded<Deferred.Deferred<LoadedPluginCatalog | null, unknown>>();
  const published = yield* Queue.unbounded<Stream.Success<PluginCatalogCache["published"]>>();
  let loadCount = 0;
  const catalog = yield* makePluginCatalogCache({
    load: Effect.fnUntraced(function* () {
      const response = yield* Deferred.make<LoadedPluginCatalog | null, unknown>();
      loadCount++;
      yield* Queue.offer(pending, response);
      return yield* Deferred.await(response);
    }),
    invalidations: Stream.fromPubSub(invalidations),
  });
  yield* catalog.published.pipe(
    Stream.runForEach((event) => Queue.offer(published, event)),
    Effect.forkScoped({ startImmediately: true }),
  );
  return {
    catalog,
    read: (options: Parameters<PluginCatalogCache["read"]>[1] = wait) =>
      catalog.read("project-a", options).pipe(Effect.forkScoped({ startImmediately: true })),
    invalidate: PubSub.publish(invalidations, undefined),
    nextLoad: Queue.take(pending),
    nextPublication: Queue.take(published),
    publicationCount: Queue.size(published),
    loadCount: () => loadCount,
  };
});

it.effect("bounds a cold read and publishes when the shared load eventually finishes", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const reading = yield* f.read();
    const pending = yield* f.nextLoad;
    yield* TestClock.adjust("4999 millis");
    expect(reading.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust("1 millis");
    expect(yield* Fiber.join(reading)).toBeNull();

    const latest = loaded("first");
    yield* Deferred.succeed(pending, latest);
    expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "first" });
    expect(yield* f.catalog.read("project-a", wait)).toBe(latest.snapshot);
    expect(f.loadCount()).toBe(1);
  }),
);

it.effect("shares one cold load even if one reader is interrupted", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const first = yield* f.read();
    const pending = yield* f.nextLoad;
    yield* Fiber.interrupt(first);
    const second = yield* f.read();
    const latest = loaded("first");
    yield* Deferred.succeed(pending, latest);
    expect(yield* Fiber.join(second)).toBe(latest.snapshot);
    expect(f.loadCount()).toBe(1);
  }),
);

it.effect(
  "reloads on invalidation and serves the last snapshot to a reader with a short wait",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const first = yield* f.read();
      const latest = loaded("first");
      yield* Deferred.succeed(yield* f.nextLoad, latest);
      yield* Fiber.join(first);
      yield* f.nextPublication;

      yield* f.invalidate;
      const pending = yield* f.nextLoad;
      const reading = yield* f.read();
      const authoritative = yield* f.read(fresh);
      yield* TestClock.adjust(wait.maxWait);
      expect(yield* Fiber.join(reading)).toBe(latest.snapshot);
      expect(authoritative.pollUnsafe()).toBeUndefined();

      const updated = loaded("second");
      yield* Deferred.succeed(pending, updated);
      expect(yield* Fiber.join(authoritative)).toBe(updated.snapshot);
      expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "second" });
    }),
);

it.effect("coalesces invalidations during a load into one follow-up", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const reading = yield* f.read(fresh);
    const pending = yield* f.nextLoad;
    yield* f.invalidate;
    yield* f.invalidate;
    yield* f.invalidate;
    yield* Effect.yieldNow;
    yield* Deferred.succeed(pending, loaded("first"));
    const followUp = yield* f.nextLoad;
    expect(reading.pollUnsafe()).toBeUndefined();
    const latest = loaded("second");
    yield* Deferred.succeed(followUp, latest);
    expect(yield* Fiber.join(reading)).toBe(latest.snapshot);
    expect(f.loadCount()).toBe(2);
  }),
);

it.effect("keeps the last snapshot after load failures and deadlines while leaving it stale", () =>
  Effect.gen(function* () {
    const f = yield* harness;
    const reading = yield* f.read();
    const latest = loaded("first");
    yield* Deferred.succeed(yield* f.nextLoad, latest);
    yield* Fiber.join(reading);
    yield* f.nextPublication;

    yield* f.invalidate;
    const failed = yield* f.nextLoad;
    const authoritative = yield* f.read(fresh);
    yield* Deferred.fail(failed, "Unavailable");
    expect(yield* Fiber.join(authoritative)).toBeNull();

    const stale = yield* f.read();
    yield* f.nextLoad;
    yield* TestClock.adjust(wait.maxWait);
    expect(yield* Fiber.join(stale)).toBe(latest.snapshot);

    yield* TestClock.adjust(PLUGIN_CATALOG_LOAD_DEADLINE);
    expect(yield* f.publicationCount).toBe(0);
    const retry = yield* f.read();
    const pending = yield* f.nextLoad;
    yield* TestClock.adjust(wait.maxWait);
    expect(yield* Fiber.join(retry)).toBe(latest.snapshot);
    const updated = loaded("second");
    yield* Deferred.succeed(pending, updated);
    expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "second" });
    expect(f.loadCount()).toBe(4);
  }),
);

it.effect(
  "reloads replaced packages and publishes only revision changes, including unavailability",
  () =>
    Effect.gen(function* () {
      const f = yield* harness;
      const first = yield* f.read();
      let current = true;
      yield* Deferred.succeed(
        yield* f.nextLoad,
        loaded(
          "first",
          Effect.sync(() => current),
        ),
      );
      yield* Fiber.join(first);
      yield* f.nextPublication;

      current = false;
      const replaced = yield* f.read();
      const sameRevision = loaded("first");
      yield* Deferred.succeed(yield* f.nextLoad, sameRevision);
      expect(yield* Fiber.join(replaced)).toBe(sameRevision.snapshot);

      yield* f.invalidate;
      yield* Deferred.succeed(yield* f.nextLoad, null);
      expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: null });
      const recovered = yield* f.read();
      yield* Deferred.succeed(yield* f.nextLoad, sameRevision);
      expect(yield* Fiber.join(recovered)).toBe(sameRevision.snapshot);
      expect(yield* f.nextPublication).toEqual({ projectId: "project-a", revision: "first" });
      expect(yield* f.publicationCount).toBe(0);
    }),
);

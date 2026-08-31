import { expect, it, vi } from "vite-plus/test";
import { AcpRendererObservationRegistry } from "./AcpRendererObservationRegistry";

it("keeps independent Thread observations and reference-counts duplicate owners", () => {
  const registry = new AcpRendererObservationRegistry<{ readonly id: number }>();
  const sender = { id: 7 };
  const releaseDestroyedListener = vi.fn();

  expect(registry.observe(7, sender, "thread-a", releaseDestroyedListener)).toEqual({
    observedThreadIds: ["thread-a"],
    unobservedThreadIds: [],
  });
  expect(registry.observe(7, sender, "thread-a", vi.fn())).toEqual({
    observedThreadIds: [],
    unobservedThreadIds: [],
  });
  expect(registry.observe(7, sender, "thread-b", vi.fn())).toEqual({
    observedThreadIds: ["thread-b"],
    unobservedThreadIds: [],
  });
  expect(registry.matching("thread-a")).toEqual([[7, sender]]);
  expect(registry.matching("thread-b")).toEqual([[7, sender]]);

  expect(registry.unobserve(7, "thread-a").unobservedThreadIds).toEqual([]);
  expect(registry.matching("thread-a")).toEqual([[7, sender]]);
  expect(registry.unobserve(7, "thread-a").unobservedThreadIds).toEqual(["thread-a"]);
  expect(registry.matching("thread-a")).toEqual([]);
  expect(registry.matching("thread-b")).toEqual([[7, sender]]);

  expect(registry.unobserve(7, "thread-b").unobservedThreadIds).toEqual(["thread-b"]);
  expect(registry.matching("thread-b")).toEqual([]);
  expect(releaseDestroyedListener).toHaveBeenCalledOnce();
});

it("releases every owner exactly once on shutdown", () => {
  const registry = new AcpRendererObservationRegistry<object>();
  const releaseFirst = vi.fn();
  const releaseSecond = vi.fn();
  registry.observe(1, {}, "thread-a", releaseFirst);
  registry.observe(2, {}, "thread-a", releaseSecond);

  expect(registry.close().unobservedThreadIds).toEqual(["thread-a"]);
  expect(registry.close().unobservedThreadIds).toEqual([]);

  expect(releaseFirst).toHaveBeenCalledOnce();
  expect(releaseSecond).toHaveBeenCalledOnce();
});

it("only releases the manager lease after the final renderer stops observing", () => {
  const registry = new AcpRendererObservationRegistry<object>();
  const first = {};
  const second = {};

  expect(registry.observe(1, first, "thread-a", vi.fn()).observedThreadIds).toEqual(["thread-a"]);
  expect(registry.observe(2, second, "thread-a", vi.fn()).observedThreadIds).toEqual([]);
  expect(registry.release(1).unobservedThreadIds).toEqual([]);
  expect(registry.release(2).unobservedThreadIds).toEqual(["thread-a"]);
});

it("bounds unique renderer observation leases", () => {
  const registry = new AcpRendererObservationRegistry<object>({
    maxOwners: 1,
    maxObservedThreads: 1,
    maxLeasesPerOwner: 2,
  });
  const sender = {};

  registry.observe(1, sender, "thread-a", vi.fn());
  registry.observe(1, sender, "thread-a", vi.fn());
  expect(() => registry.observe(1, sender, "thread-a", vi.fn())).toThrow(/lease limit/u);
  registry.unobserve(1, "thread-a");
  expect(() => registry.observe(1, sender, "thread-b", vi.fn())).toThrow(/observed Thread limit/u);
  expect(() => registry.observe(2, {}, "thread-a", vi.fn())).toThrow(/owner limit/u);
});

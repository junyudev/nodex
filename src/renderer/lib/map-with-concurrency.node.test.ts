import { describe, expect, test, vi, it } from "vite-plus/test";
import { BoundedBurstScheduler } from "./bounded-burst-scheduler";
import { createFrameHealthWindow, type LongFrame } from "./frame-health";
import { createLatestReturnedValueOwner } from "./latest-returned-value-owner";
import { createRendererCausalTrace, recordRendererOwnerTrace } from "./renderer-causal-trace";
import { mapWithConcurrency } from "./map-with-concurrency";

describe("BoundedBurstScheduler", () => {
  test("runs after quiet but never starves during continuous requests", async () => {
    vi.useFakeTimers();
    try {
      const ready = vi.fn();
      const scheduler = new BoundedBurstScheduler({
        quietMs: 100,
        maxMs: 500,
        onReady: ready,
      });
      for (let elapsed = 0; elapsed < 500; elapsed += 50) {
        scheduler.request();
        await vi.advanceTimersByTimeAsync(50);
      }

      expect(ready).toHaveBeenCalledOnce();
      expect(scheduler.scheduled).toBe(false);
      scheduler.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not leave a second timer behind a queued flush", async () => {
    const ready = vi.fn();
    const scheduler = new BoundedBurstScheduler({
      quietMs: 100,
      maxMs: 500,
      onReady: ready,
    });

    scheduler.flush();
    scheduler.request();
    await Promise.resolve();

    expect(ready).toHaveBeenCalledOnce();
    expect(scheduler.scheduled).toBe(false);
    scheduler.dispose();
  });
});

describe("frame health", () => {
  const frame = (
    duration: number,
    blockingDuration: number,
    scripts: LongFrame["scripts"] = [],
  ): LongFrame => ({
    startTime: 1_000,
    duration,
    blockingDuration,
    styleAndLayoutStart: 1_000 + duration - 30,
    scripts,
  });
  const script = (duration: number, sourceFunctionName: string) => ({
    duration,
    invoker: "BUTTON.onclick",
    invokerType: "event-listener",
    sourceURL: "app://nodex/assets/workbench-abc123.js?v=1",
    sourceFunctionName,
  });

  describe("renderer frame health window", () => {
    test("reports visible time and the longest frame's longest script", () => {
      let now = 0;
      const window = createFrameHealthWindow(() => now);
      window.visible(true);
      window.record(frame(80, 30, [script(20, "small")]));
      window.record(frame(200, 150, [script(40, "render"), script(120, "layout")]));
      window.record(frame(60, 10));
      now = 1_000;
      window.visible(false);
      now = 5_000;

      expect(window.take()).toEqual({
        windowMs: 5_000,
        visibleMs: 1_000,
        frames: 3,
        durationMs: 340,
        blockingMs: 190,
        maxDurationMs: 200,
        maxBlockingMs: 150,
        worst: {
          durationMs: 200,
          layoutMs: 30,
          script: {
            invoker: "event-listener:BUTTON.onclick",
            source: "workbench-abc123.js:layout",
            durationMs: 120,
          },
        },
      });
    });

    test("stays silent for a window that was never visible, and restarts each window", () => {
      let now = 0;
      const window = createFrameHealthWindow(() => now);
      now = 60_000;
      expect(window.take()).toBeNull();

      window.visible(true);
      now = 90_000;
      expect(window.take()).toMatchObject({ windowMs: 30_000, visibleMs: 30_000, frames: 0 });
      now = 100_000;
      // Still visible: the next window counts from the previous report.
      expect(window.take()).toMatchObject({ windowMs: 10_000, visibleMs: 10_000 });
    });
  });
});

describe("latest returned value owner", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (cause: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { promise, reject, resolve };
  }

  interface Setting {
    readonly mode: string;
  }

  const setting = (mode: string): Setting => ({ mode });

  function operationIds() {
    let sequence = 0;
    return () => `operation-${++sequence}`;
  }

  describe("LatestReturnedValueOwner", () => {
    it("does not materialize a cancelled read after a newer canonical read", async () => {
      const stale = deferred<Setting>();
      let reads = 0;
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("initial"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired: Setting) => desired,
        port: {
          read: () => (++reads === 1 ? stale.promise : Promise.resolve(setting("current"))),
          update: async (desired) => desired,
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
      });
      const controller = new AbortController();
      const initialRead = owner.readCanonical({ signal: controller.signal });
      controller.abort();
      await owner.readCanonical();
      stale.resolve(setting("old"));
      await initialRead;
      expect(owner.getSnapshot().value).toEqual(setting("current"));
    });

    it("presents complete intent before transport and settles only its matching render", async () => {
      const request = deferred<Setting>();
      const trace = createRendererCausalTrace({ enabled: true });
      let presentedAtSend = "";
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("initial"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired) => desired,
        port: {
          read: async () => setting("initial"),
          update: async (_, context) => {
            recordRendererOwnerTrace(
              context,
              { kind: "submitted", reason: "transport_submit" },
              trace,
            );
            presentedAtSend = owner.getSnapshot().value.mode;
            return await request.promise;
          },
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
        trace,
      });

      const update = owner.update(setting("desired"));
      expect(presentedAtSend).toBe("desired");
      const renderToken = owner.getSnapshot().renderToken;
      expect(renderToken).not.toBeNull();
      owner.markRendered((renderToken ?? 0) + 1);
      expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken });
      owner.markRendered(renderToken ?? 0);
      expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken: null });

      request.resolve(setting("desired"));
      await expect(update).resolves.toEqual(setting("desired"));
      expect(owner.getSnapshot()).toMatchObject({
        value: setting("desired"),
        pending: false,
        renderToken: null,
      });
      expect(trace.reduce()).toMatchObject({ legal: true });
    });

    it("keeps B over late A success and reads that started before B", async () => {
      const readBeforeB = deferred<Setting>();
      const requestA = deferred<Setting>();
      const requestB = deferred<Setting>();
      const requests = [requestA, requestB];
      const trace = createRendererCausalTrace({ enabled: true });
      let updateIndex = 0;
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("canonical"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired) => desired,
        port: {
          read: async () => await readBeforeB.promise,
          update: async (_, context) => {
            const request = requests[updateIndex++]!;
            recordRendererOwnerTrace(
              context,
              { kind: "submitted", reason: "transport_submit" },
              trace,
            );
            const result = await request.promise;
            recordRendererOwnerTrace(context, { kind: "result", reason: "terminal_result" }, trace);
            return result;
          },
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
        trace,
      });

      const staleRead = owner.readCanonical();
      const updateA = owner.update(setting("A"));
      const tokenA = owner.getSnapshot().renderToken;
      const updateB = owner.update(setting("B"));
      const tokenB = owner.getSnapshot().renderToken;
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      readBeforeB.resolve(setting("canonical"));
      await staleRead;
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      requestB.resolve(setting("B"));
      await expect(updateB).resolves.toEqual(setting("B"));
      requestA.resolve(setting("A"));
      await expect(updateA).resolves.toEqual(setting("B"));
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      owner.markRendered(tokenA ?? 0);
      expect(owner.getSnapshot()).toMatchObject({ pending: true, renderToken: tokenB });
      owner.markRendered(tokenB ?? 0);
      expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });
      expect(trace.reduce()).toMatchObject({
        legal: true,
        operations: [{ outcome: "superseded" }, { outcome: "settled" }],
      });
    });

    it("ignores a superseded failure and fences canonical reads while B is pending", async () => {
      const reads: Array<ReturnType<typeof deferred<Setting>>> = [];
      const requestA = deferred<Setting>();
      const requestB = deferred<Setting>();
      const requests = [requestA, requestB];
      let updateIndex = 0;
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("canonical"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired) => desired,
        port: {
          read: async () => {
            const request = deferred<Setting>();
            reads.push(request);
            return await request.promise;
          },
          update: async () => await requests[updateIndex++]!.promise,
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
      });

      const updateA = owner.update(setting("A"));
      const updateB = owner.update(setting("B"));
      const tokenB = owner.getSnapshot().renderToken;
      requestB.resolve(setting("B"));
      await expect(updateB).resolves.toEqual(setting("B"));

      const staleAfterResult = owner.readCanonical();
      reads[0]!.resolve(setting("A"));
      await staleAfterResult;
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      owner.markRendered(tokenB ?? 0);
      requestA.reject(new Error("late A failure"));
      await expect(updateA).resolves.toEqual(setting("B"));
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      const laterCanonicalRead = owner.readCanonical();
      reads[1]!.resolve(setting("external"));
      await laterCanonicalRead;
      expect(owner.getSnapshot().value).toEqual(setting("external"));
    });

    it("does not install a read started during an intent after that intent settles", async () => {
      const staleRead = deferred<Setting>();
      const request = deferred<Setting>();
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("canonical"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired) => desired,
        port: {
          read: async () => await staleRead.promise,
          update: async () => await request.promise,
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
      });

      const update = owner.update(setting("B"));
      const renderToken = owner.getSnapshot().renderToken;
      const read = owner.readCanonical();
      request.resolve(setting("B"));
      await update;
      owner.markRendered(renderToken ?? 0);
      expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });

      staleRead.resolve(setting("A"));
      await read;
      expect(owner.getSnapshot()).toMatchObject({ value: setting("B"), pending: false });
    });

    it("rolls a failed latest intent back to an older command's canonical result", async () => {
      const requestA = deferred<Setting>();
      const requestB = deferred<Setting>();
      const requests = [requestA, requestB];
      let requestIndex = 0;
      const owner = createLatestReturnedValueOwner({
        initialValue: setting("canonical"),
        equals: (left, right) => left.mode === right.mode,
        operationId: operationIds(),
        project: (_current, desired) => desired,
        port: {
          read: async () => setting("canonical"),
          update: async () => await requests[requestIndex++]!.promise,
        },
        semanticKey: "settings.update",
        owner: "settings",
        scopeKind: "application",
      });

      const updateA = owner.update(setting("A"));
      const updateB = owner.update(setting("B"));
      requestA.resolve(setting("A"));
      await updateA;
      expect(owner.getSnapshot().value).toEqual(setting("B"));

      requestB.reject(new Error("B failed"));
      await expect(updateB).rejects.toThrow("B failed");
      expect(owner.getSnapshot()).toMatchObject({ value: setting("A"), pending: false });
    });
  });
});

describe("mapWithConcurrency", () => {
  test("preserves input order while bounding active work", async () => {
    let active = 0;
    let maxActive = 0;
    const values = Array.from({ length: 24 }, (_, index) => index);

    const results = await mapWithConcurrency(values, 4, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, (value % 3) + 1);
      });
      active -= 1;
      return value * 2;
    });

    expect(maxActive).toBe(4);
    expect(results).toEqual(values.map((value) => value * 2));
  });

  test("rejects an invalid concurrency bound before starting work", async () => {
    let started = false;
    await expect(
      mapWithConcurrency([1], 0, async () => {
        started = true;
        return 1;
      }),
    ).rejects.toThrow("concurrency must be a positive integer");
    expect(started).toBe(false);
  });
});

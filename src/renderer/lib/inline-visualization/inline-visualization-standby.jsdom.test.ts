import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  createInlineVisualizationStandby,
  scheduleInlineVisualizationIdle,
} from "./inline-visualization-standby";
import { startInlineVisualizationPrewarmer } from "./inline-visualization-prewarmer";
import type { InlineVisualizationPreparedLease } from "./inline-visualization-prepared";

type Job = {
  readonly kind: "idle" | "delay" | "paint";
  readonly duration?: number;
  canceled: boolean;
  readonly run: () => void;
};
function scheduler() {
  const jobs: Job[] = [];
  const schedule = (kind: Job["kind"], run: () => void, duration?: number) => {
    const job = { kind, run, duration, canceled: false };
    jobs.push(job);
    return () => {
      job.canceled = true;
    };
  };
  const next = () => {
    const job = jobs.shift();
    if (!job) throw new Error("Expected a scheduled background phase");
    if (!job.canceled) job.run();
    return job;
  };
  return {
    jobs,
    next,
    idle: (run: () => void) => schedule("idle", run),
    delay: (run: () => void, duration: number) => schedule("delay", run, duration),
    paint: (run: () => void) => schedule("paint", run),
  };
}
function harness() {
  const clock = scheduler();
  const leases: Array<{ readonly lease: InlineVisualizationPreparedLease; ready: () => void }> = [];
  const container = document.createElement("div");
  document.body.append(container);
  const standby = createInlineVisualizationStandby({
    idle: clock.idle,
    delay: clock.delay,
    prepare: (locale, onDispose) => {
      let ready = false;
      let disposed = false;
      const element = document.createElement("webview");
      const lease: InlineVisualizationPreparedLease = {
        locale,
        element,
        get identity(): InlineVisualizationPreparedLease["identity"] {
          throw new Error("The fake broker lease has no native identity");
        },
        get isReady() {
          return ready && !disposed;
        },
        presentationRevision: 1,
        prepare: vi.fn(async (parent) => {
          parent.append(element);
        }),
        activate: vi.fn(async () => {
          throw new Error("This fixture exercises only broker ownership");
        }),
        dispose: vi.fn(async () => {
          if (disposed) return;
          disposed = true;
          element.remove();
          onDispose(lease);
        }),
      };
      leases.push({
        lease,
        ready: () => {
          ready = true;
        },
      });
      return lease;
    },
  });
  return {
    clock,
    container,
    leases,
    standby,
    close: () => {
      standby.dispose();
      container.remove();
    },
  };
}
const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("window-owned blank sandbox standby", () => {
  test("warming claims are empty, ready claim transfers one guest and replenishes once", () => {
    const value = harness();
    closers.push(value.close);
    value.standby.start(value.container, "en-US");
    expect(value.clock.jobs).toHaveLength(1);
    expect(value.standby.claim("en-US")).toBeNull();
    value.clock.next();
    const first = value.leases[0]!;
    expect(value.standby.claim("en-US")).toBeNull();
    expect(value.leases).toHaveLength(1);
    first.ready();
    expect(value.standby.claim("en-US")).toBe(first.lease);
    expect(value.clock.jobs).toHaveLength(1);
    value.clock.next();
    expect(value.leases).toHaveLength(2);
    value.standby.dispose();
    expect(first.lease.dispose).not.toHaveBeenCalled();
    expect(value.leases[1]!.lease.dispose).toHaveBeenCalledOnce();
    void first.lease.dispose();
  });
  test("one preparation retry belongs to the root, including a mismatching locale claim", () => {
    const value = harness();
    closers.push(value.close);
    value.standby.start(value.container, "en-US");
    value.clock.next();
    value.leases[0]!.ready();
    expect(value.standby.claim("zh-CN")).toBeNull();
    expect(value.clock.jobs[0]).toMatchObject({ kind: "delay", duration: 1_000 });
    value.clock.next();
    void value.leases[1]!.lease.dispose();
    expect(value.clock.jobs).toHaveLength(0);
    // A later demand may prepare; failure never causes a self-sustaining retry loop.
    expect(value.standby.claim("en-US")).toBeNull();
    expect(value.clock.jobs[0]?.kind).toBe("idle");
  });
  test("stale root stop and late disposal cannot retire the replacement or a claimed guest", () => {
    const value = harness();
    closers.push(value.close);
    const stopOld = value.standby.start(value.container, "en-US");
    value.clock.next();
    const first = value.leases[0]!;
    first.ready();
    value.standby.claim("en-US");
    value.standby.start(value.container, "zh-CN");
    stopOld();
    void first.lease.dispose();
    while (value.clock.jobs.length) value.clock.next();
    expect(value.leases).toHaveLength(2);
    expect(value.leases[1]!.lease.locale).toBe("zh-CN");
    expect(value.leases[1]!.lease.dispose).not.toHaveBeenCalled();
  });
  test("paint, five seconds, two distinct idle phases; locale and pagehide cancel their own root", () => {
    const value = harness();
    closers.push(value.close);
    let locale = "en-US";
    let changeLocale: (() => void) | null = null;
    let pageHide: (() => void) | null = null;
    const stop = startInlineVisualizationPrewarmer(value.container, value.standby, {
      afterVisiblePaint: value.clock.paint,
      delay: value.clock.delay,
      idle: value.clock.idle,
      readLocale: () => locale,
      onLocaleChange: (callback) => {
        changeLocale = callback;
        return () => {
          changeLocale = null;
        };
      },
      onPageHide: (callback) => {
        pageHide = callback;
        return () => {
          pageHide = null;
        };
      },
    });
    expect(value.clock.next().kind).toBe("paint");
    expect(value.clock.jobs[0]).toMatchObject({ kind: "delay", duration: 5_000 });
    locale = "zh-CN";
    changeLocale!();
    value.clock.next();
    expect(value.clock.next().kind).toBe("idle");
    expect(value.leases).toHaveLength(0);
    expect(value.clock.next().kind).toBe("idle");
    expect(value.leases[0]!.lease.locale).toBe("zh-CN");
    locale = "de-DE";
    changeLocale!();
    expect(value.leases[0]!.lease.dispose).toHaveBeenCalledOnce();
    expect(value.clock.jobs[0]?.kind).toBe("idle");
    pageHide!();
    stop();
    value.clock.next();
    expect(value.leases).toHaveLength(1);
    expect(changeLocale).toBeNull();
    expect(pageHide).toBeNull();
  });
  test("idle admission requires both APIs, and cancellation preserves the scheduled identity", () => {
    vi.useFakeTimers();
    const execute = vi.fn();
    const request = vi.fn(() => 19);
    const cancel = vi.fn();
    vi.stubGlobal("requestIdleCallback", request);
    vi.stubGlobal("cancelIdleCallback", undefined);
    const cancelFallback = scheduleInlineVisualizationIdle(execute);
    expect(request).not.toHaveBeenCalled();
    cancelFallback();
    vi.runAllTimers();
    expect(execute).not.toHaveBeenCalled();
    vi.stubGlobal("cancelIdleCallback", cancel);
    const cancelIdle = scheduleInlineVisualizationIdle(execute);
    expect(request).toHaveBeenCalledWith(execute, { timeout: 2_000 });
    cancelIdle();
    expect(cancel).toHaveBeenCalledWith(19);
  });
});

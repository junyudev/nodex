import { describe, expect, test } from "vite-plus/test";
import {
  createAdaptiveMarkdownBuffer,
  type AdaptiveMarkdownScheduler,
} from "./adaptive-markdown-buffer";

function clockFixture() {
  let nowMs = 0;
  let nextId = 0;
  const timeouts = new Map<number, { due: number; callback: () => void }>();
  const frames = new Map<number, () => void>();
  const callbacks: Array<() => void> = [];
  const scheduler: AdaptiveMarkdownScheduler = {
    nowSeconds: () => nowMs / 1_000,
    timeout(callback, delayMs) {
      const id = nextId++;
      timeouts.set(id, { due: nowMs + delayMs, callback });
      callbacks.push(callback);
      return () => {
        timeouts.delete(id);
      };
    },
    frame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      callbacks.push(callback);
      return () => {
        frames.delete(id);
      };
    },
  };
  return {
    scheduler,
    callbacks,
    pending: () => ({ timeouts: timeouts.size, frames: frames.size }),
    advance(ms: number) {
      const end = nowMs + ms;
      for (;;) {
        const next = [...timeouts.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        nowMs = next[1].due;
        timeouts.delete(next[0]);
        next[1].callback();
      }
      nowMs = end;
    },
    publishFrame() {
      const pending = [...frames.values()];
      frames.clear();
      for (const callback of pending) callback();
    },
  };
}

describe("adaptive Markdown presentation", () => {
  test("history is immediately complete and repeated reads retain the immutable snapshot", () => {
    const clock = clockFixture();
    const owner = createAdaptiveMarkdownBuffer(
      { source: "History", streamId: "a", active: false },
      clock.scheduler,
    );
    const snapshot = owner.getSnapshot();
    owner.update({ source: "History", streamId: "a", active: false });
    expect(owner.getSnapshot()).toBe(snapshot);
    expect(snapshot).toEqual({
      source: "History",
      streamId: "a",
      text: "History",
      isComplete: true,
    });
    expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
  });

  test("append retains the displayed prefix and coalesces publication into one frame", () => {
    const clock = clockFixture();
    const owner = createAdaptiveMarkdownBuffer(
      { source: "Prefix", streamId: "a", active: true },
      clock.scheduler,
    );
    let notifications = 0;
    owner.subscribe(() => {
      notifications++;
    });
    const source = "Prefix" + "a".repeat(100);
    owner.update({ source, streamId: "a", active: true });
    expect(owner.getSnapshot().text).toBe("Prefix");
    clock.advance(50);
    clock.advance(50);
    expect(clock.pending()).toEqual({ timeouts: 1, frames: 1 });
    expect(notifications).toBe(0);
    clock.publishFrame();
    expect(notifications).toBe(1);
    expect(owner.getSnapshot().text.startsWith("Prefix")).toBe(true);
    expect(owner.getSnapshot().text.length).toBeGreaterThan(6);
    expect(owner.getSnapshot().text.length).toBeLessThan(source.length);
    expect(source.startsWith(owner.getSnapshot().text)).toBe(true);
    expect(owner.getSnapshot().isComplete).toBe(false);
    clock.advance(10_000);
    clock.publishFrame();
    expect(owner.getSnapshot().text).toBe(source);
    expect(owner.getSnapshot().isComplete).toBe(false);
    expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
  });

  test("arrival floor is measured in seconds and preserves fractional progress", () => {
    const measure = (floor: number) => {
      const clock = clockFixture();
      const owner = createAdaptiveMarkdownBuffer(
        { source: "", streamId: "a", active: true },
        clock.scheduler,
      );
      owner.update({
        source: "a".repeat(100),
        streamId: "a",
        active: true,
        arrivalIntervalFloorSeconds: floor,
      });
      clock.advance(50);
      owner.update({
        source: "a".repeat(200),
        streamId: "a",
        active: true,
        arrivalIntervalFloorSeconds: floor,
      });
      clock.advance(50);
      clock.publishFrame();
      return owner.getSnapshot().text.length;
    };
    expect(measure(0.01)).toBeGreaterThan(measure(10));
    const clock = clockFixture();
    const owner = createAdaptiveMarkdownBuffer(
      { source: "", streamId: "a", active: true },
      clock.scheduler,
    );
    owner.update({ source: "x", streamId: "a", active: true });
    clock.advance(50);
    clock.publishFrame();
    expect(owner.getSnapshot().text).toBe("");
    clock.advance(1_000);
    clock.publishFrame();
    expect(owner.getSnapshot().text).toBe("x");
  });

  test.each([
    { source: "replacement", streamId: "a", active: true },
    { source: "Prefix-new-stream", streamId: "b", active: true },
    { source: "Prefix-finished", streamId: "a", active: false },
  ])("identity, replacement or completion flush immediately: $source", (next) => {
    const clock = clockFixture();
    const owner = createAdaptiveMarkdownBuffer(
      { source: "Prefix", streamId: "a", active: true },
      clock.scheduler,
    );
    owner.update({ source: "Prefix" + "a".repeat(100), streamId: "a", active: true });
    clock.advance(50);
    const stale = [...clock.callbacks];
    owner.update(next);
    const snapshot = owner.getSnapshot();
    expect(snapshot.text).toBe(next.source);
    expect(snapshot.streamId).toBe(next.streamId);
    expect(snapshot.isComplete).toBe(!next.active);
    expect(clock.pending()).toEqual({ timeouts: 0, frames: 0 });
    for (const callback of stale) callback();
    expect(owner.getSnapshot()).toBe(snapshot);
  });

  test("idle-to-active starts from full source, and cancellation can survive layout replay", () => {
    const clock = clockFixture();
    const owner = createAdaptiveMarkdownBuffer(
      { source: "Old", streamId: "a", active: false },
      clock.scheduler,
    );
    owner.update({ source: "Old resumed", streamId: "a", active: true });
    expect(owner.getSnapshot().text).toBe("Old resumed");
    owner.update({ source: "Old resumed" + "x".repeat(100), streamId: "a", active: true });
    const stale = [...clock.callbacks];
    owner.cancel();
    const snapshot = owner.getSnapshot();
    for (const callback of stale) callback();
    expect(owner.getSnapshot()).toBe(snapshot);
    owner.update({ source: "Old resumed" + "x".repeat(100), streamId: "a", active: true });
    clock.advance(50);
    clock.publishFrame();
    expect(owner.getSnapshot().text.length).toBeGreaterThan("Old resumed".length);
  });
});

import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, vi } from "vitest";
import { makeDictationHotkeyCapture } from "./DictationHotkeyCapture";

const createWindow = () =>
  Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isFocused: vi.fn(() => true),
    webContents: Object.assign(new EventEmitter(), { id: 41, isDestroyed: () => false }),
  });

describe("DictationHotkeyCapture", () => {
  it.effect("admits only the focused primary renderer", () =>
    Effect.gen(function* () {
      const window = createWindow();
      const native = vi.fn(async () => "Ctrl+Alt");
      const owner = yield* makeDictationHotkeyCapture({
        primaryWindows: () => [window as unknown as BrowserWindow],
        capture: native,
      });
      expect(yield* owner.capture(99, true)).toBeNull();
      window.isFocused.mockReturnValue(false);
      expect(yield* owner.capture(41, true)).toBeNull();
      expect(native).not.toHaveBeenCalled();
      window.isFocused.mockReturnValue(true);
      expect(yield* owner.capture(41, false)).toBe("Ctrl+Alt");
      expect(native).toHaveBeenCalledWith(window, expect.any(AbortSignal), false);
      expect(window.listenerCount("blur")).toBe(0);
      expect(window.webContents.listenerCount("did-start-navigation")).toBe(0);
    }),
  );

  it.effect("ignores same-document navigation and cancels on blur without leaking listeners", () =>
    Effect.gen(function* () {
      const window = createWindow();
      let signal: AbortSignal | undefined;
      let started!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const owner = yield* makeDictationHotkeyCapture({
        primaryWindows: () => [window as unknown as BrowserWindow],
        capture: (_window, current) =>
          new Promise<string>((_resolve, reject) => {
            signal = current;
            current.addEventListener("abort", () => reject(current.reason), { once: true });
            started();
          }),
      });
      const capture = yield* owner.capture(41, true).pipe(Effect.forkScoped);
      yield* Effect.promise(() => ready);
      window.webContents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
      expect(signal?.aborted).toBe(false);
      expect(yield* owner.cancel(99)).toBe(false);
      window.emit("blur");
      expect(yield* Fiber.join(capture)).toBeNull();
      expect(signal?.aborted).toBe(true);
      expect(window.listenerCount("blur")).toBe(0);
      expect(window.webContents.listenerCount("destroyed")).toBe(0);
      expect(yield* owner.cancel(41)).toBe(false);
    }),
  );

  it.effect("waits for native cancellation cleanup before the cancel command completes", () =>
    Effect.gen(function* () {
      const window = createWindow();
      let started!: () => void;
      let aborted!: () => void;
      let finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const abortSeen = new Promise<void>((resolve) => {
        aborted = resolve;
      });
      const owner = yield* makeDictationHotkeyCapture({
        primaryWindows: () => [window as unknown as BrowserWindow],
        capture: (_window, signal) =>
          new Promise<string>((_resolve, reject) => {
            finish = () => reject(signal.reason);
            signal.addEventListener("abort", aborted, { once: true });
            started();
          }),
      });
      const capture = yield* owner.capture(41, true).pipe(Effect.forkScoped);
      yield* Effect.promise(() => ready);
      let cancelled = false;
      const cancel = yield* owner.cancel(41).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            cancelled = true;
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.promise(() => abortSeen);
      expect(cancelled).toBe(false);
      finish();
      expect(yield* Fiber.join(cancel)).toBe(true);
      expect(yield* Fiber.join(capture)).toBeNull();
      expect(cancelled).toBe(true);
    }),
  );
});

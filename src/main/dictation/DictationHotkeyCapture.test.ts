import { describe, expect, vi, afterEach } from "vite-plus/test";
import {
  WebContentsDestructionSubscriptions,
  makeWebContentsDestructionSubscriptions,
} from "../platform/electron/WebContentsDestructionSubscriptions";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeDictationHotkeyCapture as makeBase } from "./DictationHotkeyCapture";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it as itglobaldictationownershiplock } from "vitest";
import { acquireGlobalDictationOwnership } from "./global-dictation-ownership-lock";
import { DictationMicrophoneLease } from "./dictation-microphone-lease";

describe("DictationHotkeyCapture", () => {
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

    it.effect(
      "ignores same-document navigation and cancels on blur without leaking listeners",
      () =>
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
          window.webContents.emit("did-start-navigation", {
            isMainFrame: true,
            isSameDocument: true,
          });
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

  const makeDictationHotkeyCapture = Effect.fnUntraced(function* (
    ...args: Parameters<typeof makeBase>
  ) {
    const subscriptions = yield* makeWebContentsDestructionSubscriptions;
    return yield* makeBase(...args).pipe(
      Effect.provideService(WebContentsDestructionSubscriptions, subscriptions),
    );
  });
});

describe("global-dictation-ownership-lock", () => {
  const it = itglobaldictationownershiplock;
  describe("global-dictation-ownership-lock", () => {
    const roots: string[] = [];

    const createLockPath = (): string => {
      const root = join(tmpdir(), `nodex-global-dictation-lock-${crypto.randomUUID()}`);
      mkdirSync(root, { recursive: true });
      roots.push(root);
      return join(root, "owner.lock");
    };

    afterEach(() => {
      vi.useRealTimers();
      for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
    });

    describe("global dictation ownership", () => {
      it("allows only one machine owner until the lease is released", () => {
        const lockPath = createLockPath();
        const first = acquireGlobalDictationOwnership({ lockPath, onLost: vi.fn() });
        expect(first).not.toBeNull();
        expect(acquireGlobalDictationOwnership({ lockPath, onLost: vi.fn() })).toBeNull();

        first?.dispose();
        const next = acquireGlobalDictationOwnership({ lockPath, onLost: vi.fn() });
        expect(next?.isOwner()).toBe(true);
        next?.dispose();
      });

      it("reports ownership that is removed by another instance", () => {
        vi.useFakeTimers();
        const lockPath = createLockPath();
        const onLost = vi.fn();
        const lease = acquireGlobalDictationOwnership({ lockPath, onLost });
        expect(lease).not.toBeNull();

        rmSync(lockPath, { force: true, recursive: true });
        vi.advanceTimersByTime(1_000);

        expect(onLost).toHaveBeenCalledOnce();
        lease?.dispose();
      });
    });
  });

  describe("dictation-microphone-lease", () => {
    const owner = (webContentsId: number, sessionId: string) => ({
      kind: "dictation" as const,
      webContentsId,
      sessionId,
      surface: "composer" as const,
    });

    describe("DictationMicrophoneLease", () => {
      it("admits one owner and uses compare-and-release semantics", () => {
        const lease = new DictationMicrophoneLease();
        const changed = vi.fn();
        lease.subscribe(changed);

        expect(lease.acquire(owner(1, "first"))).toBe(true);
        expect(lease.acquire(owner(1, "first"))).toBe(true);
        expect(lease.acquire(owner(2, "second"))).toBe(false);
        expect(lease.release(2, "second")).toBe(false);
        expect(lease.getOwner()).toEqual(owner(1, "first"));
        expect(lease.release(1, "first")).toBe(true);
        expect(changed).toHaveBeenCalledTimes(2);
      });

      it("releases a crashed renderer without affecting another owner", () => {
        const lease = new DictationMicrophoneLease();
        lease.acquire(owner(7, "active"));

        expect(lease.releaseOwner(8)).toBe(false);
        expect(lease.releaseOwner(7)).toBe(true);
        expect(lease.getOwner()).toBeNull();
      });
    });
  });
});

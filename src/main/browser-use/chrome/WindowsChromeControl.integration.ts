import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { expect, test } from "vite-plus/test";
import { requiredNativeExecutable } from "../../../../scripts/testing/native-artifacts";
import { ScopedCallbackRuntime, layer as callbacksLayer } from "../../app/ScopedCallbackRuntime";
import {
  WindowsDesktopTools,
  windowsDesktopToolsLayer,
} from "../../platform/node/WindowsDesktopTools";
import { windowsChromeFileSecurity } from "./WindowsChromeNativeHost";
import { createWindowsChromePipeTransport } from "./WindowsChromePipeTransport";
import { createWindowsChromeRegistration } from "./WindowsChromeRegistration";

const testOnWindows = test.skipIf(process.platform !== "win32");
const platform = () =>
  Layer.merge(
    windowsDesktopToolsLayer("win32", requiredNativeExecutable("core-server")),
    callbacksLayer,
  );

testOnWindows(
  "takes over and gives back a disposable registration shared by both Windows views",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nodex-browser-registration-"));
    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const native = yield* WindowsDesktopTools;
          const callbacks = yield* ScopedCallbackRuntime;
          const host = "com.nodex.test_" + randomUUID().replaceAll("-", "");
          const key = { browser: "chrome", view: "x64", host } as const;
          const previous = yield* native.writeRegistration(
            key,
            null,
            path.join(root, "previous.json"),
          );
          const registration = createWindowsChromeRegistration({
            statePath: path.join(root, "chrome-control", "windows"),
            host,
            browsers: ["chrome", "edge"],
            security: windowsChromeFileSecurity((file) =>
              callbacks.runPromise(native.inspectPath(file)),
            ),
            registry: {
              readRegistration: (key) => callbacks.runPromise(native.readRegistration(key)),
              writeRegistration: (key, expected, manifest) =>
                callbacks.runPromise(native.writeRegistration(key, expected, manifest)),
              restoreRegistration: (key, receipt) =>
                callbacks.runPromise(native.restoreRegistration(key, receipt)),
            },
          });
          const prepare = async () => async () => {};
          try {
            const observed = yield* Effect.promise(() => registration.reconcile(prepare));
            expect(observed).toMatchObject({ status: "registration-in-use", owner: "app" });
            if (observed.status !== "registration-in-use" || !observed.takeoverToken) {
              throw new Error("Expected an existing browser registration");
            }
            const token = observed.takeoverToken;
            const owned = yield* Effect.promise(() =>
              registration.reconcile(prepare, { kind: "takeover", token }),
            );
            expect(owned).toEqual({ status: "owned", canGiveBack: true });
            expect(yield* native.readRegistration(key)).not.toEqual(previous.installed);
          } finally {
            yield* Effect.promise(() => registration.reconcile(prepare, { kind: "disable" }));
            expect(yield* native.readRegistration(key)).toEqual(previous.installed);
            expect(yield* native.restoreRegistration(key, previous)).toBe(true);
            expect(yield* native.readRegistration({ ...key, browser: "edge" })).toBeNull();
          }
        }).pipe(Effect.scoped, Effect.provide(platform())),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

testOnWindows("binds the outgoing pipe transport to the OS-reported server image", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const native = yield* WindowsDesktopTools;
      const callbacks = yield* ScopedCallbackRuntime;
      const prefix = "nodex-test-" + randomUUID();
      const listener = yield* native.listenPipe(prefix);
      const transport = (nativeHostPath: string) =>
        createWindowsChromePipeTransport({
          callbacks,
          native,
          nativeHostPath,
          ownsRegistration: async () => true,
          verifyHost: async () => {},
        });
      const wrong = transport(process.execPath);
      expect(yield* Effect.promise(() => wrong.enumerate(prefix, 4))).toContain(listener.endpoint);
      const accepted = yield* listener.accept.pipe(Effect.forkScoped);
      try {
        yield* Effect.promise(() =>
          expect(
            wrong.withPeer(listener.endpoint, AbortSignal.timeout(5000), async () => {
              throw new Error("Wrong peer received a request");
            }),
          ).rejects.toThrow("different native host"),
        );
      } finally {
        const connection = yield* Fiber.join(accepted);
        connection.stream.destroy();
      }
      const expected = transport(requiredNativeExecutable("core-server"));
      const second = yield* listener.accept.pipe(Effect.forkScoped);
      yield* Effect.promise(() =>
        expected.withPeer(listener.endpoint, AbortSignal.timeout(5000), async () => true),
      );
      const connection = yield* Fiber.join(second);
      connection.stream.destroy();
    }).pipe(Effect.scoped, Effect.provide(platform())),
  );
});

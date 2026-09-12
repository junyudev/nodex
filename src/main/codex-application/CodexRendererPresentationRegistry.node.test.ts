import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { make } from "./CodexRendererPresentationRegistry";

it.effect("retains foreground presentation until a client's last surface closes", () =>
  Effect.gen(function* () {
    const registry = yield* make;
    registry.setClientForegrounded("renderer-a", true);
    assert.isFalse(registry.isPresentedInForeground("thread-a"));
    registry.setPresented("thread-a", "renderer-a", "surface-one", true);
    registry.setPresented("thread-a", "renderer-a", "surface-two", true);
    registry.setPresented("thread-a", "renderer-b", "surface-three", true);
    registry.setPresented("thread-a", "renderer-a", "surface-one", false);
    assert.isTrue(registry.isPresentedInForeground("thread-a"));
    assert.strictEqual(registry.resolvePresentedSurfaceClient("thread-a"), "renderer-b");
    registry.setPresented("thread-a", "renderer-a", "surface-two", false);
    assert.isFalse(registry.isPresentedInForeground("thread-a"));
    assert.isTrue(registry.isClientPresenting("thread-a", "renderer-b"));
    assert.deepEqual(registry.setClientForegrounded("renderer-b", true), ["thread-a"]);
    assert.isTrue(registry.isPresentedInForeground("thread-a"));
  }),
);

it.effect(
  "retires one client's surfaces and admits a later connection with the same identity",
  () =>
    Effect.gen(function* () {
      const registry = yield* make;
      registry.setClientForegrounded("renderer-a", true);
      registry.setPresented("thread-a", "renderer-a", "surface-a", true);
      registry.setPresented("thread-b", "renderer-a", "surface-b", true);
      registry.setPresented("thread-a", "renderer-b", "surface-c", true);
      assert.deepEqual(registry.handleClientDisposed("renderer-a"), ["thread-a", "thread-b"]);
      assert.isFalse(registry.hasForegroundClient());
      assert.isFalse(registry.isClientPresenting("thread-b", "renderer-a"));
      assert.isTrue(registry.isClientPresenting("thread-a", "renderer-b"));
      assert.isFalse(registry.setPresented("thread-a", "renderer-a", "stale", true).accepted);
      assert.deepEqual(registry.handleClientDisposed("renderer-a"), []);

      registry.handleClientConnected("renderer-a");
      assert.isFalse(registry.hasForegroundClient());
      assert.isFalse(registry.isClientPresenting("thread-a", "renderer-a"));
      registry.setClientForegrounded("renderer-a", true);
      assert.deepEqual(registry.setPresented("thread-a", "renderer-a", "new-surface", true), {
        accepted: true,
        presentedInForeground: true,
      });
      registry.handleClientConnected("renderer-a");
      assert.isTrue(registry.isClientPresenting("thread-a", "renderer-a"));
    }),
);

it.effect("closes presentation admission and clears all queries with its owning Scope", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const registry = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    registry.setClientForegrounded("renderer-a", true);
    registry.setPresented("thread-a", "renderer-a", "surface-a", true);
    yield* Scope.close(scope, Exit.void);
    registry.handleClientConnected("renderer-a");
    registry.handleClientConnected("renderer-b");
    assert.isFalse(registry.setPresented("thread-a", "renderer-b", "new-surface", true).accepted);
    assert.deepEqual(registry.setClientForegrounded("renderer-b", true), []);
    assert.deepEqual(registry.handleClientDisposed("renderer-a"), []);
    assert.isFalse(registry.hasForegroundClient());
    assert.isFalse(registry.isPresentedInForeground("thread-a"));
    assert.isFalse(registry.isClientPresenting("thread-a", "renderer-a"));
    assert.isNull(registry.resolvePresentedSurfaceClient("thread-a"));
  }),
);

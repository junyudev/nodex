import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { makeBrowserLocalServerRuntime } from "./browser-local-server-runtime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeBrowserLocalServerPreferencesRuntime } from "./browser-local-server-preferences";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import type { BrowserSidebarLocalServerThumbnailResult } from "../../shared/browser-sidebar";
import {
  BrowserLocalServerThumbnailCaptureError,
  makeBrowserLocalServerThumbnailRuntime,
  normalizeLocalServerThumbnailUrl,
} from "./browser-local-server-thumbnail";

describe("browser-local-server-runtime", () => {
  it.effect("discovers terminal routes and owns hide/remove state immutably", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidated: string[] = [];
        const runtime = yield* makeBrowserLocalServerRuntime({
          fetch: () => Effect.succeed(new Response(null, { status: 204 })),
          invalidateThumbnail: (url) => Effect.sync(() => void invalidated.push(url ?? "all")),
        });
        yield* runtime.observePtyData(
          "project-1",
          'ready at http://localhost:3000/app and "https://example.com/not-local"',
        );

        const discovered = yield* runtime.snapshot("project-1");
        assert.lengthOf(discovered.servers, 1);
        assert.deepInclude(discovered.servers[0], {
          origin: "http://localhost:3000",
          online: true,
        });
        assert.deepInclude(discovered.servers[0]?.routes[0], {
          id: "http://localhost:3000/app",
          path: "/app",
        });
        assert.deepEqual(invalidated, ["http://localhost:3000", "http://localhost:3000/app"]);

        yield* runtime.applyCommand({
          type: "hide-local-server",
          projectId: "project-1",
          server: discovered.servers[0]!,
        });
        assert.isTrue((yield* runtime.snapshot("project-1")).servers[0]?.hidden);
        yield* runtime.applyCommand({
          type: "remove-local-server-route",
          projectId: "project-1",
          serverUrl: "http://localhost:3000",
          routeUrl: "/app",
        });
        assert.isEmpty((yield* runtime.snapshot("project-1")).servers[0]?.routes ?? []);
        yield* runtime.applyCommand({
          type: "unhide-local-server",
          projectId: "project-1",
          url: "http://localhost:3000",
        });
        assert.isFalse((yield* runtime.snapshot("project-1")).servers[0]?.hidden);

        yield* runtime.closeProject("project-1");
        assert.isEmpty((yield* runtime.snapshot("project-1")).servers);
      }),
    ),
  );

  it.effect("uses an Effect deadline and ignores superseded refresh generations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const runtime = yield* makeBrowserLocalServerRuntime({
          fetch: () => {
            calls += 1;
            return calls === 1 ? Effect.never : Effect.succeed(new Response(null, { status: 204 }));
          },
          invalidateThumbnail: () => Effect.void,
        });
        yield* runtime.observePtyData("project-1", "http://localhost:3000/");
        const first = yield* Effect.forkChild(
          runtime.applyCommand({ type: "local-servers-refresh", projectId: "project-1" }),
          { startImmediately: true },
        );
        yield* Effect.yieldNow;
        assert.isTrue((yield* runtime.snapshot("project-1")).isLoading);

        yield* runtime.applyCommand({ type: "local-servers-refresh", projectId: "project-1" });
        assert.isTrue((yield* runtime.snapshot("project-1")).servers[0]?.online);
        yield* TestClock.adjust("750 millis");
        yield* Fiber.join(first);
        const snapshot = yield* runtime.snapshot("project-1");
        assert.isFalse(snapshot.isLoading);
        assert.isTrue(snapshot.servers[0]?.online);
      }),
    ),
  );
});

describe("browser-local-server-preferences", () => {
  it.layer(NodeServices.layer)("Browser local server preferences runtime", (it) => {
    const makeRuntime = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-local-prefs-" });
      const filePath = path.join(root, "browser-local-server-preferences.json");
      const runtime = yield* makeBrowserLocalServerPreferencesRuntime(filePath, () => 1_234);
      return { filePath, fs, root, runtime };
    });

    it.effect("durably serializes concurrent updates without losing fields", () =>
      Effect.gen(function* () {
        const { filePath, fs, runtime } = yield* makeRuntime;
        assert.deepEqual(yield* runtime.snapshot, {
          showMode: "online",
          sortMode: "recently-used",
          expandedProjectIds: [],
        });

        yield* Effect.all(
          [
            runtime.update({ showMode: "hidden" }),
            runtime.update({
              sortMode: "origin",
              expandedProjectIds: [" alpha ", "alpha", "", "beta"],
            }),
          ],
          { concurrency: "unbounded" },
        );
        assert.deepEqual(yield* runtime.snapshot, {
          showMode: "hidden",
          sortMode: "origin",
          expandedProjectIds: ["alpha", "beta"],
        });
        const replacement = yield* makeBrowserLocalServerPreferencesRuntime(filePath);
        assert.deepEqual(yield* replacement.snapshot, yield* runtime.snapshot);
        if (process.platform !== "win32")
          assert.strictEqual((yield* fs.stat(filePath)).mode & 0o777, 0o600);
      }),
    );

    it.effect("quarantines malformed state instead of blocking Browser startup", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-browser-local-invalid-" });
        const filePath = path.join(root, "browser-local-server-preferences.json");
        yield* fs.writeFileString(filePath, "{broken");

        const runtime = yield* makeBrowserLocalServerPreferencesRuntime(filePath, () => 4_321);
        assert.deepEqual(yield* runtime.snapshot, {
          showMode: "online",
          sortMode: "recently-used",
          expandedProjectIds: [],
        });
        assert.deepEqual(yield* fs.readDirectory(root), [
          "browser-local-server-preferences.json.corrupt-4321",
        ]);
      }),
    );
  });
});

describe("browser-local-server-thumbnail", () => {
  it("accepts loopback HTTP(S) routes and rejects remote or credential URLs", () => {
    assert.strictEqual(
      normalizeLocalServerThumbnailUrl("http://localhost:3000/app#state"),
      "http://localhost:3000/app",
    );
    assert.strictEqual(
      normalizeLocalServerThumbnailUrl("https://127.0.0.1:8443/"),
      "https://127.0.0.1:8443/",
    );
    assert.strictEqual(
      normalizeLocalServerThumbnailUrl("http://[::1]:4173/"),
      "http://[::1]:4173/",
    );
    assert.isNull(normalizeLocalServerThumbnailUrl("https://example.com/"));
    assert.isNull(normalizeLocalServerThumbnailUrl("http://user:secret@localhost:3000/"));
  });

  it.effect("coalesces identical work and bounds captures with an Effect semaphore", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<{
          readonly url: string;
          readonly release: Deferred.Deferred<string>;
        }>();
        let active = 0;
        let maximumActive = 0;
        let captures = 0;
        const runtime = yield* makeBrowserLocalServerThumbnailRuntime({
          maxConcurrency: 1,
          capture: (url) =>
            Effect.acquireUseRelease(
              Effect.gen(function* () {
                captures += 1;
                active += 1;
                maximumActive = Math.max(maximumActive, active);
                const release = yield* Deferred.make<string>();
                yield* Queue.offer(started, { url, release });
                return release;
              }),
              Deferred.await,
              () =>
                Effect.sync(() => {
                  active -= 1;
                }),
            ),
        });

        const first = yield* Effect.forkChild(runtime.get("http://localhost:3000/"));
        const duplicate = yield* Effect.forkChild(runtime.get("http://localhost:3000/"));
        const second = yield* Effect.forkChild(runtime.get("http://localhost:4000/"));
        const firstCapture = yield* Queue.take(started);
        assert.strictEqual(firstCapture.url, "http://localhost:3000/");
        assert.strictEqual(captures, 1);
        yield* Deferred.succeed(firstCapture.release, "data:image/png;base64,first");
        assert.deepInclude(yield* Fiber.join(first), { status: "ready" });
        assert.deepInclude(yield* Fiber.join(duplicate), { status: "ready" });

        const secondCapture = yield* Queue.take(started);
        assert.strictEqual(secondCapture.url, "http://localhost:4000/");
        yield* Deferred.succeed(secondCapture.release, "data:image/png;base64,second");
        assert.deepInclude(yield* Fiber.join(second), { status: "ready" });
        assert.strictEqual(maximumActive, 1);

        assert.deepInclude(yield* runtime.get("http://localhost:3000/"), {
          status: "ready",
          dataUrl: "data:image/png;base64,first",
        });
        assert.strictEqual(captures, 2);
      }),
    ),
  );

  it.effect("negative-caches failures with the Effect clock and redacts their cause", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let captures = 0;
        const runtime = yield* makeBrowserLocalServerThumbnailRuntime({
          capture: () =>
            Effect.sync(() => {
              captures += 1;
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new BrowserLocalServerThumbnailCaptureError({
                    operation: "test-capture",
                    cause: new Error("private route detail"),
                  }),
                ),
              ),
            ),
        });
        const expected = {
          status: "unavailable",
          message: "Local server preview is unavailable",
        } satisfies BrowserSidebarLocalServerThumbnailResult;

        assert.deepEqual(yield* runtime.get("http://localhost:3000/private"), expected);
        assert.deepEqual(yield* runtime.get("http://localhost:3000/private"), expected);
        assert.strictEqual(captures, 1);
        yield* TestClock.adjust("5 seconds");
        assert.deepEqual(yield* runtime.get("http://localhost:3000/private"), expected);
        assert.strictEqual(captures, 2);
      }),
    ),
  );

  it.effect("interrupts capture cleanup when the Browser runtime Scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const started = yield* Deferred.make<void>();
      let released = false;
      const runtime = yield* makeBrowserLocalServerThumbnailRuntime({
        capture: () =>
          Effect.acquireUseRelease(
            Effect.void,
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      }).pipe(Scope.provide(scope));
      const fiber = yield* Effect.forkChild(runtime.get("http://localhost:3000/"));
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(released);
      yield* Fiber.interrupt(fiber);
    }),
  );
});

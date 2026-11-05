// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import * as OpenCodeServerLedger from "./OpenCodeServerLedger.ts";
import * as OpenCodeServerOwner from "./OpenCodeServerOwner.ts";

for (const phase of ["spawn", "readiness", "ready"] as const) {
  it.live.skipIf(process.platform === "win32")(
    `shutdown stops a long-lived server during ${phase} and fences later borrowers`,
    () => Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-server-quit-" });
      const binary = `${home}/server`;
      yield* fs.writeFileString(binary, `#!${process.execPath}\nprocess.stdout.write('opencode server listening on http://127.0.0.1:4096\\n');\nsetInterval(() => {}, 1000);\n`);
      yield* fs.chmod(binary, 0o700);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawned = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
      const verified = yield* Deferred.make<void>();
      const used = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const testScope = yield* Scope.Scope;
      const intercepted = ChildProcessSpawner.make((command) => spawner.spawn(command).pipe(Effect.tap((child) =>
        Scope.addFinalizer(testScope, child.kill({ killSignal: "SIGKILL", forceKillAfter: "100 millis" }).pipe(Effect.ignore)).pipe(Effect.andThen(Deferred.succeed(spawned, child)), Effect.andThen(phase === "spawn" ? Deferred.await(release) : Effect.void)),
      )));
      const services = yield* Layer.buildWithScope(OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, intercepted)),
      ), scope);
      const runtime = yield* OpenCodeRuntime.OpenCodeRuntime.pipe(Effect.provide(services));
      // The real spawner launches the executable; only the timing boundaries are held.
      const owner = yield* OpenCodeServerOwner.make({
        binaryPath: binary, directory: home,
        verify: () => Deferred.succeed(verified, undefined).pipe(
          Effect.andThen(phase === "readiness" ? Deferred.await(release).pipe(Effect.as("1.19.4")) : Effect.succeed("1.19.4")),
        ),
      }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
      );
      const borrower = yield* owner.withServer(() => Deferred.succeed(used, undefined).pipe(Effect.andThen(Effect.never))).pipe(Effect.forkChild);
      yield* Effect.addFinalizer(() => Fiber.interrupt(borrower));
      const child = yield* Deferred.await(spawned).pipe(Effect.timeout("5 seconds"));
      if (phase !== "spawn") yield* Deferred.await(verified).pipe(Effect.timeout("5 seconds"));
      if (phase === "ready") yield* Deferred.await(used);
      const closing = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
      const closed = yield* Fiber.await(closing).pipe(Effect.timeoutOption("4 seconds"));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.interrupt(borrower);
      yield* Fiber.join(closing);
      expect(closed._tag).toBe("Some");
      expect(yield* child.isRunning).toBe(false);
      const late = yield* Effect.exit(owner.withServer(() => Effect.void));
      expect(Exit.isFailure(late)).toBe(true);
      yield* Fiber.interrupt(borrower);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    15_000,
  );
}

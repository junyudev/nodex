import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HostShellEnvironment, live } from "../../host-runtime/HostShellEnvironment";
import { makeHostExecutableSearch } from "./HostExecutableSearch";

const host = {
  platform: "darwin",
  homeDirectory: "/home/person",
  environment: { PATH: "/usr/bin:/bin" },
} as const;
const request = { commands: ["agy"] };

it.effect("a known location can answer while concurrent consumers wait for a stalled shell", () =>
  Effect.gen(function* () {
    const missingChecked = yield* Deferred.make<void>();
    let attempts = 0;
    let aborts = 0;
    const shellContext = yield* Layer.build(
      live({
        platform: "darwin",
        baseEnvironment: host.environment,
        loadInteractiveEnvironment: (signal) => {
          attempts++;
          // The Effect clock drives cancellation of this real adapter boundary.
          return new Promise((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                aborts++;
                reject(signal.reason);
              },
              { once: true },
            );
          });
        },
      }),
    );
    const shell = Context.get(shellContext, HostShellEnvironment);
    const known = "/home/person/.local/bin/agy";
    const search = makeHostExecutableSearch(host, shell, (path) =>
      path === "/usr/bin/missing"
        ? Deferred.succeed(missingChecked, undefined).pipe(Effect.as(undefined))
        : Effect.succeed(path === known ? path : undefined),
    );
    const runtime = yield* Effect.forkChild(shell.load, { startImmediately: true });
    const missing = yield* Effect.forkChild(search.first({ commands: ["missing"] }));
    assert.strictEqual((yield* search.first(request))?.path, known);
    yield* Deferred.await(missingChecked);
    assert.isNull(yield* shell.latest);
    assert.strictEqual(attempts, 1);
    yield* TestClock.adjust("25 seconds");
    assert.deepEqual(yield* Fiber.join(runtime), host.environment);
    assert.isUndefined(yield* Fiber.join(missing));
    assert.strictEqual((yield* shell.latest)?.status, "failed");
    assert.strictEqual(aborts, 1);
  }).pipe(Effect.scoped),
);

it.effect("honors Windows PATH casing, native extensions, and real-path identity", () =>
  Effect.gen(function* () {
    const environment = {
      Path: "C:\\Tools;C:\\Aliases",
      Pathext: ".CMD;.EXE",
      APPDATA: "C:\\User\\Roaming",
    };
    const exe = "C:\\Tools\\agy.exe";
    const known = "C:\\User\\Roaming\\npm\\agy.com";
    const search = makeHostExecutableSearch(
      { homeDirectory: "C:\\User", platform: "win32", environment },
      { recover: Effect.die("no Windows shell probe"), latest: Effect.die("no Windows capture") },
      (path) =>
        Effect.succeed(
          new Map([
            ["C:\\Tools\\agy.cmd", "C:\\Tools\\agy.cmd"],
            [exe, exe],
            ["C:\\Aliases\\agy.exe", exe.toUpperCase()],
            [known, known],
          ]).get(path),
        ),
    );
    const candidates = yield* search.select(
      { ...request, windowsKind: "native" },
      (found) => Effect.succeed(found.map(({ path }) => path)),
      () => true,
    );
    assert.deepEqual(candidates, [exe, known]);
  }),
);

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Platform from "../platform/node/LocalAgentDiscoveryPlatform";
import { live, LocalAgentDiscovery } from "./LocalAgentDiscovery";

const desktop = "/desktop/bin/agy";
const login = "/login/bin/agy";
const installed = "/home/person/.local/bin/agy";

const fakeHost = (files: ReadonlyMap<string, string | null>) => {
  const probes: string[] = [];
  let loginReads = 0;
  const platform = Platform.make(
    {
      environment: { PATH: "/desktop/bin" },
      homeDirectory: "/home/person",
      platform: "darwin",
    },
    {
      isExecutable: (path) => Effect.sync(() => files.has(path)),
      loadLoginPath: Effect.sync(() => {
        loginReads++;
        return "/login/bin";
      }),
      readVersion: (path) =>
        Effect.sync(() => {
          probes.push(path);
          return files.get(path) ?? null;
        }),
    },
  );
  return { platform, probes, loginReads: () => loginReads };
};

const scanWith = (platform: Platform.LocalAgentDiscoveryPlatform["Service"]) =>
  LocalAgentDiscovery.use(({ scan }) => scan).pipe(
    Effect.provide(
      live.pipe(Layer.provide(Layer.succeed(Platform.LocalAgentDiscoveryPlatform, platform))),
    ),
  );

it.effect("keeps the first executable on the Desktop PATH even when it is too old", () =>
  Effect.gen(function* () {
    const host = fakeHost(
      new Map([
        [desktop, "agy v1.4.9\n"],
        [login, "1.5.4"],
        [installed, "1.5.4"],
      ]),
    );
    assert.deepEqual(yield* scanWith(host.platform), {
      agents: [{ id: "antigravity", executable: desktop, version: "1.4.9", supported: false }],
    });
    assert.deepEqual(host.probes, [desktop]);
    assert.strictEqual(host.loginReads(), 0);
  }),
);

it.effect("finds an executable on the login PATH before checking installer locations", () =>
  Effect.gen(function* () {
    const host = fakeHost(
      new Map([
        [login, "v1.5.0+local\n"],
        [installed, "1.5.4"],
      ]),
    );
    assert.deepEqual(yield* scanWith(host.platform), {
      agents: [{ id: "antigravity", executable: login, version: "1.5.0+local", supported: true }],
    });
    assert.deepEqual(host.probes, [login]);
  }),
);

it.effect("finds a home installer executable and keeps it eligible with an unknown version", () =>
  Effect.gen(function* () {
    const host = fakeHost(new Map([[installed, "unavailable"]]));
    assert.deepEqual(yield* scanWith(host.platform), {
      agents: [{ id: "antigravity", executable: installed, version: null, supported: true }],
    });
  }),
);

it.effect("returns an empty scan when no executable exists", () =>
  Effect.gen(function* () {
    const host = fakeHost(new Map());
    assert.deepEqual(yield* scanWith(host.platform), { agents: [] });
    assert.isEmpty(host.probes);
  }),
);

it.effect("finds agy.exe using the case-insensitive Windows PATH and PATHEXT", () =>
  Effect.gen(function* () {
    const launcher = "C:\\Tools\\agy.cmd";
    const executable = "C:\\Tools\\agy.exe";
    const platform = Platform.make(
      {
        environment: { Path: "C:\\Tools", PathExt: ".CMD;.EXE" },
        homeDirectory: "C:\\Users\\Person",
        platform: "win32",
      },
      {
        isExecutable: (path) => Effect.succeed([launcher, executable].includes(path)),
        loadLoginPath: Effect.die("Windows does not need login shell discovery"),
        readVersion: () => Effect.succeed("1.5.0-rc.1"),
      },
    );
    assert.deepEqual(yield* scanWith(platform), {
      agents: [{ id: "antigravity", executable, version: "1.5.0-rc.1", supported: false }],
    });
  }),
);

it.effect("shares concurrent scans and refreshes after 30 seconds", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const host = fakeHost(new Map([[desktop, "1.5.4"]]));
    const platform = Platform.LocalAgentDiscoveryPlatform.of({
      ...host.platform,
      readVersion: (path) =>
        host.platform.readVersion(path).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.tap(() => Deferred.await(finish)),
        ),
    });

    yield* Effect.gen(function* () {
      const { scan } = yield* LocalAgentDiscovery;
      const first = yield* Effect.forkChild(scan, { startImmediately: true });
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(scan, { startImmediately: true });
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(first), yield* Fiber.join(second));
      assert.deepEqual(host.probes, [desktop]);

      yield* TestClock.adjust("29 seconds");
      yield* scan;
      assert.deepEqual(host.probes, [desktop]);

      yield* TestClock.adjust("1 second");
      yield* scan;
      assert.deepEqual(host.probes, [desktop, desktop]);
    }).pipe(
      Effect.provide(
        live.pipe(Layer.provide(Layer.succeed(Platform.LocalAgentDiscoveryPlatform, platform))),
      ),
    );
  }),
);

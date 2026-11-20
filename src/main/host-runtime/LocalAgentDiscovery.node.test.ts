import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { makeHostExecutableSearch } from "../platform/node/HostExecutableSearch";
import { LocalAgentDiscoveryPlatform } from "../platform/node/LocalAgentDiscoveryPlatform";
import { HostShellEnvironment, live as shellLive } from "./HostShellEnvironment";
import { live, LocalAgentDiscovery } from "./LocalAgentDiscovery";

const desktop = "/desktop/bin/agy";
const login = "/login/bin/agy";
const installed = "/home/person/.local/bin/agy";

const host = {
  environment: { PATH: "/desktop/bin" },
  homeDirectory: "/home/person",
  platform: "darwin",
};
const loginEnvironment = { PATH: "/login/bin", TEST_MODE: "from-shell" };
const captured = { status: "captured", environment: loginEnvironment } as const;
const fakeHost = (
  files: ReadonlyMap<string, string | null>,
  shell: Pick<HostShellEnvironment["Service"], "latest" | "recover"> = {
    latest: Effect.succeed(captured),
    recover: Effect.succeed(captured),
  },
) => {
  const probes: Array<{ path: string; testMode: string | undefined }> = [];
  const search = makeHostExecutableSearch(host, shell, (path) =>
    Effect.sync(() => (files.has(path) ? path : undefined)),
  );
  const platform = LocalAgentDiscoveryPlatform.of({
    select: search.select,
    readVersion: (path, environment) =>
      Effect.sync(() => {
        probes.push({ path, testMode: environment.TEST_MODE });
        return files.get(path) ?? null;
      }),
  });
  return { platform, probes };
};

const discoveryLayer = (platform: LocalAgentDiscoveryPlatform["Service"]) =>
  live.pipe(Layer.provide(Layer.succeed(LocalAgentDiscoveryPlatform, platform)));
const scanWith = (platform: LocalAgentDiscoveryPlatform["Service"]) =>
  LocalAgentDiscovery.use(({ scan }) => scan()).pipe(Effect.provide(discoveryLayer(platform)));

it.effect(
  "selects the first supported copy after an outdated copy and uses the recovered environment",
  () =>
    Effect.gen(function* () {
      const host = fakeHost(
        new Map([
          [desktop, "agy v1.4.9\n"],
          [login, "v1.5.4+local"],
          [installed, "1.5.9"],
        ]),
      );
      assert.deepEqual(yield* scanWith(host.platform), {
        agents: [{ id: "antigravity", executable: login, version: "1.5.4+local", supported: true }],
      });
      assert.deepEqual(
        host.probes,
        [desktop, login, installed].map((path) => ({ path, testMode: "from-shell" })),
      );
    }),
);

it.effect("reports the newest outdated version ahead of candidates with an unknown version", () =>
  Effect.gen(function* () {
    const host = fakeHost(
      new Map([
        [desktop, "unavailable"],
        [login, "1.4.9"],
        [installed, "1.5.0-rc.1"],
      ]),
    );
    assert.deepEqual(yield* scanWith(host.platform), {
      agents: [
        { id: "antigravity", executable: installed, version: "1.5.0-rc.1", supported: false },
      ],
    });
  }),
);

it.effect("excludes an editor launcher and retains an otherwise eligible unknown version", () =>
  Effect.gen(function* () {
    const launcher = "1.107.0\n0123456789abcdef0123456789abcdef01234567\narm64";
    const wrongProduct = fakeHost(new Map([[desktop, launcher]]));
    assert.deepEqual(yield* scanWith(wrongProduct.platform), { agents: [] });
    const unknown = fakeHost(
      new Map([
        [desktop, launcher],
        [installed, "unavailable"],
      ]),
    );
    assert.deepEqual(yield* scanWith(unknown.platform), {
      agents: [{ id: "antigravity", executable: installed, version: null, supported: true }],
    });
  }),
);

it.effect("a fresh scan retries failed shell recovery and replaces a cached fallback", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const context = yield* Layer.build(
      shellLive({
        platform: "darwin",
        baseEnvironment: host.environment,
        loadInteractiveEnvironment: () =>
          ++attempts === 1
            ? Promise.reject(new Error("shell exited"))
            : Promise.resolve(loginEnvironment),
      }),
    );
    const shell = Context.get(context, HostShellEnvironment);
    const fixture = fakeHost(
      new Map([
        [login, "1.5.9"],
        [installed, "1.4.9"],
      ]),
      shell,
    );
    yield* Effect.gen(function* () {
      const { scan } = yield* LocalAgentDiscovery;
      const fallback = yield* scan();
      assert.deepEqual(fallback, {
        agents: [{ id: "antigravity", executable: installed, version: "1.4.9", supported: false }],
      });
      assert.deepEqual(yield* scan(), fallback);
      assert.strictEqual(attempts, 1);
      // Once capture settles, the next scan takes the login PATH ahead of the fallback.
      const refreshed = yield* scan({ fresh: true });
      assert.strictEqual(attempts, 2);
      assert.deepEqual(refreshed, {
        agents: [{ id: "antigravity", executable: login, version: "1.5.9", supported: true }],
      });
    }).pipe(Effect.provide(discoveryLayer(fixture.platform)));
  }).pipe(Effect.scoped),
);

it.effect("shares concurrent scans and refreshes after 30 seconds", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const host = fakeHost(new Map([[desktop, "1.5.4"]]));
    const platform = LocalAgentDiscoveryPlatform.of({
      ...host.platform,
      readVersion: (path, environment) =>
        host.platform.readVersion(path, environment).pipe(
          Effect.tap(() => Deferred.succeed(entered, undefined)),
          Effect.tap(() => Deferred.await(finish)),
        ),
    });

    yield* Effect.gen(function* () {
      const { scan } = yield* LocalAgentDiscovery;
      const first = yield* Effect.forkChild(scan(), { startImmediately: true });
      yield* Deferred.await(entered);
      const second = yield* Effect.forkChild(scan(), { startImmediately: true });
      yield* Deferred.succeed(finish, undefined);
      assert.deepEqual(yield* Fiber.join(first), yield* Fiber.join(second));
      assert.deepEqual(
        host.probes.map(({ path }) => path),
        [desktop],
      );

      yield* TestClock.adjust("29 seconds");
      yield* scan();
      assert.deepEqual(
        host.probes.map(({ path }) => path),
        [desktop],
      );

      yield* TestClock.adjust("1 second");
      yield* scan();
      assert.deepEqual(
        host.probes.map(({ path }) => path),
        [desktop, desktop],
      );
      yield* scan({ fresh: true });
      assert.deepEqual(
        host.probes.map(({ path }) => path),
        [desktop, desktop, desktop],
      );
    }).pipe(Effect.provide(discoveryLayer(platform)));
  }),
);

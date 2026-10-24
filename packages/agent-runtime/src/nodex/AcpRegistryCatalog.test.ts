import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AcpRegistryInstallPreview, AcpRegistrySearchResult } from "@t3tools/contracts";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Catalog from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const archiveUrl = "https://registry.test/agent.bin";
const checksum = "a".repeat(64);
const agent = (
  id: string,
  distribution: Catalog.AcpRegistryAgent["distribution"],
): Catalog.AcpRegistryAgent => ({
  id,
  name: id,
  description: "Fixture",
  version: "1.2.3",
  distribution,
});
const binary = (target = "linux-x86_64") => ({
  binary: { [target]: { archive: archiveUrl, cmd: "agent", sha256: checksum } },
});
const settings = Schema.decodeSync(AcpRegistrySettings);
const platform = Layer.mergeAll(
  NodeServices.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
);

const fixture = Effect.fnUntraced(function* (
  initialAgents: ReadonlyArray<Catalog.AcpRegistryAgent>,
  runners: ReadonlyArray<"npm" | "uv" | "tar" | "unzip"> = [],
  cached = true,
) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-catalog-" });
  let agents = initialAgents;
  let networkCalls = 0;
  let processCalls = 0;
  const registryText = () => JSON.stringify({ version: "1.0.0", agents });
  if (cached) {
    yield* fs.makeDirectory(`${home}/acp-registry`);
    yield* fs.writeFileString(`${home}/acp-registry/registry.json`, registryText());
  }
  const catalog = yield* Catalog.makeAcpRegistryCatalog({
    cacheDir: home,
    toolsDir: `${home}/tools`,
    registryUrl: "https://registry.test/index.json",
  }).pipe(
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(SpawnExecutableResolution, (command) =>
      runners.some((runner) => command === runner) ? `/fixture/bin/${command}` : undefined,
    ),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          networkCalls++;
          return HttpClientResponse.fromWeb(request, new Response(registryText()));
        }),
      ),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
      ...spawner,
      spawn: (...args) => {
        processCalls++;
        return spawner.spawn(...args);
      },
    }),
  );
  return {
    home,
    fs,
    catalog,
    calls: () => ({ network: networkCalls, processes: processCalls }),
    replace: (next: ReadonlyArray<Catalog.AcpRegistryAgent>) => {
      agents = next;
    },
  };
});

it.live("keeps unavailable Agents and reports each advertised distribution and runner", () =>
  Effect.gen(function* () {
    const { catalog } = yield* fixture(
      [
        agent("other-platform", binary("darwin-aarch64")),
        agent("missing-runner", { npx: { package: "example@1.2.3" } }),
        agent("choices", {
          ...binary(),
          npx: { package: "example@1.2.3" },
          uvx: { package: "example==1.2.3" },
        }),
        agent("fallback", {
          npx: { package: "example@1.2.3" },
          uvx: { package: "example==1.2.3" },
        }),
      ],
      ["uv"],
    );
    const result = yield* catalog.search({ query: "" });
    expect(Schema.is(AcpRegistrySearchResult)(result)).toBe(true);
    expect(result.agents).toHaveLength(4);
    expect(result.agents.find((entry) => entry.id === "other-platform")).toMatchObject({
      distribution: null,
      integrity: null,
      distributions: [
        { kind: "binary", available: false, runner: null, reason: "unsupported_platform" },
      ],
    });
    expect(result.agents.find((entry) => entry.id === "missing-runner")).toMatchObject({
      distribution: null,
      distributions: [
        { kind: "npx", available: false, runner: "npm", reason: "runner_unavailable" },
      ],
    });
    expect(result.agents.find((entry) => entry.id === "choices")).toMatchObject({
      distribution: "binary",
      integrity: "sha256",
      distributions: [
        { kind: "binary", available: true, runner: null, reason: null },
        { kind: "npx", available: false, runner: "npm", reason: "runner_unavailable" },
        { kind: "uvx", available: true, runner: "uv", reason: null },
      ],
    });
    expect(result.agents.find((entry) => entry.id === "fallback")?.distribution).toBe("uvx");
    expect((yield* catalog.preview({ agentId: "fallback" })).distribution).toBe("uvx");
  }).pipe(Effect.provide(platform)),
);

it.live(
  "previews exact cached binary and package sources without downloads, processes or receipts",
  () =>
    Effect.gen(function* () {
      const { catalog, home, fs, calls } = yield* fixture(
        [
          agent("choices", {
            ...binary(),
            npx: { package: "@example/acp@1.2.3" },
            uvx: { package: "example==1.2.3" },
          }),
        ],
        ["uv"],
      );
      const archive = yield* catalog.preview({ agentId: "choices", distribution: "binary" });
      expect(Schema.is(AcpRegistryInstallPreview)(archive)).toBe(true);
      expect(archive).toMatchObject({
        agentId: "choices",
        version: "1.2.3",
        distribution: "binary",
        integrity: "sha256",
        sha256: checksum,
        archiveUrl,
        packageSpec: null,
        runner: null,
        runnerPath: null,
        available: true,
        reason: null,
      });
      expect(archive.installDirectory.startsWith(`${home}/tools/choices/1.2.3/linux-x86_64/`)).toBe(
        true,
      );
      expect(archive.receiptPath).toBe(
        `${home}/acp-registry/installations/${archive.installationId}.json`,
      );
      const npm = yield* catalog.preview({ agentId: "choices", distribution: "npx" });
      expect(npm).toMatchObject({
        distribution: "npx",
        packageSpec: "@example/acp@1.2.3",
        archiveUrl: null,
        sha256: null,
        integrity: "registry",
        runner: "npm",
        runnerPath: null,
        available: false,
        reason: "runner_unavailable",
        installDirectory: `${home}/tools/choices/1.2.3/npm`,
      });
      const uv = yield* catalog.preview({ agentId: "choices", distribution: "uvx" });
      expect(uv).toMatchObject({
        distribution: "uvx",
        packageSpec: "example==1.2.3",
        runner: "uv",
        runnerPath: "/fixture/bin/uv",
        available: true,
        reason: null,
        installDirectory: `${home}/tools/choices/1.2.3/python`,
      });
      expect(calls()).toEqual({ network: 0, processes: 0 });
      expect(yield* fs.exists(`${home}/tools`)).toBe(false);
      expect(yield* fs.readDirectory(`${home}/acp-registry`)).toEqual(["registry.json"]);
    }).pipe(Effect.provide(platform)),
);

it.live("does not fetch a missing cache for preview and rejects unsupported binary choices", () =>
  Effect.gen(function* () {
    const empty = yield* fixture([], [], false);
    const failure = yield* empty.catalog.preview({ agentId: "missing" }).pipe(Effect.flip);
    expect(failure.reason).toBe("registry_unavailable");
    expect(empty.calls()).toEqual({ network: 0, processes: 0 });
    const unavailable = yield* fixture([agent("other-platform", binary("darwin-aarch64"))]);
    expect(
      (yield* unavailable.catalog
        .preview({ agentId: "other-platform", distribution: "binary" })
        .pipe(Effect.flip)).reason,
    ).toBe("unsupported_distribution");
    expect(unavailable.calls()).toEqual({ network: 0, processes: 0 });
  }).pipe(Effect.provide(platform)),
);

it.live("reports the required archive extractor before attempting a binary download", () =>
  Effect.gen(function* () {
    const { catalog, calls } = yield* fixture(
      [
        agent("zip", {
          binary: { "linux-x86_64": { archive: `${archiveUrl}.zip`, cmd: "agent" } },
        }),
        agent("tar", {
          binary: { "linux-x86_64": { archive: `${archiveUrl}.tar.gz`, cmd: "agent" } },
        }),
      ],
      ["tar"],
    );
    expect(yield* catalog.preview({ agentId: "zip" })).toMatchObject({
      distribution: "binary",
      runner: "unzip",
      runnerPath: null,
      available: false,
      reason: "runner_unavailable",
    });
    expect(yield* catalog.preview({ agentId: "tar" })).toMatchObject({
      distribution: "binary",
      runner: "tar",
      runnerPath: "/fixture/bin/tar",
      available: true,
      reason: null,
    });
    expect(calls()).toEqual({ network: 0, processes: 0 });
  }).pipe(Effect.provide(platform)),
);

it.live("refuses changed preview metadata before downloading or installing", () =>
  Effect.gen(function* () {
    const initial = agent("example", binary());
    const { catalog, replace, calls, fs, home } = yield* fixture([initial]);
    const preview = yield* catalog.preview({ agentId: "example" });
    // Even a changed archive with the same version requires renewed review.
    replace([
      {
        ...initial,
        distribution: {
          binary: {
            "linux-x86_64": { archive: `${archiveUrl}?updated`, cmd: "agent", sha256: checksum },
          },
        },
      },
    ]);
    const failure = yield* catalog
      .prepare({
        agentId: "example",
        distribution: "binary",
        expectedInstallationId: preview.installationId,
      })
      .pipe(Effect.flip);
    expect(failure.reason).toBe("install_failed");
    expect(calls()).toEqual({ network: 1, processes: 0 });
    expect(yield* fs.exists(`${home}/tools`)).toBe(false);
  }).pipe(Effect.provide(platform)),
);

it.live("inspects cached versions and local commands without fetching the registry", () =>
  Effect.gen(function* () {
    const { catalog, calls } = yield* fixture([agent("example", binary())]);
    expect(yield* catalog.inspect(settings({ agentId: "example" }))).toMatchObject({
      status: "unprepared",
      version: "1.2.3",
      latestVersion: "1.2.3",
    });
    expect(
      yield* catalog.inspect(settings({ source: "local", commandPath: "local-agent" })),
    ).toMatchObject({
      status: "missing_runner",
      latestVersion: null,
    });
    expect(calls()).toEqual({ network: 0, processes: 0 });
  }).pipe(Effect.provide(platform)),
);

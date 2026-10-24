import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import * as Catalog from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Schedule from "effect/Schedule";
import * as Fiber from "effect/Fiber";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const registryUrl = "https://registry.test/index.json";
const archiveUrl = "https://registry.test/agent.bin";
const decode = Schema.decodeSync(AcpRegistrySettings);
const settings = (installationId?: string) =>
  decode({
    agentId: "example-agent",
    discovery: "explicit",
    ...(installationId ? { installationId } : {}),
  });
const registry = (distribution: Catalog.AcpRegistryAgent["distribution"], version = "1.2.3") =>
  JSON.stringify({
    version: "1.0.0",
    agents: [
      { id: "example-agent", name: "Example", description: "Fixture", version, distribution },
    ],
  });
const platform = Layer.mergeAll(
  NodeServices.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(HostProcess.Architecture, "x64"),
);
const binary = (checksum?: string) => ({
  binary: {
    "linux-x86_64": {
      archive: archiveUrl,
      cmd: "agent",
      ...(checksum ? { sha256: checksum } : {}),
    },
  },
});

it.live(
  "pins explicit binary installations across catalog upgrades and offline launches",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-install-" });
      const bytes = "#!/bin/sh\nexit 0\n";
      const checksum = createHash("sha256").update(bytes).digest("hex");
      let version = "1.2.3";
      let online = true;
      let downloads = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (!online) throw new Error("Unexpected network during a pinned launch");
          if (request.url === archiveUrl) downloads++;
          return HttpClientResponse.fromWeb(
            request,
            new Response(request.url === archiveUrl ? bytes : registry(binary(checksum), version)),
          );
        }),
      );
      const catalog = yield* Catalog.makeAcpRegistryCatalog({
        cacheDir: home,
        toolsDir: `${home}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, process.env),
      );
      yield* catalog.search({ query: "" });
      expect((yield* catalog.inspect(settings())).status).toBe("unprepared");
      expect(Exit.isFailure(yield* catalog.resolve(settings(), home).pipe(Effect.exit))).toBe(true);
      expect(downloads).toBe(0);
      const progress: string[] = [];
      const first = yield* catalog.prepare(
        { agentId: "example-agent", distribution: "binary" },
        (value) =>
          Effect.sync(() => {
            progress.push(value.phase);
          }),
      );
      expect(progress).toContain("verifying");
      const firstLaunch = yield* catalog.resolve(settings(first.installationId), home);
      version = "2.0.0";
      const second = yield* catalog.prepare({ agentId: "example-agent", distribution: "binary" });
      expect(second.installationId).not.toBe(first.installationId);
      expect(
        (yield* catalog.resolve(settings(second.installationId), home)).spawn.command,
      ).not.toBe(firstLaunch.spawn.command);
      online = false;
      expect(yield* catalog.inspect(settings(first.installationId))).toMatchObject({
        status: "ready",
        version: "1.2.3",
        latestVersion: "2.0.0",
      });
      expect((yield* catalog.resolve(settings(first.installationId), home)).spawn.command).toBe(
        firstLaunch.spawn.command,
      );
      expect(downloads).toBe(2);
      yield* fs.remove(`${home}/acp-registry/registry.json`);
      const restarted = yield* Catalog.makeAcpRegistryCatalog({
        cacheDir: home,
        toolsDir: `${home}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, process.env),
      );
      expect(yield* restarted.inspect(settings(first.installationId))).toMatchObject({
        status: "ready",
        version: "1.2.3",
        latestVersion: null,
      });
    }).pipe(Effect.provide(platform)),
  20_000,
);

it.live(
  "cancels an incomplete download without publishing it and permits a clean retry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-cancel-" });
      const downloading = yield* Deferred.make<void>();
      let block = true;
      const client = HttpClient.make((request) =>
        request.url === archiveUrl && block
          ? Deferred.succeed(downloading, undefined).pipe(Effect.andThen(Effect.never))
          : Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(request.url === archiveUrl ? "#!/bin/sh\n" : registry(binary())),
              ),
            ),
      );
      const catalog = yield* Catalog.makeAcpRegistryCatalog({
        cacheDir: home,
        toolsDir: `${home}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, process.env),
      );
      const installing = yield* catalog
        .prepare({ agentId: "example-agent" })
        .pipe(Effect.forkScoped);
      yield* Deferred.await(downloading);
      yield* Fiber.interrupt(installing);
      expect((yield* catalog.inspect(settings())).status).toBe("unprepared");
      block = false;
      const prepared = yield* catalog.prepare({ agentId: "example-agent" });
      expect((yield* catalog.inspect(settings(prepared.installationId))).status).toBe("ready");
    }).pipe(Effect.provide(platform)),
  20_000,
);

it.live(
  "keeps same-version binary sources separate and matches each preview to its installed bytes",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-binary-identity-" });
      const firstBytes = "#!/bin/sh\nprintf first\n";
      const secondBytes = "#!/bin/sh\nprintf second\n";
      const secondArchiveUrl = `${archiveUrl}?revision=2`;
      let revision = 1;
      let downloads = 0;
      const metadata = () => ({
        binary: {
          "linux-x86_64": {
            archive: revision === 1 ? archiveUrl : secondArchiveUrl,
            cmd: "agent",
            sha256: createHash("sha256")
              .update(revision === 1 ? firstBytes : secondBytes)
              .digest("hex"),
          },
        },
      });
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url !== registryUrl) downloads++;
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              request.url === registryUrl
                ? registry(metadata())
                : request.url === archiveUrl
                  ? firstBytes
                  : secondBytes,
            ),
          );
        }),
      );
      const catalog = yield* Catalog.makeAcpRegistryCatalog({
        cacheDir: home,
        toolsDir: `${home}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.provideService(HostProcess.Environment, process.env),
      );
      yield* catalog.search({ query: "example-agent" });
      const firstPreview = yield* catalog.preview({
        agentId: "example-agent",
        distribution: "binary",
      });
      const first = yield* catalog.prepare({
        agentId: "example-agent",
        distribution: "binary",
        expectedInstallationId: firstPreview.installationId,
      });
      const firstLaunch = yield* catalog.resolve(settings(first.installationId), home);
      expect(first.installationId).toBe(firstPreview.installationId);
      expect(firstLaunch.spawn.command).toBe(
        yield* fs.realPath(`${firstPreview.installDirectory}/agent`),
      );
      expect(yield* fs.exists(firstPreview.receiptPath)).toBe(true);

      revision = 2;
      yield* catalog.search({ query: "example-agent" });
      const secondPreview = yield* catalog.preview({
        agentId: "example-agent",
        distribution: "binary",
      });
      expect(secondPreview.version).toBe(firstPreview.version);
      expect(secondPreview.installDirectory).not.toBe(firstPreview.installDirectory);
      const second = yield* catalog.prepare({
        agentId: "example-agent",
        distribution: "binary",
        expectedInstallationId: secondPreview.installationId,
      });
      const secondLaunch = yield* catalog.resolve(settings(second.installationId), home);
      expect(second.installationId).toBe(secondPreview.installationId);
      expect(secondLaunch.spawn.command).toBe(
        yield* fs.realPath(`${secondPreview.installDirectory}/agent`),
      );
      expect(yield* fs.exists(secondPreview.receiptPath)).toBe(true);
      expect(yield* fs.readFileString(secondLaunch.spawn.command)).toBe(secondBytes);
      expect(yield* fs.readFileString(firstLaunch.spawn.command)).toBe(firstBytes);
      expect((yield* catalog.resolve(settings(first.installationId), home)).spawn.command).toBe(
        firstLaunch.spawn.command,
      );
      expect(downloads).toBe(2);
    }).pipe(Effect.provide(platform)),
  20_000,
);

for (const distribution of ["npx", "uvx"] as const) {
  it.effect(
    `prepares ${distribution} in its private root and launches without reinstalling`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: `nodex-acp-${distribution}-` });
        const home = `${root}/12345678-1234-4234-8234-123456789012`;
        yield* fs.makeDirectory(home);
        const tool = distribution === "npx" ? "npm" : "uv";
        const bin = `${home}/bin`;
        const log = `${home}/commands.log`;
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(log, "");
        yield* fs.copyFile(
          fileURLToPath(
            new URL(
              `../../vendor/provider-acp-registry/src/server/testing/AcpRegistrySupport.${tool}.fixture.sh`,
              import.meta.url,
            ),
          ),
          `${bin}/${tool}`,
        );
        yield* fs.chmod(`${bin}/${tool}`, 0o755);
        const environment = {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_NPM_LOG: log,
          FAKE_UV_LOG: log,
          FAKE_NPM_MANIFEST: JSON.stringify({
            name: "@example/acp",
            version: "1.2.3",
            bin: { "example-agent": "dist/cli.js" },
          }),
        };
        const distributionMetadata =
          distribution === "npx"
            ? { ...binary(), npx: { package: "@example/acp@1.2.3", args: ["--acp"] } }
            : { uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] } };
        let online = true;
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            if (!online) throw new Error("Unexpected network after installation");
            return HttpClientResponse.fromWeb(
              request,
              new Response(registry(distributionMetadata)),
            );
          }),
        );
        const catalog = yield* Catalog.makeAcpRegistryCatalog({
          cacheDir: home,
          toolsDir: `${home}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(HostProcess.Environment, environment),
        );
        yield* catalog.search({ query: "" });
        expect((yield* catalog.inspect(settings(), environment)).status).toBe("unprepared");
        expect(
          Exit.isFailure(yield* catalog.resolve(settings(), home, environment).pipe(Effect.exit)),
        ).toBe(true);
        expect(yield* fs.readFileString(log)).toBe("");
        const prepared = yield* catalog.prepare({ agentId: "example-agent", distribution });
        const installationLog = yield* fs.readFileString(log);
        online = false;
        const launched = yield* catalog.resolve(
          settings(prepared.installationId),
          home,
          environment,
        );
        expect(launched.distribution).toBe(distribution);
        expect(launched.spawn.command.startsWith(`${home}/tools/example-agent/1.2.3/`)).toBe(true);
        expect(launched.spawn.args).toEqual(["--acp"]);
        if (distribution === "npx") {
          yield* fs.writeFileString(`${bin}/node`, "#!/bin/sh\nexit 77\n");
          yield* fs.chmod(`${bin}/node`, 0o755);
          yield* fs.writeFileString(
            launched.spawn.command,
            "#!/usr/bin/env node\nprocess.stdout.write(process.execPath)\n",
          );
          const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
            ChildProcess.make(launched.spawn.command, [], {
              cwd: home,
              env: { ...launched.spawn.env, HOME: home },
              extendEnv: false,
            }),
          );
          const output = yield* child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (text, chunk) => text + chunk,
            ),
          );
          expect(Number(yield* child.exitCode)).toBe(0);
          expect(output).toBe(process.execPath);
        }
        expect(yield* fs.readFileString(log)).toBe(installationLog);
        yield* TestClock.adjust("31 seconds");
        expect((yield* catalog.uninstallManagedBinary({ agentId: "example-agent" })).removed).toBe(
          true,
        );
        expect(
          (yield* catalog.inspect(settings(prepared.installationId), environment)).status,
        ).toBe("unprepared");
      }).pipe(Effect.provide(platform)),
    20_000,
  );
}

for (const distribution of ["npx", "uvx"] as const) {
  for (const outcome of ["fail", "cancel"] as const) {
    it.live(
      `reinstalls ${distribution} after ${outcome} leaves incomplete package artifacts`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-package-atomic-" });
          const tool = distribution === "npx" ? "npm" : "uv";
          const bin = `${home}/bin`;
          const log = `${home}/commands.log`;
          const mode = `${home}/install-mode`;
          const partial = `${home}/partial-ready`;
          yield* fs.makeDirectory(bin);
          yield* fs.writeFileString(log, "");
          yield* fs.writeFileString(mode, outcome);
          yield* fs.copyFile(
            fileURLToPath(
              new URL(
                `../../vendor/provider-acp-registry/src/server/testing/AcpRegistrySupport.${tool}.fixture.sh`,
                import.meta.url,
              ),
            ),
            `${bin}/${tool}.real`,
          );
          yield* fs.copyFile(
            fileURLToPath(new URL("./testing/acp-package-manager.sh", import.meta.url)),
            `${bin}/${tool}`,
          );
          yield* fs.chmod(`${bin}/${tool}.real`, 0o755);
          yield* fs.chmod(`${bin}/${tool}`, 0o755);
          const environment = {
            ...process.env,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            ACP_INSTALL_MODE: mode,
            ACP_PARTIAL_READY: partial,
            FAKE_NPM_LOG: log,
            FAKE_UV_LOG: log,
            FAKE_NPM_MANIFEST: JSON.stringify({
              name: "@example/acp",
              version: "1.2.3",
              bin: { "example-agent": "dist/cli.js" },
            }),
          };
          const metadata =
            distribution === "npx"
              ? { npx: { package: "@example/acp@1.2.3" } }
              : { uvx: { package: "fast-agent-acp==0.10.1" } };
          const client = HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(registry(metadata)))),
          );
          const catalog = yield* Catalog.makeAcpRegistryCatalog({
            cacheDir: home,
            toolsDir: `${home}/tools`,
            registryUrl,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, client),
            Effect.provideService(HostProcess.Environment, environment),
          );
          const attempt = catalog.prepare({ agentId: "example-agent", distribution });
          if (outcome === "fail")
            expect(Exit.isFailure(yield* attempt.pipe(Effect.exit))).toBe(true);
          else {
            const running = yield* attempt.pipe(Effect.forkScoped);
            yield* fs
              .exists(partial)
              .pipe(
                Effect.repeat({ until: Boolean, schedule: Schedule.spaced("20 millis") }),
                Effect.timeout("5 seconds"),
              );
            yield* Fiber.interrupt(running);
          }
          expect((yield* catalog.inspect(settings(), environment)).status).toBe("unprepared");
          expect(
            Exit.isFailure(yield* catalog.resolve(settings(), home, environment).pipe(Effect.exit)),
          ).toBe(true);
          const generations = `${home}/tools/example-agent/1.2.3/${distribution === "npx" ? "npm" : "python"}/generations`;
          expect(yield* fs.readDirectory(generations)).toEqual([]);
          yield* fs.writeFileString(mode, "success");
          const installed = yield* attempt;
          const launched = yield* catalog.resolve(
            settings(installed.installationId),
            home,
            environment,
          );
          const commands = (yield* fs.readFileString(log)).trim().split("\n");
          expect(
            commands.filter((line) =>
              line.startsWith(distribution === "npx" ? "install --global" : "tool install"),
            ),
          ).toHaveLength(2);
          const child = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).spawn(
            ChildProcess.make(launched.spawn.command, [], { cwd: home, env: launched.spawn.env }),
          );
          expect(Number(yield* child.exitCode)).toBe(0);
          expect(yield* fs.readDirectory(generations)).toHaveLength(1);
        }).pipe(Effect.provide(platform)),
      20_000,
    );
  }
}

for (const distribution of ["binary", "npx", "uvx"] as const) {
  it.effect(
    `protects ${distribution} publication from queued uninstall until its preparation lease expires`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-install-uninstall-" });
        const bin = `${home}/bin`;
        const log = `${home}/commands.log`;
        yield* fs.makeDirectory(bin);
        yield* fs.writeFileString(log, "");
        for (const tool of ["npm", "uv"]) {
          yield* fs.copyFile(
            fileURLToPath(
              new URL(
                `../../vendor/provider-acp-registry/src/server/testing/AcpRegistrySupport.${tool}.fixture.sh`,
                import.meta.url,
              ),
            ),
            `${bin}/${tool}`,
          );
          yield* fs.chmod(`${bin}/${tool}`, 0o755);
        }
        const environment = {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FAKE_NPM_LOG: log,
          FAKE_UV_LOG: log,
          FAKE_NPM_MANIFEST: JSON.stringify({
            name: "@example/acp",
            version: "1.2.3",
            bin: { "example-agent": "dist/cli.js" },
          }),
        };
        const metadata =
          distribution === "binary"
            ? binary()
            : distribution === "npx"
              ? { npx: { package: "@example/acp@1.2.3" } }
              : { uvx: { package: "fast-agent-acp==0.10.1" } };
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const actualSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const spawner = {
          ...actualSpawner,
          spawn: (command: Parameters<typeof actualSpawner.spawn>[0]) =>
            actualSpawner.spawn(command).pipe(
              Effect.tap(() => Deferred.succeed(started, undefined)),
              Effect.map((child) => ({
                ...child,
                exitCode: Deferred.await(release).pipe(Effect.andThen(child.exitCode)),
              })),
            ),
        };
        const client = HttpClient.make((request) =>
          request.url === registryUrl
            ? Effect.succeed(HttpClientResponse.fromWeb(request, new Response(registry(metadata))))
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(HttpClientResponse.fromWeb(request, new Response("#!/bin/sh\nexit 0\n"))),
              ),
        );
        const catalog = yield* Catalog.makeAcpRegistryCatalog({
          cacheDir: home,
          toolsDir: `${home}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(HostProcess.Environment, environment),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const preparing = yield* catalog
          .prepare({ agentId: "example-agent", distribution })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        const uninstalling = yield* catalog
          .uninstallManagedBinary({ agentId: "example-agent" })
          .pipe(Effect.result, Effect.forkScoped({ startImmediately: true }));
        expect(uninstalling.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        const prepared = yield* Fiber.join(preparing);
        const blocked = yield* Fiber.join(uninstalling);
        expect(blocked._tag).toBe("Failure");
        if (blocked._tag === "Failure") expect(blocked.failure.reason).toBe("busy");
        expect(
          (yield* catalog.inspect(settings(prepared.installationId), environment)).status,
        ).toBe("ready");
        const resolved = yield* catalog.resolve(
          settings(prepared.installationId),
          home,
          environment,
        );
        expect(yield* fs.exists(resolved.spawn.command)).toBe(true);
        expect(
          (yield* catalog.uninstallManagedBinary({ agentId: "example-agent" }).pipe(Effect.flip))
            .reason,
        ).toBe("busy");
        yield* TestClock.adjust("31 seconds");
        expect(yield* catalog.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: true,
        });
        expect(
          (yield* catalog.inspect(settings(prepared.installationId), environment)).status,
        ).toBe("unprepared");
        expect(yield* catalog.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: false,
        });
      }).pipe(Effect.provide(platform)),
    20_000,
  );
}

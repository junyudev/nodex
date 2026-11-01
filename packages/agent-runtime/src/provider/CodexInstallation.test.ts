import { expect, test } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import releaseLock from "../../../../resources/agent-runtime/codex-app-server.lock.json" with { type: "json" };
import { makeCodexInstallation, resolveCodexReleaseAsset } from "./CodexInstallation.ts";
import * as ModelManifest from "./ModelManifest.ts";

for (const platform of ["linux", "win32"] as const) {
  it.effect(`requires the declared exec server in a managed ${platform} package`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "codex-installation-" });
      const release = resolveCodexReleaseAsset(platform, "x64")!;
      const directory = path.join(baseDir, "tools", "codex", release.version);
      const suffix = platform === "win32" ? ".exe" : "";
      const execServer = `bin/codex-exec-server${suffix}`;
      const manifest = {
        layoutVersion: 1,
        version: release.version,
        target: release.target,
        entrypoint: `bin/codex${suffix}`,
        execServer,
      };
      for (const name of [
        manifest.entrypoint,
        execServer,
        `bin/codex-code-mode-host${suffix}`,
        `codex-path/rg${suffix}`,
      ]) {
        const file = path.join(directory, name);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFileString(file, "fixture", { mode: 0o755 });
      }
      const manifestPath = path.join(directory, "codex-package.json");
      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      yield* fs.writeFileString(
        path.join(directory, ".install-complete.json"),
        JSON.stringify({
          version: release.version,
          target: release.target,
          sha256: release.sha256,
        }),
      );
      yield* fs.writeFileString(
        path.join(directory, "..", "active.json"),
        JSON.stringify({ version: release.version }),
      );
      const installation = yield* makeCodexInstallation({ baseDir });
      expect((yield* installation.resolve()).executablePath).toBe(
        path.join(directory, manifest.entrypoint),
      );

      yield* fs.remove(path.join(directory, execServer));
      expect(Exit.isFailure(yield* installation.resolve().pipe(Effect.exit))).toBe(true);
      yield* fs.writeFileString(path.join(directory, execServer), "fixture", { mode: 0o755 });
      yield* fs.writeFileString(
        manifestPath,
        JSON.stringify({ ...manifest, execServer: "bin/other" }),
      );
      expect(Exit.isFailure(yield* installation.resolve().pipe(Effect.exit))).toBe(true);

      yield* fs.writeFileString(manifestPath, JSON.stringify(manifest));
      const manifestService = yield* ModelManifest.ModelManifest;
      const blocked = yield* makeCodexInstallation({ baseDir }).pipe(
        Effect.provideService(ModelManifest.ModelManifest, {
          ...manifestService,
          current: Effect.succeed({
            ...ModelManifest.BUNDLED_MODEL_MANIFEST,
            compatibility: [
              {
                driver: "codex",
                appRange: ">=0.0.0",
                ranges: [{ range: `=${release.version}`, status: "unsupported" as const }],
              },
            ],
          }),
        }),
      );
      expect(Exit.isFailure(yield* blocked.resolve().pipe(Effect.exit))).toBe(true);
    }).pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, "x64"),
      Effect.provideService(HostProcess.Environment, { PATH: "" }),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("No network expected")),
      ),
      Effect.provide(Layer.mergeAll(NodeServices.layer, ModelManifest.layer)),
    ),
  );
}

test.each([
  ["darwin", "arm64", "darwin-arm64"],
  ["linux", "arm64", "linux-arm64"],
  ["linux", "x64", "linux-x64"],
  ["win32", "arm64", "win32-arm64"],
  ["win32", "x64", "win32-x64"],
] as const)("installs the locked official Codex release on %s/%s", (platform, arch, key) => {
  const build = releaseLock.builds[key];
  expect(resolveCodexReleaseAsset(platform, arch)).toEqual({
    version: releaseLock.appServerRuntimeVersion,
    target: build.targetTriple,
    url: build.url,
    sha256: build.archiveSha256,
    archiveBytes: build.archiveSize,
  });
});

test.each([
  ["darwin", "x64"],
  ["linux", "ia32"],
  ["freebsd", "arm64"],
] as const)("does not offer a managed Codex release on %s/%s", (platform, arch) => {
  expect(resolveCodexReleaseAsset(platform, arch)).toBeNull();
});

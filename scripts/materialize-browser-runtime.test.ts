import { writeWindowsBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-windows-test-fixture";
import { windowsBrowserRuntimeLockFixture } from "./testing/browser-runtime-lock-fixture";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { writeBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-test-fixture";
import { BROWSER_RUNTIME_MANIFEST_FILENAME } from "../src/shared/browser-runtime-metadata";
import { archiveBrowserRuntime } from "./archive-browser-runtime";
import { materializeBrowserRuntime } from "./materialize-browser-runtime";
import { readBrowserRuntimeReleaseLock } from "./browser-runtime-release-lock";
import { readBrowserRuntimeFileSha256, stageBrowserRuntime } from "./stage-browser-runtime";

const temporaryRoots: string[] = [];

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("materializeBrowserRuntime", () => {
  test("installs, reuses, and repairs a lock-bound archive", async () => {
    const root = makeRoot("nodex-browser-materialize-");
    const sourceRoot = path.join(root, "source");
    const outputPath = path.join(root, "output");
    const archivePath = path.join(root, "nodex-browser-runtime-test-build-darwin-arm64.tar.gz");
    const lockPath = path.join(root, "browser-runtime.lock.json");
    const manifest = writeBrowserRuntimeFixture(sourceRoot, {
      codexCompatibilityVersion: "0.144.5",
    });
    const archive = archiveBrowserRuntime({ outputPath: archivePath, sourceRoot });
    const runtimeVersions = manifest.runtimeVersions;
    const sharedAsset = {
      archiveSha256: archive.archiveSha256,
      archiveSize: archive.archiveSize,
      assetName: archive.assetName,
      manifestSha256: archive.manifestSha256,
      runtimeVersions,
      url: "https://github.com/example/nodex/releases/download/browser-runtime-test/nodex-browser-runtime-test-build-darwin-arm64.tar.gz",
    };
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        assets: {
          "darwin-arm64": sharedAsset,
          ...windowsBrowserRuntimeLockFixture(manifest.desktopBuild),
        },
        browserPluginVersion: manifest.browserPlugin.version,
        codexCompatibilityVersion: manifest.codexCompatibilityVersion,
        repository: "example/nodex",
        runtimeFamily: "browser",
        schemaVersion: 2,
        source: {
          buildNumber: manifest.desktopBuildNumber,
          desktopBuild: manifest.desktopBuild,
          product: "chatgpt-desktop",
        },
        tag: "browser-runtime-test",
      }),
    );

    await materializeBrowserRuntime({
      archivePath,
      lockPath,
      outputPath,
      projectRootPath: root,
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    const installedManifestPath = path.join(outputPath, BROWSER_RUNTIME_MANIFEST_FILENAME);
    expect(readBrowserRuntimeFileSha256(installedManifestPath)).toBe(archive.manifestSha256);

    const firstModifiedAt = fs.statSync(installedManifestPath).mtimeMs;
    await materializeBrowserRuntime({
      archivePath: path.join(root, "missing.tar.gz"),
      lockPath,
      outputPath,
      projectRootPath: root,
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    expect(fs.statSync(installedManifestPath).mtimeMs).toBe(firstModifiedAt);

    // A new output can use the verified extraction even when the archive is unavailable.
    const secondOutput = path.join(root, "second-output");
    await materializeBrowserRuntime({
      archivePath: path.join(root, "missing.tar.gz"),
      lockPath,
      outputPath: secondOutput,
      projectRootPath: root,
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    const clientPath = path.join(outputPath, manifest.browserPlugin.client);
    const secondClientPath = path.join(secondOutput, manifest.browserPlugin.client);
    expect(fs.statSync(clientPath, { bigint: true }).ino).not.toBe(
      fs.statSync(secondClientPath, { bigint: true }).ino,
    );
    const originalClient = fs.readFileSync(secondClientPath);
    fs.appendFileSync(clientPath, "tampered");
    expect(fs.readFileSync(secondClientPath)).toEqual(originalClient);
    await materializeBrowserRuntime({
      archivePath,
      lockPath,
      outputPath,
      projectRootPath: root,
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    expect(fs.statSync(clientPath).size).toBe(
      manifest.artifacts.find((artifact) => artifact.path === manifest.browserPlugin.client)!.size,
    );

    const defaultCachedArchivePath = path.join(
      root,
      "cache.local",
      "browser-runtime",
      archive.archiveSha256,
      archive.assetName,
    );
    fs.mkdirSync(path.dirname(defaultCachedArchivePath), { recursive: true });
    fs.copyFileSync(archivePath, defaultCachedArchivePath);
    const defaultFetch = vi.fn(async () => {
      throw new Error("default cache should prevent a download");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = defaultFetch as typeof fetch;
    try {
      await materializeBrowserRuntime({
        lockPath,
        outputPath: path.join(root, "default-cache-output"),
        projectRootPath: root,
        targetArch: "arm64",
        targetPlatform: "darwin",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(defaultFetch).not.toHaveBeenCalled();

    const cachePath = path.join(root, "cache");
    const cachedArchivePath = path.join(cachePath, archive.archiveSha256, archive.assetName);
    fs.mkdirSync(path.dirname(cachedArchivePath), { recursive: true });
    fs.writeFileSync(cachedArchivePath, "corrupt");
    const originalDownloadFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
      async () =>
        new Response(fs.readFileSync(archivePath), {
          headers: {
            "content-length": String(archive.archiveSize),
          },
          status: 200,
        }),
    ) as typeof fetch;
    try {
      await materializeBrowserRuntime({
        cachePath,
        lockPath,
        outputPath: path.join(root, "downloaded-output"),
        targetArch: "arm64",
        targetPlatform: "darwin",
      });
    } finally {
      globalThis.fetch = originalDownloadFetch;
    }
    expect(readBrowserRuntimeFileSha256(cachedArchivePath)).toBe(archive.archiveSha256);
  });
});

test.each(["x64", "arm64"] as const)(
  "archives, materializes and stages the unpublished Windows %s closure",
  async (arch) => {
    const root = makeRoot("nodex-browser-materialize-win-");
    const sourceRoot = path.join(root, "source");
    const outputPath = path.join(root, "output");
    const manifest = writeWindowsBrowserRuntimeFixture(sourceRoot, arch);
    const other = writeBrowserRuntimeFixture(path.join(root, "mac"));
    const archivePath = path.join(root, `nodex-browser-runtime-1.0.0-win32-${arch}.tar.gz`);
    const archive = archiveBrowserRuntime({ outputPath: archivePath, sourceRoot });
    const lockPath = path.join(root, "lock.json");
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        assets: {
          "darwin-arm64": {
            ...archive,
            assetName: "nodex-browser-runtime-1.0.0-darwin-arm64.tar.gz",
            runtimeVersions: other.runtimeVersions,
            url: null,
          },
          ...windowsBrowserRuntimeLockFixture("1.0.0"),
          [`win32-${arch}`]: {
            ...windowsBrowserRuntimeLockFixture("1.0.0")[`win32-${arch}`],
            ...archive,
            runtimeVersions: manifest.runtimeVersions,
            sourcePackage: manifest.sourcePackage,
            url: null,
          },
        },
        schemaVersion: 2,
        runtimeFamily: "browser",
        browserPluginVersion: "1.0.0",
        codexCompatibilityVersion: "1.0.0",
        repository: "example/nodex",
        tag: "browser-runtime-v1.0.0",
        source: { buildNumber: "6067", desktopBuild: "1.0.0", product: "chatgpt-desktop" },
      }),
    );
    const options = {
      cachePath: path.join(root, "cache"),
      lockPath,
      outputPath,
      targetArch: arch,
      targetPlatform: "win32" as const,
    };
    await expect(materializeBrowserRuntime(options)).rejects.toThrow("is unpublished");
    await expect(materializeBrowserRuntime({ ...options, archivePath })).resolves.toEqual(manifest);
    const runtimeRoot = path.join(root, "staged");
    const windowsReleaseAsset = readBrowserRuntimeReleaseLock(lockPath).assets[`win32-${arch}`];
    if (!windowsReleaseAsset) throw new Error("Missing Windows test asset");
    const stageOptions = {
      windowsReleaseAsset,
      runtimeRoot,
      sourceRoot: outputPath,
      targetArch: arch,
      targetPlatform: "win32" as const,
      appServerIdentity: {
        targetArch: arch,
        targetPlatform: "win32",
        entrypointSha256: "a".repeat(64),
        protocolSchemaFingerprint: "b".repeat(64),
        runtimeVersion: "1.0.0",
        sourceCommit: "c".repeat(40),
      },
    };
    await expect(
      stageBrowserRuntime({ ...stageOptions, targetArch: arch === "x64" ? "arm64" : "x64" }),
    ).rejects.toThrow("does not match");
    await expect(
      stageBrowserRuntime({
        ...stageOptions,
        appServerIdentity: { ...stageOptions.appServerIdentity, entrypointSha256: "d".repeat(64) },
      }),
    ).rejects.toThrow("exact app-server pair");
    await stageBrowserRuntime(stageOptions);
    expect(
      readBrowserRuntimeFileSha256(
        path.join(runtimeRoot, "browser-runtime", BROWSER_RUNTIME_MANIFEST_FILENAME),
      ),
    ).toBe(archive.manifestSha256);
  },
);

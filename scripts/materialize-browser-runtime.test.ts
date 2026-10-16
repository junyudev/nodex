import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { writeBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-test-fixture";
import { BROWSER_RUNTIME_MANIFEST_FILENAME } from "../src/shared/browser-runtime-metadata";
import { archiveBrowserRuntime } from "./archive-browser-runtime";
import { materializeBrowserRuntime } from "./materialize-browser-runtime";
import { readBrowserRuntimeFileSha256 } from "./stage-browser-runtime";

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

describe("materializeBrowserRuntime", () => {
  test("installs, reuses, and repairs a lock-bound archive", async () => {
    const root = makeRoot("nodex-browser-materialize-");
    const sourceRoot = path.join(root, "source");
    const outputPath = path.join(root, "output");
    const archivePath = path.join(root, "browser-runtime.tar.gz");
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
      url: "https://github.com/example/nodex/releases/download/browser-runtime-test/browser-runtime.tar.gz",
    };
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        assets: {
          "darwin-arm64": sharedAsset,
        },
        browserPluginVersion: manifest.browserPlugin.version,
        codexCompatibilityVersion: manifest.codexCompatibilityVersion,
        repository: "example/nodex",
        runtimeFamily: "browser",
        schemaVersion: 1,
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
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    expect(fs.statSync(installedManifestPath).mtimeMs).toBe(firstModifiedAt);

    const clientPath = path.join(outputPath, manifest.browserPlugin.client);
    fs.appendFileSync(clientPath, "tampered");
    await materializeBrowserRuntime({
      archivePath,
      lockPath,
      outputPath,
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

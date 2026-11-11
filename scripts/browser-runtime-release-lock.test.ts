import { windowsBrowserRuntimeLockFixture } from "./testing/browser-runtime-lock-fixture";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  parseBrowserRuntimeReleaseLock,
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
} from "./browser-runtime-release-lock";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
} from "./agent-runtime-release-lock";
import { isTestedBrowserAppServerPair } from "../src/shared/browser-app-server-compatibility";

const HASH = "a".repeat(64);

function makeLock(): Record<string, unknown> {
  const asset = {
    archiveSha256: HASH,
    archiveSize: 123,
    assetName: "nodex-browser-runtime-26.727.40816-darwin-arm64.tar.gz",
    manifestSha256: HASH,
    runtimeVersions: {
      codexCli: "0.146.0",
      cuaRuntime: "0.0.6/build",
      node: "24.14.0",
      peerAuthorization: `sha256:${HASH}`,
    },
    url: "https://github.com/example/nodex/releases/download/browser-runtime-v26.727.40816/nodex-browser-runtime-26.727.40816-darwin-arm64.tar.gz",
  };
  return {
    assets: {
      "darwin-arm64": asset,
      ...windowsBrowserRuntimeLockFixture("26.727.40816"),
    },
    browserPluginVersion: "26.727.40816",
    codexCompatibilityVersion: "0.144.5",
    repository: "example/nodex",
    runtimeFamily: "browser",
    schemaVersion: 2,
    source: {
      buildNumber: "6067",
      desktopBuild: "26.727.40816",
      product: "chatgpt-desktop",
    },
    tag: "browser-runtime-v26.727.40816",
  };
}

describe("parseBrowserRuntimeReleaseLock", () => {
  test("accepts an exact Apple Silicon release contract", () => {
    const lock = parseBrowserRuntimeReleaseLock(makeLock());

    expect(lock.assets["darwin-arm64"].runtimeVersions.cuaRuntime).toBe("0.0.6/build");
    expect(lock.source.buildNumber).toBe("6067");
  });

  test("rejects locks that silently omit a supported architecture", () => {
    const lock = makeLock();
    delete (lock.assets as Record<string, unknown>)["darwin-arm64"];

    expect(() => parseBrowserRuntimeReleaseLock(lock)).toThrow("must contain exactly darwin-arm64");
  });

  test("rejects non-HTTPS release assets", () => {
    const lock = makeLock();
    const assets = lock.assets as Record<string, Record<string, unknown>>;
    assets["darwin-arm64"]!.url =
      "file:///tmp/nodex-browser-runtime-26.727.40816-darwin-arm64.tar.gz";

    expect(() => parseBrowserRuntimeReleaseLock(lock)).toThrow("assets.darwin-arm64.url");
  });

  test("binds the macOS release to its conformance pair and Windows candidates to their expected primary runtimes", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const browserLockPath = resolveBrowserRuntimeReleaseLockPath(projectRoot);
    expect(fs.existsSync(browserLockPath)).toBe(true);
    const browserLock = readBrowserRuntimeReleaseLock(browserLockPath);
    const agentLock = readCodexAppServerReleaseLock(
      resolveCodexAppServerReleaseLockPath(projectRoot),
    );

    for (const targetArch of ["arm64"] as const) {
      const asset = browserLock.assets[`darwin-${targetArch}`];
      const appServer = {
        entrypointSha256: agentLock.builds[`darwin-${targetArch}`].entrypointSha256,
        protocolSchemaFingerprint: agentLock.protocolSchema.sha256,
        runtimeVersion: agentLock.appServerRuntimeVersion,
        sourceCommit: agentLock.upstream.commit,
        targetArch,
        targetPlatform: "darwin",
      };
      const browser = {
        browserPluginVersion: browserLock.browserPluginVersion,
        manifestSha256: asset.manifestSha256,
        peerCliVersion: asset.runtimeVersions.codexCli,
        targetArch,
        targetPlatform: "darwin",
      };
      expect(isTestedBrowserAppServerPair(appServer, browser)).toBe(true);
    }
    for (const target of ["win32-arm64", "win32-x64"] as const) {
      const asset = browserLock.assets[target];
      expect(asset.appServer.entrypointSha256).toBe(agentLock.builds[target].entrypointSha256);
      expect(asset.appServer.protocolSchemaFingerprint).toBe(agentLock.protocolSchema.sha256);
      expect(asset.appServer.sourceCommit).toBe(agentLock.upstream.commit);
      expect(asset.appServer.runtimeVersion).toBe(agentLock.appServerRuntimeVersion);
      expect(asset.url).toBeNull();
      expect(
        isTestedBrowserAppServerPair(asset.appServer, {
          browserPluginVersion: browserLock.browserPluginVersion,
          manifestSha256: asset.manifestSha256,
          peerCliVersion: asset.runtimeVersions.codexCli,
          targetArch: asset.appServer.targetArch,
          targetPlatform: asset.appServer.targetPlatform,
        }),
      ).toBe(false);
    }
  });
});

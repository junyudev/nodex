import { windowsBrowserRuntimeLockFixture } from "./testing/browser-runtime-lock-fixture";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_RELEASE_TARGETS,
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

  test("records Windows targets with no verified runtime", () => {
    const lock = makeLock();
    const assets = lock.assets as Record<string, unknown>;
    assets["win32-x64"] = null;
    assets["win32-arm64"] = null;

    const parsed = parseBrowserRuntimeReleaseLock(lock);
    expect(parsed.assets["win32-x64"]).toBeNull();
    expect(parsed.assets["win32-arm64"]).toBeNull();
    expect(parsed.assets["darwin-arm64"].url).not.toBeNull();
  });

  test("rejects non-HTTPS release assets", () => {
    const lock = makeLock();
    const assets = lock.assets as Record<string, Record<string, unknown>>;
    assets["darwin-arm64"]!.url =
      "file:///tmp/nodex-browser-runtime-26.727.40816-darwin-arm64.tar.gz";

    expect(() => parseBrowserRuntimeReleaseLock(lock)).toThrow("assets.darwin-arm64.url");
  });

  test("binds every published closure to its exact app-server conformance pair", () => {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const browserLockPath = resolveBrowserRuntimeReleaseLockPath(projectRoot);
    expect(fs.existsSync(browserLockPath)).toBe(true);
    const browserLock = readBrowserRuntimeReleaseLock(browserLockPath);
    const agentLock = readCodexAppServerReleaseLock(
      resolveCodexAppServerReleaseLockPath(projectRoot),
    );

    for (const target of BROWSER_RUNTIME_RELEASE_TARGETS) {
      const [targetPlatform, targetArch] = target.split("-");
      const asset = browserLock.assets[target];
      if (!asset) continue;
      expect(asset.url).not.toBeNull();
      const appServer = {
        entrypointSha256: agentLock.builds[target].entrypointSha256,
        protocolSchemaFingerprint: agentLock.protocolSchema.sha256,
        runtimeVersion: agentLock.appServerRuntimeVersion,
        sourceCommit: agentLock.upstream.commit,
        targetArch,
        targetPlatform,
      };
      const browser = {
        browserPluginVersion: browserLock.browserPluginVersion,
        manifestSha256: asset.manifestSha256,
        peerCliVersion: asset.runtimeVersions.codexCli,
        targetArch,
        targetPlatform,
      };
      if ("appServer" in asset) expect(asset.appServer).toEqual(appServer);
      expect(isTestedBrowserAppServerPair(appServer, browser)).toBe(true);
    }
  });
});

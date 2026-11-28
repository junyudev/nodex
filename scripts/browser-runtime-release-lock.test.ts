import { windowsBrowserRuntimeLockFixture } from "./testing/browser-runtime-lock-fixture";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_RELEASE_TARGETS,
  browserRuntimeReleaseForTarget,
  parseBrowserRuntimeReleaseLock,
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
} from "./browser-runtime-release-lock";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
} from "./agent-runtime-release-lock";
import { isTestedBrowserAppServerPair } from "../src/shared/browser-app-server-compatibility";
import os from "node:os";
import { BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS } from "../src/shared/browser-runtime-metadata";
import {
  browserPluginNodeModuleDirs,
  readCuaRuntimeVersion,
  readMachOMinimumMacosVersion,
  readSkyNativeExports,
} from "./vendor-browser-runtime";

const HASH = "a".repeat(64);

function makeLock(): Record<string, unknown> {
  const asset = {
    archiveSha256: HASH,
    archiveSize: 123,
    unpackedSize: 456,
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

  test("binds Windows archives to their own published release", () => {
    const lock = makeLock();
    const desktopBuild = "26.726.40816";
    const tag = `browser-runtime-v${desktopBuild}.1`;
    lock.windowsRelease = {
      browserPluginVersion: desktopBuild,
      codexCompatibilityVersion: "0.144.4",
      repository: "example/nodex",
      source: { buildNumber: "6066", desktopBuild, product: "chatgpt-desktop" },
      tag,
    };
    const assets = lock.assets as Record<string, unknown>;
    Object.assign(assets, windowsBrowserRuntimeLockFixture(desktopBuild));
    const arm64 = assets["win32-arm64"] as Record<string, unknown>;
    arm64.url = `https://github.com/example/nodex/releases/download/${tag}/${arm64.assetName}`;

    const parsed = parseBrowserRuntimeReleaseLock(lock);
    expect(browserRuntimeReleaseForTarget(parsed, "win32-arm64").tag).toBe(tag);
    expect(browserRuntimeReleaseForTarget(parsed, "darwin-arm64").tag).toBe(lock.tag);

    arm64.url = String(arm64.url).replace(tag, String(lock.tag));
    expect(() => parseBrowserRuntimeReleaseLock(lock)).toThrow("win32-arm64 URL does not match");
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
        browserPluginVersion: browserRuntimeReleaseForTarget(browserLock, target)
          .browserPluginVersion,
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

describe("vendoring the browser runtime", () => {
  const temporaryRoots: string[] = [];

  function writeAddon(exports: readonly string[]): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-sky-exports-"));
    temporaryRoots.push(root);
    const addonPath = path.join(root, "sky.cjs");
    fs.writeFileSync(
      addonPath,
      `module.exports = {${exports.map((name) => `${JSON.stringify(name)}() {}`).join(",")}};\n`,
    );
    return addonPath;
  }

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  test("declares the vendored Browser plugin dependency directory", () => {
    expect(browserPluginNodeModuleDirs()).toEqual([
      "runtime/lib/node_modules",
      "marketplace/plugins/browser/node_modules",
    ]);
  });

  describe("readCuaRuntimeVersion", () => {
    test("reads the unified CUA runtime version used by current desktop builds", () => {
      expect(
        readCuaRuntimeVersion({
          runtime_archive_version: "0.0.6/current",
          node_repl_archive_path: "legacy",
        }),
      ).toBe("0.0.6/current");
    });

    test("requires the current runtime manifest field", () => {
      expect(() =>
        readCuaRuntimeVersion({
          node_repl_archive_path: "legacy",
        }),
      ).toThrow("CUA runtime version");
    });
  });

  test("records the selected Chrome host architecture's actual deployment target", () => {
    expect(
      readMachOMinimumMacosVersion("/signed/ChatGPT for Chrome", "arm64", (command, args) => {
        expect(command).toBe("/usr/bin/otool");
        expect(args).toEqual(["-arch", "arm64", "-l", "/signed/ChatGPT for Chrome"]);
        return `
Load command 8
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 10.12
      sdk 15.5
`;
      }),
    ).toBe("10.12");
  });

  describe("sky.node ABI vendoring", () => {
    test("records every function export in stable sorted order", () => {
      const required = Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS).flat();
      const expected = [...new Set(["futureNativeCapability", ...required])].sort();

      expect(readSkyNativeExports(process.execPath, writeAddon(expected.toReversed()))).toEqual(
        expected,
      );
    });

    test("rejects an add-on missing a required capability export", () => {
      const required = Object.values(BROWSER_RUNTIME_NATIVE_PIP_EXPORT_GROUPS).flat();
      const incomplete = required.filter(
        (name) => name !== "setRemoteHostedPIPContentLayoutStateChangedHandler",
      );

      expect(() => readSkyNativeExports(process.execPath, writeAddon(incomplete))).toThrow(
        "setRemoteHostedPIPContentLayoutStateChangedHandler",
      );
    });
  });
});

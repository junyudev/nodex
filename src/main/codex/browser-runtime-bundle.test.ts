import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  parseBrowserRuntimeManifest,
} from "../../shared/browser-runtime-metadata";
import type {
  AppServerRuntimeIdentity,
  TestedBrowserAppServerPair,
} from "../../shared/browser-app-server-compatibility";
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import { writeBrowserRuntimeFixture } from "./browser-runtime-test-fixture";

const temporaryRoots: string[] = [];
const APP_SERVER_IDENTITY: AppServerRuntimeIdentity = {
  entrypointSha256: "a".repeat(64),
  protocolSchemaFingerprint: "b".repeat(64),
  runtimeVersion: "0.152.0-test",
  sourceCommit: "c".repeat(40),
  targetArch: "arm64",
  targetPlatform: "darwin",
};

function makeRuntimeRoot(): string {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-runtime-"));
  temporaryRoots.push(runtimeRoot);
  return runtimeRoot;
}

function testedPairFor(runtimeRoot: string): readonly TestedBrowserAppServerPair[] {
  const manifestPath = path.join(
    runtimeRoot,
    BROWSER_RUNTIME_BUNDLE_DIRECTORY,
    BROWSER_RUNTIME_MANIFEST_FILENAME,
  );
  if (!fs.existsSync(manifestPath)) return [];
  const bytes = fs.readFileSync(manifestPath);
  const manifest = parseBrowserRuntimeManifest(JSON.parse(bytes.toString("utf8")));
  if (!manifest) return [];
  return [
    {
      appServer: APP_SERVER_IDENTITY,
      browser: {
        browserPluginVersion: manifest.browserPlugin.version,
        manifestSha256: createHash("sha256").update(bytes).digest("hex"),
        peerCliVersion: manifest.runtimeVersions.codexCli,
        targetArch: manifest.targetArch,
        targetPlatform: manifest.targetPlatform,
      },
    },
  ];
}

function resolveFixture(
  runtimeRoot: string,
  testedPairs: readonly TestedBrowserAppServerPair[] = testedPairFor(runtimeRoot),
) {
  return resolveBrowserRuntimeBundle({
    appServerIdentity: APP_SERVER_IDENTITY,
    runtimeRoot,
    targetArch: "arm64",
    targetPlatform: "darwin",
    testedPairs,
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe("resolveBrowserRuntimeBundle", () => {
  test("returns an explicit unavailable state when no bundle is installed", () => {
    const result = resolveFixture(makeRuntimeRoot());

    expect(result).toMatchObject({
      reason: "manifest-missing",
      status: "unavailable",
    });
  });

  test("exposes only verified absolute bundle paths", () => {
    const runtimeRoot = makeRuntimeRoot();
    const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    const manifest = writeBrowserRuntimeFixture(bundleRoot);

    const result = resolveFixture(runtimeRoot);

    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.bundle.paths.nodeRepl).toBe(path.join(bundleRoot, "bin", "node_repl"));
    expect(result.bundle.paths.browserPluginService).toBe(
      path.join(bundleRoot, "marketplace", "plugins", "browser", "service.js"),
    );
    expect(result.bundle.paths.computerUseRpcService).toBe(
      path.join(
        bundleRoot,
        "runtime",
        "lib",
        "node_modules",
        "@oai",
        "sky",
        "dist",
        "project",
        "cua",
        "sky_js",
        "src",
        "service.js",
      ),
    );
    expect(result.bundle.paths.chromeNativeHost).toBe(
      path.join(
        bundleRoot,
        "marketplace",
        "plugins",
        "chrome",
        "extension-host",
        "macos",
        "arm64",
        "ChatGPT for Chrome",
      ),
    );
    expect(result.bundle.paths.chromeInstallManifest).toBe(
      path.join(bundleRoot, "marketplace", "plugins", "chrome", "scripts", "installManifest.mjs"),
    );
    expect(result.bundle.browserPluginRoot).toBe(
      path.join(bundleRoot, "marketplace", "plugins", "browser"),
    );
    if (manifest.capabilities.computerUse.status !== "available") {
      throw new Error("Computer Use fixture is unavailable");
    }
    expect(manifest.artifacts).toContainEqual(
      expect.objectContaining({ path: manifest.capabilities.computerUse.rpcService }),
    );
  });

  test("makes a tampered payload unavailable before it reaches thread config", () => {
    const runtimeRoot = makeRuntimeRoot();
    const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    writeBrowserRuntimeFixture(bundleRoot);
    fs.appendFileSync(
      path.join(bundleRoot, "marketplace", "plugins", "browser", "client.js"),
      "tampered",
    );

    expect(resolveFixture(runtimeRoot)).toMatchObject({
      reason: "artifact-integrity",
      status: "unavailable",
    });
  });

  test("rejects symlinked artifact parents even when their payload is valid", () => {
    const runtimeRoot = makeRuntimeRoot();
    const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    writeBrowserRuntimeFixture(bundleRoot);
    const pluginRoot = path.join(bundleRoot, "marketplace");
    const relocatedPluginRoot = path.join(runtimeRoot, "relocated-plugins");
    fs.renameSync(pluginRoot, relocatedPluginRoot);
    fs.symlinkSync(relocatedPluginRoot, pluginRoot);

    expect(resolveFixture(runtimeRoot)).toMatchObject({
      reason: "artifact-invalid",
      status: "unavailable",
    });
  });

  test("rejects a valid bundle without an exact conformance record", () => {
    const runtimeRoot = makeRuntimeRoot();
    writeBrowserRuntimeFixture(path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY));

    expect(resolveFixture(runtimeRoot, [])).toMatchObject({
      reason: "untested-runtime-pair",
      status: "unavailable",
    });
  });

  test("accepts only the exact app-server and Browser artifact identities", () => {
    const runtimeRoot = makeRuntimeRoot();
    writeBrowserRuntimeFixture(path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY), {
      codexCliVersion: "0.146.0-alpha.9",
      codexCompatibilityVersion: "0.144.5",
    });

    expect(resolveFixture(runtimeRoot).status).toBe("available");
    const pair = testedPairFor(runtimeRoot)[0];
    if (!pair) throw new Error("Expected a tested fixture pair");
    const wrongAppServerPair: TestedBrowserAppServerPair = {
      ...pair,
      appServer: { ...pair.appServer, entrypointSha256: "d".repeat(64) },
    };

    expect(resolveFixture(runtimeRoot, [wrongAppServerPair])).toMatchObject({
      reason: "untested-runtime-pair",
      status: "unavailable",
    });
  });

  test("provides a platform verification seam for architecture and signing checks", () => {
    const runtimeRoot = makeRuntimeRoot();
    writeBrowserRuntimeFixture(path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY));

    const result = resolveBrowserRuntimeBundle({
      appServerIdentity: APP_SERVER_IDENTITY,
      platformArtifactVerifier: ({ artifact, manifest }) =>
        artifact.kind === "native-addon" && manifest.peerAuthorization.signingTeamId !== "REALTEAM"
          ? "unexpected signing team"
          : null,
      runtimeRoot,
      targetArch: "arm64",
      targetPlatform: "darwin",
      testedPairs: testedPairFor(runtimeRoot),
    });

    expect(result).toMatchObject({
      reason: "platform-verification-failed",
      status: "unavailable",
    });
  });

  test("rejects an invalid manifest without reading undeclared paths", () => {
    const runtimeRoot = makeRuntimeRoot();
    const bundleRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(bundleRoot);
    fs.writeFileSync(path.join(bundleRoot, BROWSER_RUNTIME_MANIFEST_FILENAME), "{}");

    expect(resolveFixture(runtimeRoot)).toMatchObject({
      reason: "invalid-manifest",
      status: "unavailable",
    });
  });
});

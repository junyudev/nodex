import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  BROWSER_RUNTIME_SCHEMA_VERSION,
} from "../src/shared/browser-runtime-metadata";
import { writeBrowserRuntimeFixture } from "../src/main/codex/browser-runtime-test-fixture";
import { resolveBrowserRuntimeBundle } from "../src/main/codex/browser-runtime-bundle";
import type {
  AppServerRuntimeIdentity,
  TestedBrowserAppServerPair,
} from "../src/shared/browser-app-server-compatibility";
import { parseBrowserRuntimeManifest } from "../src/shared/browser-runtime-metadata";
import { stageBrowserRuntime } from "./stage-browser-runtime";

const temporaryRoots: string[] = [];
const APP_SERVER_IDENTITY: AppServerRuntimeIdentity = {
  entrypointSha256: "a".repeat(64),
  protocolSchemaFingerprint: "b".repeat(64),
  runtimeVersion: "0.152.0-test",
  sourceCommit: "c".repeat(40),
  targetArch: "arm64",
  targetPlatform: "darwin",
};

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function testedPairsForSource(sourceRoot: string): readonly TestedBrowserAppServerPair[] {
  const sourceBytes = fs.readFileSync(path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME));
  const sourceValue = JSON.parse(sourceBytes.toString("utf8")) as { schemaVersion?: unknown };
  const sourceManifest = parseBrowserRuntimeManifest(sourceValue);
  if (!sourceManifest) throw new Error("Expected a valid Browser fixture manifest");
  const manifest = sourceManifest;
  return [
    {
      appServer: APP_SERVER_IDENTITY,
      browser: {
        browserPluginVersion: manifest.browserPlugin.version,
        manifestSha256: createHash("sha256").update(sourceBytes).digest("hex"),
        peerCliVersion: manifest.runtimeVersions.codexCli,
        targetArch: manifest.targetArch,
        targetPlatform: manifest.targetPlatform,
      },
    },
  ];
}

function stageOptions(sourceRoot: string, runtimeRoot: string) {
  return {
    appServerIdentity: APP_SERVER_IDENTITY,
    runtimeRoot,
    sourceRoot,
    targetArch: "arm64" as const,
    targetPlatform: "darwin" as const,
    testedPairs: testedPairsForSource(sourceRoot),
  };
}

function resolveOptions(runtimeRoot: string, sourceRoot: string) {
  return {
    appServerIdentity: APP_SERVER_IDENTITY,
    runtimeRoot,
    targetArch: "arm64" as const,
    targetPlatform: "darwin" as const,
    testedPairs: testedPairsForSource(sourceRoot),
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

describe.skipIf(process.platform === "win32")("stageBrowserRuntime", () => {
  test("atomically installs a source closure that passes runtime verification", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const previousRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(previousRoot);
    fs.writeFileSync(path.join(previousRoot, "stale"), "stale");

    await stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(fs.existsSync(path.join(previousRoot, "stale"))).toBe(false);
    expect(
      (await resolveBrowserRuntimeBundle(resolveOptions(runtimeRoot, sourceRoot))).status,
    ).toBe("available");
  });

  test("installs an explicitly tested Browser and App Server artifact pair", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot, {
      codexCliVersion: "0.146.0-alpha.9",
      codexCompatibilityVersion: "0.144.5",
    });

    await stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(
      (await resolveBrowserRuntimeBundle(resolveOptions(runtimeRoot, sourceRoot))).status,
    ).toBe("available");
  });

  test("preserves the exact current manifest bytes during staging", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
    fs.appendFileSync(manifestPath, "\n");
    const staged = await stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));
    const activePath = path.join(
      runtimeRoot,
      BROWSER_RUNTIME_BUNDLE_DIRECTORY,
      BROWSER_RUNTIME_MANIFEST_FILENAME,
    );
    expect(fs.readFileSync(activePath)).toEqual(fs.readFileSync(manifestPath));
    expect(staged.schemaVersion).toBe(BROWSER_RUNTIME_SCHEMA_VERSION);
  });

  test("preserves the previously active bundle when source verification fails", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    fs.appendFileSync(
      path.join(sourceRoot, "marketplace", "plugins", "browser", "client.js"),
      "tampered",
    );
    const activeRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(activeRoot);
    fs.writeFileSync(path.join(activeRoot, "preserved"), "active");

    await expect(stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot))).rejects.toThrow(
      "does not match its manifest",
    );
    expect(fs.readFileSync(path.join(activeRoot, "preserved"), "utf8")).toBe("active");
  });

  test("rejects undeclared payloads instead of silently expanding trust", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    writeBrowserRuntimeFixture(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, "undeclared.js"), "payload");

    await expect(
      stageBrowserRuntime(stageOptions(sourceRoot, makeRoot("nodex-browser-destination-"))),
    ).rejects.toThrow("exactly the manifest-declared artifacts");
  });

  test("repairs an otherwise reusable active closure with an undeclared payload", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const options = stageOptions(sourceRoot, runtimeRoot);
    await stageBrowserRuntime(options);
    const undeclaredPath = path.join(
      runtimeRoot,
      BROWSER_RUNTIME_BUNDLE_DIRECTORY,
      "undeclared.js",
    );
    fs.writeFileSync(undeclaredPath, "payload");

    await stageBrowserRuntime(options);

    expect(fs.existsSync(undeclaredPath)).toBe(false);
  });

  test("repairs same-size active corruption and rejects same-size source corruption on reuse", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    const manifest = writeBrowserRuntimeFixture(sourceRoot);
    const options = stageOptions(sourceRoot, runtimeRoot);
    await stageBrowserRuntime(options);
    const artifact = manifest.artifacts.find((entry) => entry.size > 0)!;
    const sourcePath = path.join(sourceRoot, artifact.path);
    const activePath = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY, artifact.path);
    const expected = fs.readFileSync(sourcePath);
    const changed = Buffer.from(expected);
    changed[0] ^= 1;
    fs.writeFileSync(activePath, changed);
    await stageBrowserRuntime(options);
    expect(fs.readFileSync(activePath)).toEqual(expected);

    fs.writeFileSync(sourcePath, changed);
    await expect(stageBrowserRuntime(options)).rejects.toThrow("does not match its manifest");
    expect(fs.readFileSync(activePath)).toEqual(expected);
  });

  test("repairs an active closure containing a symlink without following its target", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    const manifest = writeBrowserRuntimeFixture(sourceRoot);
    const options = stageOptions(sourceRoot, runtimeRoot);
    await stageBrowserRuntime(options);
    const artifact = manifest.artifacts[0]!;
    const activePath = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY, artifact.path);
    const targetPath = path.join(sourceRoot, artifact.path);
    fs.unlinkSync(activePath);
    fs.symlinkSync(targetPath, activePath);
    await stageBrowserRuntime(options);
    expect(fs.lstatSync(activePath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(activePath)).toEqual(fs.readFileSync(targetPath));
  });

  test("keeps the active bundle when platform verification rejects a staged native artifact", async () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const activeRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(activeRoot);
    fs.writeFileSync(path.join(activeRoot, "preserved"), "active");

    await expect(
      stageBrowserRuntime({
        ...stageOptions(sourceRoot, runtimeRoot),
        platformArtifactVerifier: async ({ artifact }) =>
          artifact.kind === "native-addon" ? "Node-API ABI mismatch" : null,
      }),
    ).rejects.toThrow("Node-API ABI mismatch");
    expect(fs.readFileSync(path.join(activeRoot, "preserved"), "utf8")).toBe("active");
  });
});

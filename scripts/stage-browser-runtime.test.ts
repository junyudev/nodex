import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  BROWSER_PLUGIN_NODE_MODULE_DIR,
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
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
  const sourceManifest = parseBrowserRuntimeManifest(JSON.parse(sourceBytes.toString("utf8")));
  if (!sourceManifest) throw new Error("Expected a valid Browser fixture manifest");
  const manifest = sourceManifest.browserPlugin.nodeModuleDirs.includes(
    "marketplace/plugins/browser/scripts/node_modules",
  )
    ? {
        ...sourceManifest,
        browserPlugin: {
          ...sourceManifest.browserPlugin,
          nodeModuleDirs: sourceManifest.browserPlugin.nodeModuleDirs.map((directory) =>
            directory === "marketplace/plugins/browser/scripts/node_modules"
              ? BROWSER_PLUGIN_NODE_MODULE_DIR
              : directory,
          ),
        },
      }
    : sourceManifest;
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return [
    {
      appServer: APP_SERVER_IDENTITY,
      browser: {
        browserPluginVersion: manifest.browserPlugin.version,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
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

describe("stageBrowserRuntime", () => {
  test("atomically installs a source closure that passes runtime verification", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const previousRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(previousRoot);
    fs.writeFileSync(path.join(previousRoot, "stale"), "stale");

    stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(fs.existsSync(path.join(previousRoot, "stale"))).toBe(false);
    expect(resolveBrowserRuntimeBundle(resolveOptions(runtimeRoot, sourceRoot)).status).toBe(
      "available",
    );
  });

  test("installs an explicitly tested Browser and App Server artifact pair", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot, {
      codexCliVersion: "0.146.0-alpha.9",
      codexCompatibilityVersion: "0.144.5",
    });

    stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(resolveBrowserRuntimeBundle(resolveOptions(runtimeRoot, sourceRoot)).status).toBe(
      "available",
    );
  });

  test("normalizes legacy Browser plugin module paths during staging", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const manifestPath = path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      browserPlugin: { nodeModuleDirs: string[] };
    };
    manifest.browserPlugin.nodeModuleDirs = manifest.browserPlugin.nodeModuleDirs.map(
      (directory) =>
        directory === BROWSER_PLUGIN_NODE_MODULE_DIR
          ? "marketplace/plugins/browser/scripts/node_modules"
          : directory,
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const stagedManifest = stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(stagedManifest.browserPlugin.nodeModuleDirs).toContain(BROWSER_PLUGIN_NODE_MODULE_DIR);
    expect(stagedManifest.browserPlugin.nodeModuleDirs).not.toContain(
      "marketplace/plugins/browser/scripts/node_modules",
    );
    const activeRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    const activeRootInode = fs.statSync(activeRoot).ino;

    stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot));

    expect(resolveBrowserRuntimeBundle(resolveOptions(runtimeRoot, sourceRoot)).status).toBe(
      "available",
    );
    expect(fs.statSync(activeRoot).ino).toBe(activeRootInode);
  });

  test("preserves the previously active bundle when source verification fails", () => {
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

    expect(() => stageBrowserRuntime(stageOptions(sourceRoot, runtimeRoot))).toThrow(
      "does not match its manifest",
    );
    expect(fs.readFileSync(path.join(activeRoot, "preserved"), "utf8")).toBe("active");
  });

  test("rejects undeclared payloads instead of silently expanding trust", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    writeBrowserRuntimeFixture(sourceRoot);
    fs.writeFileSync(path.join(sourceRoot, "undeclared.js"), "payload");

    expect(() =>
      stageBrowserRuntime(stageOptions(sourceRoot, makeRoot("nodex-browser-destination-"))),
    ).toThrow("exactly the manifest-declared artifacts");
  });

  test("repairs an otherwise reusable active closure with an undeclared payload", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const options = stageOptions(sourceRoot, runtimeRoot);
    stageBrowserRuntime(options);
    const undeclaredPath = path.join(
      runtimeRoot,
      BROWSER_RUNTIME_BUNDLE_DIRECTORY,
      "undeclared.js",
    );
    fs.writeFileSync(undeclaredPath, "payload");

    stageBrowserRuntime(options);

    expect(fs.existsSync(undeclaredPath)).toBe(false);
  });

  test("keeps the active bundle when platform verification rejects a staged native artifact", () => {
    const sourceRoot = makeRoot("nodex-browser-source-");
    const runtimeRoot = makeRoot("nodex-browser-destination-");
    writeBrowserRuntimeFixture(sourceRoot);
    const activeRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
    fs.mkdirSync(activeRoot);
    fs.writeFileSync(path.join(activeRoot, "preserved"), "active");

    expect(() =>
      stageBrowserRuntime({
        ...stageOptions(sourceRoot, runtimeRoot),
        platformArtifactVerifier: ({ artifact }) =>
          artifact.kind === "native-addon" ? "Node-API ABI mismatch" : null,
      }),
    ).toThrow("Node-API ABI mismatch");
    expect(fs.readFileSync(path.join(activeRoot, "preserved"), "utf8")).toBe("active");
  });
});

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { BROWSER_RUNTIME_SCHEMA_VERSION } from "../src/shared/browser-runtime-metadata";
import {
  applyMacCodeObjectEntitlementPolicy,
  applyMacSigningMode,
  isPreservedBrowserRuntimeVendorCode,
  isPreservedCodexRuntimeVendorCode,
  refreshSignedBrowserRuntimeManifest,
  refreshSignedSparkleRuntimeManifest,
  refreshSignedWorkspaceRuntimeManifest,
  isWorkspaceRuntimeData,
  sparkleCodeSignArguments,
} from "./sign-macos-runtime.mjs";

const temporaryRoots: string[] = [];

test("signs workspace Mach-O code while leaving document and bytecode data to the outer seal", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-workspace-code-"));
  temporaryRoots.push(app);
  const root = path.join(app, "Contents/Resources/workspace-runtime");
  fs.mkdirSync(root, { recursive: true });
  const binary = path.join(root, "extension.so");
  const data = path.join(root, "template.docx");
  fs.writeFileSync(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe]));
  fs.writeFileSync(data, Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  expect(isWorkspaceRuntimeData(app, binary)).toBe(false);
  expect(isWorkspaceRuntimeData(app, data)).toBe(true);
  expect(isWorkspaceRuntimeData(app, app)).toBe(false);
});

test("reseals signed workspace binaries and rejects escaping artifact paths", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-signed-workspace-"));
  temporaryRoots.push(app);
  const root = path.join(app, "Contents/Resources/workspace-runtime");
  fs.mkdirSync(path.join(root, "python/bin"), { recursive: true });
  const executable = path.join(root, "python/bin/python3.13");
  fs.writeFileSync(executable, "signed Python");
  const manifestPath = path.join(root, "workspace-runtime-manifest.json");
  const manifest = {
    schemaVersion: 1,
    targetPlatform: "darwin",
    targetArch: "arm64",
    pythonExecutable: "python/bin/python3.13",
    artifacts: [{ path: "python/bin/python3.13", size: 0, sha256: "old", executable: true }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  refreshSignedWorkspaceRuntimeManifest(app);
  expect(JSON.parse(fs.readFileSync(manifestPath, "utf8")).artifacts).toEqual([
    {
      ...manifest.artifacts[0],
      size: 13,
      sha256: createHash("sha256").update("signed Python").digest("hex"),
    },
  ]);
  manifest.artifacts[0]!.path = "../outside";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => refreshSignedWorkspaceRuntimeManifest(app)).toThrow(
    "Invalid workspace artifact path",
  );
});

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("applyMacSigningMode", () => {
  const releaseOptions = {
    app: "/tmp/Nodex.app",
    platform: "darwin",
    optionsForFile: (filePath: string) => ({
      entitlements: `${filePath}.entitlements`,
      hardenedRuntime: true,
    }),
  };

  test("returns release options untouched when no mode is selected", () => {
    expect(applyMacSigningMode(releaseOptions, undefined)).toBe(releaseOptions);
  });

  test("local mode disables timestamping while keeping per-file release options", () => {
    const local = applyMacSigningMode(releaseOptions, "local");
    expect(local).not.toBe(releaseOptions);
    expect(local.optionsForFile("/tmp/Nodex.app/Contents/MacOS/Nodex")).toEqual({
      entitlements: "/tmp/Nodex.app/Contents/MacOS/Nodex.entitlements",
      hardenedRuntime: true,
      timestamp: "none",
    });
  });

  test("local mode disables timestamping even without base per-file options", () => {
    const local = applyMacSigningMode({ app: "/tmp/Nodex.app", platform: "darwin" }, "local");
    expect(local.optionsForFile?.("/tmp/anything")).toEqual({ timestamp: "none" });
  });

  test("rejects unknown signing modes instead of silently signing differently", () => {
    expect(() => applyMacSigningMode(releaseOptions, "adhoc")).toThrow(
      "Unknown NODEX_MAC_SIGN_MODE: adhoc",
    );
  });
});

describe("macOS code-object entitlement policy", () => {
  const appPath = "/tmp/Nodex.app";
  const policy = applyMacCodeObjectEntitlementPolicy({
    app: appPath,
    platform: "darwin",
    optionsForFile: (filePath: string) => ({ entitlements: `${filePath}.entitlements` }),
  });

  test("preserves Electron entitlements only for the main runtime closure", () => {
    const mainExecutable = path.join(appPath, "Contents/MacOS/Nodex");
    const rendererHelper = path.join(
      appPath,
      "Contents/Frameworks/Nodex Helper (Renderer).app/Contents/MacOS/Nodex Helper (Renderer)",
    );
    expect(policy.optionsForFile(mainExecutable).entitlements).toBe(
      `${mainExecutable}.entitlements`,
    );
    expect(policy.optionsForFile(rendererHelper).entitlements).toBe(
      `${rendererHelper}.entitlements`,
    );
  });

  test("replaces inherited Electron entitlements with an empty plist for native helpers", () => {
    for (const nativePath of [
      path.join(appPath, "Contents/Resources/bin/nodex-dictation-helper"),
      path.join(
        appPath,
        "Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/Release/pty.node",
      ),
      path.join(appPath, "Contents/Helpers/Nodex Service.app/Contents/MacOS/nodex-service"),
    ]) {
      expect(policy.optionsForFile(nativePath).entitlements).toEqual([]);
    }
  });
});

describe("desktop tool runtime vendor signing boundary", () => {
  const appPath = "/tmp/Nodex.app";
  const vendorRuntimePath = path.join(appPath, "Contents/Resources/browser-runtime");

  test("preserves the complete signed runtime closure but not adjacent code", () => {
    expect(
      isPreservedBrowserRuntimeVendorCode(
        appPath,
        path.join(
          vendorRuntimePath,
          "runtime/lib/node_modules/@oai/sky/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService",
        ),
      ),
    ).toBe(true);
    expect(
      isPreservedBrowserRuntimeVendorCode(appPath, path.join(vendorRuntimePath, "native/sky.node")),
    ).toBe(true);
    expect(
      isPreservedBrowserRuntimeVendorCode(appPath, path.join(vendorRuntimePath, "bin/node_repl")),
    ).toBe(true);
    expect(
      isPreservedBrowserRuntimeVendorCode(appPath, `${vendorRuntimePath}.backup/native/sky.node`),
    ).toBe(false);
    expect(
      isPreservedBrowserRuntimeVendorCode(
        appPath,
        path.join(appPath, "Contents/Resources/bin/nodex"),
      ),
    ).toBe(false);
  });
});

describe("Codex runtime vendor signing boundary", () => {
  const appPath = "/tmp/Nodex.app";

  test("preserves only the official Codex package executables", () => {
    for (const relativePath of [
      "Contents/Resources/bin/codex-app-server",
      "Contents/Resources/bin/codex-code-mode-host",
      "Contents/Resources/codex-path/rg",
      "Contents/Resources/codex-resources/zsh/bin/zsh",
    ]) {
      expect(isPreservedCodexRuntimeVendorCode(appPath, path.join(appPath, relativePath))).toBe(
        true,
      );
    }
    expect(
      isPreservedCodexRuntimeVendorCode(
        appPath,
        path.join(appPath, "Contents/Resources/bin/nodex"),
      ),
    ).toBe(false);
    expect(
      isPreservedCodexRuntimeVendorCode(
        appPath,
        path.join(appPath, "Contents/Resources/bin/codex-app-server.backup"),
      ),
    ).toBe(false);
  });
});

describe("Sparkle code signing", () => {
  test("uses hardened runtime without an entitlement file", () => {
    expect(
      sparkleCodeSignArguments({
        identity: "DEVELOPER-ID-HASH",
        keychain: "/tmp/nodex.keychain-db",
        local: false,
        targetPath: "/tmp/Nodex.app/Contents/Frameworks/Sparkle.framework",
      }),
    ).toEqual([
      "--force",
      "--sign",
      "DEVELOPER-ID-HASH",
      "--options",
      "runtime",
      "--timestamp",
      "--keychain",
      "/tmp/nodex.keychain-db",
      "/tmp/Nodex.app/Contents/Frameworks/Sparkle.framework",
    ]);
  });

  test("reseals Sparkle artifacts after code signing changes their bytes", () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-sparkle-signing-"));
    temporaryRoots.push(appPath);
    const artifactPaths = {
      autoupdate: "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
      bridge: "Resources/native/nodex-sparkle.node",
      frameworkExecutable: "Frameworks/Sparkle.framework/Versions/B/Sparkle",
      frameworkInfoPlist: "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
      updater: "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
    };
    const artifacts = Object.fromEntries(
      Object.entries(artifactPaths).map(([name, relativePath]) => {
        const filePath = path.join(appPath, "Contents", relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, `signed-${name}\n`);
        return [name, { path: relativePath, sha256: "0".repeat(64), size: 1 }];
      }),
    );
    const manifestPath = path.join(appPath, "Contents/Resources/native/sparkle-runtime.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        architecture: "arm64",
        artifacts,
        buildChannel: "nightly",
        feedUrls: {
          stable: "https://nodex.jyu.app/updates/stable/arm64/appcast.xml",
          nightly: "https://nodex.jyu.app/updates/nightly/arm64/appcast.xml",
        },
        minimumMacOS: "15.0",
        publicKey: "A".repeat(43) + "=",
        schemaVersion: 3,
        sparkleArchiveSha256: "1".repeat(64),
        sparkleVersion: "2.9.4",
      }),
    );

    refreshSignedSparkleRuntimeManifest(appPath);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts: Record<string, { path: string; sha256: string; size: number }>;
    };
    expect(manifest.artifacts.bridge).toMatchObject({
      path: artifactPaths.bridge,
      sha256: createHash("sha256").update("signed-bridge\n").digest("hex"),
      size: Buffer.byteLength("signed-bridge\n"),
    });
    expect(manifest).toMatchObject({
      architecture: "arm64",
      buildChannel: "nightly",
      schemaVersion: 3,
    });
  });
});

describe("refreshSignedBrowserRuntimeManifest", () => {
  test("reseals the current Browser runtime manifest schema", () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-signing-"));
    temporaryRoots.push(appPath);
    const browserRoot = path.join(appPath, "Contents", "Resources", "browser-runtime");
    const executablePath = path.join(browserRoot, "bin", "node_repl");
    const peerAuthorizationPath = path.join(browserRoot, "peer", "authorize.node");
    fs.mkdirSync(path.dirname(executablePath), { recursive: true });
    fs.writeFileSync(executablePath, "developer-id-signed-node-repl", { mode: 0o755 });
    fs.mkdirSync(path.dirname(peerAuthorizationPath), { recursive: true });
    fs.writeFileSync(peerAuthorizationPath, "developer-id-signed-peer");
    const manifestPath = path.join(browserRoot, "browser-runtime-manifest.json");
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        schemaVersion: BROWSER_RUNTIME_SCHEMA_VERSION,
        artifacts: [
          {
            architecture: "arm64",
            executable: true,
            kind: "executable",
            path: "bin/node_repl",
            sha256: "0".repeat(64),
            size: 1,
          },
          {
            architecture: "arm64",
            executable: false,
            kind: "native-addon",
            path: "peer/authorize.node",
            sha256: "0".repeat(64),
            size: 1,
          },
        ],
        entrypoints: {
          peerAuthorization: "peer/authorize.node",
        },
        peerAuthorization: {
          nodeApiVersion: "127",
          signingTeamId: "UPSTREAM",
        },
      }),
    );

    expect(
      refreshSignedBrowserRuntimeManifest(appPath, {
        readSigningTeamIdentifier: (artifactPath: string) => {
          expect(artifactPath).toBe(peerAuthorizationPath);
          return "TESTTEAM";
        },
      }),
    ).toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      artifacts: Array<{ sha256: string; size: number }>;
      peerAuthorization: { signingTeamId: string };
    };
    expect(manifest.artifacts[0]).toMatchObject({
      sha256: createHash("sha256").update("developer-id-signed-node-repl").digest("hex"),
      size: Buffer.byteLength("developer-id-signed-node-repl"),
    });
    expect(manifest.peerAuthorization.signingTeamId).toBe("TESTTEAM");
  });

  test("is a no-op while the optional Browser bundle is absent", () => {
    const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-browser-signing-"));
    temporaryRoots.push(appPath);

    expect(refreshSignedBrowserRuntimeManifest(appPath)).toBe(false);
  });
});

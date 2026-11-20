import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { assertMacNodeSigningDetails } from "./macos-node-runtime.mjs";
import {
  applyMacCodeObjectEntitlementPolicy,
  applyMacSigningMode,
  isPreservedNodeRuntimeVendorCode,
  isPreservedCodexRuntimeVendorCode,
  refreshSignedSparkleRuntimeManifest,
  refreshSignedAgentRuntimeNativeManifest,
  sparkleCodeSignArguments,
} from "./sign-macos-runtime.mjs";

const temporaryRoots: string[] = [];
const signingContext = { platform: "darwin" } as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("applyMacSigningMode", () => {
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
    expect(local.optionsForFile("/tmp/Nodex.app/Contents/MacOS/Nodex", signingContext)).toEqual({
      entitlements: "/tmp/Nodex.app/Contents/MacOS/Nodex.entitlements",
      hardenedRuntime: true,
      timestamp: "none",
    });
  });

  test("local mode disables timestamping even without base per-file options", () => {
    const local = applyMacSigningMode({ app: "/tmp/Nodex.app", platform: "darwin" }, "local");
    expect(local.optionsForFile?.("/tmp/anything", signingContext)).toEqual({ timestamp: "none" });
  });

  test("rejects unknown signing modes instead of silently signing differently", () => {
    expect(() => applyMacSigningMode(releaseOptions, "adhoc")).toThrow(
      "Unknown NODEX_MAC_SIGN_MODE: adhoc",
    );
  });
});

test("composed signing policies preserve the resolved platform for per-file options", () => {
  const app = "/tmp/Nodex.app";
  const policy = applyMacCodeObjectEntitlementPolicy(
    applyMacSigningMode(
      {
        app,
        optionsForFile: (_filePath, { platform }) => ({
          entitlements: `${platform}.plist`,
          hardenedRuntime: platform === "darwin",
        }),
      },
      "local",
    ),
  );

  expect(policy.optionsForFile(app, signingContext)).toEqual({
    entitlements: "darwin.plist",
    hardenedRuntime: true,
    timestamp: "none",
  });
  expect(policy.optionsForFile(`${app}/Contents/Resources/bin/nodex`, signingContext)).toEqual({
    entitlements: [],
    hardenedRuntime: true,
    timestamp: "none",
  });
});

describe.skipIf(process.platform === "win32")("macOS code-object entitlement policy", () => {
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
    expect(policy.optionsForFile(mainExecutable, signingContext).entitlements).toBe(
      `${mainExecutable}.entitlements`,
    );
    expect(policy.optionsForFile(rendererHelper, signingContext).entitlements).toBe(
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
      expect(policy.optionsForFile(nativePath, signingContext).entitlements).toEqual([]);
    }
  });
});

test("preserves the locked Node executable without exempting adjacent code", () => {
  const app = path.resolve("Nodex.app");
  const resources = path.join(app, "Contents/Resources");
  expect(isPreservedNodeRuntimeVendorCode(app, path.join(resources, "node-runtime/node"))).toBe(
    true,
  );
  expect(isPreservedNodeRuntimeVendorCode(app, path.join(resources, "node-runtime/other"))).toBe(
    false,
  );
  expect(isPreservedNodeRuntimeVendorCode(app, path.join(resources, "bin/nodex"))).toBe(false);
});

test("requires a hardened Node signature with a secure timestamp", () => {
  const runtime = "CodeDirectory v=20500 size=123 flags=0x10000(runtime) hashes=123";
  const timestamp = "Timestamp=Oct 20, 2026 at 5:14:59 PM";
  expect(() =>
    assertMacNodeSigningDetails(`${runtime}
${timestamp}`),
  ).not.toThrow();
  expect(() => assertMacNodeSigningDetails(runtime)).toThrow("secure signing timestamp");
  expect(() => assertMacNodeSigningDetails(timestamp)).toThrow("hardened runtime");
});

describe.skipIf(process.platform === "win32")("Codex runtime vendor signing boundary", () => {
  const appPath = "/tmp/Nodex.app";

  test("preserves every locked Codex artifact without exempting adjacent files", () => {
    const lock = JSON.parse(
      fs.readFileSync(
        new URL("../resources/agent-runtime/codex-app-server.lock.json", import.meta.url),
        "utf8",
      ),
    ) as { requiredArtifacts: string[] };
    for (const artifactPath of lock.requiredArtifacts) {
      const relativePath = path.join("Contents/Resources", artifactPath);
      expect(isPreservedCodexRuntimeVendorCode(appPath, path.join(appPath, relativePath))).toBe(
        true,
      );
      expect(
        isPreservedCodexRuntimeVendorCode(appPath, path.join(appPath, `${relativePath}.backup`)),
      ).toBe(false);
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
        path.join(appPath, "Contents/Resources/bin/codex.backup"),
      ),
    ).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Sparkle code signing", () => {
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
        updates: "enabled",
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
      updates: "enabled",
      schemaVersion: 3,
    });
  });
});

test("reseals the separate execution PTY dependency after signing", () => {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-execution-sign-"));
  temporaryRoots.push(app);
  const root = path.join(app, "Contents/Resources/agent-runtime");
  fs.mkdirSync(path.join(root, "node_modules/node-pty"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/node-pty/pty.node"), "signed-native-bytes");
  const manifestPath = path.join(root, "native-dependencies.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({ schemaVersion: 1, identity: "build", artifactDigest: "unsigned" }),
  );
  refreshSignedAgentRuntimeNativeManifest(app);
  const signed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  expect(signed.unsignedArtifactDigest).toBe("unsigned");
  expect(signed.artifactDigest).toMatch(/^[a-f0-9]{64}$/u);
  expect(signed.identity).toBe("build");
  refreshSignedAgentRuntimeNativeManifest(app);
  expect(JSON.parse(fs.readFileSync(manifestPath, "utf8"))).toEqual(signed);
});

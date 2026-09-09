import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import {
  assertPackagedMacCodeObjectEntitlements,
  assertContentAddressedStoreMigrationBackup,
  assertLegacyPackagedRuntimePathsAbsent,
  isPackagedAppReady,
  parseMacCodeSigningEntitlements,
  removePrivateTemporaryDirectory,
  resolveNodexNativeCodeObjects,
  selectPackagedSmokeProjectId,
} from "./verify-native-runtime";
import { NATIVE_RUNTIME_BINARY_PATHS, parseNativeRuntimeManifest } from "./native-runtime-manifest";
import {
  isPreservedBrowserRuntimeVendorCode,
  isPreservedCodexRuntimeVendorCode,
} from "./sign-macos-runtime.mjs";
import {
  acquireIsolatedRunLease,
  markIsolatedRunClaimReady,
  publishIsolatedRunClaim,
} from "../src/main/core-client/isolated-run-ownership";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    if (!fs.existsSync(directory)) continue;
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("packaged native runtime verification", () => {
  test("keeps Nodex signature and entitlement verification disjoint from preserved vendor code", () => {
    const appPath = "/signed/Nodex.app";
    const manifest = parseNativeRuntimeManifest({
      schemaVersion: 4,
      productVersion: "0.2.3",
      minimumMacOS: "15.0",
      targetArch: "arm64",
      targetPlatform: "darwin",
      rustTarget: "aarch64-apple-darwin",
      binaries: Object.entries(NATIVE_RUNTIME_BINARY_PATHS).map(([name, bundlePath]) => ({
        name,
        bundlePath,
        file: name,
        sourceSize: 1,
        sourceSha256: "a".repeat(64),
      })),
    });
    const codeObjects = resolveNodexNativeCodeObjects(appPath, manifest);
    expect(codeObjects).toHaveLength(manifest.binaries.length + 1);
    expect(codeObjects).toContain(
      path.join(appPath, "Contents/Resources/native/nodex-clipboard.node"),
    );
    for (const artifactPath of codeObjects) {
      expect(isPreservedCodexRuntimeVendorCode(appPath, artifactPath)).toBe(false);
      expect(isPreservedBrowserRuntimeVendorCode(appPath, artifactPath)).toBe(false);
    }
    const ripgrep = path.join(appPath, "Contents/Resources/codex-path/rg");
    expect(isPreservedCodexRuntimeVendorCode(appPath, ripgrep)).toBe(true);
    expect(codeObjects).not.toContain(ripgrep);
  });

  test("parses boolean capabilities from codesign entitlement output", () => {
    expect(
      parseMacCodeSigningEntitlements(`
        Executable=/Applications/Nodex.app/Contents/MacOS/Nodex
        <plist version="1.0"><dict>
          <key>com.apple.security.device.audio-input</key><true/>
          <key>com.apple.security.cs.allow-jit</key><false/>
          <key>application-identifier</key><string>TEAM.app.jyu.nodex</string>
        </dict></plist>
      `),
    ).toEqual({
      "application-identifier": "present",
      "com.apple.security.cs.allow-jit": false,
      "com.apple.security.device.audio-input": true,
    });
  });

  test("accepts audio input only on the main app while preserving Electron helper runtime needs", () => {
    expect(() =>
      assertPackagedMacCodeObjectEntitlements([
        {
          artifactPath: "/Applications/Nodex.app",
          entitlements: { "com.apple.security.device.audio-input": true },
          role: "main-app",
        },
        {
          artifactPath: "/Applications/Nodex.app/Contents/Frameworks/Nodex Helper.app",
          entitlements: { "com.apple.security.cs.allow-jit": true },
          role: "electron-helper",
        },
        {
          artifactPath: "/Applications/Nodex.app/Contents/Resources/bin/nodex-core",
          entitlements: {},
          role: "native-helper",
        },
        {
          artifactPath: "/Applications/Nodex.app/Contents/Frameworks/Sparkle.framework",
          entitlements: {},
          role: "sparkle",
        },
      ]),
    ).not.toThrow();
  });

  test("rejects a missing main capability and microphone leakage to every child role", () => {
    expect(() =>
      assertPackagedMacCodeObjectEntitlements([
        {
          artifactPath: "/Applications/Nodex.app",
          entitlements: {},
          role: "main-app",
        },
      ]),
    ).toThrow("lacks audio-input entitlement");

    for (const role of ["electron-helper", "native-helper", "sparkle"] as const) {
      expect(() =>
        assertPackagedMacCodeObjectEntitlements([
          {
            artifactPath: "/Applications/Nodex.app",
            entitlements: { "com.apple.security.device.audio-input": true },
            role: "main-app",
          },
          {
            artifactPath: `/Applications/Nodex.app/${role}`,
            entitlements: { "com.apple.security.device.audio-input": true },
            role,
          },
        ]),
      ).toThrow("Microphone entitlement leaked outside the main app");
    }
  });

  test("rejects App Sandbox microphone and Electron runtime capabilities on native code", () => {
    expect(() =>
      assertPackagedMacCodeObjectEntitlements([
        {
          artifactPath: "/Applications/Nodex.app",
          entitlements: {
            "com.apple.security.device.audio-input": true,
            "com.apple.security.device.microphone": true,
          },
          role: "main-app",
        },
      ]),
    ).toThrow("App Sandbox microphone entitlement");

    for (const role of ["native-helper", "sparkle"] as const) {
      for (const entitlement of [
        "com.apple.security.cs.allow-dyld-environment-variables",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
      ]) {
        expect(() =>
          assertPackagedMacCodeObjectEntitlements([
            {
              artifactPath: "/Applications/Nodex.app",
              entitlements: { "com.apple.security.device.audio-input": true },
              role: "main-app",
            },
            {
              artifactPath: `/Applications/Nodex.app/${role}`,
              entitlements: { [entitlement]: true },
              role,
            },
          ]),
        ).toThrow("Non-Electron code object carries Electron runtime entitlements");
      }
    }
  });

  test("verifies the migration backup digest encoded in its filename", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-migration-backup-"));
    temporaryDirectories.push(directory);
    const bytes = Buffer.from("content-addressed Store backup");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const backupPath = path.join(directory, `v130-to-v132-${digest}.db`);
    fs.writeFileSync(backupPath, bytes);

    const transition = { sourceRevision: 130, targetRevision: 132 };
    expect(() => assertContentAddressedStoreMigrationBackup(backupPath, transition)).not.toThrow();
    expect(() =>
      assertContentAddressedStoreMigrationBackup(backupPath, {
        sourceRevision: 130,
        targetRevision: 131,
      }),
    ).toThrow("transition does not match the runtime");
    fs.appendFileSync(backupPath, "tampered");
    expect(() => assertContentAddressedStoreMigrationBackup(backupPath, transition)).toThrow(
      "digest does not match its filename",
    );
  });

  test("uses the one Project returned by fresh-Profile bootstrap", () => {
    expect(selectPackagedSmokeProjectId([{ id: "019c-generated-project" }])).toBe(
      "019c-generated-project",
    );
    expect(() => selectPackagedSmokeProjectId([])).toThrow(
      "expected one bootstrapped Project, found 0",
    );
    expect(() =>
      selectPackagedSmokeProjectId([{ id: "project-one" }, { id: "project-two" }]),
    ).toThrow("expected one bootstrapped Project, found 2");
  });

  test("requires one supervised host and Core generation to reach packaged app readiness", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-packaged-app-ready-"));
    temporaryDirectories.push(directory);
    const nodexHome = path.join(directory, "profile");
    fs.mkdirSync(nodexHome, { mode: 0o700 });
    const runId = randomUUID();
    const lease = acquireIsolatedRunLease({
      nodexHome,
      runId,
      supervisorPid: process.pid,
    });
    const descriptorPath = path.join(nodexHome, "run/core/core.json");
    const expectedCoreSha256 = "a".repeat(64);
    const readiness = () =>
      isPackagedAppReady({
        descriptorPath,
        expectedCoreSha256,
        expectedHostPid: process.pid,
        nodexHome,
        runId,
      });

    try {
      expect(readiness()).toBe(false);
      publishIsolatedRunClaim({ nodexHome, runId, hostPid: process.pid });
      expect(readiness()).toBe(false);
      fs.mkdirSync(path.dirname(descriptorPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        descriptorPath,
        `${JSON.stringify({
          artifact: { sha256: expectedCoreSha256 },
          manifest_digest: "b".repeat(64),
          pid: 42,
          start_nonce: "packaged-smoke-core",
        })}\n`,
      );
      markIsolatedRunClaimReady({ nodexHome, runId });

      expect(readiness()).toBe(true);
      expect(() =>
        isPackagedAppReady({
          descriptorPath,
          expectedCoreSha256,
          expectedHostPid: process.pid + 1,
          nodexHome,
          runId,
        }),
      ).toThrow("readiness belongs to another host generation");
    } finally {
      lease.release();
    }
  });
  test("rejects the obsolete nested Agent runtime even when canonical resources exist", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-native-runtime-layout-"));
    temporaryDirectories.push(directory);
    fs.mkdirSync(path.join(directory, "Resources", "agent-runtime"), { recursive: true });

    expect(() => assertLegacyPackagedRuntimePathsAbsent(directory)).toThrow(
      "obsolete duplicate path",
    );
  });

  test("removes Core search caches with read-only directories", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-native-runtime-cleanup-"));
    temporaryDirectories.push(directory);
    const cacheDirectory = path.join(
      directory,
      "profile/search-snapshots/.reusable/pages/page-hash",
    );
    fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(cacheDirectory, "body.nested.md"), "body\n", {
      mode: 0o400,
    });
    fs.chmodSync(cacheDirectory, 0o500);
    fs.chmodSync(path.dirname(cacheDirectory), 0o500);

    removePrivateTemporaryDirectory(directory);

    expect(fs.existsSync(directory)).toBe(false);
  });
});

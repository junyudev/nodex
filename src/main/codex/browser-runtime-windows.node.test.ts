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
import { resolveBrowserRuntimeBundle } from "./browser-runtime-bundle";
import type { WindowsBrowserRuntimeVerifierPort } from "./browser-runtime-windows-verifier-port";
import {
  fixtureWindowsPe,
  fixtureWindowsVerifier,
  writeWindowsBrowserRuntimeFixture,
} from "./browser-runtime-windows-test-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(arch: "arm64" | "x64" = "x64") {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nodex-win-desktop-tools-"));
  roots.push(runtimeRoot);
  const root = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  const manifest = writeWindowsBrowserRuntimeFixture(root, arch);
  const manifestPath = path.join(root, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const addon = manifest.artifacts.find((entry) => entry.path === "bin/dependency.dll")!;
  const file = path.join(root, addon.path);
  const appServerIdentity = {
    entrypointSha256: "a".repeat(64),
    protocolSchemaFingerprint: "b".repeat(64),
    runtimeVersion: "0.166.0",
    sourceCommit: "c".repeat(40),
    targetArch: arch,
    targetPlatform: "win32",
  };
  return {
    root,
    manifest,
    file,
    replacePe(bytes: Buffer, attest = false) {
      fs.writeFileSync(file, bytes);
      if (!attest) return;
      addon.sha256 = sha(bytes);
      addon.size = bytes.length;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    },
    load(windowsVerifier?: WindowsBrowserRuntimeVerifierPort, targetArch = arch) {
      return resolveBrowserRuntimeBundle({
        appServerIdentity,
        runtimeRoot,
        targetArch,
        targetPlatform: "win32",
        windowsVerifier,
        testedPairs: [
          {
            appServer: appServerIdentity,
            browser: {
              browserPluginVersion: manifest.browserPlugin.version,
              manifestSha256: sha(fs.readFileSync(manifestPath)),
              peerCliVersion: manifest.runtimeVersions.codexCli,
              targetArch: arch,
              targetPlatform: "win32",
            },
          },
        ],
      });
    },
  };
}

describe("Windows Desktop Tool manifests", () => {
  test.each(["arm64", "x64"] as const)("round trips %s with independent capabilities", (arch) => {
    const { manifest } = fixture(arch);
    expect(parseBrowserRuntimeManifest(manifest)).toEqual(manifest);
    expect(
      parseBrowserRuntimeManifest({
        ...manifest,
        capabilities: { ...manifest.capabilities, nativePip: {} },
      }),
    ).toBeNull();
    delete manifest.trust.pe["bin/dependency.dll"];
    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });

  test("rejects case aliases and foreign-CPU trust declarations", () => {
    const { manifest } = fixture();
    const original = manifest.artifacts.find(
      (entry) => entry.path === "marketplace/plugins/browser/client.js",
    )!;
    const alias = { ...original, path: "Marketplace/plugins/browser/alias.js" };
    expect(
      parseBrowserRuntimeManifest({ ...manifest, artifacts: [...manifest.artifacts, alias] }),
    ).toBeNull();
    manifest.trust.pe["bin/dependency.dll"]!.machine = "arm64";
    expect(parseBrowserRuntimeManifest(manifest)).toBeNull();
  });
});

describe("Windows Desktop Tool load", () => {
  test.each(["arm64", "x64"] as const)(
    "attests the %s closure through the Windows port",
    async (arch) => {
      const { load } = fixture(arch);
      expect(await load(fixtureWindowsVerifier())).toMatchObject({ status: "available" });
      expect(
        await load(fixtureWindowsVerifier(), arch === "arm64" ? "x64" : "arm64"),
      ).toMatchObject({ reason: "target-mismatch" });
      expect(await load()).toMatchObject({
        status: "unavailable",
        message: "Windows Desktop Tool verification unavailable",
      });
    },
  );

  test.each(["size", "hash"] as const)("rejects a wrong %s", async (kind) => {
    const { file, replacePe, load } = fixture();
    const bytes = fs.readFileSync(file);
    bytes[0x120] ^= 1;
    replacePe(kind === "size" ? bytes.subarray(0, bytes.length - 1) : bytes);
    expect(await load(fixtureWindowsVerifier())).toMatchObject({ reason: "artifact-integrity" });
  });

  test.each([
    ["foreign CPU", fixtureWindowsPe("arm64"), "PE machine type mismatch"],
    ["unsigned image", fixtureWindowsPe("x64", null), "no embedded Authenticode signature"],
  ] as const)("rejects an attested %s", async (_name, bytes, message) => {
    const { replacePe, load } = fixture();
    replacePe(bytes, true);
    expect(await load(fixtureWindowsVerifier())).toMatchObject({
      reason: "platform-verification-failed",
      message: expect.stringContaining(message),
    });
  });

  test("rejects a signer outside the publisher policy", async () => {
    const { load } = fixture();
    expect(
      await load(
        fixtureWindowsVerifier({
          async verifyAuthenticode() {
            return { ok: true, value: { subject: "CN=Other", issuer: "CN=Other" } };
          },
        }),
      ),
    ).toMatchObject({
      reason: "platform-verification-failed",
      message: expect.stringContaining("publisher"),
    });
  });

  test.each(["reparse entry", "foreign owner"])(
    "propagates native rejection of a %s",
    async (reason) => {
      const { load } = fixture();
      expect(
        await load(
          fixtureWindowsVerifier({
            async verifyClosurePaths() {
              return { ok: false, reason };
            },
          }),
        ),
      ).toMatchObject({ reason: "platform-verification-failed", message: reason });
    },
  );

  test("rejects a file outside the manifest", async () => {
    const { root, load } = fixture();
    fs.writeFileSync(path.join(root, "extra.js"), "unexpected");
    expect(await load(fixtureWindowsVerifier())).toMatchObject({
      reason: "artifact-invalid",
      message: expect.stringContaining("extra.js"),
    });
  });
});

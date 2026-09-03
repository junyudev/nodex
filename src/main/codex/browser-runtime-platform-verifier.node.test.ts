import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import type { BrowserRuntimePlatformArtifactVerifier } from "./browser-runtime-bundle";
import {
  createBrowserRuntimePlatformArtifactVerifier,
  parseMachOMinimumMacosVersion,
} from "./browser-runtime-platform-verifier";

const temporaryRoots: string[] = [];

const buildVersion = (minimum: string): string => `
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos ${minimum}
      sdk 26.0
`;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const verificationInput = (
  artifactPath: string,
): Parameters<BrowserRuntimePlatformArtifactVerifier>[0] =>
  ({
    artifact: { architecture: "arm64", path: "bin/node" },
    artifactPath,
    manifest: {
      capabilities: { computerUse: { reason: "architecture-unsupported", status: "unavailable" } },
      peerAuthorization: { signingTeamId: "TEAM" },
      targetArch: "arm64",
      targetPlatform: "darwin",
    },
  }) as Parameters<BrowserRuntimePlatformArtifactVerifier>[0];

const machOFixture = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-browser-platform-"));
  temporaryRoots.push(root);
  const artifactPath = path.join(root, "node");
  writeFileSync(artifactPath, Buffer.from([0xfe, 0xed, 0xfa, 0xcf]));
  return artifactPath;
};

const verifierForMinimum = (minimum: string): BrowserRuntimePlatformArtifactVerifier =>
  createBrowserRuntimePlatformArtifactVerifier({
    platform: "darwin",
    runCommand: (command, arguments_) => {
      if (command === "/usr/bin/lipo") return "arm64";
      if (command === "/usr/bin/otool") return buildVersion(minimum);
      if (arguments_[0] === "-dv") return "TeamIdentifier=TEAM";
      return "";
    },
  });

describe("Browser runtime macOS product contract", () => {
  test("parses modern and legacy Mach-O deployment commands", () => {
    expect(parseMachOMinimumMacosVersion(buildVersion("15.0"))).toBe("15.0");
    expect(
      parseMachOMinimumMacosVersion(`
      cmd LC_VERSION_MIN_MACOSX
  version 10.13
      sdk 13.3
`),
    ).toBe("10.13");
  });

  test("allows older third-party slices and rejects slices newer than the product minimum", () => {
    const artifactPath = machOFixture();
    expect(verifierForMinimum("13.5")(verificationInput(artifactPath))).toBeNull();
    expect(verifierForMinimum("16.0")(verificationInput(artifactPath))).toContain(
      "newer than the product minimum 15.0",
    );
  });

  test("distinguishes an artifact deployment target from the product minimum", () => {
    const artifactPath = machOFixture();
    const input = verificationInput(artifactPath);
    input.artifact.path = "native/sky.node";
    input.manifest.capabilities.nativePip = {
      addon: "native/sky.node",
      artifactMinimumMacOSVersion: "13.0",
    } as never;

    expect(verifierForMinimum("13.0")(input)).toBeNull();
    expect(verifierForMinimum("14.0")(input)).toContain("does not match manifest declaration 13.0");
  });
});

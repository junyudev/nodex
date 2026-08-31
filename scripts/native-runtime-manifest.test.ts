import { readFileSync } from "node:fs";

import { parse as parseToml } from "smol-toml";
import { describe, expect, test } from "vite-plus/test";

import { parseNativeRuntimeManifest, swiftTargetForNativeRuntime } from "./native-runtime-manifest";

const manifest = {
  schemaVersion: 4,
  targetPlatform: "darwin",
  targetArch: "arm64",
  rustTarget: "aarch64-apple-darwin",
  minimumMacOS: "15.0",
  productVersion: "0.1.10",
  binaries: [
    {
      name: "nodex-core",
      bundlePath: "Resources/bin/nodex-core",
      sourceSha256: "a".repeat(64),
      sourceSize: 10,
      file: "Mach-O 64-bit executable arm64",
    },
    {
      name: "nodex",
      bundlePath: "Resources/bin/nodex",
      sourceSha256: "b".repeat(64),
      sourceSize: 11,
      file: "Mach-O 64-bit executable arm64",
    },
    {
      name: "nodex-browser-profile-helper",
      bundlePath: "Resources/bin/nodex-browser-profile-helper",
      sourceSha256: "c".repeat(64),
      sourceSize: 12,
      file: "Mach-O 64-bit executable arm64",
    },
    {
      name: "nodex-appshot-helper",
      bundlePath: "Resources/bin/nodex-appshot-helper",
      sourceSha256: "e".repeat(64),
      sourceSize: 14,
      file: "Mach-O 64-bit executable arm64",
    },
    {
      name: "nodex-dictation-helper",
      bundlePath: "Resources/bin/nodex-dictation-helper",
      sourceSha256: "f".repeat(64),
      sourceSize: 15,
      file: "Mach-O 64-bit executable arm64",
    },
    {
      name: "nodex-service",
      bundlePath: "Helpers/Nodex Service.app/Contents/MacOS/nodex-service",
      sourceSha256: "d".repeat(64),
      sourceSize: 13,
      file: "Mach-O 64-bit executable arm64",
    },
  ],
};

describe("native runtime manifest", () => {
  test("keeps Cargo and both macOS linkers on the product deployment target", () => {
    const config = parseToml(readFileSync(".cargo/config.toml", "utf8"));

    expect(config).toMatchObject({
      env: { MACOSX_DEPLOYMENT_TARGET: "15.0" },
      target: {
        "aarch64-apple-darwin": {
          rustflags: ["-C", "link-arg=-mmacosx-version-min=15.0"],
        },
        "x86_64-apple-darwin": {
          rustflags: ["-C", "link-arg=-mmacosx-version-min=15.0"],
        },
      },
    });
  });

  test("maps package architectures to valid Swift target triples", () => {
    expect(swiftTargetForNativeRuntime("arm64")).toBe("arm64-apple-macos15.0");
    expect(swiftTargetForNativeRuntime("x64")).toBe("x86_64-apple-macos15.0");
  });

  test("accepts the complete architecture-bound package inventory", () => {
    expect(parseNativeRuntimeManifest(manifest)).toEqual(manifest);
  });

  test("rejects cross-architecture and duplicate package inventories", () => {
    expect(() =>
      parseNativeRuntimeManifest({ ...manifest, rustTarget: "x86_64-apple-darwin" }),
    ).toThrow("Rust target");
    expect(() =>
      parseNativeRuntimeManifest({
        ...manifest,
        binaries: [
          manifest.binaries[0],
          manifest.binaries[0],
          manifest.binaries[1],
          manifest.binaries[2],
          manifest.binaries[3],
          manifest.binaries[4],
        ],
      }),
    ).toThrow("each required binary exactly once");
  });

  test("rejects an unstable or missing product version", () => {
    expect(() =>
      parseNativeRuntimeManifest({ ...manifest, productVersion: "0.2.0-beta.1" }),
    ).toThrow("release semantic version");
    expect(() => parseNativeRuntimeManifest({ ...manifest, productVersion: undefined })).toThrow(
      "productVersion",
    );
  });
});

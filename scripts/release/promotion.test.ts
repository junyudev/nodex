import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { assembleReleaseBundle } from "./bundle";
import { assertImmutableNightlyAssets, assertPromotedBuildBytes } from "./promotion";
import { makeReleaseFixture } from "./windows-release.fixture";

test("promotes the exact public binaries and private iOS build while replacing the feeds", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-promotion-"));
  try {
    const assemble = (channel: "stable" | "nightly") => {
      const directory = join(root, channel);
      return assembleReleaseBundle({
        ...makeReleaseFixture(directory, channel),
        outputDirectory: join(directory, "bundle"),
      });
    };
    const nightly = assemble("nightly");
    const stable = assemble("stable");
    expect(() => assertPromotedBuildBytes(nightly, stable)).not.toThrow();
    expect(nightly.assets.find(({ role }) => role === "sparkle-appcast")?.sha256).not.toBe(
      stable.assets.find(({ role }) => role === "sparkle-appcast")?.sha256,
    );
    expect(() =>
      assertPromotedBuildBytes(nightly, {
        ...stable,
        assets: stable.assets.map((asset) =>
          asset.name === "Nodex-0.2.2-arm64.dmg" ? { ...asset, sha256: "f".repeat(64) } : asset,
        ),
      }),
    ).toThrow("byte-identical");
    expect(() =>
      assertPromotedBuildBytes(nightly, {
        ...stable,
        mobile: {
          ...stable.mobile,
          ios: {
            ...stable.mobile.ios,
            artifact: { ...stable.mobile.ios.artifact, sha256: "f".repeat(64) },
          },
        },
      }),
    ).toThrow("mobile builds");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retained Nightly assets must match the immutable GitHub SHA-256 digests", () => {
  const sha256 = "b".repeat(64);
  const name = "Nodex-0.2.2-arm64.dmg";
  const expected = new Map([[name, { bytes: 42, sha256 }]]);
  const release = {
    tag_name: "v0.2.2-nightly.19700101.1",
    draft: false,
    immutable: true,
    prerelease: true,
    assets: [{ name, size: 42, digest: `sha256:${sha256}` }],
  };
  expect(() => assertImmutableNightlyAssets(release, expected)).not.toThrow();
  expect(() => assertImmutableNightlyAssets({ ...release, immutable: false }, expected)).toThrow(
    "immutable",
  );
  expect(() =>
    assertImmutableNightlyAssets(
      { ...release, assets: [{ name, size: 42, digest: `sha256:${"c".repeat(64)}` }] },
      expected,
    ),
  ).toThrow("does not match");
  expect(() => assertImmutableNightlyAssets({ ...release, assets: [] }, expected)).toThrow(
    "missing assets",
  );
});

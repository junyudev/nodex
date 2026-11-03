import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { windowsUpdateManifest } from "./windows-update-manifest";

const identity = {
  schemaVersion: 1,
  channel: "stable",
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
  sourceVersion: "0.5.0",
  version: "0.5.0",
  tag: "v0.5.0",
  mainlineOrdinal: 1201,
  sourceDate: "2026-11-03",
  buildVersion: "1.12.1",
};

test.each(["x64", "arm64"] as const)(
  "local %s packages default to disabled updates",
  (architecture) => {
    expect(windowsUpdateManifest(architecture, {})).toMatchObject({
      architecture,
      buildChannel: "disabled",
      buildVersion: "0.0.0",
      feedUrls: null,
    });
  },
);

test("enabled packages use the shared Sparkle inputs and Release Identity build", () => {
  const directory = mkdtempSync(join(tmpdir(), "nodex-update-manifest-"));
  try {
    const path = join(directory, "identity.json");
    writeFileSync(path, JSON.stringify(identity));
    expect(
      windowsUpdateManifest("arm64", {
        NODEX_SPARKLE_CHANNEL: "stable",
        NODEX_RELEASE_IDENTITY_PATH: path,
      }),
    ).toMatchObject({
      buildVersion: "1.12.1",
      buildChannel: "stable",
      feedUrls: { stable: "https://nodex.jyu.app/updates/stable/windows-arm64/appcast.xml" },
    });
    expect(() =>
      windowsUpdateManifest("x64", {
        NODEX_SPARKLE_CHANNEL: "nightly",
        NODEX_RELEASE_IDENTITY_PATH: path,
      }),
    ).toThrow("matching Release Identity");
    expect(() => windowsUpdateManifest("x64", { NODEX_SPARKLE_CHANNEL: "stable" })).toThrow(
      "matching Release Identity",
    );
    expect(() =>
      windowsUpdateManifest("x64", {
        NODEX_SPARKLE_CHANNEL: "invalid",
        NODEX_RELEASE_IDENTITY_PATH: path,
      }),
    ).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

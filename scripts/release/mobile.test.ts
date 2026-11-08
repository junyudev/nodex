import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { mobileAppFor, readMobileBuildDirectory } from "./mobile";
import { makeMobileBuild } from "./mobile-release.fixture";
import { createReleaseIdentity } from "./candidate";
import { fixtureIdentity } from "./windows-release.fixture";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nodex-mobile-release-"));
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

const identity = (channel: "stable" | "nightly", mainlineOrdinal: number) =>
  createReleaseIdentity({
    channel,
    mainlineOrdinal,
    sourceDate: "2026-11-08",
    sourceSha: "1".repeat(40),
    sourceTree: "2".repeat(40),
    sourceVersion: "0.5.2",
  });

test("a stable release and the Nightlies before it share store versions and rising builds", () => {
  expect(mobileAppFor("ios", identity("stable", 2405))).toEqual({
    id: "app.jyu.nodex.mobile",
    version: "0.5.2",
    build: "1.24.5",
  });
  expect(mobileAppFor("android", identity("stable", 2405)).build).toBe("2405");
  // A Nightly built from 0.5.2 sources leads up to 0.5.3, the next version the stores will see.
  expect(mobileAppFor("ios", identity("nightly", 2410))).toEqual({
    id: "app.jyu.nodex.mobile",
    version: "0.5.3",
    build: "1.24.10",
  });
  expect(Number(mobileAppFor("android", identity("nightly", 2410)).build)).toBeGreaterThan(
    Number(mobileAppFor("android", identity("stable", 2405)).build),
  );
});

test("a build directory proves its identity, versions, signer and bytes", () => {
  const release = fixtureIdentity();
  const directory = makeMobileBuild(root, "android", release);
  expect(readMobileBuildDirectory(directory, "android", release).manifest.app.build).toBe("1");

  expect(() => readMobileBuildDirectory(directory, "android", fixtureIdentity("nightly"))).toThrow(
    "Release Identity",
  );
  expect(() => readMobileBuildDirectory(directory, "ios", release)).toThrow("Release Identity");
  writeFileSync(join(directory, "Nodex-0.2.2-android.apk"), "tampered");
  expect(() => readMobileBuildDirectory(directory, "android", release)).toThrow("artifact");
});

test("a build signed outside Nodex is refused", () => {
  const release = fixtureIdentity();
  const directory = makeMobileBuild(root, "android", release, { signer: "0".repeat(64) });
  expect(() => readMobileBuildDirectory(directory, "android", release)).toThrow("signer");
});

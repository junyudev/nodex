import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";

import { mobileAppFor, readMobileBuildDirectory } from "./mobile";
import { makeMobileBuild } from "./mobile-release.fixture";
import { createBuildIdentity } from "./candidate";
import { buildIdentityOf } from "./model";
import { fixtureIdentity } from "./windows-release.fixture";

let root = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nodex-mobile-release-"));
});
afterEach(() => rmSync(root, { force: true, recursive: true }));

const identity = (mainlineOrdinal: number) =>
  createBuildIdentity({
    mainlineOrdinal,
    sourceDate: "2026-11-08",
    sourceSha: "1".repeat(40),
    sourceTree: "2".repeat(40),
    version: "0.5.2",
  });

test("a stable release and the Nightlies before it share store versions and rising builds", () => {
  expect(mobileAppFor("ios", identity(2405))).toEqual({
    id: "app.jyu.nodex.mobile",
    version: "0.5.2",
    build: "1.24.5",
  });
  expect(mobileAppFor("android", identity(2405)).build).toBe("2405");
  expect(mobileAppFor("ios", identity(2410))).toEqual({
    id: "app.jyu.nodex.mobile",
    version: "0.5.2",
    build: "1.24.10",
  });
  expect(Number(mobileAppFor("android", identity(2410)).build)).toBeGreaterThan(
    Number(mobileAppFor("android", identity(2405)).build),
  );
});

test("a build directory proves its identity, versions, signer and bytes", () => {
  const release = fixtureIdentity();
  const directory = makeMobileBuild(root, "android", release);
  expect(
    readMobileBuildDirectory(directory, "android", buildIdentityOf(release)).manifest.app.build,
  ).toBe("1");

  expect(() =>
    readMobileBuildDirectory(directory, "android", {
      ...buildIdentityOf(release),
      sourceSha: "f".repeat(40),
    }),
  ).toThrow("Build Identity");
  expect(() => readMobileBuildDirectory(directory, "ios", buildIdentityOf(release))).toThrow(
    "Build Identity",
  );
  writeFileSync(join(directory, "Nodex-0.2.2-android.apk"), "tampered");
  expect(() => readMobileBuildDirectory(directory, "android", buildIdentityOf(release))).toThrow(
    "artifact",
  );
});

test("a build signed outside Nodex is refused", () => {
  const release = fixtureIdentity();
  const directory = makeMobileBuild(root, "android", release, { signer: "0".repeat(64) });
  expect(() => readMobileBuildDirectory(directory, "android", buildIdentityOf(release))).toThrow(
    "signer",
  );
});

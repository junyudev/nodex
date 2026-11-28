import { describe, expect, test } from "vite-plus/test";

import {
  parseImmutableReleaseDownloadUrl,
  parseStableReleasePointer,
  releaseObjectKey,
} from "./release-download";

const stableTag = "v0.5.15";
const nightlyTag = "v0.5.15-nightly.20261128.2524";
const asset = "Nodex-0.5.15-windows-x64.exe";
const bucket = "https://dl.nodex.jyu.app";
const github = "https://github.com/junyudev/nodex/releases/download";
const stableBucketUrl = `${bucket}/releases/${stableTag}/${asset}`;
const stableGitHubUrl = `${github}/${stableTag}/${asset}`;

describe("immutable release downloads", () => {
  test.each([
    [stableGitHubUrl, "github", "stable", stableTag],
    [`${github}/${nightlyTag}/${asset}`, "github", "nightly", nightlyTag],
    [stableBucketUrl, "release-bucket", "stable", stableTag],
    [`${bucket}/nightly/${nightlyTag}/${asset}`, "release-bucket", "nightly", nightlyTag],
  ])("parses %s", (url, host, channel, tag) => {
    expect(parseImmutableReleaseDownloadUrl(url)).toEqual({ host, channel, tag, assetName: asset });
  });

  test.each([
    ["HTTP", stableGitHubUrl.replace("https:", "http:")],
    ["an untrusted host", stableBucketUrl.replace("dl.nodex.jyu.app", "example.test")],
    [
      "a bucket look-alike",
      stableBucketUrl.replace("dl.nodex.jyu.app", "dl.nodex.jyu.app.evil.example"),
    ],
    ["a GitHub look-alike", stableGitHubUrl.replace("github.com", "evil-github.com")],
    ["a userinfo host trick", stableGitHubUrl.replace("github.com", "github.com@evil.example")],
    ["credentials", stableBucketUrl.replace("dl.nodex.jyu.app", "user:secret@dl.nodex.jyu.app")],
    ["empty userinfo", stableGitHubUrl.replace("github.com", "@github.com")],
    [
      "an explicit default port",
      stableBucketUrl.replace("dl.nodex.jyu.app", "dl.nodex.jyu.app:443"),
    ],
    ["a nondefault port", stableGitHubUrl.replace("github.com", "github.com:8443")],
    ["a query", `${stableGitHubUrl}?key=1`],
    ["an empty query", `${stableGitHubUrl}?`],
    ["a fragment", `${stableBucketUrl}#asset`],
    ["an empty fragment", `${stableBucketUrl}#`],
    ["an encoded slash", `${bucket}/releases/${stableTag}/sub%2F${asset}`],
    ["an encoded dot in the asset", stableGitHubUrl.replace(".exe", "%2Eexe")],
    ["encoded traversal", `${bucket}/releases/extra/%2e%2e/${stableTag}/${asset}`],
    ["literal traversal", `${github}/extra/../${stableTag}/${asset}`],
    ["a stable tag under nightly", `${bucket}/nightly/${stableTag}/${asset}`],
    ["a Nightly tag under releases", `${bucket}/releases/${nightlyTag}/${asset}`],
    ["an extra segment", `${stableBucketUrl}/extra`],
    ["a missing tag", `${github}/${asset}`],
    ["a missing asset", `${bucket}/releases/${stableTag}`],
    ["another GitHub repository", stableGitHubUrl.replace("/junyudev/nodex/", "/junyudev/other/")],
  ])("rejects %s", (_reason, url) => {
    expect(parseImmutableReleaseDownloadUrl(url)).toBeNull();
  });

  test("keys release objects by channel, tag and filename", () => {
    expect(releaseObjectKey(stableTag, asset)).toBe(`releases/${stableTag}/${asset}`);
    expect(releaseObjectKey(nightlyTag, asset)).toBe(`nightly/${nightlyTag}/${asset}`);
  });
});

describe("stable release pointers", () => {
  const installers = {
    macos: "Nodex-0.5.15-arm64.dmg",
    "windows-x64": asset,
    android: "Nodex-0.5.15-android.apk",
  };
  const pointer = { version: 1, tag: stableTag, installers };

  test("reads an installer for each download target", () => {
    expect(parseStableReleasePointer(pointer)).toEqual(pointer);
  });

  test.each([
    ["an unsupported version", { ...pointer, version: 2 }],
    ["a Nightly tag", { ...pointer, tag: nightlyTag }],
    ["a missing top-level field", { tag: stableTag, installers }],
    ["an extra top-level field", { ...pointer, publishedAt: "2026-11-28" }],
    [
      "a missing installer",
      { ...pointer, installers: { macos: installers.macos, "windows-x64": asset } },
    ],
    ["an extra installer", { ...pointer, installers: { ...installers, "windows-arm64": asset } }],
    [
      "an installer for an unknown target",
      {
        ...pointer,
        installers: { macos: installers.macos, "windows-x64": asset, ios: "Nodex.ipa" },
      },
    ],
    [
      "an installer with path traversal",
      { ...pointer, installers: { ...installers, "windows-x64": `../${asset}` } },
    ],
    [
      "an installer with an encoded separator",
      { ...pointer, installers: { ...installers, macos: "other%2Finstaller.dmg" } },
    ],
  ])("rejects %s", (_reason, value) => {
    expect(() => parseStableReleasePointer(value)).toThrow();
  });
});

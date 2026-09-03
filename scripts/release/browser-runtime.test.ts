import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { writeBrowserRuntimeFixture } from "../../src/main/codex/browser-runtime-test-fixture";
import { archiveBrowserRuntime } from "../archive-browser-runtime";
import {
  browserRuntimeReleaseArguments,
  planBrowserRuntimePublication,
  verifyBrowserRuntimePublishInput,
  type BrowserRuntimePublishOptions,
} from "./browser-runtime";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("Browser runtime publisher always opts out of app Latest", () => {
  const directory = mkdtempSync(join(tmpdir(), "nodex-browser-release-"));
  directories.push(directory);
  const arm64 = join(directory, "browser-runtime-arm64.tar.gz");
  const x64 = join(directory, "browser-runtime-x64.tar.gz");
  writeFileSync(arm64, "arm64");
  writeFileSync(x64, "x64");
  const args = browserRuntimeReleaseArguments({
    arm64Path: arm64,
    repo: "junyudev/nodex",
    tag: "browser-runtime-v26.727.40816",
    x64Path: x64,
  });
  expect(args).toContain("--latest=false");
  expect(args).toContain("--verify-tag");
  expect(args).toContain("--draft");
  expect(args).not.toContain("--latest");
});

test("Browser runtime publication resumes only exact missing draft assets", () => {
  const expected = new Map([
    ["arm64.tar.gz", { sha256: "a".repeat(64), size: 10 }],
    ["x64.tar.gz", { sha256: "b".repeat(64), size: 20 }],
  ]);

  expect(planBrowserRuntimePublication(null, expected)).toEqual({ kind: "create" });
  expect(
    planBrowserRuntimePublication(
      {
        assets: [{ digest: `sha256:${"a".repeat(64)}`, name: "arm64.tar.gz", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "browser-runtime-v1.0.0",
      },
      expected,
    ),
  ).toEqual({ kind: "resume-draft", missingAssetNames: ["x64.tar.gz"] });
  const completeAssets = [
    { digest: `sha256:${"a".repeat(64)}`, name: "arm64.tar.gz", size: 10 },
    { digest: `sha256:${"b".repeat(64)}`, name: "x64.tar.gz", size: 20 },
  ];
  expect(
    planBrowserRuntimePublication(
      {
        assets: completeAssets,
        draft: true,
        prerelease: false,
        tag_name: "browser-runtime-v1.0.0",
      },
      expected,
    ),
  ).toEqual({ kind: "resume-draft", missingAssetNames: [] });
  expect(
    planBrowserRuntimePublication(
      {
        assets: completeAssets,
        draft: false,
        prerelease: false,
        tag_name: "browser-runtime-v1.0.0",
      },
      expected,
    ),
  ).toEqual({ kind: "verify-published" });
  expect(() =>
    planBrowserRuntimePublication(
      {
        assets: [{ digest: `sha256:${"c".repeat(64)}`, name: "arm64.tar.gz", size: 10 }],
        draft: true,
        prerelease: false,
        tag_name: "browser-runtime-v1.0.0",
      },
      expected,
    ),
  ).toThrow("does not match its lock");
});

function makePublishFixture(): BrowserRuntimePublishOptions {
  const directory = mkdtempSync(join(tmpdir(), "nodex-browser-release-"));
  directories.push(directory);
  const tag = "browser-runtime-v1.0.0";
  const repo = "example/nodex";
  const arm64Source = join(directory, "arm64-source");
  const x64Source = join(directory, "x64-source");
  const arm64Manifest = writeBrowserRuntimeFixture(arm64Source, { targetArch: "arm64" });
  const x64Manifest = writeBrowserRuntimeFixture(x64Source, { targetArch: "x64" });
  const arm64Path = join(directory, "nodex-browser-runtime-1.0.0-darwin-arm64.tar.gz");
  const x64Path = join(directory, "nodex-browser-runtime-1.0.0-darwin-x64.tar.gz");
  const arm64Archive = archiveBrowserRuntime({ outputPath: arm64Path, sourceRoot: arm64Source });
  const x64Archive = archiveBrowserRuntime({ outputPath: x64Path, sourceRoot: x64Source });
  const lockPath = join(directory, "browser-runtime.lock.json");
  writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        assets: {
          "darwin-arm64": {
            archiveSha256: arm64Archive.archiveSha256,
            archiveSize: arm64Archive.archiveSize,
            assetName: arm64Archive.assetName,
            manifestSha256: arm64Archive.manifestSha256,
            runtimeVersions: arm64Manifest.runtimeVersions,
            url: `https://github.com/${repo}/releases/download/${tag}/${arm64Archive.assetName}`,
          },
          "darwin-x64": {
            archiveSha256: x64Archive.archiveSha256,
            archiveSize: x64Archive.archiveSize,
            assetName: x64Archive.assetName,
            manifestSha256: x64Archive.manifestSha256,
            runtimeVersions: x64Manifest.runtimeVersions,
            url: `https://github.com/${repo}/releases/download/${tag}/${x64Archive.assetName}`,
          },
        },
        browserPluginVersion: arm64Manifest.browserPlugin.version,
        codexCompatibilityVersion: arm64Manifest.codexCompatibilityVersion,
        repository: repo,
        runtimeFamily: "browser",
        schemaVersion: 1,
        source: {
          buildNumber: arm64Manifest.desktopBuildNumber,
          desktopBuild: arm64Manifest.desktopBuild,
          product: "chatgpt-desktop",
        },
        tag,
      },
      null,
      2,
    )}\n`,
  );
  return { arm64Path, lockPath, repo, tag, x64Path };
}

test("Browser runtime publisher proves both archives against the reviewed release lock", async () => {
  const options = makePublishFixture();

  await expect(verifyBrowserRuntimePublishInput(options)).resolves.toBeUndefined();
  await expect(
    verifyBrowserRuntimePublishInput({ ...options, repo: "example/wrong-repository" }),
  ).rejects.toThrow("does not match its release lock");

  writeFileSync(options.x64Path, "tampered");
  await expect(verifyBrowserRuntimePublishInput(options)).rejects.toThrow("archive size mismatch");
});

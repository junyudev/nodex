import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { publishRuntimeArchive } from "./runtime-publication";
import { assertWorkspaceRuntimePublicationTarget } from "./workspace-runtime";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBrowserRuntimeFixture } from "../../src/main/codex/browser-runtime-test-fixture";
import { archiveBrowserRuntime } from "../archive-browser-runtime";
import {
  awaitBrowserRuntimePublicationPlan,
  browserRuntimeReleaseArguments,
  planBrowserRuntimePublication,
  type BrowserRuntimePublishOptions,
  verifyBrowserRuntimePublishInput,
} from "./browser-runtime";
import codexLock from "../../resources/agent-runtime/codex-app-server.lock.json";
import { verifyMacCodexDownload, verifyMacDesktopToolsDownload } from "./distribution";
import { appComponentCatalog } from "../../src/main/app-components/AppComponentCatalog";
import {
  macComponentManifest,
  readComponentManifest,
  verifyWindowsComponentDownloads,
  windowsComponentManifest,
} from "./components";
import { windowsComponentPins } from "./windows-components.fixture";
import { execFileSync } from "node:child_process";
import { generateHomebrewCask } from "./homebrew";

const target = {
  repo: "example/nodex",
  tag: "workspace-runtime-vfixture",
  title: "Document Tools",
  notes: "Fixture",
};
const asset = { digest: `sha256:${"a".repeat(64)}`, size: 20, name: "fixture.tar.gz" };
const expected = new Map([[asset.name, { sha256: "a".repeat(64), size: 20 }]]);
const paths = new Map([[asset.name, `/tmp/${asset.name}`]]);

function githubFixture({
  assets = [] as (typeof asset)[],
  exists = false,
  latestAfter = "v0.5.10",
} = {}) {
  const release = { assets, draft: true, prerelease: false, tag_name: target.tag };
  let existsRemotely = exists;
  return vi.fn((args: readonly string[]) => {
    if (args[0] === "api") {
      if (args[1]?.endsWith("latest"))
        return JSON.stringify({ tag_name: release.draft ? "v0.5.10" : latestAfter });
      return JSON.stringify([existsRemotely ? [release] : []]);
    }
    if (args[1] === "create") existsRemotely = true;
    if (args[1] === "upload") release.assets = [asset];
    if (args[1] === "edit") release.draft = false;
    return "";
  });
}

test("creates a draft, uploads only missing assets and verifies stable Latest after publication", async () => {
  const github = githubFixture();
  await publishRuntimeArchive(target, expected, paths, github);
  const mutations = github.mock.calls.map(([args]) => args).filter(([verb]) => verb === "release");
  expect(mutations.map((args) => args[1])).toEqual(["create", "upload", "edit"]);
  expect(mutations[0]).toEqual(
    expect.arrayContaining(["--verify-tag", "--draft", "--latest=false"]),
  );
  expect(mutations[1]).toContain(paths.get(asset.name));
  expect(mutations[2]).toEqual(expect.arrayContaining(["--draft=false", "--latest=false"]));
  expect(github.mock.calls.at(0)?.[0][1]).toContain("/releases/latest");
  expect(github.mock.calls.at(-1)?.[0][1]).toContain("/releases/latest");
});

test("resumes an exact draft without replacing its asset and rejects a changed Latest", async () => {
  const github = githubFixture({ assets: [asset], exists: true, latestAfter: target.tag });
  await expect(publishRuntimeArchive(target, expected, paths, github)).rejects.toThrow(
    /changed.*Latest/,
  );
  expect(github.mock.calls.map(([args]) => args[1])).not.toContain("upload");
});

test("rejects conflicting assets before mutating a release", async () => {
  const github = githubFixture({ assets: [{ ...asset, size: 21 }], exists: true });
  await expect(publishRuntimeArchive(target, expected, paths, github)).rejects.toThrow(
    "does not match its lock",
  );
  expect(github.mock.calls.every(([args]) => args[0] === "api")).toBe(true);
});

test("requires a remote annotated tag at the chosen commit and immutable releases", () => {
  const commit = "a".repeat(40);
  const github = vi
    .fn()
    .mockReturnValueOnce(JSON.stringify({ object: { type: "commit", sha: commit } }));
  expect(() =>
    assertWorkspaceRuntimePublicationTarget(target.repo, target.tag, commit, github),
  ).toThrow("annotated");
  github
    .mockReturnValueOnce(JSON.stringify({ object: { type: "tag", sha: "b".repeat(40) } }))
    .mockReturnValueOnce(JSON.stringify({ object: { type: "commit", sha: commit } }))
    .mockReturnValueOnce(JSON.stringify({ enabled: false }));
  expect(() =>
    assertWorkspaceRuntimePublicationTarget(target.repo, target.tag, commit, github),
  ).toThrow("immutable releases");
});

describe("Browser runtime publication", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  test.skipIf(process.platform === "win32")(
    "Browser runtime publisher always opts out of app Latest",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "nodex-browser-release-"));
      directories.push(directory);
      const arm64 = join(directory, "browser-runtime-arm64.tar.gz");
      writeFileSync(arm64, "arm64");
      const args = browserRuntimeReleaseArguments({
        arm64Path: arm64,
        repo: "junyudev/nodex",
        tag: "browser-runtime-v26.727.40816",
      });
      expect(args).toContain("--latest=false");
      expect(args).toContain("--verify-tag");
      expect(args).toContain("--draft");
      expect(args).not.toContain("--latest");
    },
  );

  test("Browser runtime publication waits for a just-created draft to become listed", async () => {
    const expected = new Map([["arm64.tar.gz", { sha256: "a".repeat(64), size: 10 }]]);
    const listings = [null, null, { assets: [], draft: true, prerelease: false, tag_name: "t" }];
    let reads = 0;
    const readPlan = () => planBrowserRuntimePublication(listings[reads++] ?? null, expected);

    await expect(
      awaitBrowserRuntimePublicationPlan(readPlan, (plan) => plan.kind !== "create", {
        delayMs: 0,
      }),
    ).resolves.toEqual({ kind: "resume-draft", missingAssetNames: ["arm64.tar.gz"] });
    expect(reads).toBe(3);

    reads = 0;
    listings.splice(0, listings.length);
    await expect(
      awaitBrowserRuntimePublicationPlan(readPlan, (plan) => plan.kind !== "create", {
        attempts: 4,
        delayMs: 0,
      }),
    ).resolves.toEqual({ kind: "create" });
    expect(reads).toBe(4);
  });

  test.skipIf(process.platform === "win32")(
    "Browser runtime publication resumes only exact missing draft assets",
    () => {
      const expected = new Map([["arm64.tar.gz", { sha256: "a".repeat(64), size: 10 }]]);

      expect(planBrowserRuntimePublication(null, expected)).toEqual({ kind: "create" });
      expect(
        planBrowserRuntimePublication(
          {
            assets: [],
            draft: true,
            prerelease: false,
            tag_name: "browser-runtime-v1.0.0",
          },
          expected,
        ),
      ).toEqual({ kind: "resume-draft", missingAssetNames: ["arm64.tar.gz"] });
      const completeAssets = [
        { digest: `sha256:${"a".repeat(64)}`, name: "arm64.tar.gz", size: 10 },
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
    },
  );

  function makePublishFixture(): BrowserRuntimePublishOptions {
    const directory = mkdtempSync(join(tmpdir(), "nodex-browser-release-"));
    directories.push(directory);
    const tag = "browser-runtime-v1.0.0";
    const repo = "example/nodex";
    const arm64Source = join(directory, "arm64-source");
    const arm64Manifest = writeBrowserRuntimeFixture(arm64Source, { targetArch: "arm64" });
    const arm64Path = join(
      directory,
      `nodex-browser-runtime-${arm64Manifest.desktopBuild}-darwin-arm64.tar.gz`,
    );
    const arm64Archive = archiveBrowserRuntime({ outputPath: arm64Path, sourceRoot: arm64Source });
    const lockPath = join(directory, "browser-runtime.lock.json");
    writeFileSync(
      lockPath,
      `${JSON.stringify(
        {
          assets: {
            "win32-x64": null,
            "win32-arm64": null,
            "darwin-arm64": {
              archiveSha256: arm64Archive.archiveSha256,
              archiveSize: arm64Archive.archiveSize,
              assetName: arm64Archive.assetName,
              manifestSha256: arm64Archive.manifestSha256,
              runtimeVersions: arm64Manifest.runtimeVersions,
              unpackedSize: arm64Archive.unpackedSize,
              url: `https://github.com/${repo}/releases/download/${tag}/${arm64Archive.assetName}`,
            },
          },
          browserPluginVersion: arm64Manifest.browserPlugin.version,
          codexCompatibilityVersion: arm64Manifest.codexCompatibilityVersion,
          repository: repo,
          runtimeFamily: "browser",
          schemaVersion: 2,
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
    return { arm64Path, lockPath, repo, tag };
  }

  test.skipIf(process.platform === "win32")(
    "Browser runtime publisher proves the archive against the reviewed release lock",
    async () => {
      const options = makePublishFixture();

      await expect(verifyBrowserRuntimePublishInput(options)).resolves.toBeUndefined();
      await expect(
        verifyBrowserRuntimePublishInput({ ...options, windowsX64Path: options.arm64Path }),
      ).rejects.toThrow("runtime is unavailable for win32-x64");
      await expect(
        verifyBrowserRuntimePublishInput({ ...options, windowsArm64Path: options.arm64Path }),
      ).rejects.toThrow("runtime is unavailable for win32-arm64");
      await expect(
        verifyBrowserRuntimePublishInput({ ...options, repo: "example/wrong-repository" }),
      ).rejects.toThrow("does not match its release lock");

      const archiveBytes = readFileSync(options.arm64Path);
      archiveBytes[0] = archiveBytes[0]! ^ 0xff;
      writeFileSync(options.arm64Path, archiveBytes);
      await expect(verifyBrowserRuntimePublishInput(options)).rejects.toThrow(
        "archive checksum mismatch",
      );

      writeFileSync(options.arm64Path, "tampered");
      await expect(verifyBrowserRuntimePublishInput(options)).rejects.toThrow(
        "archive size mismatch",
      );
    },
  );
});

describe("published macOS component downloads", () => {
  const asset = { url: "https://example.com/component.tar.gz", archiveSize: 100 };

  test("checks the pinned size through the published URL", async () => {
    const fetchAsset = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { headers: { "content-length": "100" } }));
    await verifyMacDesktopToolsDownload(asset, fetchAsset);
    expect(fetchAsset).toHaveBeenCalledExactlyOnceWith(asset.url, {
      method: "HEAD",
      signal: expect.any(AbortSignal),
    });
  });

  test("checks the total archive size with a ranged GET when HEAD cannot provide it", async () => {
    const fetchAsset = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(
        new Response("x", {
          status: 206,
          headers: { "content-range": "bytes 0-0/100" },
        }),
      );
    await verifyMacDesktopToolsDownload(asset, fetchAsset);
    expect(fetchAsset).toHaveBeenLastCalledWith(asset.url, {
      headers: { Range: "bytes=0-0" },
      signal: expect.any(AbortSignal),
    });
  });

  test("rejects a missing asset or a different published size", async () => {
    const fetchAsset = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { "content-length": "99" } }))
      .mockImplementation(async () => new Response(null, { status: 404 }));
    await expect(verifyMacDesktopToolsDownload(asset, fetchAsset)).rejects.toThrow("has 99 bytes");
    await expect(verifyMacDesktopToolsDownload(asset, fetchAsset)).rejects.toThrow("HTTP 404");
    await expect(
      verifyMacDesktopToolsDownload({ ...asset, url: null }, fetchAsset),
    ).rejects.toThrow("Publish the pinned macOS Desktop Tools archive first");
  });

  test("rejects a missing official Codex package despite any local cache", async () => {
    const fetchAsset = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 404 }));
    await expect(
      verifyMacCodexDownload(codexLock.builds["darwin-arm64"], fetchAsset),
    ).rejects.toThrow("Published macOS Codex archive is unavailable");
    expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual([
      codexLock.builds["darwin-arm64"].url,
      codexLock.builds["darwin-arm64"].url,
    ]);
  });
});

describe("macOS Components manifest", () => {
  test("the macOS Components manifest uses the exact packaged catalog and build identity", () => {
    const identity = { version: "0.2.2", buildVersion: "1.25.24" };
    expect(macComponentManifest(identity)).toEqual({
      schemaVersion: 1,
      target: "darwin-arm64",
      ...identity,
      components: appComponentCatalog({ platform: "darwin", arch: "arm64", isPackaged: true }),
    });
  });

  test("the macOS Components manifest advertises the exact official Codex download", () => {
    const manifest = macComponentManifest({ version: "0.2.2", buildVersion: "1.25.24" });
    const asset = codexLock.builds["darwin-arm64"];
    expect(manifest.components.find(({ id }) => id === "codex")).toMatchObject({
      install: "on-first-use",
      archive: { url: asset.url, size: asset.archiveSize, sha256: asset.archiveSha256 },
      payload: {
        kind: "codex",
        metadataSha256: asset.runtimeMetadataSha256,
        entrypointSha256: asset.entrypointSha256,
      },
    });
  });
});

describe("Windows Components distribution", () => {
  const identity = { version: "0.2.2", buildVersion: "1.25.24" };

  test("matches the published pins and rejects a different target at the release boundary", () => {
    const root = mkdtempSync(join(tmpdir(), "nodex-component-manifest-"));
    try {
      const file = join(root, "components.json");
      const manifest = windowsComponentManifest(identity, windowsComponentPins);
      writeFileSync(file, JSON.stringify(manifest));
      expect(readComponentManifest(file, "win32-x64", identity)).toEqual({
        schemaVersion: 1,
        target: "win32-x64",
        ...identity,
        components: windowsComponentPins,
      });
      writeFileSync(file, JSON.stringify(macComponentManifest(identity)));
      expect(() => readComponentManifest(file, "win32-x64", identity)).toThrow(
        "does not match its architecture build",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("checks each public Windows archive and rejects a different published size", async () => {
    const wrongSize = windowsComponentPins[2]!.archive.url;
    const fetchAsset = vi.fn<typeof fetch>(
      async (url) =>
        new Response(null, { headers: { "content-length": url === wrongSize ? "99" : "100" } }),
    );
    await expect(verifyWindowsComponentDownloads(windowsComponentPins, fetchAsset)).rejects.toThrow(
      "Published Windows claude-code archive has 99 bytes",
    );
    expect(fetchAsset.mock.calls.map(([url]) => url)).toEqual(
      windowsComponentPins.map(({ archive }) => archive.url),
    );
  });
});

describe("Homebrew cask", () => {
  test("generated cask binds the Apple silicon download and hardware requirement", () => {
    const cask = generateHomebrewCask({
      version: "0.3.0",
      arm64Sha256: "a".repeat(64),
    });
    const result = execFileSync(
      "ruby",
      [
        "-rjson",
        "-e",
        `
    class CaskContract
      attr_reader :downloads, :requirements
      def initialize; @downloads = []; @requirements = {}; end
      def depends_on(**values); @requirements.merge!(values); end
      def version(value = nil); @version = value if value; @version; end
      def appdir; "/Applications"; end
      def url(value, **options)
        raise "Unsupported URL keywords" unless options.empty?
        @downloads << value if value.end_with?(".dmg")
      end
      def method_missing(name, *args, **options, &block)
        instance_eval(&block) if block
      end
    end
    contract = CaskContract.new
    contract.instance_eval(STDIN.read)
    puts JSON.generate({ downloads: contract.downloads, requirements: contract.requirements })
  `,
      ],
      { input: cask, encoding: "utf8" },
    );
    expect(JSON.parse(result)).toEqual({
      downloads: ["https://dl.nodex.jyu.app/releases/v0.3.0/Nodex-0.3.0-arm64.dmg"],
      requirements: { arch: "arm64", macos: "sequoia" },
    });
  });

  test("generateHomebrewCask binds immutable version tags to canonical DMGs", () => {
    const cask = generateHomebrewCask({
      arm64Sha256: "a".repeat(64),
      version: "0.2.0",
    });
    expect(cask).toContain('version "0.2.0"');
    expect(cask).toContain("/releases/v#{version}/Nodex-#{version}-arm64.dmg");
    expect(cask).toContain("strategy :github_latest");
    expect(cask).toContain('homepage "https://nodex.jyu.app/"');
    expect(cask).toContain('url "https://github.com/junyudev/nodex"');
    expect(cask).not.toContain('depends_on macos: ">= :sequoia"');
  });

  test("generateHomebrewCask rejects malformed checksums", () => {
    expect(() =>
      generateHomebrewCask({
        arm64Sha256: "bad",
        version: "0.2.0",
      }),
    ).toThrow("SHA-256");
  });
});

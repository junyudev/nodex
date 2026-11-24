import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vite-plus/test";
import * as github from "./github-release";
import { assembleReleaseBundle } from "./bundle";
import * as candidate from "./candidate";
import { publicationIdentity } from "./model";
import {
  assertImmutableNightlyAssets,
  assertPromotedBuildBytes,
  promoteFromLocal,
  resolvePromotion,
} from "./promotion";
import { makeReleaseFixture } from "./windows-release.fixture";

test("promotes the exact public binaries and private iOS build while replacing the feeds", () => {
  const root = mkdtempSync(join(tmpdir(), "nodex-promotion-"));
  try {
    const assemble = (channel: "stable" | "nightly") => {
      const directory = join(root, channel);
      const fixture = makeReleaseFixture(directory, channel);
      const outputDirectory = join(directory, "bundle");
      const bundle = assembleReleaseBundle({ ...fixture, outputDirectory });
      const bundlePath = join(outputDirectory, "release-bundle.json");
      const asset = bundle.assets.find(({ role }) => role === "components-manifest")!;
      expect(github.releaseAssetPaths(bundlePath, fixture.windowsPublicKey)).toContain(
        join(outputDirectory, asset.name),
      );
      expect(github.readPublishedReleaseIndex(bundlePath).assets.get(asset.name)).toEqual({
        bytes: asset.bytes,
        sha256: asset.sha256,
      });
      return bundle;
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
          asset.role === "components-manifest" ? { ...asset, sha256: "f".repeat(64) } : asset,
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

test("previews source entries, requires an explicit headline to dispatch, and binds resume to it", () => {
  const cwd = mkdtempSync(join(tmpdir(), "nodex-promotion-headline-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    git("init", "--initial-branch=main");
    git("config", "user.name", "Nodex Test");
    git("config", "user.email", "nodex@example.com");
    git("config", "commit.gpgsign", "false");
    git("remote", "add", "origin", ".");
    git("commit", "--allow-empty", "-m", "Source before change files");

    const repo = "test/nodex";
    const build = candidate.createBuildIdentity({
      sourceSha: git("rev-parse", "HEAD"),
      sourceTree: git("rev-parse", "HEAD^{tree}"),
      version: "0.2.2",
      sourceDate: "2026-10-29",
      mainlineOrdinal: 2,
    });
    const { tag } = publicationIdentity(build, "nightly");
    const stableTag = "v0.2.2";
    const headline = "More reliable sync";
    const nightlyRelease = {
      tag_name: tag,
      draft: false,
      immutable: true,
      prerelease: true,
      published_at: "2026-10-29T00:00:00Z",
      assets: [],
    };
    let sourceSha = build.sourceSha;
    let retained = false;
    let stableExists = false;
    const readRelease = vi.spyOn(github, "readGitHubRelease").mockReturnValue(null);
    vi.spyOn(github, "readTagReference").mockImplementation((_repo, requestedTag) => {
      if (requestedTag !== tag && !(stableExists && requestedTag === stableTag)) return null;
      return { ref: `refs/tags/${requestedTag}`, object: { type: "commit", sha: sourceSha } };
    });
    const gh = vi.spyOn(github, "gh").mockImplementation((args) => {
      const endpoint = args[1];
      const artifact = (kind: string) => ({ name: `nodex-${kind}-${sourceSha}`, expired: false });
      const run = (id: number, workflow: string) => ({
        id,
        path: `.github/workflows/${workflow}.yml`,
        head_branch: "main",
        head_sha: sourceSha,
        conclusion: "success",
        event: "workflow_dispatch",
      });
      if (endpoint === `repos/${repo}/releases?per_page=100`)
        return JSON.stringify([[nightlyRelease]]);
      if (endpoint.includes("/nightly-release.yml/runs?")) {
        return JSON.stringify([{ workflow_runs: [run(1, "nightly-release")] }]);
      }
      if (endpoint.endsWith("/runs/1/artifacts?per_page=100")) {
        return JSON.stringify({
          artifacts: [
            "macos-arm64",
            "windows-x64",
            "windows-arm64",
            "mobile-android",
            "mobile-ios",
            "build-identity",
            "source-certification",
            "release-bundle",
          ].map(artifact),
        });
      }
      if (endpoint.includes("/actions/artifacts?name=")) {
        return JSON.stringify([
          {
            artifacts: retained ? [{ ...artifact("release-bundle"), workflow_run: { id: 2 } }] : [],
          },
        ]);
      }
      if (endpoint.endsWith("/runs/2")) return JSON.stringify(run(2, "release"));
      if (endpoint.endsWith("/release.yml/dispatches")) {
        return JSON.stringify({ html_url: "https://example.invalid/run" });
      }
      throw new Error(`Unexpected GitHub endpoint ${endpoint}`);
    });

    expect(() => resolvePromotion(cwd, repo, headline, tag)).toThrow(
      "no release entries in changes/",
    );
    mkdirSync(join(cwd, "changes/fixed"), { recursive: true });
    writeFileSync(join(cwd, "changes/fixed/2026-10-29-sync.md"), "Fixed sync.\n");
    git("add", "changes");
    git("commit", "-m", "Fix sync");
    sourceSha = git("rev-parse", "HEAD");
    vi.spyOn(candidate, "resolveBuildIdentity").mockReturnValue({ ...build, sourceSha });

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    promoteFromLocal(cwd, repo, tag);
    expect(output.join("")).toContain(
      `### Fixed\n\n- Fixed sync.\n\nTo promote, run vp run release:promote -- ${tag} --headline`,
    );
    expect(gh.mock.calls.some(([args]) => args[1].endsWith("/dispatches"))).toBe(false);
    promoteFromLocal(cwd, repo, tag, headline);
    expect(gh.mock.lastCall?.[0]).toContain(`inputs[headline]=${headline}`);

    retained = true;
    expect(resolvePromotion(cwd, repo, "Another headline", tag)).toMatchObject({
      resumeRunId: null,
      notes: "Another headline\n\n### Fixed\n\n- Fixed sync.\n",
    });
    stableExists = true;
    expect(resolvePromotion(cwd, repo, headline, tag)).toMatchObject({
      resumeRunId: 2,
      notes: `${headline}\n\n### Fixed\n\n- Fixed sync.\n`,
    });
    readRelease.mockReturnValue({
      ...nightlyRelease,
      tag_name: stableTag,
      prerelease: false,
      body: `${headline}\r\n### Fixed\r\n- Fixed sync.`,
    });
    expect(resolvePromotion(cwd, repo, headline, tag).resumeRunId).toBe(2);
    expect(() => resolvePromotion(cwd, repo, "A different headline", tag)).toThrow(
      "Resume with its original headline",
    );
    readRelease.mockReturnValue({
      ...nightlyRelease,
      tag_name: stableTag,
      prerelease: false,
      body: `${headline}\n### Fixed\n- A different entry.`,
    });
    expect(() => resolvePromotion(cwd, repo, headline, tag)).toThrow(
      "notes do not match its source change files",
    );
  } finally {
    vi.restoreAllMocks();
    rmSync(cwd, { recursive: true, force: true });
  }
});

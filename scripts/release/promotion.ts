import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  readArchitectureDirectory,
  parseReleaseBundleManifest,
  type ReleaseBundleManifest,
} from "./bundle";
import { assertSameBuildIdentity, resolveBuildIdentity } from "./candidate";
import { extractUnreleasedNotes } from "./changelog";
import {
  gh,
  planPublication,
  readGitHubRelease,
  readPublishedReleaseIndex,
  readTagReference,
  releaseAssetPaths,
  resolveTagTargetSha,
  type GitHubRelease,
} from "./github-release";
import { MOBILE_PLATFORMS, readMobileBuildDirectory } from "./mobile";
import {
  buildIdentityOf,
  compareBuildVersions,
  compareStableVersions,
  parseBuildIdentity,
  publicationIdentity,
  sha256File,
  stableVersionFromAppTag,
} from "./model";
import { advanceReleaseSource, inspectReleaseSourceAtRef, RELEASE_SOURCE_PATHS } from "./source";
import { RELEASE_ARCHITECTURES } from "./targets";

const NIGHTLY_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*$/u;
const api = <T>(endpoint: string, ...args: string[]): T =>
  JSON.parse(gh(["api", endpoint, ...args])) as T;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fetchMain(cwd: string): string {
  git(cwd, "fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main");
  return git(cwd, "rev-parse", "refs/remotes/origin/main");
}

function tagTarget(repo: string, tag: string): string | null {
  const reference = readTagReference(repo, tag);
  return reference ? resolveTagTargetSha(repo, reference) : null;
}

function assertOnMain(cwd: string, sourceSha: string, main: string): void {
  try {
    git(cwd, "merge-base", "--is-ancestor", sourceSha, main);
  } catch (cause) {
    throw new Error(`Source ${sourceSha} is outside protected main.`, { cause });
  }
}

type PublishedRelease = GitHubRelease & { published_at: string };

function publishedReleases(repo: string): PublishedRelease[] {
  return api<GitHubRelease[][]>(`repos/${repo}/releases?per_page=100`, "--paginate", "--slurp")
    .flat()
    .filter(
      (release): release is PublishedRelease =>
        !release.draft &&
        typeof release.published_at === "string" &&
        Number.isFinite(Date.parse(release.published_at)),
    );
}

function downloadReleaseIndex(repo: string, release: GitHubRelease) {
  const dir = mkdtempSync(join(tmpdir(), "nodex-published-index-"));
  try {
    gh([
      "release",
      "download",
      release.tag_name,
      "--repo",
      repo,
      "--dir",
      dir,
      "--pattern",
      "release-bundle.json",
      "--pattern",
      "SHA256SUMS",
    ]);
    const index = readPublishedReleaseIndex(join(dir, "release-bundle.json"));
    planPublication(release, index.assets, release.prerelease);
    if (index.bundle.tag !== release.tag_name) throw new Error("Published bundle tag mismatch.");
    return index.bundle;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const artifact = (kind: string, sha: string): string => `nodex-${kind}-${sha}`;
const distributionArtifacts = [
  "macos-arm64",
  "windows-x64",
  "windows-arm64",
  "mobile-android",
  "mobile-ios",
];
const nightlyArtifacts = [
  ...distributionArtifacts,
  "build-identity",
  "source-certification",
  "release-bundle",
];

interface WorkflowRun {
  readonly id: number;
  readonly path: string;
  readonly head_branch: string;
  readonly head_sha: string;
  readonly conclusion: string | null;
  readonly event: string;
}

function nightlyRun(repo: string, sha: string): number {
  const pages = api<{ workflow_runs: WorkflowRun[] }[]>(
    `repos/${repo}/actions/workflows/nightly-release.yml/runs?branch=main&status=success&head_sha=${sha}&per_page=100`,
    "--paginate",
    "--slurp",
  );
  for (const run of pages.flatMap((page) => page.workflow_runs)) {
    if (
      run.head_branch !== "main" ||
      run.head_sha !== sha ||
      run.conclusion !== "success" ||
      run.path !== ".github/workflows/nightly-release.yml" ||
      !["schedule", "workflow_dispatch"].includes(run.event)
    )
      continue;
    const { artifacts } = api<{ artifacts: { name: string; expired: boolean }[] }>(
      `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`,
    );
    if (
      nightlyArtifacts.every((kind) =>
        artifacts.some((entry) => entry.name === artifact(kind, sha) && !entry.expired),
      )
    )
      return run.id;
  }
  throw new Error(
    "No successful Nightly Release run on main retains the full candidate. The promotion window is 14 days.",
  );
}

function stableResumeRun(repo: string, sha: string): number | null {
  const name = artifact("release-bundle", sha);
  const pages = api<
    { artifacts: { name: string; expired: boolean; workflow_run: { id: number } }[] }[]
  >(`repos/${repo}/actions/artifacts?name=${name}&per_page=100`, "--paginate", "--slurp");
  for (const item of pages.flatMap((page) => page.artifacts)) {
    if (item.name !== name || item.expired) continue;
    const run = api<WorkflowRun>(`repos/${repo}/actions/runs/${item.workflow_run.id}`);
    if (
      run.path === ".github/workflows/release.yml" &&
      run.head_branch === "main" &&
      run.event === "workflow_dispatch" &&
      String(run.id) !== process.env.GITHUB_RUN_ID
    )
      return run.id;
  }
  return null;
}

export function resolvePromotion(cwd: string, repo: string, requestedTag?: string) {
  const releases = publishedReleases(repo);
  const nightly = requestedTag?.trim()
    ? releases.find((release) => release.tag_name === requestedTag.trim())
    : releases
        .filter((release) => release.prerelease && NIGHTLY_TAG.test(release.tag_name))
        .sort((left, right) => Date.parse(right.published_at) - Date.parse(left.published_at))[0];
  if (!nightly?.prerelease || !NIGHTLY_TAG.test(nightly.tag_name) || nightly.immutable !== true) {
    throw new Error("Select a published immutable Nightly prerelease from this repository.");
  }
  const sourceSha = tagTarget(repo, nightly.tag_name);
  if (!sourceSha) throw new Error("The Nightly tag has no source commit.");
  assertOnMain(cwd, sourceSha, fetchMain(cwd));
  const build = resolveBuildIdentity({ cwd, ref: sourceSha });
  const identity = publicationIdentity(build, "nightly");
  if (identity.tag !== nightly.tag_name)
    throw new Error("The Nightly tag does not match its source Build Identity.");
  const stable = publicationIdentity(build, "stable");
  const stableTarget = tagTarget(repo, stable.tag);
  if (stableTarget !== null && stableTarget !== sourceSha)
    throw new Error(`${stable.tag} points to another source commit.`);
  const latest = releases
    .filter((release) => !release.prerelease && stableVersionFromAppTag(release.tag_name) !== null)
    .sort((left, right) =>
      compareStableVersions(right.tag_name.slice(1), left.tag_name.slice(1)),
    )[0];
  if (latest?.tag_name === stable.tag) {
    if (
      latest.immutable !== true ||
      !isDeepStrictEqual(downloadReleaseIndex(repo, latest).releaseIdentity, stable)
    ) {
      throw new Error("Existing stable release does not match the promoted Build Identity.");
    }
  } else if (latest) {
    if (latest.immutable !== true) throw new Error("Latest stable release is not immutable.");
    const previous = downloadReleaseIndex(repo, latest);
    if (
      compareStableVersions(stable.version, previous.version) <= 0 ||
      compareBuildVersions(stable.buildVersion, previous.releaseIdentity.buildVersion) <= 0
    ) {
      throw new Error(
        `Promotion must advance both version and buildVersion beyond ${latest.tag_name}.`,
      );
    }
  }
  const resumeRunId = stableTarget ? stableResumeRun(repo, sourceSha) : null;
  if (stableTarget && resumeRunId === null && readGitHubRelease(repo, stable.tag)) {
    throw new Error(
      "The stable release exists, but its assembled promotion artifact is no longer retained.",
    );
  }
  const notes = extractUnreleasedNotes(inspectReleaseSourceAtRef(cwd, sourceSha).changelog);
  return {
    identity,
    stable,
    notes,
    publishedAt: nightly.published_at,
    runId: nightlyRun(repo, sourceSha),
    resumeRunId,
  };
}

/** Compare the native deliverables. Feed files and publication metadata are regenerated. */
export function assertPromotedBuildBytes(
  nightly: ReleaseBundleManifest,
  stable: ReleaseBundleManifest,
): void {
  if (
    nightly.releaseIdentity.channel !== "nightly" ||
    stable.releaseIdentity.channel !== "stable" ||
    !isDeepStrictEqual(
      buildIdentityOf(nightly.releaseIdentity),
      buildIdentityOf(stable.releaseIdentity),
    )
  ) {
    throw new Error("Stable and Nightly do not identify the same build.");
  }
  const roles = new Set(["dmg", "sparkle-full", "windows-installer", "android-apk"]);
  const binaries = nightly.assets.filter(({ role }) => roles.has(role));
  const promoted = stable.assets.filter(
    ({ role, name }) => roles.has(role) && !name.startsWith("Nodex-latest-"),
  );
  if (!isDeepStrictEqual(binaries, promoted)) {
    throw new Error("Stable public build assets must be byte-identical to the immutable Nightly.");
  }
  if (
    !isDeepStrictEqual(nightly.mobile, stable.mobile) ||
    RELEASE_ARCHITECTURES.some(
      (arch) =>
        nightly.architectures[arch].manifestSha256 !== stable.architectures[arch].manifestSha256,
    )
  ) {
    throw new Error("Stable must reuse the Nightly architecture and mobile builds.");
  }
}

export function assertImmutableNightlyAssets(
  release: GitHubRelease | null,
  expected: ReturnType<typeof readPublishedReleaseIndex>["assets"],
): void {
  if (!release || release.draft || !release.prerelease || release.immutable !== true) {
    throw new Error("The Nightly is no longer a published immutable prerelease.");
  }
  planPublication(release, expected, true);
}

export function verifyPromotionInputs(
  repo: string,
  dir: string,
  candidate: ReturnType<typeof resolvePromotion>,
): void {
  const { identity, runId } = candidate;
  const sha = identity.sourceSha;
  const root = (kind: string): string => join(dir, artifact(kind, sha));
  const bundlePath = join(root("release-bundle"), "release-bundle.json");
  releaseAssetPaths(bundlePath);
  const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
  if (!isDeepStrictEqual(bundle.releaseIdentity, identity))
    throw new Error("Nightly bundle identity mismatch.");
  // GitHub's immutable asset digests must match every retained file, including
  // the bundle and checksum index, before any protected job can start.
  assertImmutableNightlyAssets(
    readGitHubRelease(repo, identity.tag),
    readPublishedReleaseIndex(bundlePath).assets,
  );
  const build = buildIdentityOf(identity);
  const cert = JSON.parse(
    readFileSync(join(root("source-certification"), "source-certification.json"), "utf8"),
  );
  assertSameBuildIdentity(build, parseBuildIdentity(cert.buildIdentity));
  if (
    cert.schemaVersion !== 2 ||
    cert.repository !== repo ||
    cert.workflowRunId !== String(runId)
  ) {
    throw new Error("Nightly source certificate does not match its producing run.");
  }
  assertSameBuildIdentity(
    build,
    parseBuildIdentity(
      JSON.parse(readFileSync(join(root("build-identity"), "build-identity.json"), "utf8")),
    ),
  );
  for (const arch of RELEASE_ARCHITECTURES) {
    const path = root(arch === "arm64" ? "macos-arm64" : arch);
    const manifest = readArchitectureDirectory(path);
    assertSameBuildIdentity(build, manifest.buildIdentity);
    if (
      manifest.architecture !== arch ||
      manifest.updates !== "enabled" ||
      sha256File(join(path, "architecture-build.json")) !==
        bundle.architectures[arch].manifestSha256 ||
      manifest.artifacts.some(
        (local) => !bundle.assets.some((publicAsset) => isDeepStrictEqual(local, publicAsset)),
      )
    ) {
      throw new Error(`Nightly architecture ${arch} does not match the immutable release bundle.`);
    }
  }
  for (const platform of MOBILE_PLATFORMS) {
    const local = readMobileBuildDirectory(root(`mobile-${platform}`), platform, build);
    if (
      sha256File(local.manifestPath) !== bundle.mobile[platform].manifestSha256 ||
      !isDeepStrictEqual(local.manifest.artifact, bundle.mobile[platform].artifact)
    ) {
      throw new Error(`Nightly ${platform} build does not match the immutable release bundle.`);
    }
  }
}

export function preparePromotion(cwd: string, repo: string, dir: string, tag?: string) {
  const candidate = resolvePromotion(cwd, repo, tag);
  gh([
    "run",
    "download",
    String(candidate.runId),
    "--repo",
    repo,
    "--dir",
    dir,
    ...nightlyArtifacts.flatMap((kind) => ["--name", artifact(kind, candidate.identity.sourceSha)]),
  ]);
  verifyPromotionInputs(repo, dir, candidate);
  return candidate;
}

export function verifyPromotedBundle(nightlyPath: string, stablePath: string): void {
  const nightly = parseReleaseBundleManifest(JSON.parse(readFileSync(nightlyPath, "utf8")));
  const stable = parseReleaseBundleManifest(JSON.parse(readFileSync(stablePath, "utf8")));
  releaseAssetPaths(stablePath);
  assertPromotedBuildBytes(nightly, stable);
  const ios = readMobileBuildDirectory(
    join(stablePath, "../testflight"),
    "ios",
    buildIdentityOf(stable.releaseIdentity),
  );
  if (
    !isDeepStrictEqual(ios.manifest.artifact, nightly.mobile.ios.artifact) ||
    sha256File(ios.manifestPath) !== nightly.mobile.ios.manifestSha256
  ) {
    throw new Error("Stable TestFlight payload does not match the Nightly.");
  }
}

export function promoteFromLocal(cwd: string, repo: string, tag?: string): void {
  const { identity, notes, publishedAt } = resolvePromotion(cwd, repo, tag);
  const hours = Math.floor((Date.now() - Date.parse(publishedAt)) / 3_600_000);
  process.stdout.write(
    `${identity.tag} · ${identity.sourceSha} · ${hours}h old · v${identity.version}\n\n${notes}\n`,
  );
  const result = api<{ html_url: string }>(
    `repos/${repo}/actions/workflows/release.yml/dispatches`,
    "--method",
    "POST",
    "-H",
    "X-GitHub-Api-Version: 2026-03-10",
    "-f",
    "ref=main",
    "-f",
    `inputs[nightly_tag]=${identity.tag}`,
  );
  process.stdout.write(`${result.html_url}\n`);
}

export function advancePublishedRelease(cwd: string, repo: string, tag: string): void {
  const version = stableVersionFromAppTag(tag);
  const release = version && readGitHubRelease(repo, tag);
  if (
    !version ||
    !release ||
    release.draft ||
    release.prerelease ||
    release.immutable !== true ||
    !release.published_at
  ) {
    throw new Error("Advance requires a published immutable stable release.");
  }
  const published = downloadReleaseIndex(repo, release);
  const sourceSha = tagTarget(repo, tag);
  if (sourceSha !== published.sourceSha)
    throw new Error("Stable tag and bundle source do not agree.");
  assertOnMain(cwd, sourceSha, fetchMain(cwd));
  const notes = extractUnreleasedNotes(inspectReleaseSourceAtRef(cwd, sourceSha).changelog);
  const date = new Date(release.published_at).toISOString().slice(0, 10);
  advanceMain({ cwd, sourceSha, version, notes, date });
}

export function advanceMain(options: {
  cwd: string;
  sourceSha: string;
  version: string;
  notes: string;
  date: string;
}): void {
  const { cwd, sourceSha, version, notes, date } = options;
  const tag = `v${version}`;
  if (git(cwd, "status", "--porcelain"))
    throw new Error("Advance requires a clean checkout of main.");
  const branch = git(cwd, "branch", "--show-current");
  if (branch !== "" && branch !== "main")
    throw new Error("Check out main before advancing a release.");
  let main = fetchMain(cwd);
  assertOnMain(cwd, git(cwd, "rev-parse", "HEAD"), main);
  git(cwd, "merge", "--ff-only", main);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assertOnMain(cwd, sourceSha, main);
    if (!advanceReleaseSource(cwd, version, notes, date)) return;
    git(cwd, "add", "--", ...RELEASE_SOURCE_PATHS);
    git(
      cwd,
      "commit",
      "-m",
      `chore(release): advance after ${tag}`,
      "-m",
      `Nodex-Release-Source: ${sourceSha}`,
    );
    try {
      git(cwd, "push", "origin", "HEAD:refs/heads/main");
      return;
    } catch (cause) {
      const newer = fetchMain(cwd);
      // Regenerate on the new parent so concurrent changelog edits are retained.
      git(cwd, "reset", "--hard", newer);
      if (newer === main) throw new Error("Unable to push the release advance to main.", { cause });
      main = newer;
    }
  }
  throw new Error("Main kept moving during the release advance. Retry the command.");
}

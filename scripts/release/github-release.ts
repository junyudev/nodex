import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseReleaseBundleManifest } from "./bundle";
import {
  compareStableVersions,
  latestStableAppVersion,
  normalizeStableVersion,
  sha256File,
  stableVersionFromAppTag,
  tagForVersion,
  type ReleaseIdentity,
} from "./model";

interface GitHubAsset {
  readonly digest?: string | null;
  readonly name: string;
  readonly size: number;
}

interface GitHubRelease {
  readonly assets: readonly GitHubAsset[];
  readonly draft: boolean;
  readonly immutable?: boolean;
  readonly prerelease: boolean;
  readonly tag_name: string;
}

interface ReleaseAssetIdentity {
  readonly bytes: number;
  readonly sha256: string;
}

export type PublicationPlan =
  | { readonly kind: "create" }
  | { readonly kind: "resume-draft"; readonly missingAssetNames: readonly string[] }
  | { readonly kind: "verify-published" };

const assertRegularFile = (filePath: string): void => {
  if (!existsSync(filePath)) throw new Error(`Release asset is missing: ${filePath}`);
  const metadata = lstatSync(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`Release asset must be a regular file: ${filePath}`);
  }
};

const readBundle = (bundlePath: string) => {
  const resolvedBundle = resolve(bundlePath);
  assertRegularFile(resolvedBundle);
  return {
    bundle: parseReleaseBundleManifest(JSON.parse(readFileSync(resolvedBundle, "utf8"))),
    resolvedBundle,
    root: dirname(resolvedBundle),
  };
};

const verifyChecksumAllowlist = (
  resolvedBundle: string,
  bundle: ReturnType<typeof parseReleaseBundleManifest>,
): string => {
  const checksumPath = join(dirname(resolvedBundle), "SHA256SUMS");
  assertRegularFile(checksumPath);
  const checksumEntries = [
    ...bundle.assets.map(({ name, sha256 }) => ({ name, sha256 })),
    { name: basename(resolvedBundle), sha256: sha256File(resolvedBundle) },
  ].sort((left, right) => left.name.localeCompare(right.name));
  const expectedChecksums = `${checksumEntries.map(({ name, sha256 }) => `${sha256}  ${name}`).join("\n")}\n`;
  if (readFileSync(checksumPath, "utf8") !== expectedChecksums) {
    throw new Error("SHA256SUMS does not match the Release Bundle allowlist.");
  }
  return checksumPath;
};

const gh = (
  args: readonly string[],
  options?: { readonly allowFailure?: boolean; readonly timeoutMs?: number },
): string => {
  try {
    return execFileSync("gh", [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", options?.allowFailure ? "ignore" : "pipe"],
      timeout: options?.timeoutMs,
    }).trim();
  } catch (error) {
    if (options?.allowFailure) return "";
    throw error;
  }
};

const commandFailureOutput = (error: unknown, stream: "stdout" | "stderr"): string | null => {
  if (!(error instanceof Error) || !("status" in error) || error.status !== 1) return null;
  if (!(stream in error)) return null;
  const output: unknown = Reflect.get(error, stream);
  return typeof output === "string" || Buffer.isBuffer(output) ? output.toString().trim() : null;
};

const missingReleaseAttestationDigest = (error: unknown, tag: string): string | null => {
  const stderr = commandFailureOutput(error, "stderr");
  if (stderr === null) return null;
  const missing = /^no attestations for tag (.+) \((sha1:[a-f0-9]{40})\)$/u.exec(stderr);
  return missing?.[1] === tag ? missing[2] : null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMissingAttestationResponse = (error: unknown): boolean => {
  if (commandFailureOutput(error, "stderr") !== "gh: Not Found (HTTP 404)") return false;
  const stdout = commandFailureOutput(error, "stdout");
  if (stdout === null) return false;
  try {
    const body: unknown = JSON.parse(stdout);
    return isRecord(body) && body.message === "Not Found" && body.status === "404";
  } catch {
    return false;
  }
};

/** The verification CLI also calls authorization and bundle-fetch failures "no attestations". */
const releaseAttestationIsMissing = (repo: string, tag: string, digest: string): boolean => {
  const reference: unknown = JSON.parse(
    gh(["api", "--method", "GET", `repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`], {
      timeoutMs: 30_000,
    }),
  );
  if (
    !isRecord(reference) ||
    reference.ref !== `refs/tags/${tag}` ||
    !isRecord(reference.object) ||
    reference.object.sha !== digest.slice("sha1:".length)
  ) {
    throw new Error("Release attestation lookup does not match the readable release tag.");
  }
  let response: unknown;
  try {
    response = JSON.parse(
      gh(
        [
          "api",
          "--method",
          "GET",
          `repos/${repo}/attestations/${digest}`,
          "-f",
          "predicate_type=release",
          "-F",
          "per_page=100",
        ],
        { timeoutMs: 30_000 },
      ),
    );
  } catch (error) {
    if (isMissingAttestationResponse(error)) return true;
    throw error;
  }
  if (
    !isRecord(response) ||
    !Array.isArray(response.attestations) ||
    !response.attestations.every(
      (entry: unknown) => isRecord(entry) && typeof entry.initiator === "string",
    )
  ) {
    throw new Error("GitHub returned an invalid release-attestation response.");
  }
  return !response.attestations.some(
    (entry: { initiator: string }) => entry.initiator === "github",
  );
};

/** GitHub can publish immutable assets before its signed attestation becomes readable. */
export async function verifyReleaseAttestation(repo: string, tag: string): Promise<void> {
  const attempts = 12;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      gh(["release", "verify", tag, "--repo", repo], { timeoutMs: 30_000 });
      return;
    } catch (error) {
      const digest = missingReleaseAttestationDigest(error, tag);
      if (digest === null || !releaseAttestationIsMissing(repo, tag, digest)) throw error;
      if (attempt === attempts) {
        throw new Error(
          `Release attestation for ${tag} remained unavailable after ${attempts} verification attempts.`,
          { cause: error },
        );
      }
      process.stderr.write(
        `Release attestation for ${tag} is not visible yet; retrying verification (${attempt + 1}/${attempts}) in 10 seconds.\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

export const releaseAssetPaths = (bundlePath: string): readonly string[] => {
  const { bundle, resolvedBundle, root } = readBundle(bundlePath);
  const checksumPath = join(root, "SHA256SUMS");
  const paths = [
    ...bundle.assets.map((asset) => join(root, asset.name)),
    resolvedBundle,
    checksumPath,
  ];
  for (const filePath of paths) assertRegularFile(filePath);
  for (const artifact of bundle.assets) {
    const filePath = join(root, artifact.name);
    if (lstatSync(filePath).size !== artifact.bytes || sha256File(filePath) !== artifact.sha256) {
      throw new Error(`Release asset ${artifact.name} does not match release-bundle.json.`);
    }
  }
  verifyChecksumAllowlist(resolvedBundle, bundle);
  return paths;
};

const expectedLocalAssets = (bundlePath: string): ReadonlyMap<string, ReleaseAssetIdentity> =>
  new Map(
    releaseAssetPaths(bundlePath).map((filePath) => [
      basename(filePath),
      { bytes: lstatSync(filePath).size, sha256: sha256File(filePath) },
    ]),
  );

export const remoteReleaseAssetIdentities = (
  bundlePath: string,
): ReadonlyMap<string, ReleaseAssetIdentity> => {
  const { bundle, resolvedBundle } = readBundle(bundlePath);
  const checksumPath = verifyChecksumAllowlist(resolvedBundle, bundle);
  return new Map([
    ...bundle.assets.map(
      (asset) => [asset.name, { bytes: asset.bytes, sha256: asset.sha256 }] as const,
    ),
    [
      basename(resolvedBundle),
      { bytes: lstatSync(resolvedBundle).size, sha256: sha256File(resolvedBundle) },
    ],
    [
      basename(checksumPath),
      { bytes: lstatSync(checksumPath).size, sha256: sha256File(checksumPath) },
    ],
  ]);
};

export function planPublication(
  release: GitHubRelease | null,
  expected: ReadonlyMap<string, ReleaseAssetIdentity>,
  expectedPrerelease: boolean,
): PublicationPlan {
  if (!release) return { kind: "create" };
  if (release.prerelease !== expectedPrerelease)
    throw new Error("GitHub release channel does not match the Release Bundle.");
  const actualNames = new Set(release.assets.map((asset) => asset.name));
  for (const asset of release.assets) {
    const identity = expected.get(asset.name);
    if (!identity) throw new Error(`GitHub release contains an unexpected asset: ${asset.name}.`);
    const digest = asset.digest?.replace(/^sha256:/, "");
    if (asset.size !== identity.bytes || digest !== identity.sha256) {
      throw new Error(
        `GitHub release asset ${asset.name} does not match the local Release Bundle.`,
      );
    }
  }
  const missingAssetNames = [...expected.keys()].filter((name) => !actualNames.has(name)).sort();
  if (!release.draft) {
    if (missingAssetNames.length > 0) {
      throw new Error(`Published release is missing assets: ${missingAssetNames.join(", ")}.`);
    }
    return { kind: "verify-published" };
  }
  return { kind: "resume-draft", missingAssetNames };
}

const readRelease = (repo: string, tag: string): GitHubRelease | null => {
  const response = gh(["api", `repos/${repo}/releases`, "--paginate", "--slurp"]);
  const releases = (JSON.parse(response) as GitHubRelease[][]).flat();
  return releases.find((release) => release.tag_name === tag) ?? null;
};

export function inspectNightlyRemoteCandidate(
  repo: string,
  identity: ReleaseIdentity,
): {
  readonly decision: "publish" | "resume-draft" | "already-published";
  readonly tagPlan: "create" | "reuse";
} {
  if (identity.channel !== "nightly")
    throw new Error("Nightly remote inspection requires a nightly identity.");
  const reference = readTagReference(repo, identity.tag);
  const tagPlan = planTag(
    reference ? resolveTagTargetSha(repo, reference) : null,
    identity.sourceSha,
  );
  const release = readRelease(repo, identity.tag);
  if (!release) return { decision: "publish", tagPlan };
  if (tagPlan !== "reuse")
    throw new Error("Existing Nightly release has no exact immutable tag target.");
  if (!release.prerelease)
    throw new Error("Nightly tag is attached to a non-prerelease GitHub Release.");
  if (release.draft) return { decision: "resume-draft", tagPlan };
  if (release.immutable !== true) throw new Error("Published Nightly release is not immutable.");
  verifyPublishedReleaseIndex(repo, release, identity);
  const latest = gh(["api", `repos/${repo}/releases/latest`], { allowFailure: true });
  if (latest && (JSON.parse(latest) as GitHubRelease).tag_name === identity.tag) {
    throw new Error("Nightly release must not be GitHub Latest.");
  }
  return { decision: "already-published", tagPlan };
}

const verifyPublishedReleaseIndex = (
  repo: string,
  release: GitHubRelease,
  identity: ReleaseIdentity,
): void => {
  const directory = mkdtempSync(join(tmpdir(), "nodex-nightly-candidate-"));
  try {
    for (const pattern of ["release-bundle.json", "SHA256SUMS"]) {
      gh([
        "release",
        "download",
        identity.tag,
        "--repo",
        repo,
        "--pattern",
        pattern,
        "--dir",
        directory,
      ]);
    }
    const bundlePath = join(directory, "release-bundle.json");
    const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
    if (!isDeepStrictEqual(bundle.releaseIdentity, identity)) {
      throw new Error("Published Nightly Bundle has a different Release Identity.");
    }
    const plan = planPublication(release, remoteReleaseAssetIdentities(bundlePath), true);
    if (plan.kind !== "verify-published") {
      throw new Error("Published Nightly release is incomplete.");
    }
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};

interface GitReference {
  readonly object: { readonly sha: string; readonly type: "commit" | "tag" };
  readonly ref: string;
}

const readTagReference = (repo: string, tag: string): GitReference | null => {
  const response = gh(["api", `repos/${repo}/git/ref/tags/${tag}`], { allowFailure: true });
  return response ? (JSON.parse(response) as GitReference) : null;
};

const resolveTagTargetSha = (repo: string, reference: GitReference): string => {
  let object = reference.object;
  for (let depth = 0; depth < 4; depth += 1) {
    if (object.type === "commit") return object.sha;
    const tag = JSON.parse(gh(["api", `repos/${repo}/git/tags/${object.sha}`])) as {
      readonly object: GitReference["object"];
    };
    object = tag.object;
  }
  throw new Error(`Git tag ${reference.ref} contains too many nested tag objects.`);
};

export function planTag(existingTargetSha: string | null, sourceSha: string): "create" | "reuse" {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha))
    throw new Error("Release source SHA must be a full commit SHA.");
  if (existingTargetSha === null) return "create";
  if (existingTargetSha !== sourceSha) {
    throw new Error(
      `Release tag points to ${existingTargetSha}, expected ${sourceSha}; tags never move.`,
    );
  }
  return "reuse";
}

const readStableTagNames = (repo: string): readonly string[] => {
  const response = gh(["api", `repos/${repo}/git/matching-refs/tags/v`, "--paginate", "--slurp"]);
  return (JSON.parse(response) as GitReference[][])
    .flat()
    .map(({ ref }) => ref.replace(/^refs\/tags\//u, ""))
    .filter((tag) => stableVersionFromAppTag(tag) !== null);
};

export function assertRemoteReleaseCandidate(options: {
  readonly repo: string;
  readonly sourceSha: string;
  readonly version: string;
}): { readonly tag: string; readonly tagPlan: "create" | "reuse" } {
  const version = normalizeStableVersion(options.version);
  const tag = tagForVersion(version);
  const reference = readTagReference(options.repo, tag);
  const tagPlan = planTag(
    reference ? resolveTagTargetSha(options.repo, reference) : null,
    options.sourceSha,
  );
  const otherTags = readStableTagNames(options.repo).filter((candidate) => candidate !== tag);
  const latestVersion = latestStableAppVersion(otherTags);
  if (tagPlan === "create" && latestVersion && compareStableVersions(version, latestVersion) <= 0) {
    throw new Error(
      `Release ${version} must be newer than remote stable app version ${latestVersion}.`,
    );
  }
  return { tag, tagPlan };
}

export function ensureGitHubReleaseTag(options: {
  readonly bundlePath: string;
  readonly repo: string;
}): "create" | "reuse" {
  const bundlePath = resolve(options.bundlePath);
  releaseAssetPaths(bundlePath);
  const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
  const reference = readTagReference(options.repo, bundle.tag);
  const tagPlan =
    bundle.releaseIdentity.channel === "stable"
      ? assertRemoteReleaseCandidate({
          repo: options.repo,
          sourceSha: bundle.sourceSha,
          version: bundle.version,
        }).tagPlan
      : planTag(reference ? resolveTagTargetSha(options.repo, reference) : null, bundle.sourceSha);
  if (tagPlan === "reuse") return "reuse";
  const annotation = [
    `Nodex ${bundle.tag}`,
    "",
    `Source: ${bundle.sourceSha}`,
    `Release-Bundle-SHA256: ${sha256File(bundlePath)}`,
  ].join("\n");
  const tagObject = JSON.parse(
    gh([
      "api",
      "--method",
      "POST",
      `repos/${options.repo}/git/tags`,
      "-f",
      `tag=${bundle.tag}`,
      "-f",
      `message=${annotation}`,
      "-f",
      `object=${bundle.sourceSha}`,
      "-f",
      "type=commit",
      "-f",
      "tagger[name]=github-actions[bot]",
      "-f",
      "tagger[email]=41898282+github-actions[bot]@users.noreply.github.com",
      "-f",
      `tagger[date]=${new Date().toISOString()}`,
    ]),
  ) as { readonly sha?: unknown };
  if (typeof tagObject.sha !== "string")
    throw new Error("GitHub did not return an annotated tag object SHA.");
  gh([
    "api",
    "--method",
    "POST",
    `repos/${options.repo}/git/refs`,
    "-f",
    `ref=refs/tags/${bundle.tag}`,
    "-f",
    `sha=${tagObject.sha}`,
  ]);
  const created = readTagReference(options.repo, bundle.tag);
  if (!created || resolveTagTargetSha(options.repo, created) !== bundle.sourceSha) {
    throw new Error("Created release tag does not resolve to the Release Bundle source SHA.");
  }
  return "create";
}

export function publishGitHubRelease(options: {
  readonly bundlePath: string;
  readonly notesPath: string;
  readonly repo: string;
}): PublicationPlan {
  const bundlePath = resolve(options.bundlePath);
  const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
  const expected = expectedLocalAssets(bundlePath);
  const release = readRelease(options.repo, bundle.tag);
  const prerelease = bundle.releaseIdentity.channel === "nightly";
  const plan = planPublication(release, expected, prerelease);
  const filesByName = new Map(
    releaseAssetPaths(bundlePath).map((filePath) => [basename(filePath), filePath]),
  );

  if (plan.kind === "create") {
    gh([
      "release",
      "create",
      bundle.tag,
      "--repo",
      options.repo,
      "--verify-tag",
      "--draft",
      ...(prerelease ? ["--prerelease"] : []),
      "--title",
      `Nodex ${bundle.tag}`,
      "--notes-file",
      resolve(options.notesPath),
    ]);
    gh(["release", "upload", bundle.tag, ...filesByName.values(), "--repo", options.repo]);
  }
  if (plan.kind === "resume-draft" || plan.kind === "create") {
    const missingPaths = (plan.kind === "resume-draft" ? plan.missingAssetNames : []).map(
      (name) => {
        const filePath = filesByName.get(name);
        if (!filePath) throw new Error(`Missing local recovery asset ${name}.`);
        return filePath;
      },
    );
    if (missingPaths.length > 0) {
      gh(["release", "upload", bundle.tag, ...missingPaths, "--repo", options.repo]);
    }
    const completedDraft = planPublication(
      readRelease(options.repo, bundle.tag),
      expected,
      prerelease,
    );
    if (completedDraft.kind !== "resume-draft" || completedDraft.missingAssetNames.length > 0) {
      throw new Error("GitHub draft does not contain the exact verified Release Bundle assets.");
    }
    gh([
      "release",
      "edit",
      bundle.tag,
      "--repo",
      options.repo,
      "--draft=false",
      ...(prerelease ? ["--prerelease"] : ["--latest"]),
      "--title",
      `Nodex ${bundle.tag}`,
      "--notes-file",
      resolve(options.notesPath),
    ]);
  }
  return plan;
}

export async function verifyRemoteRelease(options: {
  readonly bundlePath: string;
  readonly repo: string;
  readonly requireImmutable?: boolean;
}): Promise<void> {
  const bundlePath = resolve(options.bundlePath);
  const bundle = parseReleaseBundleManifest(JSON.parse(readFileSync(bundlePath, "utf8")));
  const release = readRelease(options.repo, bundle.tag);
  const expected = remoteReleaseAssetIdentities(bundlePath);
  const prerelease = bundle.releaseIdentity.channel === "nightly";
  const plan = planPublication(release, expected, prerelease);
  if (plan.kind !== "verify-published" || !release)
    throw new Error("GitHub release is not fully published.");
  if (options.requireImmutable !== false && release.immutable !== true) {
    throw new Error("GitHub release is not immutable.");
  }
  const tagReference = readTagReference(options.repo, bundle.tag);
  if (!tagReference || resolveTagTargetSha(options.repo, tagReference) !== bundle.sourceSha) {
    throw new Error("Published release tag does not target the Release Bundle source SHA.");
  }
  const latestResponse = gh(["api", `repos/${options.repo}/releases/latest`], {
    allowFailure: true,
  });
  const latest = (latestResponse ? JSON.parse(latestResponse) : {}) as {
    readonly tag_name?: unknown;
  };
  if (!prerelease && latest.tag_name !== bundle.tag) {
    throw new Error(`GitHub Latest is ${String(latest.tag_name)}, expected ${bundle.tag}.`);
  }
  if (prerelease && latest.tag_name === bundle.tag) {
    throw new Error("Nightly release must not be GitHub Latest.");
  }
  await verifyReleaseAttestation(options.repo, bundle.tag);

  const downloadRoot = mkdtempSync(join(tmpdir(), "nodex-release-redownload-"));
  try {
    gh(["release", "download", bundle.tag, "--repo", options.repo, "--dir", downloadRoot]);
    for (const [name, identity] of expected) {
      const downloaded = join(downloadRoot, name);
      if (
        !existsSync(downloaded) ||
        lstatSync(downloaded).size !== identity.bytes ||
        sha256File(downloaded) !== identity.sha256
      ) {
        throw new Error(`Re-downloaded GitHub release asset ${name} failed byte verification.`);
      }
    }
  } finally {
    rmSync(downloadRoot, { force: true, recursive: true });
  }
}

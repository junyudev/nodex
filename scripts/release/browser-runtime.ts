import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { materializeBrowserRuntime } from "../materialize-browser-runtime";
import { readBrowserRuntimeReleaseLock } from "../browser-runtime-release-lock";
import { stableVersionFromAppTag } from "./model";

const run = (args: readonly string[]): string =>
  execFileSync("gh", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

interface BrowserRuntimeRemoteAsset {
  readonly digest?: string | null;
  readonly name: string;
  readonly size: number;
}

interface BrowserRuntimeRemoteRelease {
  readonly assets: readonly BrowserRuntimeRemoteAsset[];
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly tag_name: string;
}

interface BrowserRuntimeAssetIdentity {
  readonly sha256: string;
  readonly size: number;
}

export type BrowserRuntimePublicationPlan =
  | { readonly kind: "create" }
  | { readonly kind: "resume-draft"; readonly missingAssetNames: readonly string[] }
  | { readonly kind: "verify-published" };

export function planBrowserRuntimePublication(
  release: BrowserRuntimeRemoteRelease | null,
  expected: ReadonlyMap<string, BrowserRuntimeAssetIdentity>,
): BrowserRuntimePublicationPlan {
  if (!release) return { kind: "create" };
  if (release.prerelease) throw new Error("Browser runtime release must not be a prerelease.");

  const actualNames = new Set(release.assets.map((asset) => asset.name));
  for (const asset of release.assets) {
    const identity = expected.get(asset.name);
    if (!identity) {
      throw new Error(`Browser runtime release contains an unexpected asset: ${asset.name}.`);
    }
    if (asset.size !== identity.size || asset.digest?.replace(/^sha256:/, "") !== identity.sha256) {
      throw new Error(`Browser runtime release asset ${asset.name} does not match its lock.`);
    }
  }

  const missingAssetNames = [...expected.keys()].filter((name) => !actualNames.has(name)).sort();
  if (!release.draft) {
    if (missingAssetNames.length > 0) {
      throw new Error(
        `Published Browser runtime is missing assets: ${missingAssetNames.join(", ")}.`,
      );
    }
    return { kind: "verify-published" };
  }
  return { kind: "resume-draft", missingAssetNames };
}

const readBrowserRuntimeRelease = (
  repo: string,
  tag: string,
): BrowserRuntimeRemoteRelease | null => {
  const pages = JSON.parse(
    run(["api", `repos/${repo}/releases`, "--paginate", "--slurp"]),
  ) as BrowserRuntimeRemoteRelease[][];
  return pages.flat().find((release) => release.tag_name === tag) ?? null;
};

export function browserRuntimeReleaseArguments(options: {
  readonly arm64Path: string;
  readonly repo: string;
  readonly tag: string;
  readonly x64Path: string;
}): readonly string[] {
  if (!/^browser-runtime-v\d+(?:\.\d+)+$/.test(options.tag)) {
    throw new Error("Browser runtime tag must use browser-runtime-v<version>.");
  }
  const arm64Path = resolve(options.arm64Path);
  const x64Path = resolve(options.x64Path);
  for (const [architecture, filePath] of [
    ["arm64", arm64Path],
    ["x64", x64Path],
  ] as const) {
    const stats = lstatSync(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || !basename(filePath).includes(architecture)) {
      throw new Error(`Browser runtime ${architecture} archive is invalid.`);
    }
  }
  return [
    "release",
    "create",
    options.tag,
    "--repo",
    options.repo,
    "--verify-tag",
    "--draft",
    "--latest=false",
    "--title",
    `Nodex Browser runtime ${options.tag.replace("browser-runtime-v", "")}`,
    "--notes",
    "Immutable Browser runtime closure consumed by Nodex release locks.",
  ];
}

export type BrowserRuntimePublishOptions = {
  readonly arm64Path: string;
  readonly lockPath: string;
  readonly repo: string;
  readonly tag: string;
  readonly x64Path: string;
};

/** Proves the two published bytes are the exact complete closures named by the release lock. */
export async function verifyBrowserRuntimePublishInput(
  options: BrowserRuntimePublishOptions,
): Promise<void> {
  const lockPath = resolve(options.lockPath);
  const lock = readBrowserRuntimeReleaseLock(lockPath);
  if (lock.repository !== options.repo || lock.tag !== options.tag) {
    throw new Error("Browser runtime publish target does not match its release lock.");
  }

  const arm64Path = resolve(options.arm64Path);
  const x64Path = resolve(options.x64Path);
  if (
    basename(arm64Path) !== lock.assets["darwin-arm64"].assetName ||
    basename(x64Path) !== lock.assets["darwin-x64"].assetName
  ) {
    throw new Error("Browser runtime archive names do not match their release lock.");
  }

  const verificationRoot = mkdtempSync(join(tmpdir(), "nodex-browser-runtime-publish-"));
  try {
    await Promise.all([
      materializeBrowserRuntime({
        archivePath: arm64Path,
        lockPath,
        outputPath: join(verificationRoot, "arm64"),
        targetArch: "arm64",
        targetPlatform: "darwin",
      }),
      materializeBrowserRuntime({
        archivePath: x64Path,
        lockPath,
        outputPath: join(verificationRoot, "x64"),
        targetArch: "x64",
        targetPlatform: "darwin",
      }),
    ]);
  } finally {
    rmSync(verificationRoot, { force: true, recursive: true });
  }
}

export async function publishBrowserRuntime(options: BrowserRuntimePublishOptions): Promise<void> {
  await verifyBrowserRuntimePublishInput(options);
  const lock = readBrowserRuntimeReleaseLock(resolve(options.lockPath));
  const expected = new Map<string, BrowserRuntimeAssetIdentity>(
    Object.values(lock.assets).map((asset) => [
      asset.assetName,
      { sha256: asset.archiveSha256, size: asset.archiveSize },
    ]),
  );
  const pathsByName = new Map([
    [basename(options.arm64Path), resolve(options.arm64Path)],
    [basename(options.x64Path), resolve(options.x64Path)],
  ]);
  const latestBefore = JSON.parse(run(["api", `repos/${options.repo}/releases/latest`])) as {
    readonly tag_name?: unknown;
  };
  if (
    typeof latestBefore.tag_name !== "string" ||
    !stableVersionFromAppTag(latestBefore.tag_name)
  ) {
    throw new Error(
      "Browser runtime publication requires Latest to already be a stable app release.",
    );
  }

  let plan = planBrowserRuntimePublication(
    readBrowserRuntimeRelease(options.repo, options.tag),
    expected,
  );
  if (plan.kind === "create") {
    run(browserRuntimeReleaseArguments(options));
    plan = planBrowserRuntimePublication(
      readBrowserRuntimeRelease(options.repo, options.tag),
      expected,
    );
  }
  if (plan.kind === "resume-draft") {
    const missingPaths = plan.missingAssetNames.map((name) => {
      const archivePath = pathsByName.get(name);
      if (!archivePath) throw new Error(`Missing local Browser runtime asset ${name}.`);
      return archivePath;
    });
    if (missingPaths.length > 0) {
      run(["release", "upload", options.tag, ...missingPaths, "--repo", options.repo]);
    }
    const completedDraft = planBrowserRuntimePublication(
      readBrowserRuntimeRelease(options.repo, options.tag),
      expected,
    );
    if (completedDraft.kind !== "resume-draft" || completedDraft.missingAssetNames.length > 0) {
      throw new Error("Browser runtime draft does not contain the exact locked assets.");
    }
    run([
      "release",
      "edit",
      options.tag,
      "--repo",
      options.repo,
      "--draft=false",
      "--latest=false",
      "--title",
      `Nodex Browser runtime ${options.tag.replace("browser-runtime-v", "")}`,
      "--notes",
      "Immutable Browser runtime closure consumed by Nodex release locks.",
    ]);
  }

  const completed = planBrowserRuntimePublication(
    readBrowserRuntimeRelease(options.repo, options.tag),
    expected,
  );
  if (completed.kind !== "verify-published") {
    throw new Error("Browser runtime release was not published with its exact locked assets.");
  }
  const latestAfter = JSON.parse(run(["api", `repos/${options.repo}/releases/latest`])) as {
    readonly tag_name?: unknown;
  };
  if (latestAfter.tag_name !== latestBefore.tag_name) {
    throw new Error("Browser runtime publication changed the stable app Latest release.");
  }
}

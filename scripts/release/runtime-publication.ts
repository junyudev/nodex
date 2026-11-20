import { gh } from "./github-release";
import { stableVersionFromAppTag } from "./model";

interface RuntimeRemoteAsset {
  readonly digest?: string | null;
  readonly name: string;
  readonly size: number;
}

interface RuntimeRemoteRelease {
  readonly assets: readonly RuntimeRemoteAsset[];
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly tag_name: string;
}

export interface RuntimeAssetIdentity {
  readonly sha256: string;
  readonly size: number;
}

export type RuntimePublicationPlan =
  | { readonly kind: "create" }
  | { readonly kind: "resume-draft"; readonly missingAssetNames: readonly string[] }
  | { readonly kind: "verify-published" };

export function planRuntimePublication(
  release: RuntimeRemoteRelease | null,
  expected: ReadonlyMap<string, RuntimeAssetIdentity>,
): RuntimePublicationPlan {
  if (!release) return { kind: "create" };
  if (release.prerelease) throw new Error("Runtime release must not be a prerelease.");

  const actualNames = new Set<string>();
  for (const asset of release.assets) {
    if (actualNames.has(asset.name))
      throw new Error(`Runtime release repeats asset ${asset.name}.`);
    actualNames.add(asset.name);
    const identity = expected.get(asset.name);
    if (!identity) {
      throw new Error(`Runtime release contains an unexpected asset: ${asset.name}.`);
    }
    if (asset.size !== identity.size || asset.digest?.replace(/^sha256:/, "") !== identity.sha256) {
      throw new Error(`Runtime release asset ${asset.name} does not match its lock.`);
    }
  }

  const missingAssetNames = [...expected.keys()].filter((name) => !actualNames.has(name)).sort();
  if (!release.draft) {
    if (missingAssetNames.length > 0) {
      throw new Error(`Published Runtime is missing assets: ${missingAssetNames.join(", ")}.`);
    }
    return { kind: "verify-published" };
  }
  return { kind: "resume-draft", missingAssetNames };
}

/**
 * GitHub's release list is eventually consistent after create, upload, and publish. Re-read until
 * the plan reflects the mutation just made; a bounded miss fails, and rerunning resumes.
 */
export async function awaitRuntimePublicationPlan(
  readPlan: () => RuntimePublicationPlan,
  settled: (plan: RuntimePublicationPlan) => boolean,
  options: { readonly attempts?: number; readonly delayMs?: number } = {},
): Promise<RuntimePublicationPlan> {
  const attempts = options.attempts ?? 10;
  let plan = readPlan();
  for (let attempt = 1; attempt < attempts && !settled(plan); attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, options.delayMs ?? 3_000));
    plan = readPlan();
  }
  return plan;
}

const readRuntimeRelease = (
  repo: string,
  tag: string,
  github: typeof gh,
): RuntimeRemoteRelease | null => {
  const pages = JSON.parse(
    github(["api", `repos/${repo}/releases`, "--paginate", "--slurp"]),
  ) as RuntimeRemoteRelease[][];
  return pages.flat().find((release) => release.tag_name === tag) ?? null;
};

export interface RuntimePublication {
  readonly repo: string;
  readonly tag: string;
  readonly title: string;
  readonly notes: string;
}

export function runtimeDraftArguments(options: RuntimePublication): readonly string[] {
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
    options.title,
    "--notes",
    options.notes,
  ];
}

export async function publishRuntimeArchive(
  options: RuntimePublication,
  expected: ReadonlyMap<string, RuntimeAssetIdentity>,
  pathsByName: ReadonlyMap<string, string>,
  github = gh,
): Promise<void> {
  if (expected.size === 0) throw new Error("Runtime release must contain an archive.");
  const latestBefore = JSON.parse(github(["api", `repos/${options.repo}/releases/latest`])) as {
    readonly tag_name?: unknown;
  };
  if (
    typeof latestBefore.tag_name !== "string" ||
    !stableVersionFromAppTag(latestBefore.tag_name)
  ) {
    throw new Error("Runtime publication requires Latest to already be a stable app release.");
  }

  const readPlan = () =>
    planRuntimePublication(readRuntimeRelease(options.repo, options.tag, github), expected);
  let plan = readPlan();
  if (plan.kind === "create") {
    github(runtimeDraftArguments(options));
    plan = await awaitRuntimePublicationPlan(readPlan, (next) => next.kind !== "create");
    if (plan.kind === "create") {
      throw new Error("The created Runtime draft is not visible yet; rerun to resume.");
    }
  }
  if (plan.kind === "resume-draft") {
    const missingPaths = plan.missingAssetNames.map((name) => {
      const archivePath = pathsByName.get(name);
      if (!archivePath) throw new Error(`Missing local Runtime asset ${name}.`);
      return archivePath;
    });
    if (missingPaths.length > 0) {
      github(["release", "upload", options.tag, ...missingPaths, "--repo", options.repo]);
    }
    const completedDraft = await awaitRuntimePublicationPlan(
      readPlan,
      (next) => next.kind !== "resume-draft" || next.missingAssetNames.length === 0,
    );
    if (completedDraft.kind !== "resume-draft" || completedDraft.missingAssetNames.length > 0) {
      throw new Error("Runtime draft does not contain the exact locked assets.");
    }
    github([
      "release",
      "edit",
      options.tag,
      "--repo",
      options.repo,
      "--draft=false",
      "--latest=false",
      "--title",
      options.title,
      "--notes",
      options.notes,
    ]);
  }

  const completed = await awaitRuntimePublicationPlan(
    readPlan,
    (next) => next.kind === "verify-published",
  );
  if (completed.kind !== "verify-published") {
    throw new Error("Runtime release was not published with its exact locked assets.");
  }
  const latestAfter = JSON.parse(github(["api", `repos/${options.repo}/releases/latest`])) as {
    readonly tag_name?: unknown;
  };
  if (latestAfter.tag_name !== latestBefore.tag_name) {
    throw new Error("Runtime publication changed the stable app Latest release.");
  }
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import { extractReleaseNotes, prepareChangelog } from "./changelog";
import { compareStableVersions, normalizeStableVersion, tagForVersion } from "./model";

export const RELEASE_SOURCE_PATHS = [
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "CHANGELOG.md",
] as const;

interface ReleaseSourceFiles {
  readonly cargoPackages: ReadonlySet<string>;
  readonly cargoLock: string;
  readonly cargoToml: string;
  readonly changelog: string;
  readonly packageJson: string;
}

export interface ReleaseSourceSnapshot {
  readonly cargoVersion: string;
  readonly changelog: string;
  readonly files: ReleaseSourceFiles;
  readonly packageVersion: string;
}

export interface ReleaseTransition {
  readonly baseVersion: string;
  readonly changedPaths: readonly string[];
  readonly releaseNotes: string;
  readonly shouldRelease: true;
  readonly tag: string;
  readonly version: string;
}

export interface NoReleaseTransition {
  readonly shouldRelease: false;
  readonly version: string;
}

export type ReleaseTransitionResult = ReleaseTransition | NoReleaseTransition;

const run = (cwd: string, command: string, args: readonly string[]): string =>
  execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const parsePackageVersion = (content: string): string => {
  const value = JSON.parse(content) as { readonly version?: unknown };
  if (typeof value.version !== "string")
    throw new Error("package.json does not contain a string version.");
  return normalizeStableVersion(value.version, "package.json version");
};

const parseCargoVersion = (content: string): string => {
  const value = parseToml(content) as {
    readonly workspace?: { readonly package?: { readonly version?: unknown } };
  };
  const version = value.workspace?.package?.version;
  if (typeof version !== "string") {
    throw new Error("Cargo.toml does not contain [workspace.package].version.");
  }
  return normalizeStableVersion(version, "Cargo workspace version");
};

// Read the inventory through the same worktree/ref reader as the release metadata.
const readWorkspacePackages = (
  cargoToml: string,
  read: (path: string) => string,
): ReadonlySet<string> => {
  const root = parseToml(cargoToml);
  const workspace = root.workspace as { members?: unknown; exclude?: unknown } | undefined;
  if (
    root.package ||
    workspace?.exclude !== undefined ||
    !Array.isArray(workspace?.members) ||
    workspace.members.length === 0
  ) {
    throw new Error(
      "Release workspace requires explicit members in a virtual workspace without exclusions.",
    );
  }
  const names = new Set<string>();
  for (const member of workspace.members) {
    if (typeof member !== "string" || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(member)) {
      throw new Error(
        "Release workspace members must be explicit repository-relative directories.",
      );
    }
    const manifest = parseToml(read(`${member}/Cargo.toml`));
    const pkg = manifest.package as
      | { name?: unknown; version?: { workspace?: unknown } }
      | undefined;
    if (typeof pkg?.name !== "string" || pkg.version?.workspace !== true || names.has(pkg.name)) {
      throw new Error(
        `Workspace member ${member} requires a unique package name and inherited workspace version.`,
      );
    }
    names.add(pkg.name);
  }
  return names;
};

const isReleasePackage = (
  entry: { readonly name?: unknown; readonly version?: unknown } | undefined,
  packages: ReadonlySet<string>,
  version: string,
): entry is { readonly name: string; readonly version: string; readonly source?: unknown } =>
  typeof entry?.name === "string" && packages.has(entry.name) && entry.version === version;

const parseLocalCargoVersions = (
  content: string,
  packages: ReadonlySet<string>,
  expectedVersion: string,
): ReadonlyMap<string, string> => {
  const value = parseToml(content) as {
    readonly package?: readonly {
      readonly name?: unknown;
      readonly source?: unknown;
      readonly version?: unknown;
    }[];
  };
  const versions = new Map<string, string>();
  for (const entry of value.package ?? []) {
    if (!isReleasePackage(entry, packages, expectedVersion)) continue;
    if (versions.has(entry.name))
      throw new Error(`Cargo.lock has duplicate local package ${entry.name}.`);
    if (entry.source !== undefined) {
      throw new Error(`Cargo.lock package ${entry.name} unexpectedly has a registry source.`);
    }
    if (typeof entry.version !== "string") {
      throw new Error(`Cargo.lock package ${entry.name} does not contain a version.`);
    }
    versions.set(
      entry.name,
      normalizeStableVersion(entry.version, `Cargo.lock ${entry.name} version`),
    );
  }
  const missing = [...packages].filter((name) => !versions.has(name));
  if (missing.length > 0)
    throw new Error(`Cargo.lock is missing local packages: ${missing.join(", ")}.`);
  return versions;
};

export function readReleaseSourceFiles(cwd: string): ReleaseSourceFiles {
  const root = realpathSync(cwd);
  const read = (path: string): string => {
    const canonical = realpathSync(join(root, path));
    const local = relative(root, canonical);
    if (
      local === ".." ||
      local.startsWith("../") ||
      isAbsolute(local) ||
      !statSync(canonical).isFile()
    ) {
      throw new Error(`Release source ${path} must resolve to a regular file within the worktree.`);
    }
    return readFileSync(canonical, "utf8");
  };
  const cargoToml = read("Cargo.toml");
  return {
    cargoPackages: readWorkspacePackages(cargoToml, read),
    packageJson: read("package.json"),
    cargoToml,
    cargoLock: read("Cargo.lock"),
    changelog: read("CHANGELOG.md"),
  };
}

const snapshotFromFiles = (files: ReleaseSourceFiles): ReleaseSourceSnapshot => {
  const packageVersion = parsePackageVersion(files.packageJson);
  const cargoVersion = parseCargoVersion(files.cargoToml);
  const localVersions = parseLocalCargoVersions(files.cargoLock, files.cargoPackages, cargoVersion);
  if (packageVersion !== cargoVersion) {
    throw new Error(
      `Release version mismatch: package.json=${packageVersion}, Cargo.toml=${cargoVersion}.`,
    );
  }
  for (const [name, version] of localVersions) {
    if (version !== packageVersion) {
      throw new Error(
        `Release version mismatch: package.json=${packageVersion}, Cargo.lock ${name}=${version}.`,
      );
    }
  }
  return { cargoVersion, changelog: files.changelog, files, packageVersion };
};

export function inspectReleaseSource(cwd: string): ReleaseSourceSnapshot {
  return snapshotFromFiles(readReleaseSourceFiles(cwd));
}

const filesAtRef = (cwd: string, ref: string): ReleaseSourceFiles => {
  run(cwd, "git", ["rev-parse", "--verify", `${ref}^{commit}`]);
  const readAtRef = (path: string): string =>
    execFileSync("git", ["show", `${ref}:${path}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const cargoToml = readAtRef("Cargo.toml");
  return {
    cargoPackages: readWorkspacePackages(cargoToml, readAtRef),
    packageJson: readAtRef("package.json"),
    cargoToml,
    cargoLock: readAtRef("Cargo.lock"),
    changelog: readAtRef("CHANGELOG.md"),
  };
};

export function inspectReleaseSourceAtRef(cwd: string, ref: string): ReleaseSourceSnapshot {
  return snapshotFromFiles(filesAtRef(cwd, ref));
}

const updatePackageVersion = (content: string, version: string): string => {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (typeof value.version !== "string")
    throw new Error("package.json does not contain a string version.");
  value.version = version;
  return `${JSON.stringify(value, null, 2)}\n`;
};

const updateCargoTomlVersion = (content: string, current: string, target: string): string => {
  const pattern = new RegExp(`^(version\\s*=\\s*)"${current.replaceAll(".", "\\.")}"\\s*$`, "m");
  const matches = content.match(new RegExp(pattern.source, "gm"));
  if (matches?.length !== 1) {
    throw new Error("Cargo.toml must contain exactly one workspace package version assignment.");
  }
  const updated = content.replace(pattern, `$1"${target}"`);
  if (parseCargoVersion(updated) !== target)
    throw new Error("Cargo.toml version update did not validate.");
  return updated;
};

const updateCargoLockVersions = (
  content: string,
  current: string,
  target: string,
  packages: ReadonlySet<string>,
): string => {
  const chunks = content.split(/(?=^\[\[package\]\]\s*$)/m);
  const updatedPackages = new Set<string>();
  const updated = chunks
    .map((chunk) => {
      if (!chunk.startsWith("[[package]]")) return chunk;
      const parsed = parseToml(chunk) as {
        readonly package?: readonly {
          readonly name?: unknown;
          readonly source?: unknown;
          readonly version?: unknown;
        }[];
      };
      const entry = parsed.package?.[0];
      if (!isReleasePackage(entry, packages, current)) return chunk;
      if (entry.source !== undefined || entry.version !== current) {
        throw new Error(`Cargo.lock local package ${entry.name} is not at ${current}.`);
      }
      const versionPattern = new RegExp(`^version = "${current.replaceAll(".", "\\.")}"$`, "m");
      if (!versionPattern.test(chunk))
        throw new Error(`Unable to update Cargo.lock package ${entry.name}.`);
      updatedPackages.add(entry.name);
      return chunk.replace(versionPattern, `version = "${target}"`);
    })
    .join("");
  const missing = [...packages].filter((name) => !updatedPackages.has(name));
  if (missing.length > 0)
    throw new Error(`Cargo.lock did not update local packages: ${missing.join(", ")}.`);
  return updated;
};

const ensureCleanWorktree = (cwd: string): void => {
  const status = run(cwd, "git", ["status", "--porcelain", "--untracked-files=all"]);
  if (status) throw new Error("Release preparation requires a clean git worktree.");
};

const writeFilesAtomically = (
  cwd: string,
  before: ReleaseSourceFiles,
  after: ReleaseSourceFiles,
): void => {
  const values: Array<[(typeof RELEASE_SOURCE_PATHS)[number], string]> = [
    ["package.json", after.packageJson],
    ["Cargo.toml", after.cargoToml],
    ["Cargo.lock", after.cargoLock],
    ["CHANGELOG.md", after.changelog],
  ];
  const temporaryPaths = values.map(([path, content]) => {
    const temporaryPath = join(cwd, `.${path.replaceAll("/", "-")}.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, content, "utf8");
    return [path, temporaryPath] as const;
  });
  try {
    for (const [path, temporaryPath] of temporaryPaths) renameSync(temporaryPath, join(cwd, path));
  } catch (error) {
    writeFileSync(join(cwd, "package.json"), before.packageJson, "utf8");
    writeFileSync(join(cwd, "Cargo.toml"), before.cargoToml, "utf8");
    writeFileSync(join(cwd, "Cargo.lock"), before.cargoLock, "utf8");
    writeFileSync(join(cwd, "CHANGELOG.md"), before.changelog, "utf8");
    throw error;
  } finally {
    for (const [, temporaryPath] of temporaryPaths) rmSync(temporaryPath, { force: true });
  }
};

export function prepareReleaseSource(options: {
  readonly cwd: string;
  readonly date: string;
  readonly validateCargoMetadata?: boolean;
  readonly version: string;
}): { readonly releaseNotes: string; readonly tag: string; readonly version: string } {
  const cwd = resolve(options.cwd);
  ensureCleanWorktree(cwd);
  const currentFiles = readReleaseSourceFiles(cwd);
  const current = snapshotFromFiles(currentFiles);
  const version = normalizeStableVersion(options.version);
  if (compareStableVersions(version, current.packageVersion) <= 0) {
    throw new Error(`Release version ${version} must be greater than ${current.packageVersion}.`);
  }
  const changelog = prepareChangelog(currentFiles.changelog, version, options.date);
  const nextFiles: ReleaseSourceFiles = {
    cargoPackages: currentFiles.cargoPackages,
    packageJson: updatePackageVersion(currentFiles.packageJson, version),
    cargoToml: updateCargoTomlVersion(currentFiles.cargoToml, current.cargoVersion, version),
    cargoLock: updateCargoLockVersions(
      currentFiles.cargoLock,
      current.cargoVersion,
      version,
      currentFiles.cargoPackages,
    ),
    changelog: changelog.changelogContent,
  };
  snapshotFromFiles(nextFiles);
  writeFilesAtomically(cwd, currentFiles, nextFiles);
  try {
    if (options.validateCargoMetadata !== false) {
      execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--no-deps"], {
        cwd,
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
  } catch (error) {
    writeFileSync(join(cwd, "package.json"), currentFiles.packageJson, "utf8");
    writeFileSync(join(cwd, "Cargo.toml"), currentFiles.cargoToml, "utf8");
    writeFileSync(join(cwd, "Cargo.lock"), currentFiles.cargoLock, "utf8");
    writeFileSync(join(cwd, "CHANGELOG.md"), currentFiles.changelog, "utf8");
    throw new Error("Cargo rejected the prepared release identity; restored the original files.", {
      cause: error,
    });
  }
  return { releaseNotes: changelog.releaseNotes, tag: tagForVersion(version), version };
}

export function evaluateReleaseTransition(options: {
  readonly base: ReleaseSourceSnapshot;
  readonly changedPaths: readonly string[];
  readonly head: ReleaseSourceSnapshot;
}): ReleaseTransitionResult {
  if (options.base.packageVersion === options.head.packageVersion) {
    return { shouldRelease: false, version: options.head.packageVersion };
  }
  if (compareStableVersions(options.head.packageVersion, options.base.packageVersion) <= 0) {
    throw new Error("Release versions must increase monotonically.");
  }
  const actual = [...new Set(options.changedPaths)].sort();
  const expected = [...RELEASE_SOURCE_PATHS].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `A release commit may change only ${expected.join(", ")}; got ${actual.join(", ") || "no files"}.`,
    );
  }
  const releaseNotes = extractReleaseNotes(options.head.changelog, options.head.packageVersion);
  return {
    baseVersion: options.base.packageVersion,
    changedPaths: actual,
    releaseNotes,
    shouldRelease: true,
    tag: tagForVersion(options.head.packageVersion),
    version: options.head.packageVersion,
  };
}

export function detectReleaseTransition(
  cwd: string,
  base: string,
  head: string,
): ReleaseTransitionResult {
  const baseFiles = filesAtRef(cwd, base);
  const headFiles = filesAtRef(cwd, head);
  const headSnapshot = snapshotFromFiles(headFiles);
  const basePackageVersion = parsePackageVersion(baseFiles.packageJson);
  if (basePackageVersion === headSnapshot.packageVersion) {
    return { shouldRelease: false, version: headSnapshot.packageVersion };
  }
  const changedPaths = run(cwd, "git", ["diff", "--name-only", base, head, "--"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  return evaluateReleaseTransition({
    base: snapshotFromFiles(baseFiles),
    changedPaths,
    head: headSnapshot,
  });
}

export function checkWorktreeReleaseTransition(cwd: string, base: string): ReleaseTransitionResult {
  const baseFiles = filesAtRef(cwd, base);
  const head = inspectReleaseSource(cwd);
  const basePackageVersion = parsePackageVersion(baseFiles.packageJson);
  if (basePackageVersion === head.packageVersion) {
    return { shouldRelease: false, version: head.packageVersion };
  }
  const trackedPaths = run(cwd, "git", ["diff", "--name-only", base, "--"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const untrackedPaths = run(cwd, "git", ["ls-files", "--others", "--exclude-standard"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  const changedPaths = [...trackedPaths, ...untrackedPaths];
  return evaluateReleaseTransition({ base: snapshotFromFiles(baseFiles), changedPaths, head });
}

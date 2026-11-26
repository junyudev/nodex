import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import {
  readUnreleasedChangesWithMedia,
  type UnreleasedChange,
} from "../../src/shared/change-media";
import {
  CHANGES_DIRECTORY,
  groupChangeEntries,
  formatChangelog,
  parseChangelog,
  type PublishedRelease,
  type RepositoryFile,
} from "../../src/shared/changelog";
import { readChangeFiles, readChangeFilesAtRef } from "./changelog";
import { compareStableVersions, nextPatchVersion, normalizeStableVersion } from "./model";

const RELEASE_METADATA_PATHS = [
  "package.json",
  "Cargo.toml",
  "Cargo.lock",
  "CHANGELOG.md",
] as const;

export const RELEASE_SOURCE_PATHS = [...RELEASE_METADATA_PATHS, CHANGES_DIRECTORY] as const;

interface ReleaseSourceFiles {
  readonly cargoPackages: ReadonlySet<string>;
  readonly cargoLock: string;
  readonly cargoToml: string;
  readonly changelog: string;
  readonly changes: readonly RepositoryFile[];
  readonly packageJson: string;
}

export interface ReleaseSourceSnapshot {
  readonly cargoVersion: string;
  readonly changelog: string;
  readonly files: ReleaseSourceFiles;
  readonly packageVersion: string;
}

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

const asTable = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

// Cargo implicitly enrolls in-tree path dependencies. Require them to be explicit
// so this static, revision-local inventory cannot silently omit a version owner.
const assertExplicitPathDependencies = (
  manifest: Record<string, unknown>,
  workspace: Record<string, unknown>,
  member: string,
  members: readonly unknown[],
): void => {
  const tables = [manifest, ...Object.values(asTable(manifest.target)).map(asTable)];
  const dependencies = tables.flatMap((table) =>
    ["dependencies", "dev-dependencies", "build-dependencies"].flatMap((kind) =>
      Object.entries(asTable(table[kind])),
    ),
  );
  for (const [name, value] of dependencies) {
    const dependency = asTable(value);
    const inherited = dependency.workspace === true;
    const path = (inherited ? asTable(asTable(workspace.dependencies)[name]) : dependency).path;
    if (typeof path !== "string") continue;
    const directory = posix.normalize(posix.join(inherited ? "." : member, path));
    if (posix.isAbsolute(path) || directory === ".." || directory.startsWith("../")) {
      throw new Error(`Release path dependency ${name} must be repository-relative.`);
    }
    if (!members.includes(directory)) {
      throw new Error(`Release path dependency ${directory} must be an explicit workspace member.`);
    }
  }
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
    assertExplicitPathDependencies(manifest, asTable(root.workspace), member, workspace.members);
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
  entry:
    | { readonly name?: unknown; readonly version?: unknown; readonly source?: unknown }
    | undefined,
  packages: ReadonlySet<string>,
  version: string,
): entry is { readonly name: string; readonly version: string; readonly source?: unknown } =>
  typeof entry?.name === "string" &&
  packages.has(entry.name) &&
  entry.version === version &&
  entry.source === undefined;

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
      local.startsWith(`..${sep}`) ||
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
    changes: readChangeFiles(root),
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
    changes: readChangeFilesAtRef(cwd, ref),
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

const metadataFiles = (files: ReleaseSourceFiles) =>
  ({
    "package.json": files.packageJson,
    "Cargo.toml": files.cargoToml,
    "Cargo.lock": files.cargoLock,
    "CHANGELOG.md": files.changelog,
  }) satisfies Record<(typeof RELEASE_METADATA_PATHS)[number], string>;

const writeFilesAtomically = (
  cwd: string,
  before: ReleaseSourceFiles,
  after: ReleaseSourceFiles,
): void => {
  const prior = metadataFiles(before);
  const next = metadataFiles(after);
  const updates = RELEASE_METADATA_PATHS.filter((path) => next[path] !== prior[path]);
  const remaining = new Set(after.changes.map(({ path }) => path));
  const deletions = before.changes.filter(({ path }) => !remaining.has(path));
  const temporaryDirectory = mkdtempSync(join(cwd, ".release-source-"));
  const backups: { path: string; backup: string }[] = [];
  let keepBackups = false;
  try {
    for (const [index, path] of updates.entries()) {
      const temporary = join(temporaryDirectory, `new-${index}`);
      writeFileSync(temporary, next[path], "utf8");
      chmodSync(temporary, statSync(join(cwd, path)).mode);
    }
    for (const [index, path] of [...updates, ...deletions.map(({ path }) => path)].entries()) {
      const original = join(cwd, path);
      const backup = join(temporaryDirectory, `original-${index}`);
      renameSync(original, backup);
      backups.push({ path: original, backup });
      if (index < updates.length) {
        renameSync(join(temporaryDirectory, `new-${index}`), original);
      }
    }
  } catch (error) {
    const failures: unknown[] = [];
    for (const { path, backup } of backups.reverse()) {
      try {
        renameSync(backup, path);
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length > 0) {
      keepBackups = true;
      throw new AggregateError(
        [error, ...failures],
        `Release source update could not be rolled back. Backups remain in ${temporaryDirectory}.`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (!keepBackups) rmSync(temporaryDirectory, { recursive: true, force: true });
  }
};

function versionFiles(current: ReleaseSourceSnapshot, version: string): ReleaseSourceFiles {
  const files = current.files;
  return {
    ...files,
    packageJson: updatePackageVersion(files.packageJson, version),
    cargoToml: updateCargoTomlVersion(files.cargoToml, current.cargoVersion, version),
    cargoLock: updateCargoLockVersions(
      files.cargoLock,
      current.cargoVersion,
      version,
      files.cargoPackages,
    ),
  };
}

export function validateReleaseSource(current: ReleaseSourceSnapshot): readonly UnreleasedChange[] {
  const version = current.packageVersion;
  if (parseChangelog(current.changelog).some((release) => release.version === version)) {
    throw new Error(`Source version ${version} already has a dated changelog section.`);
  }
  return readUnreleasedChangesWithMedia(current.files.changes);
}

export function setSourceVersion(cwd: string, target: string): void {
  const version = normalizeStableVersion(target);
  const current = inspectReleaseSource(cwd);
  validateReleaseSource(current);
  if (version === current.packageVersion) return;
  if (compareStableVersions(version, current.packageVersion) < 0) {
    throw new Error("Source version must increase.");
  }
  const next = versionFiles(current, version);
  validateReleaseSource(snapshotFromFiles(next));
  writeFilesAtomically(cwd, current.files, next);
}

function advancedFiles(
  current: ReleaseSourceSnapshot,
  release: PublishedRelease,
  sourceChanges: readonly RepositoryFile[],
): ReleaseSourceFiles | null {
  const published = parseChangelog(current.changelog);
  const existing = published.find(({ version }) => version === release.version);
  if (existing) {
    if (isDeepStrictEqual(existing, release)) return null;
    throw new Error(
      `CHANGELOG.md already lists ${release.version} with different release notes or date.`,
    );
  }
  const source = readUnreleasedChangesWithMedia(sourceChanges);
  if (!isDeepStrictEqual(release.sections, groupChangeEntries(source))) {
    throw new Error(`Release ${release.version} notes do not match its source change files.`);
  }
  const comparison = compareStableVersions(current.packageVersion, release.version);
  if (comparison < 0) throw new Error("Main source version is older than the published release.");
  const shipped = new Map(source.map(({ path, entry }) => [path, entry]));
  const publishedPaths = new Set(
    readUnreleasedChangesWithMedia(current.files.changes)
      .filter(({ path, entry }) => shipped.get(path) === entry)
      .map(({ path }) => path),
  );
  return {
    ...(comparison === 0
      ? versionFiles(current, nextPatchVersion(release.version))
      : current.files),
    changelog: formatChangelog([release, ...published]),
    changes: current.files.changes.filter(({ path }) => !publishedPaths.has(path)),
  };
}

export function advanceReleaseSource(
  cwd: string,
  release: PublishedRelease,
  sourceChanges: readonly RepositoryFile[],
): boolean {
  const current = inspectReleaseSource(cwd);
  const next = advancedFiles(current, release, sourceChanges);
  if (!next) return false;
  validateReleaseSource(snapshotFromFiles(next));
  writeFilesAtomically(cwd, current.files, next);
  return true;
}

const allowedAdvancePaths = (cwd: string, base: string, head: string): boolean => {
  // Raw diff includes mode changes. An advance only rewrites regular metadata files or deletes changes.
  const fields = run(cwd, "git", [
    "diff",
    "--raw",
    "--no-renames",
    "--ignore-submodules=none",
    "-z",
    base,
    head,
    "--",
  ]).split("\0");
  let changedChangelog = false;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1]!;
    const [oldMode, newMode, , , status] = fields[index]!.slice(1).split(" ");
    if (path === "CHANGELOG.md") changedChangelog = true;
    if (RELEASE_METADATA_PATHS.some((allowed) => allowed === path)) {
      if (status !== "M" || oldMode !== newMode || !/^100(?:644|755)$/.test(oldMode ?? "")) {
        return false;
      }
      continue;
    }
    if (status !== "D" || !path.startsWith(`${CHANGES_DIRECTORY}/`)) return false;
  }
  return changedChangelog;
};

/** Only the exact release notes and version roll-forward bypass push-triggered CI admission. */
export function isVersionAdvance(cwd: string, base: string, head: string): boolean {
  try {
    const parent = run(cwd, "git", ["show", "-s", "--format=%P", head]);
    if (parent !== run(cwd, "git", ["rev-parse", "--verify", `${base}^{commit}`])) return false;
    if (!allowedAdvancePaths(cwd, base, head)) return false;
    const source = run(cwd, "git", [
      "show",
      "-s",
      "--format=%(trailers:key=Nodex-Release-Source,valueonly,unfold)",
      head,
    ]);
    if (!/^[a-f0-9]{40}$/.test(source)) return false;
    run(cwd, "git", ["merge-base", "--is-ancestor", source, base]);

    const released = inspectReleaseSourceAtRef(cwd, source);
    const before = inspectReleaseSourceAtRef(cwd, base);
    const after = inspectReleaseSourceAtRef(cwd, head);
    validateReleaseSource(after);
    const [release] = parseChangelog(after.changelog);
    if (release?.version !== released.packageVersion) return false;
    const expected = advancedFiles(before, release, released.files.changes);
    return (
      expected !== null &&
      isDeepStrictEqual(metadataFiles(after.files), metadataFiles(expected)) &&
      isDeepStrictEqual(
        new Map(after.files.changes.map(({ path, content }) => [path, content])),
        new Map(expected.changes.map(({ path, content }) => [path, content])),
      )
    );
  } catch {
    return false;
  }
}

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  advanceChangelog,
  extractReleaseNotes,
  extractUnreleasedNotes,
  validateNextVersionChangelog,
} from "./changelog";
import { compareStableVersions, nextPatchVersion, normalizeStableVersion } from "./model";

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
  const prior = [before.packageJson, before.cargoToml, before.cargoLock, before.changelog];
  const temporaryPaths = values
    .filter(([, content], index) => content !== prior[index])
    .map(([path, content]) => {
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

export function setSourceVersion(cwd: string, target: string): void {
  const version = normalizeStableVersion(target);
  const current = inspectReleaseSource(cwd);
  validateNextVersionChangelog(current.changelog, version);
  if (version === current.packageVersion) return;
  if (compareStableVersions(version, current.packageVersion) < 0) {
    throw new Error("Source version must increase.");
  }
  const next = versionFiles(current, version);
  snapshotFromFiles(next);
  writeFilesAtomically(cwd, current.files, next);
}

function advancedFiles(
  current: ReleaseSourceSnapshot,
  version: string,
  notes: string,
  date: string,
): ReleaseSourceFiles | null {
  const comparison = compareStableVersions(current.packageVersion, version);
  if (comparison < 0) throw new Error("Main source version is older than the published release.");
  if (comparison > 0) {
    try {
      if (extractReleaseNotes(current.changelog, version) === notes) return null;
    } catch {
      // Main may have selected a higher next version during promotion.
    }
  }
  return {
    ...(comparison === 0 ? versionFiles(current, nextPatchVersion(version)) : current.files),
    changelog: advanceChangelog(current.changelog, notes, version, date),
  };
}

export function advanceReleaseSource(
  cwd: string,
  version: string,
  notes: string,
  date: string,
): boolean {
  const current = inspectReleaseSource(cwd);
  const next = advancedFiles(current, version, notes, date);
  if (!next) return false;
  snapshotFromFiles(next);
  validateNextVersionChangelog(next.changelog, parsePackageVersion(next.packageJson));
  writeFilesAtomically(cwd, current.files, next);
  return true;
}

/** Only the exact release notes and version roll-forward bypass push-triggered CI admission. */
export function isVersionAdvance(cwd: string, base: string, head: string): boolean {
  const paths = run(cwd, "git", ["diff", "--name-only", base, head, "--"]).split("\n");
  if (
    !paths.includes("CHANGELOG.md") ||
    paths.some((path) => !RELEASE_SOURCE_PATHS.some((allowed) => allowed === path))
  )
    return false;
  const message = run(cwd, "git", ["show", "-s", "--format=%B", head]);
  const source = /^Nodex-Release-Source: ([a-f0-9]{40})$/m.exec(message)?.[1];
  if (!source) return false;
  try {
    run(cwd, "git", ["merge-base", "--is-ancestor", source, base]);
  } catch {
    return false;
  }
  const released = inspectReleaseSourceAtRef(cwd, source);
  const before = inspectReleaseSourceAtRef(cwd, base);
  const after = inspectReleaseSourceAtRef(cwd, head).files;
  const date = after.changelog
    .split("\n")
    .find((line) => line.startsWith(`## [${released.packageVersion}] - `))
    ?.slice(-10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const expected = advancedFiles(
    before,
    released.packageVersion,
    extractUnreleasedNotes(released.changelog),
    date,
  );
  return (
    !!expected &&
    after.packageJson === expected.packageJson &&
    after.cargoToml === expected.cargoToml &&
    after.cargoLock === expected.cargoLock &&
    after.changelog === expected.changelog
  );
}

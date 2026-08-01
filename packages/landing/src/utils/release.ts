import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type RootPackage = {
  version?: unknown;
};

function findRepositoryRoot(startDirectory = process.cwd()): string {
  let directory = startDirectory;

  for (;;) {
    const workspaceFile = join(directory, "pnpm-workspace.yaml");
    const landingPackage = join(directory, "packages/landing/package.json");
    if (existsSync(workspaceFile) && existsSync(landingPackage)) return directory;

    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  throw new Error(`Unable to resolve the Nodex repository root from ${startDirectory}`);
}

const repositoryRoot = findRepositoryRoot();
const rootPackagePath = join(repositoryRoot, "package.json");
const rootChangelogPath = join(repositoryRoot, "CHANGELOG.md");

export function readReleaseVersion(): string {
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as RootPackage;
  const version = rootPackage.version;
  if (typeof version !== "string" || version.trim().length === 0) {
    throw new Error(`Expected a non-empty version in ${rootPackagePath}`);
  }

  return version.trim();
}

export function readRootChangelog(): string {
  return readFileSync(rootChangelogPath, "utf8");
}

const version = readReleaseVersion();

export const release = {
  version,
  versionLabel: `v${version}`,
} as const;

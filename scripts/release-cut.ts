import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareReleaseArtifacts } from "./release-changelog";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const packageJsonRelativePath = "package.json";
const changelogRelativePath = "CHANGELOG.md";

type ReleaseCutOptions = {
  cwd: string;
  target: string;
};

type CliOptions = ReleaseCutOptions;

function runCommand(cwd: string, command: string, args: string[], options?: { allowFailure?: boolean }): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (options?.allowFailure) {
      return "";
    }

    throw error;
  }
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function readPackageVersion(cwd: string): string {
  const packageJsonPath = join(cwd, packageJsonRelativePath);
  const rawPackageJson = readFileSync(packageJsonPath, "utf8");
  const parsedPackageJson = JSON.parse(rawPackageJson) as { version?: unknown };

  if (typeof parsedPackageJson.version !== "string" || parsedPackageJson.version.trim().length === 0) {
    throw new Error(`Unable to read a valid version from ${packageJsonPath}.`);
  }

  return parsedPackageJson.version.trim();
}

function ensureCleanWorktree(cwd: string): void {
  const statusOutput = runCommand(cwd, "git", ["status", "--porcelain", "--untracked-files=no"], {
    allowFailure: false,
  });

  if (statusOutput.length > 0) {
    throw new Error("Release cut requires a clean git worktree with no tracked changes.");
  }
}

function ensureTagDoesNotExist(cwd: string, tagName: string): void {
  const existingTag = runCommand(cwd, "git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
    allowFailure: true,
  });

  if (existingTag.length > 0) {
    throw new Error(`Git tag ${tagName} already exists.`);
  }
}

function updateChangelog(cwd: string, version: string): string {
  const changelogPath = join(cwd, changelogRelativePath);
  const currentChangelog = readFileSync(changelogPath, "utf8");
  const preparedArtifacts = prepareReleaseArtifacts({
    changelogContent: currentChangelog,
    version,
    date: getTodayDate(),
  });

  writeFileSync(changelogPath, preparedArtifacts.changelogContent, "utf8");
  return preparedArtifacts.commitMessage;
}

function commitRelease(cwd: string, commitMessage: string, version: string): void {
  const tempDir = mkdtempSync(join(tmpdir(), "nodex-release-cut-"));
  const commitMessagePath = join(tempDir, "commit-message.txt");
  const tagName = `v${version}`;

  try {
    writeFileSync(commitMessagePath, commitMessage, "utf8");
    runCommand(cwd, "git", ["add", packageJsonRelativePath, changelogRelativePath]);
    runCommand(cwd, "git", ["commit", "-F", commitMessagePath]);
    runCommand(cwd, "git", ["tag", "-a", tagName, "-F", commitMessagePath]);
  } finally {
    rmSync(tempDir, {
      recursive: true,
      force: true,
    });
  }
}

export function cutRelease(options: ReleaseCutOptions): { tagName: string; version: string } {
  const packageJsonPath = join(options.cwd, packageJsonRelativePath);
  const changelogPath = join(options.cwd, changelogRelativePath);
  const previousPackageJson = readFileSync(packageJsonPath, "utf8");
  const previousChangelog = readFileSync(changelogPath, "utf8");
  let commitCreated = false;

  ensureCleanWorktree(options.cwd);

  try {
    runCommand(options.cwd, "bun", ["pm", "version", options.target, "--no-git-tag-version"]);
    const version = readPackageVersion(options.cwd);
    const tagName = `v${version}`;
    ensureTagDoesNotExist(options.cwd, tagName);
    const commitMessage = updateChangelog(options.cwd, version);
    commitRelease(options.cwd, commitMessage, version);
    commitCreated = true;

    return { version, tagName };
  } catch (error) {
    if (!commitCreated) {
      writeFileSync(packageJsonPath, previousPackageJson, "utf8");
      writeFileSync(changelogPath, previousChangelog, "utf8");
    }

    throw error;
  }
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((value) => value !== "--");
  const target = args[0];

  if (!target) {
    throw new Error('Expected a version target such as "patch", "minor", "major", or "0.2.3".');
  }

  if (args.length > 1) {
    throw new Error(`Unexpected extra arguments: ${args.slice(1).join(" ")}`);
  }

  return {
    cwd: projectRoot,
    target,
  };
}

function main(): void {
  const options = parseCliOptions(process.argv.slice(2));
  const result = cutRelease(options);

  console.log(`Created release commit and tag ${result.tagName}.`);
}

if (import.meta.main) {
  main();
}

import { INBOX_TRIAGE_SCENARIO_ID, seedInboxTriageSkills } from "../scenarios/inbox-triage";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Neither inherited Git routing nor personal templates/config may attach a seed to another repo.
const gitEnvironment = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
});

const git = async (cwd: string, ...args: readonly string[]): Promise<string> =>
  (await execFileAsync("git", args, { cwd, env: gitEnvironment(), timeout: 30_000 })).stdout.trim();

const sourceSlug = (scenarioId: string): string => {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/u.test(scenarioId)) {
    throw new Error(`Invalid seed source identity: ${scenarioId}`);
  }
  return scenarioId.startsWith("landing/") ? "tinyboard" : scenarioId.replaceAll("/", "-");
};

const sourcePaths = async (home: string, scenarioId: string) => {
  if (!path.isAbsolute(home)) throw new Error("Seed home must be absolute");
  const root = await realpath(home);
  const workspace = path.join(root, "workspace");
  return { workspace, source: path.join(workspace, sourceSlug(scenarioId)) };
};

const assertDirectory = async (directory: string): Promise<void> => {
  if (!(await lstat(directory)).isDirectory()) {
    throw new Error(`Seed source must be an owned directory, not a symlink: ${directory}`);
  }
};

/** Rejects old or redirected seed workspaces without resetting any manual edits. */
export const assertSeededSourceFolder = async (
  home: string,
  scenarioId: string,
): Promise<string> => {
  try {
    const { workspace, source } = await sourcePaths(home, scenarioId);
    await assertDirectory(workspace);
    await assertDirectory(source);
    await assertDirectory(path.join(source, ".git"));
    const gitRoot = await git(source, "rev-parse", "--show-toplevel");
    const commonDirectory = await git(
      source,
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    );
    if (
      path.resolve(gitRoot) !== source ||
      path.resolve(commonDirectory) !== path.join(source, ".git")
    ) {
      throw new Error("Seed source shares another repository");
    }
    return source;
  } catch (cause) {
    throw new Error(
      `Seed ${scenarioId} has no isolated source repository in ${home}; create a fresh development home`,
      { cause },
    );
  }
};

/** Creates an independent repository inside the home; never copies a checkout or reuses a source. */
export const materializeSeededSourceFolder = async (
  home: string,
  scenarioId: string,
): Promise<string> => {
  const { workspace, source } = await sourcePaths(home, scenarioId);
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  await assertDirectory(workspace);
  // Exclusive creation prevents overwriting a previous take or following an existing symlink.
  await mkdir(source, { mode: 0o700 });
  try {
    if (scenarioId.startsWith("landing/")) {
      await cp(path.resolve("scripts/scenarios/fixtures/tinyboard"), source, {
        recursive: true,
      });
    } else {
      await writeFile(
        path.join(source, "README.md"),
        `# ${scenarioId}\n\nDevelopment workspace.\n`,
      );
    }
    if (scenarioId === INBOX_TRIAGE_SCENARIO_ID) await seedInboxTriageSkills(source);
    await git(source, "init", "--initial-branch=main", "--template=");
    await git(source, "config", "user.name", "Nodex Development");
    await git(source, "config", "user.email", "development@nodex.invalid");
    await git(source, "config", "commit.gpgSign", "false");
    await git(source, "add", "--all");
    await git(
      source,
      "commit",
      "-m",
      scenarioId.startsWith("landing/")
        ? "Build the Tinyboard task list"
        : "Create development workspace",
    );
    return await assertSeededSourceFolder(home, scenarioId);
  } catch (error) {
    await rm(source, { recursive: true, force: true });
    throw error;
  }
};

import { realpath, stat } from "node:fs/promises";
import { execFile } from "./child-stdio-errors";
import { basename, dirname, isAbsolute } from "node:path";

/**
 * The folder may sit behind a macOS privacy prompt or on a stalled mount. A killable child with a
 * short deadline keeps one such folder from holding up everything else.
 */
const PROBE_TIMEOUT_MS = 2_000;

const git = (args: readonly string[], cwd: string): Promise<string | null> =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      { cwd, encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    );
  });

export interface GitRepositoryIdentity {
  /** The main working tree, also for a folder inside one of its linked worktrees. */
  readonly root: string;
  readonly commonDirectory?: string;
  readonly remoteUrl: string | null;
}

export async function probeGitRepository(cwd: string): Promise<GitRepositoryIdentity | null> {
  const output = await git(
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    cwd,
  );
  if (!output) return null;
  const [topLevel, commonDirectory] = output.split("\n");
  if (!topLevel) return null;
  const main =
    commonDirectory && basename(commonDirectory) === ".git"
      ? dirname(commonDirectory)
      : (await git(["worktree", "list", "--porcelain", "-z"], cwd))
          ?.split("\0")[0]
          ?.slice("worktree ".length);
  return {
    root: main || topLevel,
    commonDirectory,
    remoteUrl: (await git(["config", "--get", "remote.origin.url"], cwd)) || null,
  };
}

export interface WorkspaceFolderIdentity {
  readonly path: string;
  readonly alias?: string;
  readonly repository: GitRepositoryIdentity | null;
}

/** Resolves aliases and verifies the working directory before reading its Git identity. */
export async function probeWorkspaceFolder(path: string): Promise<WorkspaceFolderIdentity | null> {
  if (!isAbsolute(path)) return null;
  const directory = await realpath(path).catch(() => null);
  if (!directory || !(await stat(directory).catch(() => null))?.isDirectory()) return null;
  const located = { path: directory, ...(directory === path ? {} : { alias: path }) };
  const probed = await probeGitRepository(directory);
  if (!probed) return { ...located, repository: null };
  const root = await realpath(probed.root).catch(() => directory);
  const commonDirectory = probed.commonDirectory
    ? await realpath(probed.commonDirectory).catch(() => probed.commonDirectory)
    : undefined;
  return { ...located, repository: { ...probed, root, commonDirectory } };
}

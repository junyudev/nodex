import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";

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
  const root =
    commonDirectory && basename(commonDirectory) === ".git" ? dirname(commonDirectory) : topLevel;
  return { root, remoteUrl: (await git(["config", "--get", "remote.origin.url"], cwd)) || null };
}

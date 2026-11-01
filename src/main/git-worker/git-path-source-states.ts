import { realpath } from "node:fs/promises";
import path from "node:path";
import type { WorkspacePathState } from "../../shared/types";
import type { GitCommandRunner } from "./git-command-runner";

type PathSourceState = Pick<WorkspacePathState, "path" | "isGitSourcePath">;

/** One repository probe and one NUL-delimited ignore check, independent of path count. */
export async function readGitPathSourceStates(
  runner: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
  signal: AbortSignal,
): Promise<PathSourceState[]> {
  if (paths.length === 0) return [];
  const identity = { hostId: "local", root: cwd, commonDir: cwd } as const;
  const probe = await runner.run(identity, ["rev-parse", "--show-toplevel"], {
    allowedNonZeroExitCodes: [128],
    signal,
  });
  if (!probe.success || probe.code !== 0) {
    const noRepository = probe.code === 128 && /not a git repository/iu.test(probe.stderr);
    return paths.map((filePath) => ({
      path: filePath,
      isGitSourcePath: noRepository ? false : null,
    }));
  }
  const root = await realpath(path.resolve(cwd, probe.stdout.trim()));
  const relativePaths = await Promise.all(
    paths.map(async (filePath) => {
      // Resolve directory aliases without dereferencing a tracked symlink file itself.
      const parent = await realpath(path.dirname(filePath)).catch(() => path.dirname(filePath));
      const relative = path.relative(root, path.join(parent, path.basename(filePath)));
      return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
        ? null
        : relative;
    }),
  );
  const inside = relativePaths.filter((filePath): filePath is string => filePath !== null);
  if (inside.length === 0)
    return paths.map((filePath) => ({ path: filePath, isGitSourcePath: false }));
  // Default check-ignore consults the index, so tracked files remain source paths
  // even when a matching ignore rule was added after they became tracked.
  const result = await runner.run({ ...identity, root }, ["check-ignore", "-z", "--stdin"], {
    allowedNonZeroExitCodes: [1],
    stdin: `${inside.join("\0")}\0`,
    signal,
  });
  const ignored = new Set(result.stdout.split("\0"));
  return paths.map((filePath, index) => {
    const relative = relativePaths[index];
    return {
      path: filePath,
      isGitSourcePath: relative == null ? false : result.success ? !ignored.has(relative) : null,
    };
  });
}

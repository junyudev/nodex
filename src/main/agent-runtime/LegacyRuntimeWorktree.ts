import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { CodexGitProbe } from "../codex-application/CodexGitProbe";
import {
  linkedGitWorktreeRoot,
  LINKED_GIT_WORKTREE_PROBE,
} from "../codex/codex-linked-git-worktree";
import { isExecutionWorkspacePathWithinRoot } from "../codex/codex-execution-workspace-roots";
import {
  isManagedWorktreeAllocationPath,
  legacyManagedWorktreeRoot,
} from "../codex/codex-managed-worktree-allocation";

/** Only a missing directory can be inferred from layout alone. Existing Git state requires a probe. */
export const makeLegacyRuntimeWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const git = yield* CodexGitProbe;
  const canonical = (directory: string) =>
    fs.realPath(directory).pipe(Effect.orElseSucceed(() => path.resolve(directory)));

  return Effect.fn("LegacyRuntimeWorktree.resolve")(function* (
    cwd: string,
    sourceRoots: readonly string[],
    currentManagedRoot: Effect.Effect<string | null>,
  ) {
    const status = yield* fs.stat(cwd).pipe(
      Effect.map((stat) =>
        stat.type === "Directory" ? ("directory" as const) : ("other" as const),
      ),
      Effect.catch((error) => {
        const cause = "cause" in error.reason ? error.reason.cause : undefined;
        return Effect.succeed(
          error.reason._tag === "NotFound" ||
            (cause instanceof Error && "code" in cause && cause.code === "ENOTDIR")
            ? ("missing" as const)
            : ("other" as const),
        );
      }),
    );
    if (status === "missing") return legacyManagedWorktreeRoot(cwd, sourceRoots);
    if (status !== "directory") return null;

    const root = linkedGitWorktreeRoot(yield* git.readPath(cwd, LINKED_GIT_WORKTREE_PROBE));
    if (!root) return null;

    const exactRoot = yield* canonical(root);
    const sources = yield* Effect.forEach(sourceRoots, canonical, { concurrency: 4 });
    if (sources.some((source) => path.relative(source, exactRoot) === "")) return null;
    if (isManagedWorktreeAllocationPath(exactRoot)) return root;
    const managedRoot = yield* currentManagedRoot;
    if (!managedRoot) return null;
    const exactManagedRoot = yield* canonical(managedRoot);
    return path.relative(exactManagedRoot, exactRoot) !== "" &&
      isExecutionWorkspacePathWithinRoot(exactRoot, exactManagedRoot)
      ? root
      : null;
  });
});

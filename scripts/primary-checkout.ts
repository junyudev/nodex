import { execFileSync } from "node:child_process";
import path from "node:path";

/** Keep task artifacts and shared caches in the primary checkout for linked worktrees. */
export function resolvePrimaryCheckoutRoot(projectRoot: string): string {
  let checkoutRoot = path.resolve(projectRoot);
  try {
    // Git lists the primary checkout first; NUL records preserve spaces/newlines in paths.
    const firstRecord = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).split("\0")[0];
    if (firstRecord?.startsWith("worktree ")) checkoutRoot = firstRecord.slice(9);
  } catch {
    // Source archives and disposable non-Git test roots keep a local cache.
  }
  return checkoutRoot;
}

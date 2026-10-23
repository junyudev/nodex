import { getGitWorkerClient } from "@/lib/api";

/** Changes the selected Project checkout; the caller fences presentation by CWD. */
export async function changeComposerBranch(input: {
  cwd: string;
  branch: string;
  create: boolean;
}) {
  const result = await getGitWorkerClient().request({
    method: input.create ? "create-branch" : "checkout-branch",
    params: { cwd: input.cwd, branch: input.branch },
  });
  if (result.type === "error") throw new Error(result.errorMessage);
  return result.value;
}

export async function loadComposerWorkingTreeChanges(cwd: string): Promise<boolean> {
  const result = await getGitWorkerClient().request({
    method: "status-summary",
    params: { cwd, includeUntrackedFiles: true },
  });
  return (
    result.type === "success" &&
    result.stagedCount + result.unstagedCount + (result.untrackedCount ?? 0) > 0
  );
}

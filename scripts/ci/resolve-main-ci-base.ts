import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

import { MAIN_CI_BASE_COMMAND, MAIN_CI_WORKFLOW_PATH, resolveMainCiBase } from "./main-ci-base.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const workflowFilename = MAIN_CI_WORKFLOW_PATH.split("/").at(-1);

function readSuccessfulRuns(repo: string): unknown {
  try {
    const response = execFileSync(
      "gh",
      [
        "api",
        "--method",
        "GET",
        `repos/${repo}/actions/workflows/${workflowFilename}/runs`,
        "-f",
        "branch=main",
        "-f",
        "status=success",
        "-F",
        "per_page=100",
        "--jq",
        "[.workflow_runs[] | {id, head_sha, head_branch, conclusion, event}]",
      ],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 },
    );
    return JSON.parse(response);
  } catch {
    return null;
  }
}

function usesLastGreenRule(sha: string): boolean {
  const workflow = spawnSync("git", ["show", `${sha}:${MAIN_CI_WORKFLOW_PATH}`], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // A force-pushed SHA may be absent locally. Older workflow revisions have no resolver step.
  return (
    workflow.status === 0 &&
    workflow.stdout.split("\n").some((line) => line.trim() === `run: ${MAIN_CI_BASE_COMMAND}`)
  );
}

function isAncestor(ancestor: string, descendant: string): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("Git could not verify Main CI commit ancestry.");
}

function main(): void {
  const { GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_SHA, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } =
    process.env;
  if (!GITHUB_REPOSITORY || !GITHUB_SHA || !/^[a-f0-9]{40}$/u.test(GITHUB_SHA)) {
    throw new Error("GITHUB_REPOSITORY and a full commit SHA in GITHUB_SHA are required.");
  }

  const decision =
    process.env.FORCE_FULL === "true"
      ? { baseSha: null, reason: "Full coverage requested by workflow dispatch" }
      : resolveMainCiBase({
          headSha: GITHUB_SHA,
          currentRunId: GITHUB_RUN_ID,
          runs: readSuccessfulRuns(GITHUB_REPOSITORY),
          usesLastGreenRule,
          isAncestor,
        });
  const summary = decision.baseSha
    ? `Main CI comparison base: \`${decision.baseSha}\`. ${decision.reason}.\n`
    : `Main CI runs every gate. ${decision.reason}.\n`;
  if (GITHUB_OUTPUT) appendFileSync(GITHUB_OUTPUT, `base_sha=${decision.baseSha ?? ""}\n`);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
}

main();

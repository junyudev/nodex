import { execFileSync } from "node:child_process";

export interface NightlySourceCiDecision {
  readonly decision: "eligible" | "missing" | "pending" | "failed";
  readonly sourceSha: string;
  readonly runUrl: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Only the latest protected-main push run for this exact source can admit a nightly. */
export function evaluateNightlySourceCi(
  sourceSha: string,
  response: unknown,
): NightlySourceCiDecision {
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) {
    throw new Error("Nightly source CI requires a full lowercase commit SHA.");
  }
  if (!isRecord(response) || !Array.isArray(response.workflow_runs)) {
    throw new Error("GitHub returned an invalid Main CI workflow-run response.");
  }
  const run: unknown = response.workflow_runs[0];
  if (run === undefined) return { decision: "missing", sourceSha, runUrl: null };
  if (
    !isRecord(run) ||
    run.head_sha !== sourceSha ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    typeof run.status !== "string" ||
    typeof run.html_url !== "string" ||
    (run.conclusion !== null && typeof run.conclusion !== "string")
  ) {
    throw new Error("GitHub returned Main CI outside the exact protected-main push source.");
  }
  const runUrl = run.html_url;
  if (run.status !== "completed") return { decision: "pending", sourceSha, runUrl };
  if (run.conclusion !== "success") return { decision: "failed", sourceSha, runUrl };
  return { decision: "eligible", sourceSha, runUrl };
}

export function inspectNightlySourceCi(repo: string, sourceSha: string): NightlySourceCiDecision {
  // Validate before sending this source coordinate across the GitHub boundary.
  evaluateNightlySourceCi(sourceSha, { workflow_runs: [] });
  const response = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/workflows/ci-main.yml/runs`,
      "-f",
      `head_sha=${sourceSha}`,
      "-f",
      "branch=main",
      "-f",
      "event=push",
      "-F",
      "per_page=1",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  return evaluateNightlySourceCi(sourceSha, JSON.parse(response));
}

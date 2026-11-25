import { execFileSync, spawnSync } from "node:child_process";

interface MainCiEvidence {
  readonly sourceSha: string;
  readonly runUrl: string;
}

interface VerifiedNightlySource extends MainCiEvidence {
  readonly commitsBehindHead: number;
}

export interface NightlySourceCi {
  readonly headSha: string;
  readonly verified: VerifiedNightlySource | null;
  readonly newerFailure: MainCiEvidence | null;
}

const fullSha = /^[a-f0-9]{40}$/u;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validateHead(headSha: string): void {
  if (!fullSha.test(headSha)) {
    throw new Error("Nightly source CI requires a full lowercase main HEAD SHA.");
  }
}

function parseMainCiRun(run: unknown) {
  if (
    !isRecord(run) ||
    typeof run.run_number !== "number" ||
    !Number.isSafeInteger(run.run_number) ||
    run.run_number < 1 ||
    typeof run.head_sha !== "string" ||
    !fullSha.test(run.head_sha) ||
    run.head_branch !== "main" ||
    run.event !== "push" ||
    typeof run.status !== "string" ||
    typeof run.html_url !== "string" ||
    (run.conclusion !== null && typeof run.conclusion !== "string")
  ) {
    throw new Error("GitHub returned invalid protected-main Main CI push evidence.");
  }
  return {
    runNumber: run.run_number,
    sourceSha: run.head_sha,
    runUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
  };
}

export function evaluateNightlySourceCi(
  headSha: string,
  runs: readonly unknown[],
  commitsBehindHead: (sha: string) => number | null,
): NightlySourceCi {
  validateHead(headSha);
  const newestFirst = runs.map(parseMainCiRun).sort((a, b) => b.runNumber - a.runNumber);
  let newerFailure: MainCiEvidence | null = null;
  for (const { sourceSha, runUrl, status, conclusion } of newestFirst) {
    if (status !== "completed") continue;
    if (conclusion !== "success" && (conclusion !== "failure" || newerFailure)) continue;
    const behind = commitsBehindHead(sourceSha);
    if (behind === null) continue;
    if (conclusion === "success") {
      return { headSha, verified: { sourceSha, runUrl, commitsBehindHead: behind }, newerFailure };
    }
    newerFailure = { sourceSha, runUrl };
  }
  return { headSha, verified: null, newerFailure };
}

function readMainCiRuns(repo: string, conclusion: "success" | "failure"): unknown[] {
  // Cancelled and pending pushes must not crowd green runs out of GitHub's filtered history.
  const response = execFileSync(
    "gh",
    [
      "api",
      "--method",
      "GET",
      `repos/${repo}/actions/workflows/ci-main.yml/runs`,
      "-f",
      "branch=main",
      "-f",
      "event=push",
      "-f",
      `status=${conclusion}`,
      "-F",
      "per_page=100",
      "--paginate",
      "--jq",
      ".workflow_runs | map({run_number, head_sha, head_branch, event, status, conclusion, html_url})",
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 },
  );
  return response
    .trim()
    .split("\n")
    .flatMap((line): unknown[] => {
      const page: unknown = JSON.parse(line);
      if (!Array.isArray(page)) throw new Error("GitHub returned an invalid Main CI run page.");
      return page;
    });
}

function distanceFromMain(cwd: string, headSha: string, sourceSha: string): number | null {
  const options = { cwd, stdio: "ignore" } as const;
  // A rewritten branch's former head may be absent from a fresh checkout.
  const object = spawnSync(
    "git",
    ["rev-parse", "--verify", "--quiet", `${sourceSha}^{commit}`],
    options,
  );
  if (object.status === 1) return null;
  if (object.status !== 0) throw new Error("Git could not read the Main CI source commit.");
  const mergeBase = spawnSync("git", ["merge-base", "--is-ancestor", sourceSha, headSha], options);
  if (mergeBase.status === 1) return null;
  if (mergeBase.status !== 0) throw new Error("Git could not verify Main CI commit ancestry.");
  return Number(
    execFileSync("git", ["rev-list", "--count", `${sourceSha}..${headSha}`], {
      cwd,
      encoding: "utf8",
    }).trim(),
  );
}

export function inspectNightlySourceCi(options: {
  readonly cwd: string;
  readonly repo: string;
  readonly headSha: string;
}): NightlySourceCi {
  const { cwd, repo, headSha } = options;
  validateHead(headSha);
  return evaluateNightlySourceCi(
    headSha,
    [...readMainCiRuns(repo, "success"), ...readMainCiRuns(repo, "failure")],
    (sourceSha) => distanceFromMain(cwd, headSha, sourceSha),
  );
}

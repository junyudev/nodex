import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

import { parseNeeds, requiredGateNames, type GitHubJobResult } from "./verify-required-gates.ts";

interface VerdictRange {
  readonly basis: "last-green" | "push-before" | "head-only";
  readonly baseSha: string | null;
  readonly headSha: string;
}

interface FailingGate {
  readonly id: string;
  readonly result: GitHubJobResult | "missing" | "invalid-plan";
}

interface FailedJob {
  readonly name: string;
  readonly result: string;
  readonly url: string;
  readonly failedSteps: readonly string[];
  readonly failedTests: readonly string[] | null;
}

const fullSha = (value: string | undefined): value is string =>
  value !== undefined && /^[a-f0-9]{40}$/u.test(value) && !/^0+$/u.test(value);

export function resolveVerdictRange(
  headSha: string,
  lastGreen: string | undefined,
  pushBefore: string | undefined,
  isAncestor: (baseSha: string, headSha: string) => boolean,
): VerdictRange {
  if (fullSha(lastGreen)) return { basis: "last-green", baseSha: lastGreen, headSha };
  if (fullSha(pushBefore) && isAncestor(pushBefore, headSha)) {
    return { basis: "push-before", baseSha: pushBefore, headSha };
  }
  return { basis: "head-only", baseSha: null, headSha };
}

function readCommits(range: VerdictRange): readonly { sha: string; subject: string }[] {
  const revision = range.baseSha ? `${range.baseSha}..${range.headSha}` : range.headSha;
  const fields = execFileSync(
    "git",
    [
      "log",
      "--reverse",
      "--topo-order",
      "--format=%H%x00%s",
      "-z",
      ...(range.baseSha ? [] : ["-1"]),
      revision,
    ],
    { encoding: "utf8" },
  ).split("\0");
  const commits = [];
  for (let index = 0; index < fields.length - 1; index += 2) {
    const sha = fields[index];
    const subject = fields[index + 1];
    if (!fullSha(sha) || subject === undefined) throw new Error("Invalid Git commit record.");
    commits.push({ sha, subject });
  }
  return commits;
}

export function failingMainCiGates(
  needs: ReturnType<typeof parseNeeds>,
  planJson: string | undefined,
): readonly FailingGate[] {
  const classify = needs.classify?.result ?? "missing";
  if (classify !== "success") return [{ id: "classify", result: classify }];
  try {
    const selected = requiredGateNames([], JSON.parse(planJson ?? ""));
    return selected.flatMap((id) => {
      const result = needs[id]?.result ?? "missing";
      return result === "success" ? [] : [{ id, result }];
    });
  } catch {
    return [{ id: "classify", result: "invalid-plan" }];
  }
}

/** Vitest, cargo test/Rustdoc, and nextest print different failure records. */
export function failedTestNames(log: string): readonly string[] {
  const names = new Set<string>();
  for (const rawLine of stripVTControlCharacters(log).split("\n")) {
    const line = rawLine.replace(/^\d{4}-\d\d-\d\dT\S+\s+/u, "").trim();
    const match =
      /^FAIL\s+(\S+\.[cm]?[jt]sx?\s+>\s+.+)$/u.exec(line) ??
      /^test (.+) \.\.\. FAILED$/u.exec(line) ??
      /^(?:FAIL|TIMEOUT|ABORT|SEGFAULT|EXECFAIL)\s+\[[^\]]+\]\s+(\S+\s+.+)$/u.exec(line);
    if (match?.[1]) names.add(match[1]);
  }
  return [...names].sort();
}

type GitHubRequest = (endpoint: string) => Promise<Response>;

interface GitHubJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly steps: readonly { readonly name: string; readonly conclusion: string | null }[];
}

async function readFailedJobs(
  request: GitHubRequest,
  runId: string,
  attempt: string,
): Promise<readonly FailedJob[]> {
  const jobs: GitHubJob[] = [];
  for (let page = 1; ; page += 1) {
    const response = await request(
      `actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    const payload = (await response.json()) as { jobs: GitHubJob[] };
    jobs.push(...payload.jobs);
    if (payload.jobs.length < 100) break;
  }
  const failed = jobs.filter(
    (job) =>
      job.status === "completed" &&
      job.conclusion !== null &&
      job.conclusion !== "success" &&
      job.conclusion !== "skipped",
  );
  return Promise.all(
    failed
      .sort((left, right) => left.name.localeCompare(right.name) || left.id - right.id)
      .map(async (job) => ({
        name: job.name,
        result: job.conclusion ?? "missing",
        url: job.html_url,
        failedSteps: job.steps
          .filter((step) => step.conclusion === "failure" || step.conclusion === "cancelled")
          .map((step) => step.name),
        failedTests: await fetchFailedTests(request, job.id),
      })),
  );
}

async function fetchFailedTests(
  request: GitHubRequest,
  jobId: number,
): Promise<readonly string[] | null> {
  try {
    const log = await request(`actions/jobs/${jobId}/logs`);
    return failedTestNames(await log.text());
  } catch {
    process.stderr.write(`Test details unavailable for GitHub job ${jobId}.\n`);
    return null;
  }
}

async function main(): Promise<void> {
  const {
    CI_BASE_SHA,
    CI_GATE_OUTCOME,
    CI_GATE_PLAN_JSON,
    CI_NEEDS_JSON,
    CI_PUSH_BEFORE_SHA,
    GH_TOKEN,
    GITHUB_API_URL,
    GITHUB_REPOSITORY,
    GITHUB_RUN_ATTEMPT,
    GITHUB_RUN_ID,
    GITHUB_SHA,
    GITHUB_STEP_SUMMARY,
    RUNNER_TEMP,
  } = process.env;
  if (
    !fullSha(GITHUB_SHA) ||
    !RUNNER_TEMP ||
    !CI_NEEDS_JSON ||
    !GITHUB_RUN_ID ||
    !GITHUB_RUN_ATTEMPT
  ) {
    throw new Error(
      "Main CI verdict requires the tested SHA, run, attempt, runner, and gate results.",
    );
  }
  const range = resolveVerdictRange(
    GITHUB_SHA,
    CI_BASE_SHA,
    CI_PUSH_BEFORE_SHA,
    (base, head) =>
      spawnSync("git", ["merge-base", "--is-ancestor", base, head], { stdio: "ignore" }).status ===
      0,
  );
  const status = CI_GATE_OUTCOME === "success" ? "success" : "failure";
  const failingGates = failingMainCiGates(parseNeeds(CI_NEEDS_JSON), CI_GATE_PLAN_JSON);
  const request: GitHubRequest = async (endpoint) => {
    const response = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${endpoint}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${GH_TOKEN}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`GitHub job evidence request returned ${response.status}.`);
    return response;
  };
  const failingJobs =
    status === "success"
      ? []
      : await readFailedJobs(request, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT).catch((error: unknown) => {
          process.stderr.write(`GitHub job details unavailable. ${String(error)}\n`);
          return null;
        });
  const verdict = {
    schemaVersion: 1,
    runId: GITHUB_RUN_ID,
    runAttempt: Number(GITHUB_RUN_ATTEMPT),
    status,
    range,
    commits: readCommits(range),
    failingGates,
    failingJobs,
  };
  const json = `${JSON.stringify(verdict, null, 2)}\n`;
  writeFileSync(path.join(RUNNER_TEMP, "main-ci-verdict.json"), json);
  if (GITHUB_STEP_SUMMARY) {
    appendFileSync(GITHUB_STEP_SUMMARY, `## Main CI verdict\n\n\`\`\`json\n${json}\`\`\`\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

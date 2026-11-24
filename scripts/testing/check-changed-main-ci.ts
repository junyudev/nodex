import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { MAIN_CI_WORKFLOW_PATH } from "../ci/main-ci-base.ts";

const exec = promisify(execFile);
const workflow = posix.basename(MAIN_CI_WORKFLOW_PATH);
const githubUrl = z.url({ protocol: /^https$/u, hostname: /^github\.com$/u });
const runs = z.object({ workflow_runs: z.array(z.unknown()) });
const failedRun = z.object({
  head_branch: z.literal("main"),
  status: z.literal("completed"),
  conclusion: z.enum(["failure", "timed_out"]),
  head_sha: z.string().regex(/^[a-f0-9]{40}$/u),
  html_url: githubUrl,
  id: z.int().positive(),
  run_attempt: z.int().positive(),
});
const job = z.object({ name: z.string(), conclusion: z.string().nullable() });
const jobPages = z.array(z.object({ jobs: z.array(job) }));
const issues = z.array(z.object({ number: z.int().positive(), url: githubUrl }));

export function githubOriginRepository(remote: string): string | undefined {
  const url = remote
    .trim()
    .replace(/\/$/u, "")
    .replace(/\.git$/iu, "");
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([\w-]+\/[\w.-]+)$/iu.exec(
    url,
  )?.[1];
}

const verdict = z.object({ conclusion: z.enum(["success", "failure", "timed_out"]) });

export function latestFailedMainCiRun(response: unknown): z.infer<typeof failedRun> | undefined {
  // The API returns completed runs newest first. Cancelled or skipped runs say nothing about
  // whether main is green, so the newest run with a verdict decides.
  const latest = runs
    .safeParse(response)
    .data?.workflow_runs.find((run) => verdict.safeParse(run).success);
  return failedRun.safeParse(latest).data;
}

export function formatMainCiNotice(
  run: z.infer<typeof failedRun>,
  jobs: readonly z.infer<typeof job>[],
  issue?: z.infer<typeof issues>[number],
): string {
  const failedJobs = jobs
    .filter(({ conclusion }) => conclusion === "failure" || conclusion === "timed_out")
    .map(({ name }) => name.replace(/\p{Cc}/gu, " ").trim())
    .filter(Boolean);
  return [
    `Main CI failed on ${run.head_sha.slice(0, 7)} (${run.html_url}).`,
    failedJobs.length ? `Failing jobs — ${failedJobs.join(", ")}` : undefined,
    "Local failures that match this run predate the current change.",
    issue ? `Tracking issue #${issue.number} — ${issue.url}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function readMainCiNotice(
  root: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
  const options = { cwd: root, signal: lookupSignal, killSignal: "SIGKILL" } as const;
  const gh = async (...args: readonly string[]): Promise<unknown> => {
    const { stdout } = await exec("gh", args, {
      ...options,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    return JSON.parse(stdout);
  };
  try {
    const { stdout } = await exec("git", ["remote", "get-url", "origin"], options);
    const repo = githubOriginRepository(stdout);
    if (!repo) return undefined;
    const api = (endpoint: string, ...args: readonly string[]) =>
      gh("api", "--hostname", "github.com", `repos/${repo}/${endpoint}`, ...args);
    const run = latestFailedMainCiRun(
      await api(`actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=10`),
    );
    if (!run) return undefined;
    const [pages, openIssues] = await Promise.all([
      api(
        `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
        "--paginate",
        "--slurp",
      ),
      gh(
        "issue",
        "list",
        "--repo",
        `github.com/${repo}`,
        "--state",
        "open",
        "--label",
        "main-ci-red",
        "--limit",
        "1",
        "--json",
        "number,url",
      ),
    ]);
    const jobs = jobPages.parse(pages).flatMap((page) => page.jobs);
    const issue = issues.parse(openIssues)[0];
    lookupSignal.throwIfAborted();
    return formatMainCiNotice(run, jobs, issue);
  } catch {
    // Optional GitHub evidence never affects local validation.
    return undefined;
  }
}

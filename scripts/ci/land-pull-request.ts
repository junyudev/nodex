/**
 * Lands a pull request the way the Ask workflow requires: wait for its checks, merge with a
 * rebase only once the aggregate `required` check passes and nothing failed, then watch Main CI
 * on the landed commit. `main` has no required checks (Agents also Ship straight to it), so
 * `gh pr merge --auto` would merge at once; use this instead.
 *
 *   vp run pr:land <number>
 *
 * Transient GitHub API failures are retried. Rerunning after an interruption resumes: a PR that
 * is already merged goes straight to watching Main CI.
 */
import { spawnSync } from "node:child_process";
import { posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { MAIN_CI_WORKFLOW_PATH } from "./main-ci-base.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const mainCiWorkflow = posix.basename(MAIN_CI_WORKFLOW_PATH);
const POLL_MS = 30_000;
/** How long a new pull request may report no checks before its CI is considered missing. */
const CHECKS_APPEAR_MS = 10 * 60_000;
const GATE = "required";

export interface PullRequestCheck {
  readonly name: string;
  readonly bucket: string;
  readonly link?: string;
}

export type ChecksVerdict =
  | { readonly kind: "pending" }
  | { readonly kind: "failed"; readonly failures: readonly PullRequestCheck[] }
  | { readonly kind: "ready" };

/**
 * Any failed or cancelled check stops the landing at once. Otherwise the pull request is ready
 * when the aggregate gate has passed; advisory checks still running do not hold it.
 */
export function assessChecks(checks: readonly PullRequestCheck[]): ChecksVerdict {
  const failures = checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel");
  if (failures.length > 0) return { kind: "failed", failures };
  const gate = checks.find((check) => check.name === GATE);
  return gate?.bucket === "pass" ? { kind: "ready" } : { kind: "pending" };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function gh(args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("gh", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  });
  return { ok: result.status === 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Reads JSON from gh, retrying transient failures; `gh pr checks` exits non-zero while pending. */
async function ghJson<T>(args: readonly string[], attempts = 10): Promise<T | null> {
  for (let attempt = 1; ; attempt += 1) {
    const result = gh(args);
    try {
      return JSON.parse(result.stdout) as T;
    } catch {
      if (/no checks reported/i.test(result.stderr)) return null;
      if (attempt >= attempts)
        throw new Error(`gh ${args.join(" ")} failed: ${result.stderr.trim()}`);
      await sleep(Math.min(5_000 * attempt, POLL_MS));
    }
  }
}

interface PullRequestState {
  readonly state: "OPEN" | "CLOSED" | "MERGED";
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly url: string;
  readonly mergeCommit: { readonly oid: string } | null;
}

const readPullRequest = async (number: string) =>
  (await ghJson<PullRequestState>([
    "pr",
    "view",
    number,
    "--json",
    "state,isDraft,headRefOid,url,mergeCommit",
  ]))!;

async function waitForGate(number: string): Promise<string> {
  const started = Date.now();
  let head = "";
  for (;;) {
    const pr = await readPullRequest(number);
    if (pr.state !== "OPEN") throw new Error(`Pull request ${number} is ${pr.state.toLowerCase()}`);
    if (pr.isDraft) throw new Error(`Pull request ${number} is a draft; mark it ready first`);
    if (head && head !== pr.headRefOid) console.log(`New head ${pr.headRefOid}; waiting again`);
    head = pr.headRefOid;
    const checks = await ghJson<PullRequestCheck[]>([
      "pr",
      "checks",
      number,
      "--json",
      "name,bucket,link",
    ]);
    if (checks === null && Date.now() - started > CHECKS_APPEAR_MS)
      throw new Error(`Pull request ${number} reported no checks; is its CI running?`);
    const verdict = assessChecks(checks ?? []);
    if (verdict.kind === "failed") {
      for (const check of verdict.failures) console.error(`✗ ${check.name} ${check.link ?? ""}`);
      throw new Error(`Checks failed on ${head}; fix and push, then run pr:land again`);
    }
    if (verdict.kind === "ready") return head;
    const done = (checks ?? []).filter((check) => check.bucket !== "pending").length;
    console.log(`Waiting for checks: ${done}/${checks?.length ?? 0} settled`);
    await sleep(POLL_MS);
  }
}

interface WorkflowRun {
  readonly databaseId: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string;
  readonly url: string;
}

const listMainRuns = async () =>
  (await ghJson<WorkflowRun[]>([
    "run",
    "list",
    "--workflow",
    mainCiWorkflow,
    "--branch",
    "main",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,status,conclusion,url",
  ])) ?? [];

/** A queued run can be replaced by a later push; that later run covers the landed commit too. */
async function watchMainCi(landed: string): Promise<void> {
  let sha = landed;
  for (;;) {
    const runs = await listMainRuns();
    const run = runs.find((candidate) => candidate.headSha === sha);
    if (!run) {
      console.log(`Waiting for Main CI on ${sha.slice(0, 10)}`);
      await sleep(POLL_MS);
      continue;
    }
    if (run.status !== "completed") {
      console.log(`Main CI ${run.status}: ${run.url}`);
      await sleep(POLL_MS);
      continue;
    }
    if (run.conclusion === "success") {
      console.log(`Main CI passed on ${sha.slice(0, 10)}: ${run.url}`);
      return;
    }
    if (run.conclusion === "cancelled") {
      // Runs are listed newest first; the run just after ours on linear `main` includes it.
      const newer = runs.slice(0, runs.indexOf(run)).at(-1);
      if (newer) {
        console.log(`Main CI on ${sha.slice(0, 10)} was superseded; following ${newer.url}`);
        sha = newer.headSha;
        continue;
      }
    }
    throw new Error(
      `Main CI ${run.conclusion} on ${sha.slice(0, 10)}: ${run.url}; fix forward now`,
    );
  }
}

async function main(): Promise<void> {
  const number = process.argv[2];
  if (!number || !/^\d+$/.test(number)) throw new Error("Usage: vp run pr:land <pull-request>");
  let pr = await readPullRequest(number);
  if (pr.state === "OPEN") {
    const head = await waitForGate(number);
    const merged = gh(["pr", "merge", number, "--rebase", "--match-head-commit", head]);
    if (!merged.ok) throw new Error(`Merge refused: ${merged.stderr.trim()}`);
    for (let attempt = 0; attempt < 10 && !pr.mergeCommit; attempt += 1) {
      pr = await readPullRequest(number);
      if (!pr.mergeCommit) await sleep(3_000);
    }
    console.log(`Merged ${pr.url}`);
  }
  if (pr.state !== "MERGED" || !pr.mergeCommit)
    throw new Error(`Pull request ${number} is ${pr.state.toLowerCase()}`);
  await watchMainCi(pr.mergeCommit.oid);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

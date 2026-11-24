import { readFileSync } from "node:fs";
import path from "node:path";

import type { MainCiVerdict } from "./write-main-ci-verdict.ts";

const LABEL = "main-ci-red";

interface IssueContext {
  readonly event: string | undefined;
  readonly ref: string | undefined;
  readonly outcome: string | undefined;
}

type IssueDecision =
  | { readonly kind: "none" }
  | { readonly kind: "create" }
  | { readonly kind: "comment"; readonly issue: number }
  | { readonly kind: "close"; readonly issues: readonly number[] };

function isMainPush({ event, ref, outcome }: IssueContext): boolean {
  return (
    event === "push" &&
    ref === "refs/heads/main" &&
    (outcome === "success" || outcome === "failure")
  );
}

export function mainCiIssueDecision(
  context: IssueContext,
  openIssues: readonly number[],
): IssueDecision {
  if (!isMainPush(context)) return { kind: "none" };
  if (context.outcome === "success") {
    return openIssues.length > 0 ? { kind: "close", issues: openIssues } : { kind: "none" };
  }
  const issue = openIssues[0];
  return issue === undefined ? { kind: "create" } : { kind: "comment", issue };
}

export function mainCiIssueContent(
  verdict: MainCiVerdict,
  runUrl: string,
): { title: string; body: string } {
  const gates = verdict.failingGates.map(({ id }) => id).join(", ") || "verification";
  const title = `main is red since ${verdict.range.headSha.slice(0, 7)}: ${gates}`;
  const link = `[Main CI run ${verdict.runId}, attempt ${verdict.runAttempt}](${runUrl})`;
  const body = `${link}\n\n\`\`\`json\n${JSON.stringify(verdict, null, 2)}\n\`\`\`\n`;
  return { title, body };
}

export const mainCiGreenComment = (verdict: MainCiVerdict, runUrl: string): string =>
  `Main CI is green at \`${verdict.range.headSha}\`. [View the run](${runUrl}).`;

type GitHubRequest = (endpoint: string, options?: RequestInit) => Promise<Response>;

async function requireOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const message = await response.text();
  throw new Error(`GitHub issue request failed (${response.status}): ${message}`);
}

async function write(
  request: GitHubRequest,
  endpoint: string,
  data: object,
  method = "POST",
): Promise<void> {
  await requireOk(await request(endpoint, { method, body: JSON.stringify(data) }));
}

async function ensureLabel(request: GitHubRequest): Promise<void> {
  const endpoint = `labels/${LABEL}`;
  const existing = await request(endpoint);
  if (existing.status !== 404) {
    await requireOk(existing);
    return;
  }
  const created = await request("labels", {
    method: "POST",
    body: JSON.stringify({ name: LABEL, color: "B60205", description: "Main CI is failing" }),
  });
  // Someone may have created the label since the lookup.
  const response = created.status === 422 ? await request(endpoint) : created;
  await requireOk(response);
}

async function readOpenIssues(request: GitHubRequest): Promise<readonly number[]> {
  const response = await requireOk(await request(`issues?state=open&labels=${LABEL}&per_page=100`));
  const items = (await response.json()) as { number: number; pull_request?: unknown }[];
  return items
    .filter((item) => item.pull_request === undefined)
    .map((item) => item.number)
    .sort((left, right) => left - right);
}

async function main(): Promise<void> {
  const env = process.env;
  const context = {
    event: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    outcome: env.CI_GATE_OUTCOME,
  };
  if (!isMainPush(context)) return;
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_TOKEN, RUNNER_TEMP } = env;
  if (
    !GITHUB_API_URL ||
    !GITHUB_REPOSITORY ||
    !GITHUB_SERVER_URL ||
    !GITHUB_TOKEN ||
    !RUNNER_TEMP
  ) {
    throw new Error(
      "Main CI issue updates require the Actions repository, verdict, and job token.",
    );
  }
  const verdict = JSON.parse(
    readFileSync(path.join(RUNNER_TEMP, "main-ci-verdict.json"), "utf8"),
  ) as MainCiVerdict;
  if (verdict.schemaVersion !== 1 || verdict.status !== context.outcome) {
    throw new Error("Main CI issue update requires a version 1 verdict matching the gate outcome.");
  }

  const request: GitHubRequest = (endpoint, options) =>
    fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}/${endpoint}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
  const decision = mainCiIssueDecision(context, await readOpenIssues(request));
  const runUrl = `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${verdict.runId}/attempts/${verdict.runAttempt}`;
  if (decision.kind === "none") return;
  if (decision.kind === "close") {
    const body = mainCiGreenComment(verdict, runUrl);
    for (const issue of decision.issues) {
      await write(request, `issues/${issue}/comments`, { body });
      await write(
        request,
        `issues/${issue}`,
        { state: "closed", state_reason: "completed" },
        "PATCH",
      );
    }
    return;
  }

  const { title, body } = mainCiIssueContent(verdict, runUrl);
  if (decision.kind === "comment") {
    await write(request, `issues/${decision.issue}/comments`, { body });
    return;
  }
  await ensureLabel(request);
  await write(request, "issues", { title, body, labels: [LABEL] });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}

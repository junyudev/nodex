import { expect, test } from "vite-plus/test";

import {
  mainCiGreenComment,
  mainCiIssueContent,
  mainCiIssueDecision,
} from "./update-main-ci-issue";
import type { MainCiVerdict } from "./write-main-ci-verdict";

const push = { event: "push", ref: "refs/heads/main" } as const;

test("opens one incident and comments on an existing open issue", () => {
  const red = { ...push, outcome: "failure" };
  expect(mainCiIssueDecision(red, [])).toEqual({ kind: "create" });
  expect(mainCiIssueDecision(red, [17])).toEqual({ kind: "comment", issue: 17 });
});

test("closes open incidents after successful main verification", () => {
  const green = { ...push, outcome: "success" };
  expect(mainCiIssueDecision(green, [17, 42])).toEqual({ kind: "close", issues: [17, 42] });
  expect(mainCiIssueDecision(green, [])).toEqual({ kind: "none" });
});

test.each([
  { ...push, outcome: "cancelled" },
  { ...push, event: "workflow_dispatch", outcome: "failure" },
  { ...push, event: "workflow_dispatch", outcome: "success" },
  { ...push, ref: "refs/heads/codex/windows-build", outcome: "failure" },
])("ignores non-eligible verification: %j", (context) => {
  expect(mainCiIssueDecision(context, [17])).toEqual({ kind: "none" });
});

test("includes the complete verdict in a failure and identifies the green revision on close", () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const baseSha = "a".repeat(40);
  const url = "https://github.com/example/nodex/actions/runs/42/attempts/2";
  const verdict: MainCiVerdict = {
    schemaVersion: 1,
    status: "failure",
    runId: "42",
    runAttempt: 2,
    range: { basis: "last-green", baseSha, headSha: sha },
    commits: [{ sha, subject: "Fix native paths", author: "CI Fixture" }],
    failingGates: [{ id: "windows-checks", result: "failure" }],
    failingJobs: [
      {
        name: "main windows checks / native x64",
        result: "failure",
        url: `${url}/job/1`,
        failedSteps: ["Test native platform boundary"],
        failedTests: ["private_paths::opens_file"],
      },
    ],
  };
  const { title, body } = mainCiIssueContent(verdict, url);
  expect(title).toBe("main is red since abcdef0: windows-checks");
  expect(body).toContain(url);
  const [opening, json, closing] = body.split("\`\`\`");
  expect(opening).toContain("Main CI run 42, attempt 2");
  expect(closing?.trim()).toBe("");
  expect(JSON.parse(json?.replace(/^json\n/u, "") ?? "")).toEqual(verdict);

  expect(mainCiGreenComment({ ...verdict, status: "success" }, url)).toBe(
    `Main CI is green at \`${sha}\`. [View the run](${url}).`,
  );
});

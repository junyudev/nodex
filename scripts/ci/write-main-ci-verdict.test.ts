import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vite-plus/test";

import { classifyChangedPaths } from "./classify-change";
import { failedTestNames, failingMainCiGates, resolveVerdictRange } from "./write-main-ci-verdict";

test("uses the last green range even when a newer push replaced a pending run", () => {
  const head = "a".repeat(40);
  const lastGreen = "b".repeat(40);
  const before = "c".repeat(40);
  expect(resolveVerdictRange(head, lastGreen, before, () => true)).toEqual({
    basis: "last-green",
    baseSha: lastGreen,
    headSha: head,
  });
  expect(resolveVerdictRange(head, "", before, () => true)).toMatchObject({
    basis: "push-before",
    baseSha: before,
  });
  expect(resolveVerdictRange(head, "", before, () => false)).toEqual({
    basis: "head-only",
    baseSha: null,
    headSha: head,
  });
});

test("records every unsuccessful selected gate, including missing and skipped results", () => {
  const plan = JSON.stringify(classifyChangedPaths(["crates/nodex-core/src/lib.rs"]));
  const needs = {
    classify: { result: "success" },
    "static-contracts": { result: "success" },
    "app-tests": { result: "failure" },
    "windows-checks": { result: "skipped" },
  } as const;
  expect(failingMainCiGates(needs, plan)).toEqual([
    { id: "app-tests", result: "failure" },
    { id: "rust-checks", result: "missing" },
    { id: "windows-checks", result: "skipped" },
  ]);
  expect(failingMainCiGates(needs, "")).toEqual([{ id: "classify", result: "invalid-plan" }]);
  expect(failingMainCiGates({ classify: { result: "cancelled" } }, plan)).toEqual([
    { id: "classify", result: "cancelled" },
  ]);
});

test("extracts named failures from runner logs without collecting unrelated error text", () => {
  const log = [
    "2026-11-24T21:34:38.123Z \u001b[31m FAIL \u001b[39m src/shared/roles.test.ts > tracks role changes",
    "FAIL  src/shared/roles.test.ts > tracks role changes",
    "test private_paths::opens_file ... FAILED",
    "        FAIL [   0.080s] nodex-platform windows_paths::checks_acl",
    "      TIMEOUT [  12.001s] nodex-core tests::drains",
    "Error: registry request failed",
  ].join("\n");
  expect(failedTestNames(log)).toEqual([
    "nodex-core tests::drains",
    "nodex-platform windows_paths::checks_acl",
    "private_paths::opens_file",
    "src/shared/roles.test.ts > tracks role changes",
  ]);
});

test("writes the landed range and failure evidence to the artifact and step summary", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "main-ci-verdict-"));
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=CI Fixture",
        "-c",
        "user.email=ci@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${dir}`,
        ...args,
      ],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  const server = createServer((request, response) => {
    if (request.url?.includes("/attempts/2/jobs")) {
      response.end(
        JSON.stringify({
          jobs: [
            {
              id: 1,
              name: "main windows checks / native x64",
              html_url: "https://example.com/job/1",
              status: "completed",
              conclusion: "failure",
              steps: [{ name: "Test native platform boundary", conclusion: "failure" }],
            },
            {
              id: 2,
              name: "main app tests / app integration",
              html_url: "https://example.com/job/2",
              status: "completed",
              conclusion: "failure",
              steps: [],
            },
          ],
        }),
      );
      return;
    }
    if (request.url?.endsWith("/jobs/1/logs")) {
      response.end("test private_paths::opens_file ... FAILED\n");
      return;
    }
    response.writeHead(404).end();
  });

  try {
    git("init", "--quiet");
    git("commit", "--quiet", "--allow-empty", "-m", "Last green");
    const base = git("rev-parse", "HEAD");
    git("commit", "--quiet", "--allow-empty", "-m", "Replaced pending push");
    git("commit", "--quiet", "--allow-empty", "-m", "Latest push");
    const head = git("rev-parse", "HEAD");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected the server port.");
    const summary = path.join(dir, "summary.md");
    await promisify(execFile)(
      process.execPath,
      ["--no-warnings", path.join(import.meta.dirname, "write-main-ci-verdict.ts")],
      {
        cwd: dir,
        env: {
          ...process.env,
          CI_BASE_SHA: base,
          CI_GATE_OUTCOME: "failure",
          CI_GATE_PLAN_JSON: JSON.stringify(
            classifyChangedPaths(["src/main/platform/host-capabilities.ts"]),
          ),
          CI_NEEDS_JSON: JSON.stringify({
            classify: { result: "success" },
            "static-contracts": { result: "success" },
            "app-tests": { result: "failure" },
            "windows-checks": { result: "failure" },
          }),
          GH_TOKEN: "fixture",
          GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
          GITHUB_REPOSITORY: "fixture/nodex",
          GITHUB_RUN_ATTEMPT: "2",
          GITHUB_RUN_ID: "42",
          GITHUB_SHA: head,
          GITHUB_STEP_SUMMARY: summary,
          RUNNER_TEMP: dir,
        },
      },
    );
    const json = await readFile(path.join(dir, "main-ci-verdict.json"), "utf8");
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      status: "failure",
      range: { basis: "last-green", baseSha: base, headSha: head },
      commits: [
        { sha: git("rev-parse", "HEAD~1"), subject: "Replaced pending push", author: "CI Fixture" },
        { sha: head, subject: "Latest push", author: "CI Fixture" },
      ],
      failingGates: [
        { id: "app-tests", result: "failure" },
        { id: "windows-checks", result: "failure" },
      ],
      failingJobs: [
        { name: "main app tests / app integration", failedTests: null },
        {
          name: "main windows checks / native x64",
          failedSteps: ["Test native platform boundary"],
          failedTests: ["private_paths::opens_file"],
        },
      ],
    });
    expect(await readFile(summary, "utf8")).toContain(json);
  } finally {
    server.close();
    await rm(dir, { force: true, recursive: true });
  }
});

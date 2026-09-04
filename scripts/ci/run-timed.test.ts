import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";

import { parseRunTimedArguments, runTimedCommand } from "./run-timed";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CI timed command runner", () => {
  test("parses a command after the separator without consuming command flags", () => {
    expect(
      parseRunTimedArguments(["--name", "rust-tests", "--", "cargo", "test", "--workspace"]),
    ).toEqual({
      name: "rust-tests",
      command: "cargo",
      commandArguments: ["test", "--workspace"],
    });
  });

  test("records successful and failed child commands with a step summary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodex-ci-timed-"));
    temporaryRoots.push(root);
    const summaryPath = path.join(root, "summary.md");
    const environmentWithoutGitHubRunIdentity = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) =>
          !["GITHUB_RUN_ATTEMPT", "GITHUB_RUN_ID", "GITHUB_SHA", "CI_SOURCE_SHA"].includes(name),
      ),
    );
    const success = await runTimedCommand({
      name: "successful step",
      command: process.execPath,
      commandArguments: ["-e", "process.exit(0)"],
      timingDirectory: root,
      summaryPath,
      env: {
        ...process.env,
        CI_TIMING_JOB: "test job",
        GITHUB_RUN_ATTEMPT: "2",
        GITHUB_RUN_ID: "12345",
        GITHUB_SHA: "abc123",
        CI_SOURCE_SHA: "source456",
      },
    });
    const failure = await runTimedCommand({
      name: "failed step",
      command: process.execPath,
      commandArguments: ["-e", "process.exit(7)"],
      timingDirectory: root,
      summaryPath,
      env: { ...environmentWithoutGitHubRunIdentity, CI_TIMING_JOB: "test job" },
    });
    expect(success.exitCode).toBe(0);
    expect(failure.exitCode).toBe(7);
    const records = (await readFile(path.join(root, "test-job.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      attempt: 2,
      exitCode: 0,
      job: "test job",
      name: "successful step",
      runId: "12345",
      sha: "source456",
    });
    expect(records[1]).toMatchObject({
      attempt: null,
      exitCode: 7,
      job: "test job",
      name: "failed step",
      runId: null,
      sha: null,
    });
    const summary = await readFile(summaryPath, "utf8");
    expect(summary).toContain("| successful step |");
    expect(summary).toContain("| failed step |");
  });
});

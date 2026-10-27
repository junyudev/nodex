import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFileSync } from "node:child_process";
import { evaluateNightlySourceCi, inspectNightlySourceCi } from "./source-ci";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const sourceSha = "a".repeat(40);
const runUrl = "https://github.com/junyudev/nodex/actions/runs/123";
const run = (overrides: Record<string, unknown> = {}) => ({
  head_sha: sourceSha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: runUrl,
  ...overrides,
});
const evaluate = (runs: unknown[]) => evaluateNightlySourceCi(sourceSha, { workflow_runs: runs });

afterEach(() => vi.resetAllMocks());

test("nightly waits when the exact source has no Main CI push run", () => {
  expect(evaluate([])).toEqual({ decision: "missing", sourceSha, runUrl: null });
});

test.each(["queued", "in_progress", "waiting", "pending", "requested"])(
  "nightly waits for %s Main CI without masking a completed failure",
  (status) => {
    expect(evaluate([run({ status, conclusion: null })])).toEqual({
      decision: "pending",
      sourceSha,
      runUrl,
    });
  },
);

test.each(["failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", null])(
  "nightly reports completed Main CI conclusion %s as blocked",
  (conclusion) => {
    expect(evaluate([run({ conclusion })])).toEqual({ decision: "failed", sourceSha, runUrl });
  },
);

test("nightly admits only the latest successful run for the exact source", () => {
  expect(evaluate([run()])).toEqual({ decision: "eligible", sourceSha, runUrl });
  expect(evaluate([run({ conclusion: "failure" }), run()]).decision).toBe("failed");
  expect(evaluate([run({ status: "queued", conclusion: null }), run()]).decision).toBe("pending");
});

test.each([
  { head_sha: "b".repeat(40) },
  { head_branch: "feature" },
  { event: "workflow_dispatch" },
  { status: undefined },
  { conclusion: undefined },
])("nightly rejects a run outside its source contract: %j", (overrides) => {
  expect(() => evaluate([run(overrides)])).toThrow("exact protected-main push source");
});

test("nightly fails closed on malformed GitHub responses", () => {
  expect(() => evaluateNightlySourceCi(sourceSha, {})).toThrow("workflow-run response");
  expect(() => evaluateNightlySourceCi(sourceSha, { workflow_runs: null })).toThrow(
    "workflow-run response",
  );
  expect(() => evaluate([null])).toThrow("exact protected-main push source");
});

test("nightly queries Main CI by exact SHA, protected branch, and push event", () => {
  vi.mocked(execFileSync).mockReturnValue(JSON.stringify({ workflow_runs: [run()] }));
  expect(inspectNightlySourceCi("junyudev/nodex", sourceSha).decision).toBe("eligible");
  expect(execFileSync).toHaveBeenCalledWith(
    "gh",
    [
      "api",
      "--method",
      "GET",
      "repos/junyudev/nodex/actions/workflows/ci-main.yml/runs",
      "-f",
      `head_sha=${sourceSha}`,
      "-f",
      "branch=main",
      "-f",
      "event=push",
      "-F",
      "per_page=1",
    ],
    expect.any(Object),
  );
});

test("nightly rejects a mutable source ref before querying GitHub", () => {
  expect(() => inspectNightlySourceCi("junyudev/nodex", "main")).toThrow(
    "full lowercase commit SHA",
  );
  expect(execFileSync).not.toHaveBeenCalled();
});

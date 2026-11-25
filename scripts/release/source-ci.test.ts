import { execFileSync } from "node:child_process";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { resolveNightlyRelease } from "./nightly";
import { evaluateNightlySourceCi, inspectNightlySourceCi } from "./source-ci";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const headSha = "a".repeat(40);
const olderSha = "b".repeat(40);
const newestGreenSha = "c".repeat(40);
const failedSha = "d".repeat(40);
const removedSha = "e".repeat(40);
const runUrl = (id: number) => `https://github.com/junyudev/nodex/actions/runs/${id}`;
const run = (id: number, sourceSha: string, overrides: Record<string, unknown> = {}) => ({
  run_number: id,
  head_sha: sourceSha,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  html_url: runUrl(id),
  ...overrides,
});
const evaluate = (runs: unknown[]) =>
  evaluateNightlySourceCi(headSha, runs, (sha) => {
    const distances = { [headSha]: 0, [olderSha]: 8, [newestGreenSha]: 5, [failedSha]: 2 };
    return distances[sha] ?? null;
  });

afterEach(() => vi.resetAllMocks());

test("selects the most recent successful Main CI push reachable from main HEAD", () => {
  expect(evaluate([run(8, olderSha), run(9, newestGreenSha)])).toEqual({
    headSha,
    verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
    newerFailure: null,
  });
  expect(evaluate([run(9, newestGreenSha), run(10, headSha)]).verified).toMatchObject({
    sourceSha: headSha,
    commitsBehindHead: 0,
  });
});

test("skips a queued HEAD and superseded pushes without reporting them as failures", () => {
  expect(
    evaluate([
      run(12, headSha, { status: "queued", conclusion: null }),
      run(11, failedSha, { conclusion: "cancelled" }),
      run(9, newestGreenSha),
    ]),
  ).toEqual({
    headSha,
    verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
    newerFailure: null,
  });
});

test("rejects unreachable success and tries the next most recent reachable success", () => {
  expect(evaluate([run(10, removedSha), run(9, newestGreenSha)]).verified?.sourceSha).toBe(
    newestGreenSha,
  );
  expect(evaluate([run(10, removedSha)]).verified).toBeNull();
});

test("returns no verified source if Main CI has never passed for current main", () => {
  expect(evaluate([])).toEqual({ headSha, verified: null, newerFailure: null });
  expect(evaluate([run(10, failedSha, { conclusion: "failure" })])).toEqual({
    headSha,
    verified: null,
    newerFailure: { sourceSha: failedSha, runUrl: runUrl(10) },
  });
});

test("reports the newest failure ahead of a verified source without blocking that source", () => {
  expect(
    evaluate([
      run(13, headSha, { conclusion: "cancelled" }),
      run(12, failedSha, { conclusion: "failure" }),
      run(11, failedSha, { conclusion: "failure" }),
      run(9, newestGreenSha),
      run(8, olderSha, { conclusion: "failure" }),
    ]),
  ).toEqual({
    headSha,
    verified: { sourceSha: newestGreenSha, runUrl: runUrl(9), commitsBehindHead: 5 },
    newerFailure: { sourceSha: failedSha, runUrl: runUrl(12) },
  });
  expect(
    evaluate([run(9, newestGreenSha), run(8, olderSha, { conclusion: "failure" })]).newerFailure,
  ).toBeNull();
});

test.each([
  { head_sha: "main" },
  { head_branch: "feature" },
  { event: "workflow_dispatch" },
  { status: undefined },
  { conclusion: undefined },
  { run_number: undefined },
])("rejects invalid protected-main push evidence: %j", (overrides) => {
  expect(() => evaluate([run(10, headSha, overrides)])).toThrow(
    "protected-main Main CI push evidence",
  );
});

test("queries all pages of green and failed Main CI pushes on main", () => {
  vi.mocked(execFileSync).mockReturnValue("[]\n[]\n");
  expect(resolveNightlyRelease({ repo: "junyudev/nodex", cwd: ".", headSha })).toEqual({
    decision: "no-verified-commit",
    headSha,
    verified: null,
    newerFailure: null,
  });
  for (const conclusion of ["success", "failure"]) {
    expect(execFileSync).toHaveBeenCalledWith(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "repos/junyudev/nodex/actions/workflows/ci-main.yml/runs",
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
        expect.any(String),
      ],
      expect.any(Object),
    );
  }
});

test("fails closed if GitHub did not return a run page", () => {
  vi.mocked(execFileSync).mockReturnValue("{}\n");
  expect(() => inspectNightlySourceCi({ repo: "junyudev/nodex", cwd: ".", headSha })).toThrow(
    "invalid Main CI run page",
  );
});

test("requires an immutable lowercase main HEAD before querying GitHub", () => {
  expect(() =>
    inspectNightlySourceCi({ repo: "junyudev/nodex", cwd: ".", headSha: "main" }),
  ).toThrow("full lowercase main HEAD SHA");
  expect(execFileSync).not.toHaveBeenCalled();
});

import { expect, test } from "vite-plus/test";
import { compareAttempts, type AttemptSummary } from "./report";
const attempt = (input: Partial<AttemptSummary> = {}): AttemptSummary => ({
  caseId: "exact-edit",
  variant: 0,
  passed: true,
  status: "completed",
  calls: 4,
  errors: 0,
  outputBytes: 1000,
  durationMs: 1000,
  tokens: 1000,
  ...input,
});
test("correctness regressions override lower cost", () => {
  expect(compareAttempts([attempt()], [attempt({ passed: false, calls: 1 })]).verdict).toBe(
    "reject",
  );
});
test("missing, duplicated and infrastructure attempts cannot establish an improvement", () => {
  expect(compareAttempts([attempt()], []).verdict).toBe("incomparable");
  expect(compareAttempts([attempt()], [attempt(), attempt()]).verdict).toBe("incomparable");
  expect(compareAttempts([attempt()], [attempt({ status: "infrastructureError" })]).verdict).toBe(
    "incomparable",
  );
});
test("requires demonstrated correctness gain or no-regression friction reduction", () => {
  expect(compareAttempts([attempt({ passed: false })], [attempt()]).verdict).toBe("eligible");
  expect(compareAttempts([attempt()], [attempt({ calls: 3 })]).verdict).toBe("eligible");
  expect(compareAttempts([attempt()], [attempt({ durationMs: 1 })]).verdict).toBe("noImprovement");
  expect(compareAttempts([attempt()], [attempt({ calls: 3, errors: 1 })]).verdict).toBe(
    "noImprovement",
  );
});

test("lower cost on still-failed tasks cannot establish or subsidize an improvement", () => {
  const failed = attempt({ caseId: "failed-task", passed: false, calls: 10, outputBytes: 5000 });
  const cheaperFailure = { ...failed, calls: 0, outputBytes: 0 };
  expect(compareAttempts([failed], [cheaperFailure]).verdict).toBe("noImprovement");
  expect(compareAttempts([attempt(), failed], [attempt(), cheaperFailure]).verdict).toBe(
    "noImprovement",
  );
  expect(
    compareAttempts([attempt(), failed], [attempt({ calls: 5 }), cheaperFailure]).verdict,
  ).toBe("noImprovement");
});

test("successful paired tasks can demonstrate improvement despite unchanged failed outcomes", () => {
  const failed = attempt({ caseId: "failed-task", passed: false });
  expect(compareAttempts([attempt(), failed], [attempt({ calls: 3 }), failed]).verdict).toBe(
    "eligible",
  );
});

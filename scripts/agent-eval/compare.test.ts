import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  compareEvaluationReports,
  compareReportDirectories,
  parseEvaluationReport,
  type EvaluationReport,
} from "./compare";

const manifest = {
  schemaVersion: 1,
  startedAt: "2026-09-07T00:00:00.000Z",
  commit: "a".repeat(40),
  dirty: false,
  cliHash: "a".repeat(64),
  coreHash: "b".repeat(64),
  skillHash: "c".repeat(64),
  agentHash: "d".repeat(64),
  caseHash: "e".repeat(64),
  runnerHash: "e".repeat(64),
  model: "gpt-5.6-luna",
  effort: "max",
  variants: 1,
  cases: ["exact-edit", "ambiguous-title", "concurrent-edit"],
  limits: { maxToolCalls: 40, maxTokens: 60000, timeoutMs: 300000 },
};
const baseline = () =>
  parseEvaluationReport(
    manifest,
    manifest.cases.map((caseId) => ({
      caseId,
      variant: 0,
      passed: true,
      status: "completed",
      calls: 4,
      errors: 0,
      outputBytes: 1000,
      durationMs: 1000,
      tokens: 1000,
    })),
  );
const cheaper = (report: EvaluationReport): EvaluationReport => ({
  ...report,
  attempts: report.attempts.map((item) => ({ ...item, calls: 3 })),
});

test("comparison accepts measured improvement across changed product artifacts with unchanged experiment", () => {
  const before = baseline();
  const after = cheaper(before);
  expect(
    compareEvaluationReports(before, {
      ...after,
      manifest: {
        ...after.manifest,
        cliHash: "f".repeat(64),
        coreHash: "f".repeat(64),
        skillHash: "f".repeat(64),
      },
    }),
  ).toMatchObject({ verdict: "eligible" });
});
test("changed oracle, model, runtime, effort, variants, cases or budgets invalidate a comparison", () => {
  const before = baseline();
  for (const change of [
    { caseHash: "f".repeat(64) },
    { runnerHash: "f".repeat(64) },
    { agentHash: "f".repeat(64) },
    { model: "another-model" },
    { effort: "high" },
    { variants: 2 },
    { cases: ["exact-edit"] },
    { limits: { ...manifest.limits, maxTokens: 1 } },
  ]) {
    expect(
      compareEvaluationReports(before, {
        ...cheaper(before),
        manifest: { ...before.manifest, ...change },
      }),
    ).toMatchObject({ verdict: "incomparable" });
  }
});
test("missing holdouts or variant attempts cannot produce eligible even with lower friction", () => {
  const before = baseline();
  const partial = {
    ...before,
    manifest: { ...before.manifest, cases: ["exact-edit"] },
    attempts: before.attempts.slice(0, 1),
  };
  expect(compareEvaluationReports(partial, cheaper(partial))).toMatchObject({
    verdict: "incomplete",
  });
  const missing = { ...before, attempts: before.attempts.slice(0, 2) };
  expect(compareEvaluationReports(missing, cheaper(missing))).toMatchObject({
    verdict: "incomplete",
  });
});
test("report ingestion rejects invalid metrics and fabricated successful unfinished attempts", () => {
  const before = baseline();
  expect(() => parseEvaluationReport(manifest, [{ ...before.attempts[0], calls: -1 }])).toThrow();
  expect(() =>
    parseEvaluationReport(manifest, [{ ...before.attempts[0], status: "timedOut" }]),
  ).toThrow();
  expect(() =>
    parseEvaluationReport({ ...manifest, caseHash: "missing" }, before.attempts),
  ).toThrow();
});
test("comparison loads actual report directories and checks their declared attempt matrix", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "nodex-eval-compare-"));
  try {
    const before = baseline();
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(before.manifest));
    await writeFile(path.join(root, "summary.json"), JSON.stringify(before.attempts));
    expect(await compareReportDirectories(root, root)).toMatchObject({ verdict: "noImprovement" });
    await writeFile(path.join(root, "summary.json"), JSON.stringify(before.attempts.slice(0, 1)));
    expect(await compareReportDirectories(root, root)).toMatchObject({ verdict: "incomplete" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

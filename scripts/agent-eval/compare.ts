import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { EVALUATION_HOLDOUT_CASE_IDS } from "./contracts";
import { compareAttempts } from "./report";

const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const manifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    startedAt: z.string().datetime(),
    commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
    dirty: z.boolean(),
    cliHash: hash,
    coreHash: hash,
    skillHash: hash,
    agentHash: hash,
    caseHash: hash,
    runnerHash: hash,
    model: z.string().min(1),
    effort: z.string().min(1),
    variants: z.number().int().min(1).max(3),
    cases: z
      .array(z.string().min(1))
      .nonempty()
      .refine((items) => new Set(items).size === items.length, "Case IDs must be unique"),
    limits: z
      .object({
        maxToolCalls: count.positive(),
        maxTokens: count.positive(),
        timeoutMs: count.positive(),
      })
      .strict(),
  })
  .strict();
const attemptSchema = z
  .object({
    caseId: z.string().min(1),
    variant: count,
    passed: z.boolean(),
    status: z.enum([
      "completed",
      "failed",
      "interrupted",
      "timedOut",
      "toolBudgetExceeded",
      "tokenBudgetExceeded",
      "infrastructureError",
      "inProgress",
    ]),
    calls: count,
    errors: count,
    outputBytes: count,
    durationMs: count,
    tokens: count,
    error: z.string().optional(),
  })
  .strict()
  .refine(
    (item) => !item.passed || item.status === "completed",
    "Only completed attempts can pass",
  );
const summarySchema = z.array(attemptSchema);

export function parseEvaluationReport(manifest: unknown, summary: unknown) {
  return { manifest: manifestSchema.parse(manifest), attempts: summarySchema.parse(summary) };
}
export type EvaluationReport = ReturnType<typeof parseEvaluationReport>;

function missingAttempts(report: EvaluationReport): string[] {
  const expected = new Set(
    report.manifest.cases.flatMap((caseId) =>
      Array.from({ length: report.manifest.variants }, (_, variant) => `${caseId}:${variant}`),
    ),
  );
  const observed = report.attempts.map((item) => `${item.caseId}:${item.variant}`);
  const problems = [...expected]
    .filter((key) => !observed.includes(key))
    .map((key) => `Missing attempt ${key}`);
  for (const key of observed) if (!expected.has(key)) problems.push(`Unexpected attempt ${key}`);
  if (new Set(observed).size !== observed.length) problems.push("Duplicate attempts");
  if (report.attempts.some((item) => item.status === "inProgress"))
    problems.push("Unfinished attempts");
  return problems;
}

/** Comparison eligibility requires an unchanged experiment and the reserved holdout matrix. */
export function compareEvaluationReports(baseline: EvaluationReport, candidate: EvaluationReport) {
  const mismatches: string[] = [];
  for (const key of [
    "caseHash",
    "runnerHash",
    "agentHash",
    "model",
    "effort",
    "variants",
  ] as const) {
    if (baseline.manifest[key] !== candidate.manifest[key]) mismatches.push(key);
  }
  if (
    JSON.stringify([...baseline.manifest.cases].sort()) !==
    JSON.stringify([...candidate.manifest.cases].sort())
  )
    mismatches.push("cases");
  for (const key of ["maxToolCalls", "maxTokens", "timeoutMs"] as const) {
    if (baseline.manifest.limits[key] !== candidate.manifest.limits[key])
      mismatches.push(`limits.${key}`);
  }
  const comparison = compareAttempts(baseline.attempts, candidate.attempts);
  if (mismatches.length)
    return {
      ...comparison,
      verdict: "incomparable",
      reasons: mismatches.map((key) => `Experiment differs: ${key}`),
    };
  const incomplete = [
    ...missingAttempts(baseline).map((reason) => `Baseline: ${reason}`),
    ...missingAttempts(candidate).map((reason) => `Candidate: ${reason}`),
  ];
  for (const caseId of EVALUATION_HOLDOUT_CASE_IDS) {
    if (!baseline.manifest.cases.includes(caseId))
      incomplete.push(`Missing required holdout ${caseId}`);
  }
  if (incomplete.length) return { ...comparison, verdict: "incomplete", reasons: incomplete };
  return {
    ...comparison,
    reasons:
      comparison.verdict === "incomparable"
        ? ["Attempts contain invalid infrastructure evidence"]
        : [],
  };
}

async function loadReport(directory: string): Promise<EvaluationReport> {
  const [manifest, summary] = await Promise.all([
    readFile(path.join(directory, "manifest.json"), "utf8"),
    readFile(path.join(directory, "summary.json"), "utf8"),
  ]);
  return parseEvaluationReport(JSON.parse(manifest), JSON.parse(summary));
}
export async function compareReportDirectories(
  baselineDirectory: string,
  candidateDirectory: string,
) {
  const [baseline, candidate] = await Promise.all([
    loadReport(baselineDirectory),
    loadReport(candidateDirectory),
  ]);
  return compareEvaluationReports(baseline, candidate);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2)
    throw new Error("Usage: vp run agent:eval:compare BASELINE_DIRECTORY CANDIDATE_DIRECTORY");
  process.stdout.write(
    `${JSON.stringify(await compareReportDirectories(args[0]!, args[1]!), null, 2)}\n`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ verdict: "incomparable", reasons: [error instanceof Error ? error.message : String(error)] }, null, 2)}\n`,
    );
    process.exitCode = 1;
  });
}

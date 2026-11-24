import path from "node:path";

import {
  parseCachedAppLaneIds,
  parseCiGatePlan,
  requiredJobIdsForGatePlan,
} from "./ci-gate-plan.ts";

export type GitHubJobResult = "cancelled" | "failure" | "skipped" | "success";

export interface RequiredGateVerification {
  readonly classifierResult: GitHubJobResult;
  readonly results: Readonly<Record<string, GitHubJobResult>>;
  readonly selectedGates: readonly string[];
}

const GITHUB_JOB_RESULTS = new Set<GitHubJobResult>(["cancelled", "failure", "skipped", "success"]);

const requireGitHubJobResult = (value: unknown, label: string): GitHubJobResult => {
  if (typeof value === "string" && GITHUB_JOB_RESULTS.has(value as GitHubJobResult)) {
    return value as GitHubJobResult;
  }
  throw new Error(`${label} has unsupported GitHub job result ${JSON.stringify(value)}.`);
};

export const verifyRequiredGates = ({
  classifierResult,
  results,
  selectedGates,
}: RequiredGateVerification): void => {
  if (classifierResult !== "success") {
    throw new Error(`classify finished with ${classifierResult}; expected success.`);
  }
  const uniqueGates = new Set(selectedGates);
  if (uniqueGates.size !== selectedGates.length) {
    throw new Error("Selected required gates must not contain duplicates.");
  }
  for (const gate of selectedGates) {
    if (!gate.trim()) throw new Error("Selected required gate names must not be empty.");
    const result = results[gate];
    if (!result) throw new Error(`${gate} has no GitHub job result.`);
    if (result !== "success") {
      throw new Error(`${gate} finished with ${result}; expected success.`);
    }
  }
};

interface GitHubNeedsJob {
  readonly result: GitHubJobResult;
  readonly outputs?: unknown;
}

export const requiredGateNames = (
  availableGateNames: readonly string[],
  rawPlan: unknown | undefined,
): readonly string[] =>
  rawPlan === undefined ? availableGateNames : requiredJobIdsForGatePlan(parseCiGatePlan(rawPlan));

export function requiredClassifiedGates(rawPlan: unknown, rawOutputs: unknown): readonly string[] {
  const plan = parseCiGatePlan(rawPlan);
  const outputs = rawOutputs as { app_lanes?: unknown } | undefined;
  const appLanes = outputs?.app_lanes;
  if (typeof appLanes !== "string")
    throw new Error("The classifier did not publish an application matrix.");
  parseCachedAppLaneIds(JSON.parse(appLanes), plan);
  return requiredJobIdsForGatePlan(plan);
}

export const parseNeeds = (value: string): Readonly<Record<string, GitHubNeedsJob>> => {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CI_NEEDS_JSON must be a JSON object.");
  }
  return Object.fromEntries(
    Object.entries(parsed).map(([name, candidate]) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
        throw new Error(`CI_NEEDS_JSON.${name} must be an object.`);
      }
      const result = requireGitHubJobResult(
        (candidate as Readonly<Record<string, unknown>>).result,
        `CI_NEEDS_JSON.${name}`,
      );
      const outputs = (candidate as Readonly<Record<string, unknown>>).outputs;
      return [name, { result, outputs }];
    }),
  );
};

const main = (): void => {
  const planJson = process.env.CI_GATE_PLAN_JSON;
  const needsJson = process.env.CI_NEEDS_JSON;
  if (!needsJson) throw new Error("CI_NEEDS_JSON is required.");
  const needs = parseNeeds(needsJson);
  const classifierResult = process.env.CI_CLASSIFIER_RESULT
    ? requireGitHubJobResult(process.env.CI_CLASSIFIER_RESULT, "CI_CLASSIFIER_RESULT")
    : needs.classify?.result;
  if (!classifierResult) throw new Error("A classifier result is required.");
  if (classifierResult !== "success") {
    verifyRequiredGates({ classifierResult, results: {}, selectedGates: [] });
    return;
  }
  const selectedGates = needs.classify
    ? requiredClassifiedGates(JSON.parse(planJson ?? "null"), needs.classify.outputs)
    : requiredGateNames(
        Object.keys(needs),
        planJson === undefined ? undefined : JSON.parse(planJson),
      );
  verifyRequiredGates({
    classifierResult,
    results: Object.fromEntries(Object.entries(needs).map(([name, job]) => [name, job.result])),
    selectedGates,
  });
  process.stdout.write("Every selected required gate succeeded.\n");
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

export interface AttemptSummary {
  readonly caseId: string;
  readonly variant: number;
  readonly passed: boolean;
  readonly status: string;
  readonly calls: number;
  readonly errors: number;
  readonly outputBytes: number;
  readonly durationMs: number;
  readonly tokens: number;
}

export function renderSummary(results: readonly AttemptSummary[]): string {
  const sum = (key: "calls" | "errors" | "outputBytes" | "durationMs" | "tokens") =>
    results.reduce((total, item) => total + item[key], 0);
  return [
    "# CLI Agent evaluation",
    "",
    `${results.filter((item) => item.passed).length}/${results.length} attempts passed independent verification.`,
    "",
    `${sum("calls")} CLI calls; ${sum("errors")} command errors; ${sum("tokens")} reported tokens; ${(sum("durationMs") / 1000).toFixed(1)} seconds; ${sum("outputBytes")} command-output bytes.`,
    "",
    "| Case | Variant | Result | CLI calls | Errors | Tokens | Seconds |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...results.map(
      (item) =>
        `| ${item.caseId} | ${item.variant} | ${item.passed ? "PASS" : item.status === "completed" ? "FAIL" : item.status} | ${item.calls} | ${item.errors} | ${item.tokens} | ${(item.durationMs / 1000).toFixed(1)} |`,
    ),
    "",
    "Command errors are friction even when recovered. Tokens are reported app-server usage, not a price estimate. Infrastructure failures are not evidence of model quality.",
    "",
  ].join("\n");
}

/** Correctness wins over cost. Missing, duplicated, or infrastructure-invalid attempts fail closed. */
export function compareAttempts(
  baseline: readonly AttemptSummary[],
  candidate: readonly AttemptSummary[],
) {
  const key = (item: AttemptSummary) => `${item.caseId}:${item.variant}`;
  const before = new Map(baseline.map((item) => [key(item), item]));
  const after = new Map(candidate.map((item) => [key(item), item]));
  const complete =
    baseline.length > 0 &&
    before.size === baseline.length &&
    after.size === candidate.length &&
    before.size === after.size &&
    [...before.keys()].every((id) => after.has(id));
  const valid = [...baseline, ...candidate].every((item) => item.status !== "infrastructureError");
  const regressions = candidate
    .filter((item) => before.get(key(item))?.passed && !item.passed)
    .map(key);
  const gains = candidate
    .filter((item) => before.get(key(item))?.passed === false && item.passed)
    .map(key);
  const total = (items: readonly AttemptSummary[], field: "calls" | "errors" | "outputBytes") =>
    items.reduce((sum, item) => sum + item[field], 0);
  const sameCorrectness = complete && regressions.length === 0 && gains.length === 0;
  // Giving up earlier is not an experience gain. Compare cost only for successful paired tasks.
  const successfulBefore = baseline.filter((item) => item.passed && after.get(key(item))?.passed);
  const successfulAfter = candidate.filter((item) => item.passed && before.get(key(item))?.passed);
  const frictionFields = ["calls", "errors", "outputBytes"] as const;
  const lowerFriction =
    sameCorrectness &&
    frictionFields.every(
      (field) => total(successfulAfter, field) <= total(successfulBefore, field),
    ) &&
    frictionFields.some((field) => total(successfulAfter, field) < total(successfulBefore, field));
  return {
    verdict:
      !complete || !valid
        ? "incomparable"
        : regressions.length > 0
          ? "reject"
          : gains.length > 0 || lowerFriction
            ? "eligible"
            : "noImprovement",
    regressions,
    gains,
  };
}

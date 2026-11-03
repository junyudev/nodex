import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { vitePlusCommand } from "../vite-plus-command";

import {
  compareBaseline,
  finishRatchet,
  followBaselineRenames,
  parseRatchetArguments,
  readBaseline,
  type CountBaseline,
} from "./count-ratchet";

interface Diagnostic {
  readonly filename?: string;
  readonly code?: string;
  readonly severity: string;
  readonly message: string;
  readonly help?: string;
  readonly causes?: readonly string[];
  readonly related?: readonly Diagnostic[];
  readonly labels?: readonly {
    readonly message?: string;
    readonly span: { readonly line: number; readonly column: number; readonly length: number };
  }[];
}

const baselinePath = "scripts/ci/lint-warning-baseline.json";
function ruleKey(diagnostic: Diagnostic): string {
  // Oxlint emits unused-disable diagnostics without a code, including the disabled
  // rule in the message. Keep their identity independent of that rule or wording.
  if (diagnostic.code) return diagnostic.code;
  return /^Unused (?:oxlint|eslint)-disable directive/.test(diagnostic.message)
    ? "oxlint/unused-disable-directive"
    : "oxlint/diagnostic";
}

function filename(diagnostic: Diagnostic): string {
  if (!diagnostic.filename) return "<configuration>";
  return path.relative(process.cwd(), path.resolve(diagnostic.filename)).split(path.sep).join("/");
}

function countWarnings(diagnostics: readonly Diagnostic[]): CountBaseline {
  const counts: CountBaseline = {};
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity !== "warning") continue;
    const rules = (counts[filename(diagnostic)] ??= {});
    const rule = ruleKey(diagnostic);
    rules[rule] = (rules[rule] ?? 0) + 1;
  }
  return counts;
}

function printDiagnostic(diagnostic: Diagnostic): void {
  const first = diagnostic.labels?.[0]?.span;
  console.error(
    `${filename(diagnostic)}:${first?.line ?? 1}:${first?.column ?? 1} ${diagnostic.severity} ${ruleKey(diagnostic)}: ${diagnostic.message}`,
  );
  const lines =
    diagnostic.filename && existsSync(diagnostic.filename)
      ? readFileSync(diagnostic.filename, "utf8").split("\n")
      : [];
  for (const label of diagnostic.labels ?? []) {
    const { line, column, length } = label.span;
    const source = lines[line - 1];
    if (source !== undefined) {
      console.error(`  ${line} | ${source}`);
      console.error(
        `    | ${" ".repeat(column - 1)}${"^".repeat(Math.max(1, Math.min(length, source.length - column + 1)))}${label.message ? ` ${label.message}` : ""}`,
      );
    }
  }
  if (diagnostic.help) console.error(`  help: ${diagnostic.help}`);
  for (const cause of diagnostic.causes ?? []) console.error(`  cause: ${cause}`);
  for (const related of diagnostic.related ?? []) printDiagnostic(related);
}

function main(): number {
  const options = parseRatchetArguments(process.argv.slice(2), "lint-warning-ratchet.ts");
  const baseline = followBaselineRenames(readBaseline(baselinePath, options));
  const invocation = vitePlusCommand(["lint", "--format", "json"]);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Oxlint interrupted by ${result.signal}.`);
  const marker = result.stdout.indexOf('{ "diagnostics"');
  if (marker < 0)
    throw new Error(`Oxlint did not return diagnostics.\n${result.stdout}${result.stderr}`);
  if (result.stderr) process.stderr.write(result.stderr);
  const report = JSON.parse(result.stdout.slice(marker)) as {
    readonly diagnostics: readonly Diagnostic[];
  };
  const counts = countWarnings(report.diagnostics);
  const comparison = compareBaseline(counts, baseline);
  for (const diagnostic of report.diagnostics) {
    if (
      options.all ||
      diagnostic.severity !== "warning" ||
      comparison.regressions.some(
        ({ file, rule }) => filename(diagnostic) === file && ruleKey(diagnostic) === rule,
      )
    )
      printDiagnostic(diagnostic);
  }
  if (
    result.status !== 0 ||
    report.diagnostics.some((diagnostic) => diagnostic.severity === "error")
  )
    return result.status || 1;
  return finishRatchet({
    counts,
    comparison,
    options,
    baselinePath,
    unit: "warnings",
    forbiddenMessage:
      "New lint warnings are forbidden. Fix them or use oxlint-disable-next-line <rule> -- <reason> for a deliberate exception.",
    updateCommand: "vp run lint:baseline",
    updatedLabel: "Lint warning baseline updated",
  });
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

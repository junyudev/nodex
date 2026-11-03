import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vitePlusCommand } from "../vite-plus-command";

type Baseline = Record<string, Record<string, number>>;

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
const growthFlag = "--allow-baseline-growth";
const arguments_ = process.argv.slice(2);
const update = arguments_.includes("--update");
const allowGrowth = arguments_.includes(growthFlag);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBaseline(): Baseline {
  if (!existsSync(baselinePath) && update && allowGrowth) return {};
  const value: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!isRecord(value)) throw new Error(`${baselinePath} must map files to rule counts.`);
  for (const [filename, rules] of Object.entries(value)) {
    if (!isRecord(rules) || Object.keys(rules).length === 0)
      throw new Error(`Invalid warning baseline for ${filename}.`);
    for (const [rule, count] of Object.entries(rules)) {
      if (!rule || typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
        throw new Error(`Invalid warning count for ${filename}: ${rule}.`);
    }
  }
  return value as Baseline;
}

function git(args: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { encoding: "utf8", env: environment });
}

/** A private index lets Git detect unstaged moves without touching the caller's index. */
function followRenames(baseline: Baseline): Baseline {
  if (git(["rev-parse", "--show-toplevel"]).status !== 0) return baseline;
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-lint-renames-"));
  const environment = { ...process.env, GIT_INDEX_FILE: path.join(directory, "index") };
  try {
    for (const args of [
      ["read-tree", "HEAD"],
      ["add", "--all"],
    ]) {
      const result = git(args, environment);
      if (result.status !== 0)
        throw new Error(`Cannot inspect lint baseline renames: ${result.stderr}`);
    }
    const main = ["main", "origin/main"]
      .map((ref) => git(["merge-base", "HEAD", ref]))
      .find((result) => result.status === 0)
      ?.stdout.trim();
    const references = [...new Set([main, "HEAD"].filter((ref) => ref !== undefined))];
    return references.reduce((current, reference) => {
      const result = git(
        ["diff", "--cached", "--name-status", "-z", "--find-renames", reference],
        environment,
      );
      if (result.status !== 0)
        throw new Error(`Cannot inspect lint baseline renames: ${result.stderr}`);
      const fields = result.stdout.split("\0");
      const renames = new Map<string, string>();
      for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++];
        const source = fields[index++];
        if (status.startsWith("R")) renames.set(source, fields[index++]);
      }
      return Object.fromEntries(
        Object.entries(current).map(([filename, rules]) => [
          renames.get(filename) ?? filename,
          rules,
        ]),
      );
    }, baseline);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

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

function countWarnings(diagnostics: readonly Diagnostic[]): Baseline {
  const counts: Baseline = {};
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
  if (arguments_.some((argument) => !["--update", "--all", growthFlag].includes(argument)))
    throw new Error(`Usage: lint-warning-ratchet.ts [--all] [--update [${growthFlag}]]`);
  if (allowGrowth && !update) throw new Error(`${growthFlag} requires --update.`);
  const baseline = followRenames(readBaseline());
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
  const regressions = Object.entries(counts).flatMap(([file, rules]) =>
    Object.entries(rules)
      .filter(([rule, count]) => count > (baseline[file]?.[rule] ?? 0))
      .map(([rule, count]) => ({ file, rule, count, previous: baseline[file]?.[rule] ?? 0 })),
  );
  const stale = Object.entries(baseline).flatMap(([file, rules]) =>
    Object.entries(rules)
      .filter(([rule, count]) => count > (counts[file]?.[rule] ?? 0))
      .map(([rule, count]) => ({ file, rule, count, actual: counts[file]?.[rule] ?? 0 })),
  );
  for (const diagnostic of report.diagnostics) {
    if (
      arguments_.includes("--all") ||
      diagnostic.severity !== "warning" ||
      regressions.some(
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
  for (const { file, rule, count, previous } of regressions)
    console.error(
      `${file}: ${rule}: ${count} warnings (baseline ${previous}, +${count - previous}).`,
    );
  if (regressions.length > 0 && !(update && allowGrowth)) {
    console.error(
      "New lint warnings are forbidden. Fix them or use oxlint-disable-next-line <rule> -- <reason> for a deliberate exception.",
    );
    return 1;
  }
  if (!update && stale.length > 0) {
    for (const { file, rule, count, actual } of stale)
      console.error(`${file}: ${rule}: ${actual} warnings (stale baseline ${count}).`);
    console.error("Run vp run lint:baseline to lock in fixed warnings and file moves.");
    return 1;
  }
  const total = Object.values(counts)
    .flatMap(Object.values)
    .reduce((sum, count) => sum + count, 0);
  if (!update) {
    console.log(`${total} baseline warnings, 0 new.`);
    return 0;
  }
  if (allowGrowth)
    console.error(`WARNING: ${growthFlag} permits baseline increases; review every added warning.`);
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(counts[file])
            .sort()
            .map((rule) => [rule, counts[file][rule]]),
        ),
      ]),
  );
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
  console.log(`Lint warning baseline updated: ${total} warnings.`);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

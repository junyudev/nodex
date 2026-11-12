import { execFileSync } from "node:child_process";
import type { JSONReport, JSONReportSuite } from "@playwright/test/reporter";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { resolveElectronE2eGrepInvert } from "../../config/playwright.e2e.config.ts";
import {
  APP_TEST_SUITES,
  STANDARD_TEST_SUITES,
  STRESS_TEST_SUITES,
  LIVE_TEST_SUITES,
  maintainedThirdPartyTests,
  ownersOfTest,
  type SuiteId,
} from "../../config/test-suites.ts";
import type { VitestTestTier } from "../../config/vitest-test-tier.ts";
import { discoverSuite } from "../testing/runtime.ts";
import { withCommandSignal } from "../tooling/process.ts";

export interface DiscoveredSuite {
  readonly suite: SuiteId;
  readonly tier: VitestTestTier;
  readonly files: readonly string[];
}

/** Candidate enumeration is independent of suite globs, including newly added files. */
export function ownedTestCandidates(files: readonly string[]): readonly string[] {
  return files.filter((file) => {
    if (maintainedThirdPartyTests.includes(file)) return true;
    if (!/^(src|scripts|config|packages)\//u.test(file)) return false;
    // These intentionally invalid programs are inputs to tooling:verify, never runnable tests.
    if (file.startsWith("scripts/fixtures/")) return false;
    return /\.(?:test|spec|integration)\.[cm]?[jt]sx?$/u.test(file);
  });
}

export function verifyTestInventory(
  candidates: readonly string[],
  discovered: readonly DiscoveredSuite[],
): void {
  const actual = new Map<string, string[]>();
  for (const selection of discovered) {
    for (const file of selection.files) {
      const owner = selection.suite + ":" + selection.tier;
      actual.set(file, [...(actual.get(file) ?? []), owner]);
    }
  }
  const problems: string[] = [];
  for (const file of new Set([...candidates, ...actual.keys()])) {
    const owners = ownersOfTest(file);
    const collected = actual.get(file) ?? [];
    if (owners.length !== 1) {
      problems.push(file + ": " + owners.length + " declared owners");
      continue;
    }
    const { suite, tier } = owners[0];
    const expected = suite + ":" + tier;
    if (collected.length !== 1 || collected[0] !== expected) {
      problems.push(file + ": expected " + expected + ", discovered " + JSON.stringify(collected));
    }
    const reachable =
      tier === "live"
        ? LIVE_TEST_SUITES.includes(suite)
        : tier === "stress"
          ? STRESS_TEST_SUITES.includes(suite)
          : STANDARD_TEST_SUITES.includes(suite as Exclude<SuiteId, "browser">) ||
            suite === "browser";
    if (!reachable) problems.push(file + ": unreachable from standard/browser/stress/live gates");
  }
  if (problems.length) throw new Error("Test inventory failed:\n" + problems.join("\n"));
}

/** Every spec with manual cases needs a recommendation, including mixed specs. */
export function verifyE2eTriage(
  specFiles: readonly string[],
  automaticOnly: ReadonlySet<string>,
  triage: string,
): void {
  const rows = new Set<string>();
  const specs = new Set(specFiles);
  const problems: string[] = [];
  const row =
    /^\|\s*`([^`]+)`\s*\|\s*(?:keep manual|move down|merge|delete)\s*\|\s*[^|\s][^|]*\|\s*$/u;
  for (const line of triage.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*(?:Spec\s*\||-)/u.test(line)) continue;
    const file = row.exec(line)?.[1];
    if (!file) {
      problems.push(`Invalid triage row: ${line}`);
      continue;
    }
    if (!specs.has(file)) problems.push(`${file}: triage row names a missing spec`);
    if (rows.has(file)) problems.push(`${file}: duplicate triage row`);
    rows.add(file);
  }
  for (const file of specs) {
    if (!automaticOnly.has(file) && !rows.has(file)) {
      problems.push(`${file}: missing triage row`);
    }
  }
  if (problems.length) throw new Error("Electron E2E triage failed:\n" + problems.join("\n"));
}

function verifyRepositoryE2eTriage(root: string): void {
  const directory = path.join(root, "tests/e2e");
  const specFiles = readdirSync(directory).filter((file) => file.endsWith(".spec.ts"));
  const playwrightCli = createRequire(import.meta.url).resolve("@playwright/test/cli");
  const output = execFileSync(
    process.execPath,
    [
      playwrightCli,
      "test",
      "--config",
      "config/playwright.e2e.config.ts",
      "--list",
      "--reporter=json",
    ],
    {
      cwd: root,
      encoding: "utf8",
      // Collect performance cases as well so a mixed spec still needs a triage row.
      env: {
        ...process.env,
        NODEX_E2E_INCLUDE_PERFORMANCE: "1",
        PLAYWRIGHT_JSON_OUTPUT_FILE: "",
        PLAYWRIGHT_JSON_OUTPUT_NAME: "",
      },
    },
  );
  const report = JSON.parse(output) as JSONReport;
  const excluded = resolveElectronE2eGrepInvert(false);
  const automaticByFile = new Map<string, boolean>();
  const collect = (suite: JSONReportSuite): void => {
    for (const spec of suite.specs) {
      const automatic =
        spec.tags.includes("automatic") &&
        !excluded.test(spec.tags.map((tag) => `@${tag}`).join(" "));
      automaticByFile.set(spec.file, (automaticByFile.get(spec.file) ?? true) && automatic);
    }
    suite.suites?.forEach(collect);
  };
  report.suites.forEach(collect);
  const automaticOnly = new Set(
    [...automaticByFile].filter(([, automatic]) => automatic).map(([file]) => file),
  );
  verifyE2eTriage(
    specFiles,
    automaticOnly,
    readFileSync(path.join(directory, "TRIAGE.md"), "utf8"),
  );
}

export async function verifyRepositoryTestInventory(
  root: string,
  signal: AbortSignal,
): Promise<void> {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter((file) => file && existsSync(path.join(root, file)));
  verifyRepositoryE2eTriage(root);
  const candidates = ownedTestCandidates(files);
  const discovered: DiscoveredSuite[] = [];
  for (const tier of ["default", "stress", "live"] as const) {
    const tierSuites = tier === "live" ? LIVE_TEST_SUITES : APP_TEST_SUITES;
    for (const suite of tierSuites) {
      if (signal.aborted) throw new Error("Test inventory cancelled.");
      const suiteFiles = await discoverSuite(suite, [], false, {
        cwd: root,
        env: { ...process.env, NODEX_TEST_TIER: tier, NODEX_TEST_TIMINGS: "" },
        signal,
      });
      discovered.push({ suite, tier, files: suiteFiles });
    }
  }
  verifyTestInventory(candidates, discovered);
  if (process.env.NODEX_TEST_TIMINGS) {
    await mkdir(process.env.NODEX_TEST_TIMINGS, { recursive: true });
    await writeFile(
      path.join(process.env.NODEX_TEST_TIMINGS, "inventory.json"),
      JSON.stringify({ candidates, discovered }, null, 2) + "\n",
    );
  }
  process.stdout.write(
    "Test inventory: " +
      candidates.length +
      " uniquely owned files across " +
      APP_TEST_SUITES.length +
      " runtime suites; tooling fixtures use tooling:verify, tests/e2e uses Playwright, crates use Cargo.\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    try {
      await verifyRepositoryTestInventory(path.resolve(import.meta.dirname, "../.."), signal);
      return 0;
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}

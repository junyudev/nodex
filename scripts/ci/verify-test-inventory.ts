import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  APP_TEST_SUITES,
  STANDARD_TEST_SUITES,
  STRESS_TEST_SUITES,
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
      tier === "stress"
        ? STRESS_TEST_SUITES.includes(suite)
        : STANDARD_TEST_SUITES.includes(suite as Exclude<SuiteId, "browser">) ||
          suite === "browser";
    if (!reachable) problems.push(file + ": unreachable from standard/browser/stress gates");
  }
  if (problems.length) throw new Error("Test inventory failed:\n" + problems.join("\n"));
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
  const candidates = ownedTestCandidates(files);
  const discovered: DiscoveredSuite[] = [];
  for (const tier of ["default", "stress"] as const) {
    for (const suite of APP_TEST_SUITES) {
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

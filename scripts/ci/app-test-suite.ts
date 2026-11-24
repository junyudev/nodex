import { appendFileSync } from "node:fs";
import path from "node:path";
import { cachedAppLanes, parseCiGatePlan } from "./ci-gate-plan.ts";

import {
  nativeRequirements,
  isNativeExecutable,
  parseTestSuite,
  runtimeForSuite,
  type SuiteId as AppTestSuite,
} from "../../config/test-suites.ts";

export interface AppTestSuitePlan {
  readonly needsPlaywright: boolean;
  readonly needsRust: boolean;
  readonly needsXvfb: boolean;
  readonly packageScript: string;
  readonly relatedPackageScript: string;
}

export const planAppTestSuite = (
  suite: AppTestSuite,
  platform: NodeJS.Platform = process.platform,
): AppTestSuitePlan => ({
  needsPlaywright: runtimeForSuite(suite) === "chromium",
  needsRust: nativeRequirements(suite, undefined, platform).some(isNativeExecutable),
  needsXvfb: platform === "linux" && runtimeForSuite(suite) === "electron-node",
  packageScript: "test:" + suite,
  relatedPackageScript: "test:" + suite + ":related",
});

export const parseAppTestSuite = parseTestSuite;

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
};

const main = (): void => {
  const args = process.argv.slice(2);
  const lane = readOption(args, "--lane");
  const segments = lane
    ? cachedAppLanes(parseCiGatePlan(JSON.parse(process.env.CI_GATE_PLAN_JSON ?? "null"))).get(lane)
    : [{ suite: parseAppTestSuite(readOption(args, "--suite") ?? ""), shard: 0 }];
  if (!segments?.length) throw new Error("Application CI lane is not selected: " + lane);
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  const suitePlans = segments.map(({ suite }) => planAppTestSuite(suite));
  appendFileSync(
    output,
    [
      `needs_playwright=${suitePlans.some((plan) => plan.needsPlaywright)}`,
      `needs_rust=${suitePlans.some((plan) => plan.needsRust)}`,
      `needs_xvfb=${suitePlans.some((plan) => plan.needsXvfb)}`,
      ...segments.flatMap(({ suite, shard }, index) => [
        `segment_${index + 1}=${suite}:${shard}`,
        `segment_${index + 1}_xvfb=${suitePlans[index].needsXvfb}`,
      ]),
      "",
    ].join("\n"),
    "utf8",
  );
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

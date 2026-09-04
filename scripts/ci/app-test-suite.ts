import { appendFileSync } from "node:fs";
import path from "node:path";

import {
  nativeRequirements,
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

export const planAppTestSuite = (suite: AppTestSuite): AppTestSuitePlan => ({
  needsPlaywright: runtimeForSuite(suite) === "chromium",
  needsRust: nativeRequirements(suite).length > 0,
  needsXvfb: runtimeForSuite(suite) === "electron-node",
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
  const suite = parseAppTestSuite(readOption(process.argv.slice(2), "--suite") ?? "");
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  const suitePlan = planAppTestSuite(suite);
  appendFileSync(
    output,
    [
      `needs_playwright=${suitePlan.needsPlaywright}`,
      `needs_rust=${suitePlan.needsRust}`,
      `needs_xvfb=${suitePlan.needsXvfb}`,
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

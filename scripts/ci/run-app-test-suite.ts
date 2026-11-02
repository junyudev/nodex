import { spawnSync } from "node:child_process";
import path from "node:path";

import { parseAppTestSuite, planAppTestSuite } from "./app-test-suite.ts";
import { parseCiGatePlan } from "./ci-gate-plan.ts";

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
};

export const commandForAppTestSuite = (
  suiteValue: string,
  planValue: unknown,
): readonly string[] => {
  const suite = parseAppTestSuite(suiteValue);
  const plan = parseCiGatePlan(planValue);
  if (!plan.appTestSuites.includes(suite)) {
    throw new Error(`Application suite ${JSON.stringify(suite)} is not selected by the gate plan.`);
  }
  const suitePlan = planAppTestSuite(suite);
  if (plan.testMode === "full")
    return [process.platform === "win32" ? "vp.cmd" : "vp", "run", suitePlan.packageScript];
  if (plan.testMode === "related") {
    return [
      process.platform === "win32" ? "vp.cmd" : "vp",
      "run",
      suitePlan.relatedPackageScript,
      ...plan.relatedPaths.map((changedPath) => `./${changedPath}`),
    ];
  }
  throw new Error("A selected application suite requires full or related test mode.");
};

const main = (): void => {
  const args = process.argv.slice(2);
  const suite = readOption(args, "--suite") ?? "";
  const planJson = process.env.CI_GATE_PLAN_JSON;
  if (!planJson) throw new Error("CI_GATE_PLAN_JSON is required.");
  const command = commandForAppTestSuite(suite, JSON.parse(planJson) as unknown);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

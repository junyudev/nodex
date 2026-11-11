import { spawnSync } from "node:child_process";
import { acquireMachineBudget } from "./machine-budget.ts";

/** Runs a command inside a claim on the shared computer budget. */
const args = process.argv.slice(2);
const separator = args.indexOf("--");
const weight = Number(args[0]);
const label = args[1];
if (separator !== 2 || !Number.isSafeInteger(weight) || weight <= 0 || !label || !args[3]) {
  throw new Error("Usage: with-machine-budget.ts <weight> <label> -- <command> [...args]");
}
void acquireMachineBudget({ weight, label }, { env: process.env, cwd: process.cwd() }).then(
  (lease) => {
    const result = spawnSync(args[3]!, args.slice(4), {
      env: { ...process.env, ...lease.env },
      stdio: "inherit",
    });
    lease.release();
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  },
);

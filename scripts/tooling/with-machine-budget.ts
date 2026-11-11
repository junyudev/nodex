import { spawnSync } from "node:child_process";
import { acquireMachineBudget } from "./machine-budget.ts";

/** Runs a shell command line inside a claim on the shared computer budget. */
const args = process.argv.slice(2);
const weight = Number(args[0]);
const memoryGiB = Number(args[1]);
const label = args[2];
const command = args.slice(4).join(" ");
if (
  args[3] !== "--" ||
  !Number.isSafeInteger(weight) ||
  weight <= 0 ||
  !(memoryGiB >= 0) ||
  !label ||
  !command
) {
  throw new Error("Usage: with-machine-budget.ts <cores> <memory GiB> <label> -- <command line>");
}
void acquireMachineBudget(
  { weight, memoryGiB, label },
  { env: process.env, cwd: process.cwd() },
).then((lease) => {
  const result = spawnSync(command, {
    env: { ...process.env, ...lease.env },
    shell: true,
    stdio: "inherit",
  });
  lease.release();
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
});

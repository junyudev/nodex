import { runVitePlus } from "./vite-plus-command";

const args = process.argv.slice(2);
const separator = args.indexOf("--");
if (separator < 1 || separator === args.length - 1)
  throw new Error("Usage: run-with-environment.ts NAME=value [...] -- <command> [...args]");
const overrides = Object.fromEntries(
  args.slice(0, separator).map((assignment) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(assignment);
    if (!match) throw new Error(`Invalid environment assignment: ${assignment}`);
    return [match[1]!, match[2]!];
  }),
);
runVitePlus(["exec", ...args.slice(separator + 1)], { env: { ...process.env, ...overrides } });

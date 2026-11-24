import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCLI, startVitest } from "vite-plus/test/node";
import { prioritizeTests } from "./cache-test-order.ts";

const [directory, ...args] = process.argv.slice(2);
if (!directory) throw new Error("Expected an isolated Vitest directory.");
const priority = JSON.parse(
  await readFile(path.join(directory, "priority.json"), "utf8"),
) as string[];
const { filter, options } = parseCLI(["vitest", ...args]);

// The ordinary fallback can overlap recorded batches, other fallbacks and discovery.
await startVitest(
  filter,
  {
    ...options,
    fsModuleCachePath: path.join(directory, "transforms"),
    ...(priority.length
      ? { sequence: { sequencer: prioritizeTests(process.cwd(), priority) } }
      : {}),
  },
  { cacheDir: path.join(directory, "vite") },
);

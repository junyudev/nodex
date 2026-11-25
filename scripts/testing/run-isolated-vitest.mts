import { readFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, parseCLI, startVitest } from "vite-plus/test/node";
import { prioritizeTests, runSelectedTestFiles } from "./cache-test-order.ts";

const [directory, ...args] = process.argv.slice(2);
if (!directory) throw new Error("Expected an isolated Vitest directory.");
const priority = JSON.parse(
  await readFile(path.join(directory, "priority.json"), "utf8"),
) as string[];
const { filter, options } = parseCLI(["vitest", ...args]);

// The ordinary fallback can overlap recorded batches, other fallbacks and discovery.
const settings = {
  ...options,
  fsModuleCachePath: path.join(directory, "transforms"),
  ...(priority.length ? { sequence: { sequencer: prioritizeTests(process.cwd(), priority) } } : {}),
};
const vite = { cacheDir: path.join(directory, "vite") };
const files = await readFile(path.join(directory, "files.json"), "utf8").catch((error: unknown) => {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  return undefined;
});

if (files === undefined) {
  await startVitest(filter, settings, vite);
} else {
  const runner = await createVitest(settings, vite);
  try {
    await runSelectedTestFiles(runner, process.cwd(), JSON.parse(files) as string[]);
  } finally {
    await runner.close();
  }
}

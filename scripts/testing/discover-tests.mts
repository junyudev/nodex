import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, parseCLI } from "vite-plus/test/node";
import { parseTestSuite, suiteConfig } from "../../config/test-suites.ts";

/** Discover in the suite's actual runtime without collecting or executing test modules. */
export async function discoverTests(suite: string, args: readonly string[], related: boolean) {
  const { filter, options } = parseCLI(["vitest", related ? "related" : "run", ...args]);
  const context = await createVitest("test", {
    ...options,
    config: suiteConfig(parseTestSuite(suite)),
    watch: false,
    reporters: [],
  });
  try {
    const specifications = related
      ? await context.getRelevantTestSpecifications(filter)
      : await context.globTestSpecifications(filter);
    return [
      ...new Set(
        specifications.map((specification) =>
          path.relative(process.cwd(), specification.moduleId).replaceAll(path.sep, "/"),
        ),
      ),
    ].sort();
  } finally {
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [suite, output, mode, ...args] = process.argv.slice(2);
  if (!suite || !output || !["run", "related"].includes(mode)) {
    throw new Error("Expected suite, manifest path, run/related, and optional Vitest arguments.");
  }
  const files = await discoverTests(suite, args, mode === "related");
  await writeFile(output, JSON.stringify(files, null, 2) + "\n");
}

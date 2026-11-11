import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, parseCLI } from "vite-plus/test/node";
import { parseTestSuite, suiteConfig } from "../../config/test-suites.ts";

/** Discover in the suite's actual runtime without collecting or executing test modules. */
export async function discoverTests(suite: string, args: readonly string[], related: boolean) {
  const { filter, options } = parseCLI(["vitest", related ? "related" : "run", ...args]);
  const context = await createVitest({
    ...options,
    config: suiteConfig(parseTestSuite(suite)),
    watch: false,
    reporters: [],
  });
  try {
    const specifications = related
      ? await context.getRelevantTestSpecifications(filter)
      : await context.globTestSpecifications(filter);
    const files = [
      ...new Set(
        specifications.map((specification) =>
          path.relative(process.cwd(), specification.moduleId).replaceAll(path.sep, "/"),
        ),
      ),
    ].sort();
    // Vitest gives VM pool files fresh realms even when the worker process is reused.
    const isolated = specifications.every(
      ({ project, pool }) =>
        (project.config.isolate || pool === "vmForks" || pool === "vmThreads") &&
        !project.config.browser.enabled &&
        project.config.experimental.viteModuleRunner !== false,
    );
    return { files, isolated };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [suite, output, mode, ...args] = process.argv.slice(2);
  if (!suite || !output || !["run", "related"].includes(mode)) {
    throw new Error("Expected suite, manifest path, run/related, and optional Vitest arguments.");
  }
  const manifest = await discoverTests(suite, args, mode === "related");
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
}

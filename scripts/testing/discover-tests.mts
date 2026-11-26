import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createVitest, parseCLI } from "vite-plus/test/node";
import {
  ownerOfTest,
  parseTestSuite,
  suiteConfig,
  type SuiteId,
} from "../../config/test-suites.ts";

import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { findCheckoutFocusedTests } from "./focused-tests.ts";
import { discoveryModes, resolveRelatedPaths } from "./runtime.ts";

type DiscoveryMode = (typeof discoveryModes)[number];

const relativeFile = (file: string) => path.relative(process.cwd(), file).replaceAll(path.sep, "/");

/** Discover in the suite's actual runtime without collecting or executing test modules. */
async function discoverTests(
  suite: SuiteId,
  args: readonly string[],
  mode: DiscoveryMode,
  directory: string,
) {
  const { filter, options } = parseCLI(["vitest", mode === "run" ? "run" : "related", ...args]);
  const related = resolveRelatedPaths(options.related);
  const context = await createVitest(
    {
      ...options,
      related,
      config: suiteConfig(suite),
      watch: false,
      reporters: [],
      fsModuleCache: false,
    },
    { cacheDir: path.join(directory, "vite") },
  );
  try {
    const focusNightly =
      mode === "default-with-related-nightly" ||
      (mode === "related" && resolveVitestTestTier(process.env.NODEX_TEST_TIER) === "nightly");
    const focused = focusNightly
      ? new Set(
          findCheckoutFocusedTests(process.cwd(), (related ?? []).map(relativeFile), true)[suite],
        )
      : undefined;
    const candidates =
      mode === "related" && !focusNightly
        ? await context.getRelevantTestSpecifications(filter)
        : await context.globTestSpecifications(filter);
    const specifications = focused
      ? candidates.filter(({ moduleId }) => {
          const file = relativeFile(moduleId);
          const owner = ownerOfTest(file);
          return owner?.tier === "nightly"
            ? focused.has(file)
            : mode === "default-with-related-nightly" && owner?.tier === "default";
        })
      : candidates;
    const files = [...new Set(specifications.map(({ moduleId }) => relativeFile(moduleId)))].sort();
    // Vitest gives VM pool files fresh realms even when the worker process is reused.
    const isolated =
      files.length === specifications.length &&
      specifications.every(
        ({ project, pool }) =>
          (project.config.isolate || pool === "vmForks" || pool === "vmThreads") &&
          !project.config.browser.enabled &&
          project.config.experimental.viteModuleRunner !== false,
      );
    const configDependencies = [
      ...new Set([
        ...context.vite.config.configFileDependencies,
        ...context.projects.flatMap((project) => project.vite.config.configFileDependencies),
      ]),
    ].sort();
    return {
      files,
      configDependencies,
      isolated,
      runtime: { versions: process.versions, platform: process.platform, arch: process.arch },
    };
  } finally {
    await context.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [suite, output, modeValue, ...args] = process.argv.slice(2);
  const mode = discoveryModes.find((mode) => mode === modeValue);
  if (!suite || !output || !mode) {
    throw new Error(
      "Expected suite, manifest path, discovery mode, and optional Vitest arguments.",
    );
  }
  const manifest = await discoverTests(parseTestSuite(suite), args, mode, path.dirname(output));
  await writeFile(output, JSON.stringify(manifest, null, 2) + "\n");
}

import type { Reporter, Vitest } from "vite-plus/test/node";

/** Use the runner's own transform directories, including the pinned VM-pool scratch cache. */
export function identifyVitestTransformCaches(vitest: Vitest) {
  const rootScratch = (vitest as Vitest & { _tmpDir?: string })._tmpDir;
  const paths = [
    rootScratch,
    vitest.viteConfig.cacheDir,
    vitest.config.fsModuleCachePath,
    ...vitest.projects.flatMap((project) => [
      project.tmpDir,
      project.viteConfig.cacheDir,
      project.config.fsModuleCachePath,
    ]),
  ].filter((directory) => typeof directory === "string");
  process.env.NODEX_TEST_TRANSFORM_CACHES = JSON.stringify(paths);
}

export default class TestObservationTransformCache implements Reporter {
  onInit(vitest: Vitest) {
    identifyVitestTransformCaches(vitest);
  }
}

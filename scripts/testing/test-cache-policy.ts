import { createHash } from "node:crypto";
import path from "node:path";
import { nativeRequirements } from "../../config/test-suites.ts";

export const CACHE_SUITES = ["unit", "renderer"] as const;
export type CacheSuite = (typeof CACHE_SUITES)[number];
export const isCacheSuite = (value: string): value is CacheSuite =>
  CACHE_SUITES.some((suite) => suite === value);

/** Toolchain, OS process, and generated-artifact tests use the ordinary suite runner. */
export function canCacheFile(suite: CacheSuite, file: string): boolean {
  return (
    nativeRequirements(suite, [file]).length === 0 &&
    !/^(?:config\/|scripts\/|packages\/mobile\/src\/native-tests\/)/u.test(file) &&
    ![
      "packages/landing/src/landing-build.test.ts",
      "packages/nodex-app-tools-mcp/src/bundle.test.ts",
      "packages/nodex-app-tools-mcp/src/pipe.test.ts",
      "src/renderer/lib/settings-search-score.node.test.ts",
      "src/shared/block-documents/yjs-yrs-fixture-generator.test.ts",
      "src/shared/database-view-rules.test.ts",
    ].includes(file) &&
    !path.isAbsolute(file) &&
    path.posix.normalize(file) === file &&
    !file.startsWith("../")
  );
}

export function partitionCacheFiles(suite: CacheSuite, files: readonly string[]) {
  const cacheable: string[] = [];
  const uncached: string[] = [];
  for (const file of [...new Set(files)].sort()) {
    (canCacheFile(suite, file) ? cacheable : uncached).push(file);
  }
  return { cacheable, uncached };
}

export function chooseCacheAudits(hits: readonly string[], seed: string, count = 1): string[] {
  const ranked = [...new Set(hits)].map((file) => ({
    file,
    rank: createHash("sha256")
      .update(JSON.stringify([seed, file]))
      .digest("hex"),
  }));
  return ranked
    .toSorted((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, count)
    .map(({ file }) => file);
}

export function relativeInput(root: string, file: string): string | undefined {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative))
    return undefined;
  return relative;
}

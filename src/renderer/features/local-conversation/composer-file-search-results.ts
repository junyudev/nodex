import type { FuzzyFileSearchResult } from "@nodex/codex-app-server-protocol";
import type { ComposerFileSearchMatch } from "../../../shared/composer-file-search";
import { createFuzzyQueryScorer } from "@/lib/settings-search-score";

const excludedSegments = new Set([
  ".git",
  ".hg",
  ".next",
  ".pnpm-store",
  ".svn",
  ".turbo",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
]);

/** Re-rank only the native session's bounded matches, keeping file and directory mentions. */
export function projectComposerFileSearchResults(
  files: readonly FuzzyFileSearchResult[],
  query: string,
): ComposerFileSearchMatch[] {
  const score = createFuzzyQueryScorer(query.trim());
  return files
    .filter((file) => !file.path.split(/[\\/]+/u).some((segment) => excludedSegments.has(segment)))
    .map((file, index) => ({ file, index, score: score(file.file_name) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.file.file_name < right.file.file_name
          ? -1
          : left.file.file_name > right.file.file_name
            ? 1
            : left.index - right.index),
    )
    .map(({ file }) => ({
      path: file.path,
      fsPath: `${file.root.replace(/[\\/]+$/u, "")}/${file.path.replace(/^[\\/]+/u, "")}`,
      label: file.file_name,
      kind: file.match_type,
    }));
}

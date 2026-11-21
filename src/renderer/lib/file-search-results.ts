import {
  FILE_SEARCH_EXCLUDED_SEGMENTS,
  type FileSearchMatch,
  type FileSearchResult,
} from "../../shared/file-search";
import { normalizeSearchPath, resolveSearchResultPath } from "../../shared/file-search-paths";
import { createFuzzyQueryScorer } from "./settings-search-score";

const excludedSegments = new Set<string>(FILE_SEARCH_EXCLUDED_SEGMENTS);

/** Re-rank only the native session's bounded matches, keeping file and directory mentions. */
export function projectFileSearchResults(
  files: readonly FileSearchResult[],
  query: string,
  roots: readonly string[],
): FileSearchMatch[] {
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
    .map(({ file }) => {
      const relativePath = normalizeSearchPath(file.path);
      const fsPath = resolveSearchResultPath(file.root, file.path);
      const rootLabel = normalizeSearchPath(file.root).replace(/\/+$/u, "").split("/").at(-1) ?? "";
      const displayPath =
        roots.length > 1 && rootLabel ? `${rootLabel}/${relativePath}` : relativePath;
      return {
        root: file.root,
        relativePath,
        path: roots.length > 1 ? fsPath : relativePath,
        fsPath,
        label: file.file_name,
        directoryPath: displayPath.substring(0, displayPath.lastIndexOf("/")),
        kind: file.match_type,
      };
    });
}

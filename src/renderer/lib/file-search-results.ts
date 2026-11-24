import {
  FILE_SEARCH_EXCLUDED_SEGMENTS,
  type FileSearchMatch,
  type FileSearchResult,
  type FileSearchTextRange,
} from "../../shared/file-search";
import { normalizeSearchPath, resolveSearchResultPath } from "../../shared/file-search-paths";

const excludedSegments = new Set<string>(FILE_SEARCH_EXCLUDED_SEGMENTS);
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function pushRange(ranges: FileSearchTextRange[], start: number, end: number): void {
  const previous = ranges.at(-1);
  if (previous?.end === start) ranges[ranges.length - 1] = { start: previous.start, end };
  else ranges.push({ start, end });
}

/**
 * Maps the search's matched grapheme positions in a root-relative path onto the displayed name
 * and folder. `directoryOffset` is where the path's folder begins in the displayed folder.
 */
export function matchedFileSearchRanges(
  path: string,
  indices: readonly number[],
  directoryOffset: number,
): NonNullable<FileSearchMatch["matched"]> {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const nameStart = separator + 1;
  const wanted = new Set(indices);
  const label: FileSearchTextRange[] = [];
  const directory: FileSearchTextRange[] = [];
  let position = 0;
  for (const { index, segment } of graphemes.segment(path)) {
    if (wanted.has(position)) {
      const end = index + segment.length;
      if (index >= nameStart) pushRange(label, index - nameStart, end - nameStart);
      else if (end <= separator)
        pushRange(directory, directoryOffset + index, directoryOffset + end);
    }
    position += 1;
  }
  return { label, directory };
}

/** Keeps the native session's order; generated folders stay out of results from any host. */
export function projectFileSearchResults(
  files: readonly FileSearchResult[],
  roots: readonly string[],
): FileSearchMatch[] {
  return files
    .filter((file) => !file.path.split(/[\\/]+/u).some((segment) => excludedSegments.has(segment)))
    .map((file) => {
      const relativePath = normalizeSearchPath(file.path);
      const fsPath = resolveSearchResultPath(file.root, file.path);
      const rootLabel = normalizeSearchPath(file.root).replace(/\/+$/u, "").split("/").at(-1) ?? "";
      const displayPath =
        roots.length > 1 && rootLabel ? `${rootLabel}/${relativePath}` : relativePath;
      // Folder highlights need the displayed path to keep the reported characters in place.
      const aligned = relativePath === file.path.replaceAll("\\", "/");
      const matched =
        file.indices && aligned
          ? matchedFileSearchRanges(
              file.path,
              file.indices,
              displayPath.length - relativePath.length,
            )
          : undefined;
      return {
        root: file.root,
        relativePath,
        path: roots.length > 1 ? fsPath : relativePath,
        fsPath,
        label: file.file_name,
        directoryPath: displayPath.substring(0, displayPath.lastIndexOf("/")),
        kind: file.match_type,
        ...(matched ? { matched } : {}),
      };
    });
}

/** Normalize host paths without depending on the renderer's operating system. */
export function normalizeSearchPath(path: string): string {
  const value = path.replaceAll("\\", "/");
  const prefix = value.startsWith("//") ? "//" : value.startsWith("/") ? "/" : "";
  const segments: string[] = [];
  const rootDepth = value.startsWith("//") ? 2 : /^[a-z]:\//iu.test(value) ? 1 : 0;
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === ".." && segments.length > rootDepth && segments.at(-1) !== "..") {
      segments.pop();
      continue;
    }
    if (segment === ".." && (prefix || rootDepth > 0)) continue;
    segments.push(segment);
  }
  const result = `${prefix}${segments.join("/")}`;
  return /^[a-z]:$/iu.test(result) ? `${result}/` : result;
}

export function isWindowsSearchPath(path: string): boolean {
  return /^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\") || path.startsWith("//");
}

export function isAbsoluteSearchPath(path: string): boolean {
  return !path.includes("\0") && (path.startsWith("/") || isWindowsSearchPath(path));
}

function comparableSearchPath(path: string): string {
  const normalized = normalizeSearchPath(path);
  return isWindowsSearchPath(path) ? normalized.toLowerCase() : normalized;
}

/** Search comparisons follow the path's host syntax without changing file resource identity. */
export function searchPathsEqual(left: string, right: string): boolean {
  return comparableSearchPath(left) === comparableSearchPath(right);
}

export function searchRootContainsPath(root: string, path: string): boolean {
  const parent = comparableSearchPath(root);
  if (!parent) return false;
  const child = comparableSearchPath(path);
  return child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

/** Keep the first occurrence and omit roots already contained in another selected root. */
export function compactFileSearchRoots(roots: readonly string[]): string[] {
  const normalized = roots.filter((root) => root.trim().length > 0);
  const comparable = normalized.map(comparableSearchPath);
  return normalized.filter((_, index) =>
    comparable.every((parent, parentIndex) => {
      if (parentIndex === index) return true;
      const current = comparable[index]!;
      if (parent === current) return parentIndex > index;
      return !current.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
    }),
  );
}

export function resolveSearchResultPath(root: string, path: string): string {
  const separator = /[\\/]$/u.test(root) ? "" : "/";
  const resolved = normalizeSearchPath(
    isAbsoluteSearchPath(path) ? path : `${root}${separator}${path}`,
  );
  return isWindowsSearchPath(root) ? resolved.replaceAll("/", "\\") : resolved;
}

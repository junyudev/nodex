const UNIX_HOME_PATTERN = /^\/(?:Users|home)\/[^/]+(?=\/|$)/;
const WINDOWS_HOME_PATTERN = /^[A-Za-z]:\/Users\/[^/]+(?=\/|$)/;

export function normalizeDisplayPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/(?<=.)\/+$/, "");
}

export function isAbsoluteDisplayPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:\//.test(value);
}

/** The renderer has no home directory authority; a conventional cwd prefix implies it. */
function inferHomeDirectory(normalizedCwd: string | null): string | null {
  if (!normalizedCwd) return null;
  return (
    UNIX_HOME_PATTERN.exec(normalizedCwd)?.[0] ??
    WINDOWS_HOME_PATTERN.exec(normalizedCwd)?.[0] ??
    null
  );
}

/**
 * Shortest readable spelling of an absolute path for a reader working in `cwd`:
 * `.` or `./relative` inside the working directory, `~` or `~/relative` inside the
 * inferred home directory, and the normalized absolute path otherwise.
 */
export function formatDisplayPath(path: string, cwd: string | null | undefined): string {
  const normalized = normalizeDisplayPath(path);
  const normalizedCwd = cwd ? normalizeDisplayPath(cwd) : null;
  if (normalizedCwd && normalizedCwd !== "/") {
    if (normalized === normalizedCwd) return ".";
    if (normalized.startsWith(`${normalizedCwd}/`))
      return `./${normalized.slice(normalizedCwd.length + 1)}`;
  }
  const home = inferHomeDirectory(normalizedCwd);
  if (home) {
    if (normalized === home) return "~";
    if (normalized.startsWith(`${home}/`)) return `~/${normalized.slice(home.length + 1)}`;
  }
  return normalized;
}

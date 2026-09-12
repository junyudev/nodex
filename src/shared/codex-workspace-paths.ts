const isWindowsPath = (value: string): boolean =>
  /^[A-Za-z]:[\\/]/.test(value) ||
  /^\\\\[^\\]+\\[^\\]+/.test(value) ||
  /^\/\/[^/]+\/[^/]+/.test(value);

const isPosixPath = (value: string): boolean => value.startsWith("/") && !value.startsWith("//");

/** Runtime roots use the path family of the executing working directory. */
export function workspaceRootsForCwd(cwd: string | null, roots: readonly string[]): string[] {
  if (cwd === null) return [];
  if (isWindowsPath(cwd)) return roots.filter(isWindowsPath);
  if (isPosixPath(cwd)) return roots.filter(isPosixPath);
  return [];
}

function stripWindowsDevicePrefix(value: string): string {
  const unc = value.match(/^\\\\\?\\UNC\\(.*)$/i);
  if (unc) return `\\\\${unc[1]}`;
  return value.match(/^\\\\\?\\([A-Za-z]:[\\/].*)$/)?.[1] ?? value;
}

function windowsComparablePath(value: string): string {
  const normalized = stripWindowsDevicePrefix(value).replaceAll("\\", "/").toLowerCase();
  const wsl = normalized.match(/^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(?:\/(.*))?$/);
  if (wsl) return wsl[1] ? `/${wsl[1]}` : "/";
  const drive = normalized.match(/^\/?([a-z]):(?:\/(.*))?$/);
  if (drive) return drive[2] ? `/mnt/${drive[1]}/${drive[2]}` : `/mnt/${drive[1]}`;
  return normalized;
}

function normalizeWorkspacePath(value: string): string {
  const normalized = stripWindowsDevicePrefix(value).replaceAll("\\", "/");
  const drivePath = /^\/[a-z]:\//i.test(normalized) ? normalized.slice(1) : normalized;
  const wsl = normalized.match(/^\/\/(?:wsl\$|wsl\.localhost)\/([^/]+)(?:\/(.*))?$/i);
  let result = normalized;
  if (wsl) {
    const path = `/${wsl[2] ?? ""}`;
    result = /^\/mnt\/[a-z](?:\/|$)/i.test(path)
      ? `win32:${windowsComparablePath(path)}`
      : `wsl:${wsl[1]!.toLowerCase()}:${path}`;
  } else if (isWindowsPath(drivePath)) {
    result = `win32:${windowsComparablePath(drivePath)}`;
  }
  return result === "/" ? result : result.replace(/\/+$/, "");
}

function windowsComparison(value: string): { path: string; explicit: boolean } | null {
  if (value.startsWith("win32:")) return { path: value.slice(6), explicit: true };
  if (/^\/mnt\/[a-z](?:\/|$)/i.test(value))
    return { path: windowsComparablePath(value), explicit: false };
  return null;
}

/** Windows aliases can match WSL mounts; ordinary Linux paths retain case and distro identity. */
export function areWorkspacePathsEquivalent(left: string, right: string): boolean {
  const normalizedLeft = normalizeWorkspacePath(left);
  const normalizedRight = normalizeWorkspacePath(right);
  if (normalizedLeft === normalizedRight) return true;
  const windowsLeft = windowsComparison(normalizedLeft);
  const windowsRight = windowsComparison(normalizedRight);
  return (
    windowsLeft !== null &&
    windowsRight !== null &&
    (windowsLeft.explicit || windowsRight.explicit) &&
    windowsLeft.path === windowsRight.path
  );
}

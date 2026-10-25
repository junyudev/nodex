import {
  isAbsoluteSearchPath,
  normalizeSearchPath,
  resolveSearchResultPath,
} from "../../shared/file-search-paths";

/** Split a host-native absolute directory into the existing directory-query coordinates. */
export function commandPaletteDirectoryCoordinates(path: string): {
  readonly workspaceRoot: string;
  readonly directoryPath: string;
} | null {
  if (path === "~" || path.startsWith("~/") || path.startsWith("~\\"))
    return { workspaceRoot: "~", directoryPath: path.slice(2).replaceAll("\\", "/") };
  if (!isAbsoluteSearchPath(path)) return null;
  const normalized = normalizeSearchPath(path);
  const unc = normalized.match(/^(\/\/[^/]+\/[^/]+)(?:\/(.*))?$/u);
  if (unc) return { workspaceRoot: unc[1]!, directoryPath: unc[2] ?? "" };
  const drive = normalized.match(/^([a-z]:\/)(.*)$/iu);
  if (drive) return { workspaceRoot: drive[1]!, directoryPath: drive[2]! };
  if (normalized.startsWith("//")) return null;
  return { workspaceRoot: "/", directoryPath: normalized.slice(1) };
}

/** Home is a starting directory; only filesystem roots stop parent navigation. */
export function commandPaletteParentDirectory(path: string): string | null {
  if (!isAbsoluteSearchPath(path)) return null;
  const coordinates = commandPaletteDirectoryCoordinates(path);
  if (!coordinates?.directoryPath) return null;
  const separator = coordinates.directoryPath.lastIndexOf("/");
  return resolveSearchResultPath(
    coordinates.workspaceRoot,
    separator < 0 ? "" : coordinates.directoryPath.slice(0, separator),
  );
}

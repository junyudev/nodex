import type {
  AdditionalFileSystemPermissions,
  FileSystemPath,
  FileSystemSpecialPath,
  GrantedPermissionProfile,
  RequestPermissionProfile,
} from "@nodex/codex-app-server-protocol/v2";

export type CodexPermissionRequestFileSystemAccess = "read" | "write" | "readWrite";

export type CodexPermissionRequestDetail =
  | { kind: "network" }
  | {
      kind: "fileSystem";
      access: CodexPermissionRequestFileSystemAccess;
      paths: string[];
    };

export type CodexPermissionRequestTitleModel =
  | { kind: "network" }
  | { kind: "fileSystem"; access: CodexPermissionRequestFileSystemAccess; path: string }
  | { kind: "additional" };

function formatSpecialPath(value: FileSystemSpecialPath): string {
  switch (value.kind) {
    case "root":
      return "/";
    case "minimal":
      return ":minimal";
    case "project_roots":
      return value.subpath === null ? ":project_roots" : `:project_roots/${value.subpath}`;
    case "tmpdir":
      return ":tmpdir";
    case "slash_tmp":
      return "/tmp";
    case "unknown":
      return value.subpath === null ? value.path : `${value.path}/${value.subpath}`;
  }
}

export function formatCodexPermissionPath(path: FileSystemPath): string {
  switch (path.type) {
    case "path":
      return path.path;
    case "glob_pattern":
      return path.pattern;
    case "special":
      return formatSpecialPath(path.value);
  }
}

function collectFileSystemPathSets(fileSystem: AdditionalFileSystemPermissions): {
  read: Set<string>;
  write: Set<string>;
} {
  const read = new Set<string>();
  const write = new Set<string>();

  if (fileSystem.entries !== undefined) {
    for (const entry of fileSystem.entries) {
      const path = formatCodexPermissionPath(entry.path);
      if (entry.access === "read") read.add(path);
      if (entry.access === "write") write.add(path);
    }
    return { read, write };
  }

  for (const path of fileSystem.read ?? []) read.add(path);
  for (const path of fileSystem.write ?? []) write.add(path);
  return { read, write };
}

export function buildCodexPermissionRequestDetails(
  permissions: RequestPermissionProfile,
): CodexPermissionRequestDetail[] {
  const details: CodexPermissionRequestDetail[] = [];
  if (permissions.network !== null) {
    details.push({ kind: "network" });
  }

  if (permissions.fileSystem === null) return details;

  const { read, write } = collectFileSystemPathSets(permissions.fileSystem);
  const readPaths = Array.from(read);
  const writePaths = Array.from(write);
  const readWritePaths = readPaths.filter((path) => write.has(path));
  const readOnlyPaths = readPaths.filter((path) => !write.has(path));
  const writeOnlyPaths = writePaths.filter((path) => !read.has(path));

  if (readWritePaths.length > 0) {
    details.push({ kind: "fileSystem", access: "readWrite", paths: readWritePaths });
  }
  if (readOnlyPaths.length > 0) {
    details.push({ kind: "fileSystem", access: "read", paths: readOnlyPaths });
  }
  if (writeOnlyPaths.length > 0) {
    details.push({ kind: "fileSystem", access: "write", paths: writeOnlyPaths });
  }

  return details;
}

export function resolveCodexPermissionRequestTitleModel(
  details: CodexPermissionRequestDetail[],
): CodexPermissionRequestTitleModel {
  if (details.length === 1) {
    const detail = details[0]!;
    if (detail.kind === "network") return { kind: "network" };
    if (detail.paths.length === 1) {
      return {
        kind: "fileSystem",
        access: detail.access,
        path: detail.paths[0]!,
      };
    }
  }

  return { kind: "additional" };
}

export function buildCodexGrantedPermissionProfile(
  permissions: RequestPermissionProfile,
): GrantedPermissionProfile {
  return {
    ...(permissions.network !== null ? { network: permissions.network } : {}),
    ...(permissions.fileSystem !== null ? { fileSystem: permissions.fileSystem } : {}),
  };
}

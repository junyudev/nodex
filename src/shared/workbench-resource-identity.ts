import type { WorkbenchFilesSurfaceConfig } from "./workbench-scene";
import { z } from "zod";

export const WORKBENCH_FILE_PATH_MAX_LENGTH = 32_768;
// A host (512), separators and a full supported path fit without encoding or truncation.
export const WorkbenchSurfaceIdSchema = z.string().min(1).max(33_300);

const absolutePath = (path: string) =>
  path.startsWith("/") || /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith("\\\\");

export const WorkbenchAbsoluteFilePathSchema = z
  .string()
  .min(1)
  .max(WORKBENCH_FILE_PATH_MAX_LENGTH)
  .refine(
    (path) => absolutePath(path) && !path.includes("\0"),
    "Expected an absolute filesystem path",
  );

/** Lexical identity only: filesystem authorization and symlink resolution belong to the host. */
export function canonicalWorkbenchFilePath(path: string, basePath?: string | null): string {
  if (!absolutePath(path)) {
    if (!basePath || !absolutePath(basePath))
      throw new Error("A file needs an absolute path or workspace directory");
    return canonicalWorkbenchFilePath(`${basePath}/${path}`);
  }
  const windows = /^[a-zA-Z]:[\\/]/u.test(path) || path.startsWith("\\\\") || path.startsWith("//");
  const normalized = windows ? path.replaceAll("\\", "/") : path;
  const drive = /^[a-zA-Z]:\//u.exec(normalized)?.[0];
  const unc =
    windows && normalized.startsWith("//") ? /^\/\/[^/]+\/[^/]+/u.exec(normalized)?.[0] : undefined;
  const prefix = drive ? `${drive[0]!.toUpperCase()}:/` : (unc ?? "/");
  const parts: string[] = [];
  for (const part of normalized.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  const canonical = prefix + (unc && parts.length ? "/" : "") + parts.join("/");
  if (canonical.length > WORKBENCH_FILE_PATH_MAX_LENGTH || canonical.includes("\0"))
    throw new Error("The file path is invalid or too long");
  return canonical;
}

export function workbenchFileResourceId(
  hostId: string,
  path: string,
  basePath?: string | null,
): string {
  return WorkbenchSurfaceIdSchema.parse(
    `file:${hostId}:${canonicalWorkbenchFilePath(path, basePath)}`,
  );
}

export function workbenchFilesResourceKey(config: {
  readonly hostId: string;
  readonly path?: string;
  readonly projectId: string | null;
  readonly workspaceRoot: string | null;
  readonly cwd: string | null;
}): string {
  if (config.path)
    return workbenchFileResourceId(config.hostId, config.path, config.cwd ?? config.workspaceRoot);
  return `files:${JSON.stringify([config.hostId, config.projectId, config.workspaceRoot ? canonicalWorkbenchFilePath(config.workspaceRoot) : null, config.cwd ? canonicalWorkbenchFilePath(config.cwd) : null])}`;
}

export function canonicalWorkbenchFilesConfig(
  config: WorkbenchFilesSurfaceConfig,
): WorkbenchFilesSurfaceConfig {
  return {
    ...config,
    cwd: config.cwd ? canonicalWorkbenchFilePath(config.cwd) : null,
    workspaceRoot: config.workspaceRoot ? canonicalWorkbenchFilePath(config.workspaceRoot) : null,
    ...(config.path
      ? { path: canonicalWorkbenchFilePath(config.path, config.cwd ?? config.workspaceRoot) }
      : {}),
  };
}

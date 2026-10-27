import { getWorkspaceFileName, getWorkspaceRelativePath } from "./workspace-file-model";

export interface WorkspaceFileBreadcrumb {
  /** Display segments, starting with the workspace folder name when the file is inside it. */
  readonly segments: readonly string[];
  /** The path the breadcrumb stands for, relative to its root when it has one. */
  readonly title: string;
}

/**
 * Breadcrumb segments for a file: relative to the workspace root, else the working directory,
 * else the absolute path.
 */
export function resolveWorkspaceFileBreadcrumb({
  cwd,
  path,
  workspaceRoot,
}: {
  readonly cwd: string | null;
  readonly path: string | null;
  readonly workspaceRoot: string | null;
}): WorkspaceFileBreadcrumb {
  const contextRoot = workspaceRoot ?? cwd;
  if (path === null) {
    const label = contextRoot ? getWorkspaceFileName(contextRoot) : "";
    return { segments: label ? [label] : [], title: label };
  }
  for (const root of [workspaceRoot, cwd]) {
    if (!root) continue;
    const relative = getWorkspaceRelativePath(root, path);
    if (relative === null) continue;
    const rootLabel = getWorkspaceFileName(root) || root;
    const parts = relative.split("/").filter(Boolean);
    return {
      segments: [rootLabel, ...parts],
      title: [rootLabel, ...parts].join("/"),
    };
  }
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return { segments: parts, title: path };
}

export interface WorkspaceFilePathVariants {
  readonly absolute: string | null;
  readonly projectRelative: string | null;
  readonly repoRelative: string | null;
}

function relativeTo(root: string | null, path: string): string | null {
  if (!root) return null;
  const relative = getWorkspaceRelativePath(root, path);
  return relative ? relative : null;
}

/** The forms a file path can be copied in; unavailable forms are `null`. */
export function resolveWorkspaceFilePathVariants({
  path,
  projectRoot,
  repoRoot,
}: {
  readonly path: string;
  readonly projectRoot: string | null;
  readonly repoRoot: string | null;
}): WorkspaceFilePathVariants {
  const absolute = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(path) ? path : null;
  return {
    absolute,
    projectRelative: absolute ? relativeTo(projectRoot, absolute) : null,
    repoRelative: absolute ? relativeTo(repoRoot, absolute) : null,
  };
}

/** The path the primary copy action copies: repo-relative, else project-relative, else absolute. */
export function preferredWorkspaceFileCopyPath(
  path: string,
  variants: WorkspaceFilePathVariants,
): string {
  return variants.repoRelative ?? variants.projectRelative ?? variants.absolute ?? path;
}

interface GitHubRepository {
  readonly owner: string;
  readonly repo: string;
}

/** Recognizes `https://`, `ssh://`, and scp-style GitHub remotes. */
export function parseGitHubRemote(remoteUrl: string): GitHubRepository | null {
  const value = remoteUrl.trim();
  const scp = /^(?:[^@/]+@)?github\.com:([^/]+)\/(.+?)(?:\.git)?\/?$/iu.exec(value);
  if (scp) return { owner: scp[1]!, repo: scp[2]! };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname.toLowerCase() !== "github.com") return null;
  const [owner, repo] = url.pathname
    .replace(/^\/+/u, "")
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .split("/");
  return owner && repo ? { owner, repo } : null;
}

function encodePathSegments(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/** The file's GitHub blob URL on the current branch, or `null` outside a GitHub checkout. */
export function buildGitHubBlobUrl({
  branch,
  line,
  path,
  remoteUrl,
  root,
}: {
  readonly branch: string | null;
  readonly line?: number;
  readonly path: string;
  readonly remoteUrl: string | null;
  readonly root: string;
}): string | null {
  const trimmedBranch = branch?.trim();
  if (!remoteUrl || !trimmedBranch) return null;
  const repository = parseGitHubRemote(remoteUrl);
  if (!repository) return null;
  const relative = getWorkspaceRelativePath(root, path);
  if (!relative) return null;
  return `https://github.com/${encodePathSegments(repository.owner)}/${encodePathSegments(repository.repo)}/blob/${encodePathSegments(trimmedBranch)}/${encodePathSegments(relative)}${line === undefined ? "" : `#L${line}`}`;
}

import { parseGitRepositoryOwnerRepo } from "./git-repository-identity";
import { canonicalWorkbenchFilePath } from "./workbench-resource-identity";

/** Build a line-aware repository URL only when the file belongs to a GitHub origin. */
export function buildGitHubBlobUrl(input: {
  readonly path: string;
  readonly cwd?: string | null;
  readonly repoRoot: string | null;
  readonly branch: string | null;
  readonly originUrl: string | null;
  readonly line?: number;
}): string | null {
  if (!input.repoRoot || !input.branch?.trim() || !input.originUrl) return null;
  const scpHost = /^(?:[^@\s/:]+@)?([^@\s/:]+):(?![\\/])/u.exec(input.originUrl)?.[1];
  let host = scpHost;
  if (!host) {
    try {
      host = new URL(input.originUrl).hostname;
    } catch {
      return null;
    }
  }
  if (host.toLowerCase() !== "github.com") return null;
  const repository = parseGitRepositoryOwnerRepo(input.originUrl);
  if (!repository) return null;
  try {
    const root = canonicalWorkbenchFilePath(input.repoRoot).replace(/\/+$/u, "");
    const file = canonicalWorkbenchFilePath(input.path, input.cwd);
    const windows = /^[a-z]:/iu.test(root) || root.startsWith("//");
    const prefix = `${root}/`;
    if (!(windows ? file.toLowerCase().startsWith(prefix.toLowerCase()) : file.startsWith(prefix)))
      return null;
    const encode = (value: string) => value.split("/").map(encodeURIComponent).join("/");
    const location = input.line && input.line > 0 ? `#L${input.line}` : "";
    return `https://github.com/${encode(repository.owner)}/${encode(repository.repo)}/blob/${encode(input.branch.trim())}/${encode(file.slice(prefix.length))}${location}`;
  } catch {
    return null;
  }
}

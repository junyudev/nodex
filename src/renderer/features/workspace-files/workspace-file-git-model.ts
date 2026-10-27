import type { GitWorkerMethod, GitWorkerMethodMap } from "../../../shared/git-worker-protocol";
import type {
  GitReviewFileSummary,
  GitReviewRepositoryMetadataResult,
  GitReviewSummaryResult,
  ReviewDiffSourceDescriptor,
} from "../../../shared/types";
import { getWorkspaceRelativePath } from "./workspace-file-model";

/** The Review picker can pass its existing Git descriptors without translation. */
export type WorkspaceFileGitSource =
  | Exclude<ReviewDiffSourceDescriptor, { kind: "last-turn" } | { kind: "pull-request" }>
  | { kind: "uncommitted" };

export type WorkspaceFileGitRead = <Method extends GitWorkerMethod>(
  method: Method,
  params: GitWorkerMethodMap[Method]["params"],
) => Promise<GitWorkerMethodMap[Method]["result"]>;

export interface WorkspaceFileGitInput {
  readonly hostId: string;
  /** Directory containing the file, so nested repositories resolve correctly. */
  readonly cwd: string;
  readonly path: string;
  readonly savedRevision: string | number | null;
  readonly source?: WorkspaceFileGitSource | null;
  readonly hasUnsavedChanges?: boolean;
}

export interface WorkspaceFileComparisonInput {
  readonly repository: GitReviewRepositoryMetadataResult;
  readonly source: WorkspaceFileGitSource;
  readonly path: string;
  readonly oldPath: string;
  /** Empty content is an added file; null is reserved for a missing snapshot side. */
  readonly oldContent: string;
  /** null for live comparisons, whose new content is the caller's current draft. */
  readonly snapshotContent: string | null;
  readonly deleted: boolean;
  readonly editable: boolean;
  readonly snapshotGeneration: number;
}

export class WorkspaceFileGitStaleError extends Error {
  constructor() {
    super("File comparison changed. Refresh to try again.");
    this.name = "WorkspaceFileGitStaleError";
  }
}

type Summary = Extract<GitReviewSummaryResult, { type: "success" }>;

function findFile(summary: Summary, root: string, path: string) {
  const relative = getWorkspaceRelativePath(root, path);
  return summary.files.find((file) => file.path === relative);
}

/** Repository reads are saved-file data; draft text never enters Git requests or query keys. */
export async function loadWorkspaceFileComparison(
  input: WorkspaceFileGitInput,
  read: WorkspaceFileGitRead,
): Promise<WorkspaceFileComparisonInput | null> {
  if (input.hostId !== "local" || !input.cwd || !input.path) return null;
  const repository = await read("stable-metadata", { cwd: input.cwd });
  const root = repository.root;
  if (!repository.isGitRepository || root === null) return null;
  const relative = getWorkspaceRelativePath(root, input.path);
  if (!relative) return null;

  const summary = async (
    source: Summary["source"],
    options?: { baseBranch?: string | null; commitSha?: string | null },
  ) => {
    const result = await read("review-summary", {
      cwd: root,
      source,
      ...options,
      includeUntrackedFiles: true,
    });
    if (result.type === "stale-snapshot") throw new WorkspaceFileGitStaleError();
    if (result.type === "error")
      throw new Error(result.errorMessage ?? "File comparison is unavailable");
    return result;
  };
  const baseBranch = async () => {
    const result = await read("base-branch", { cwd: root });
    if (result.errorMessage) throw new Error(result.errorMessage);
    return result.remote ?? result.local;
  };

  let source = input.source ?? null;
  let unstaged: Summary | null = null;
  let staged: Summary | null = null;
  let branch: Summary | null = null;
  if (source === null && input.hasUnsavedChanges) source = { kind: "unstaged" };
  if (source === null) {
    unstaged = await summary("unstaged");
    if (findFile(unstaged, root, input.path)) source = { kind: "unstaged" };
  }
  if (source === null) {
    staged = await summary("staged");
    if (findFile(staged, root, input.path)) source = { kind: "uncommitted" };
  }
  if (source === null) {
    const base = await baseBranch();
    if (base !== null) {
      branch = await summary("branch", { baseBranch: base });
      if (findFile(branch, root, input.path)) source = { kind: "branch", baseBranch: base };
    }
  }
  source ??= { kind: "unstaged" };

  if (source.kind === "unstaged") {
    const selected = unstaged ?? (await summary("unstaged"));
    return await readComparison(
      input,
      repository,
      source,
      selected,
      findFile(selected, root, input.path),
      read,
    );
  }
  if (source.kind === "uncommitted") {
    const selected = staged ?? (await summary("staged"));
    const working = unstaged ?? (await summary("unstaged"));
    if (working.snapshotGeneration !== selected.snapshotGeneration) {
      throw new WorkspaceFileGitStaleError();
    }
    const workingFile = findFile(working, root, input.path);
    if (workingFile?.status === "unmerged") {
      throw new Error("File comparison has unresolved conflicts");
    }
    const stagedFile =
      findFile(selected, root, input.path) ??
      selected.files.find((candidate) => candidate.path === workingFile?.previousPath);
    if (stagedFile)
      return await readComparison(
        input,
        repository,
        source,
        selected,
        {
          ...stagedFile,
          path: relative,
          previousPath: stagedFile.previousPath ?? workingFile?.previousPath ?? null,
        },
        read,
      );
    // Without a staged change the index baseline is HEAD, including unborn repositories.
    return await readComparison(input, repository, source, working, workingFile, read);
  }
  if (source.kind === "staged" || source.kind === "commit") {
    const selected =
      source.kind === "staged"
        ? (staged ?? (await summary("staged")))
        : await summary("commit", { commitSha: source.commitSha });
    const file = findFile(selected, root, input.path);
    if (!file) return null;
    return await readComparison(input, repository, source, selected, file, read);
  }
  const base = source.baseBranch ?? (await baseBranch());
  if (base === null) throw new Error("File comparison base is unavailable");
  const selected = branch ?? (await summary("branch", { baseBranch: base }));
  const working = unstaged ?? (await summary("unstaged"));
  const index = staged ?? (await summary("staged"));
  if (
    working.snapshotGeneration !== selected.snapshotGeneration ||
    index.snapshotGeneration !== selected.snapshotGeneration
  )
    throw new WorkspaceFileGitStaleError();
  const workingFile = findFile(working, root, input.path);
  const indexFile =
    findFile(index, root, input.path) ??
    index.files.find((candidate) => candidate.path === workingFile?.previousPath);
  if (workingFile?.status === "unmerged" || indexFile?.status === "unmerged") {
    throw new Error("File comparison has unresolved conflicts");
  }
  const previousPath = indexFile?.previousPath ?? workingFile?.previousPath;
  const file =
    findFile(selected, root, input.path) ??
    selected.files.find((candidate) => previousPath !== null && candidate.path === previousPath);
  if (file)
    return await readComparison(
      input,
      repository,
      { ...source, baseBranch: base },
      selected,
      { ...file, path: relative, previousPath: file.previousPath ?? previousPath ?? null },
      read,
    );
  const addedFile =
    indexFile?.status === "added"
      ? indexFile
      : workingFile?.status === "untracked"
        ? workingFile
        : null;
  if (addedFile)
    return await readComparison(
      input,
      repository,
      { ...source, baseBranch: base },
      selected,
      { ...addedFile, path: relative },
      read,
    );
  const mergeBase = await read("merge-base", { cwd: root, gitRoot: root, baseBranch: base });
  if (!mergeBase.mergeBaseSha)
    throw new Error(mergeBase.errorMessage ?? "File comparison base is unavailable");
  // Branch review summarizes committed changes. Read its base blob explicitly for working-only edits.
  const workingChange = workingFile ?? indexFile;
  return await readComparison(
    input,
    repository,
    { ...source, baseBranch: base },
    selected,
    workingChange
      ? { ...workingChange, path: relative, previousPath: previousPath ?? null }
      : undefined,
    read,
    `${mergeBase.mergeBaseSha}:${previousPath ?? relative}`,
    previousPath ?? relative,
  );
}

async function readComparison(
  input: WorkspaceFileGitInput,
  repository: GitReviewRepositoryMetadataResult,
  source: WorkspaceFileGitSource,
  summary: Summary,
  file: GitReviewFileSummary | undefined,
  read: WorkspaceFileGitRead,
  baseObject?: string,
  basePath?: string,
): Promise<WorkspaceFileComparisonInput> {
  if (file?.status === "unmerged") throw new Error("File comparison has unresolved conflicts");
  if (!file && summary.untrackedFilesOmitted > 0)
    throw new Error("File comparison summary is incomplete");
  const path = file?.path ?? getWorkspaceRelativePath(repository.root!, input.path)!;
  const oldPath = file?.previousPath ?? basePath ?? path;
  const added = file?.status === "added" || file?.status === "untracked";
  const editable = source.kind !== "staged" && source.kind !== "commit";
  const requests: GitWorkerMethodMap["review-cat-file"]["params"]["requests"] = [];
  if (!added) {
    if (file && file.oldOid === null) throw new Error("File comparison base is unavailable");
    requests.push({
      oid: baseObject ?? file?.oldOid ?? null,
      path: oldPath,
      fallbackToDisk: !file && !baseObject,
    });
  }
  if (!editable && file?.status !== "deleted") {
    if (!file?.newOid) throw new Error("File comparison content is unavailable");
    requests.push({ oid: file.newOid, path, fallbackToDisk: false });
  }
  const contents =
    requests.length === 0
      ? []
      : await readContents(repository.root!, summary.snapshotGeneration, requests, read);
  return {
    repository,
    source,
    path,
    oldPath,
    oldContent: added ? "" : contents[0]!,
    snapshotContent: editable || file?.status === "deleted" ? null : contents[added ? 0 : 1]!,
    deleted: file?.status === "deleted",
    editable,
    snapshotGeneration: summary.snapshotGeneration,
  };
}

async function readContents(
  root: string,
  generation: number,
  requests: GitWorkerMethodMap["review-cat-file"]["params"]["requests"],
  read: WorkspaceFileGitRead,
) {
  const result = await read("review-cat-file", {
    cwd: root,
    snapshotGeneration: generation,
    requests,
  });
  if (result.type === "stale-snapshot") throw new WorkspaceFileGitStaleError();
  if (result.value.snapshotGeneration !== generation) throw new WorkspaceFileGitStaleError();
  if (result.value.results.length !== requests.length)
    throw new Error("File comparison base could not be read");
  return result.value.results.map((content) => {
    if (content.type !== "success")
      throw new Error(
        content.error.type === "too-large"
          ? "File comparison base is too large"
          : "File comparison base could not be read",
      );
    return content.lines.join("");
  });
}

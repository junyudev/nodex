import { QueryClient } from "@tanstack/query-core";
import { describe, expect, test } from "vite-plus/test";
import type { GitReviewFileSummary, GitReviewSummaryResult } from "../../../shared/types";
import type { GitWorkerMethod, GitWorkerMethodMap } from "../../../shared/git-worker-protocol";
import {
  loadWorkspaceFileComparison,
  WorkspaceFileGitStaleError,
  type WorkspaceFileGitInput,
  type WorkspaceFileGitRead,
} from "./workspace-file-git-model";
import {
  workspaceFileBlameQueryOptions,
  workspaceFileComparisonQueryOptions,
} from "./use-workspace-file-git";

const input: WorkspaceFileGitInput = {
  hostId: "local",
  cwd: "/repo/src",
  path: "/repo/src/file.ts",
  savedRevision: 1,
};
const file: GitReviewFileSummary = {
  path: "src/file.ts",
  previousPath: null,
  status: "modified",
  rawStatus: "M",
  oldOid: "old",
  newOid: "new",
  revision: "revision",
  additions: 1,
  deletions: 1,
  safety: {
    binary: false,
    tooLarge: false,
    invalidText: false,
    renderable: true,
    sizeBytes: 8,
    mimeType: "text/plain",
    skipReason: null,
  },
};
type Source = GitReviewSummaryResult["source"];

function fakeWorker(files: Partial<Record<Source, GitReviewFileSummary[]>> = {}) {
  const calls: Array<{ method: GitWorkerMethod; params: unknown; signal?: AbortSignal }> = [];
  const read: WorkspaceFileGitRead = async (method, params) => {
    calls.push({ method, params });
    const source = (params as { source?: Source }).source;
    const value =
      method === "stable-metadata"
        ? {
            cwd: "/repo/src",
            root: "/repo",
            gitDir: "/repo/.git",
            commonDir: "/repo/.git",
            isGitRepository: true,
            currentBranch: "feature",
            defaultBranch: "main",
            originUrl: "git@github.com:org/repo.git",
            errorMessage: null,
          }
        : method === "base-branch"
          ? { cwd: "/repo", local: "main", remote: "origin/main", errorMessage: null }
          : method === "merge-base"
            ? { cwd: "/repo", baseBranch: "main", mergeBaseSha: "merge", errorMessage: null }
            : method === "review-summary"
              ? {
                  type: "success",
                  source,
                  files: files[source!] ?? [],
                  snapshotGeneration: 1,
                  stageCounts: { stagedFileCount: 0, unstagedFileCount: 0, untrackedFileCount: 0 },
                  untrackedFilesOmitted: 0,
                }
              : method === "review-cat-file"
                ? {
                    type: "success",
                    value: {
                      snapshotGeneration: 1,
                      results: (
                        params as GitWorkerMethodMap["review-cat-file"]["params"]
                      ).requests.map((request) => ({
                        type: "success",
                        lines: [request.oid === "new" ? "snapshot\n" : "base\n"],
                      })),
                    },
                  }
                : method === "blame-file"
                  ? { cwd: "/repo", path: input.path, ref: null, lines: [], errorMessage: null }
                  : null;
    return value as GitWorkerMethodMap[typeof method]["result"];
  };
  return { read, calls };
}

describe("workspace file Git comparison", () => {
  test("Branch preserves a working-only deletion while reading its merge-base", async () => {
    const worker = fakeWorker({ unstaged: [{ ...file, status: "deleted", newOid: null }] });
    expect(
      await loadWorkspaceFileComparison(
        { ...input, source: { kind: "branch", baseBranch: "main" } },
        worker.read,
      ),
    ).toMatchObject({ deleted: true, editable: true });
    expect(worker.calls.at(-1)?.params).toMatchObject({ requests: [{ oid: "merge:src/file.ts" }] });
  });
  test("Uncommitted keeps the HEAD baseline when index and working tree both changed", async () => {
    const worker = fakeWorker({
      unstaged: [{ ...file, oldOid: "index" }],
      staged: [{ ...file, oldOid: "HEAD" }],
    });
    await loadWorkspaceFileComparison({ ...input, source: { kind: "uncommitted" } }, worker.read);
    expect(worker.calls.at(-1)?.params).toMatchObject({ requests: [{ oid: "HEAD" }] });
  });

  test.each(["untracked", "added"] as const)(
    "Branch compares a working-only %s file against empty content",
    async (status) => {
      const worker = fakeWorker(
        status === "untracked"
          ? { unstaged: [{ ...file, status, oldOid: null }] }
          : { staged: [{ ...file, status, oldOid: null }] },
      );
      expect(
        await loadWorkspaceFileComparison(
          { ...input, source: { kind: "branch", baseBranch: "main" } },
          worker.read,
        ),
      ).toMatchObject({ oldContent: "", editable: true });
      expect(worker.calls.some((call) => call.method === "review-cat-file")).toBe(false);
    },
  );

  test("resolves an unstaged rename through the staged file to its HEAD blob", async () => {
    const worker = fakeWorker({
      unstaged: [{ ...file, previousPath: "index-name.ts", oldOid: "index" }],
      staged: [{ ...file, path: "index-name.ts", previousPath: "original.ts", oldOid: "HEAD" }],
    });
    expect(
      await loadWorkspaceFileComparison({ ...input, source: { kind: "uncommitted" } }, worker.read),
    ).toMatchObject({ path: "src/file.ts", oldPath: "original.ts" });
    expect(worker.calls.at(-1)?.params).toMatchObject({
      requests: [{ oid: "HEAD", path: "original.ts" }],
    });
  });

  test("Branch rejects working-tree conflicts even when the committed summary has a base", async () => {
    const worker = fakeWorker({ branch: [file], unstaged: [{ ...file, status: "unmerged" }] });
    await expect(
      loadWorkspaceFileComparison(
        { ...input, source: { kind: "branch", baseBranch: "main" } },
        worker.read,
      ),
    ).rejects.toThrow("File comparison has unresolved conflicts");
  });

  test("staged deletion keeps the base and has no snapshot new side", async () => {
    const worker = fakeWorker({ staged: [{ ...file, status: "deleted", newOid: null }] });
    expect(
      await loadWorkspaceFileComparison({ ...input, source: { kind: "staged" } }, worker.read),
    ).toMatchObject({
      oldContent: "base\n",
      snapshotContent: null,
      deleted: true,
      editable: false,
    });
  });
  test("chooses unstaged before uncommitted and branch, using the index blob", async () => {
    const worker = fakeWorker({
      unstaged: [file],
      staged: [{ ...file, oldOid: "HEAD" }],
      branch: [file],
    });
    const result = await loadWorkspaceFileComparison(input, worker.read);
    expect(result).toMatchObject({
      source: { kind: "unstaged" },
      oldContent: "base\n",
      snapshotContent: null,
      editable: true,
    });
    expect(worker.calls.map((call) => call.method)).toEqual([
      "stable-metadata",
      "review-summary",
      "review-cat-file",
    ]);
    expect(worker.calls.at(-1)?.params).toMatchObject({
      cwd: "/repo",
      requests: [{ oid: "old", path: "src/file.ts", fallbackToDisk: false }],
    });
  });

  test("chooses HEAD-to-draft for staged-only files and honors dirty-draft unstaged fallback", async () => {
    const worker = fakeWorker({ staged: [file] });
    expect(await loadWorkspaceFileComparison(input, worker.read)).toMatchObject({
      source: { kind: "uncommitted" },
      editable: true,
    });
    const dirty = fakeWorker({ staged: [file], branch: [file] });
    expect(
      await loadWorkspaceFileComparison({ ...input, hasUnsavedChanges: true }, dirty.read),
    ).toMatchObject({ source: { kind: "unstaged" } });
    expect(dirty.calls.at(-1)?.params).toMatchObject({
      requests: [{ oid: null, path: "src/file.ts", fallbackToDisk: true }],
    });
  });

  test("keeps an explicit source when drafts are dirty and resolves branch default with remote priority", async () => {
    const worker = fakeWorker({ branch: [file] });
    expect(await loadWorkspaceFileComparison(input, worker.read)).toMatchObject({
      source: { kind: "branch", baseBranch: "origin/main" },
    });
    const snapshot = fakeWorker({ staged: [file] });
    expect(
      await loadWorkspaceFileComparison(
        { ...input, hasUnsavedChanges: true, source: { kind: "staged" } },
        snapshot.read,
      ),
    ).toMatchObject({
      source: { kind: "staged" },
      oldContent: "base\n",
      snapshotContent: "snapshot\n",
      editable: false,
    });
  });

  test.each(["added", "untracked"] as const)(
    "uses an empty baseline for %s files without reading a nonexistent blob",
    async (status) => {
      const worker = fakeWorker({ unstaged: [{ ...file, status, oldOid: null }] });
      expect(await loadWorkspaceFileComparison(input, worker.read)).toMatchObject({
        oldContent: "",
        editable: true,
      });
      expect(worker.calls.some((call) => call.method === "review-cat-file")).toBe(false);
    },
  );

  test("reads committed snapshots independently of the working draft and uses previous paths for renamed bases", async () => {
    const worker = fakeWorker({ commit: [{ ...file, previousPath: "old-name.ts" }] });
    const source = { kind: "commit", commitSha: "commit", title: "Subject" } as const;
    expect(await loadWorkspaceFileComparison({ ...input, source }, worker.read)).toMatchObject({
      source,
      oldPath: "old-name.ts",
      snapshotContent: "snapshot\n",
      editable: false,
    });
    expect(worker.calls.at(-1)?.params).toMatchObject({
      requests: [
        { oid: "old", path: "old-name.ts", fallbackToDisk: false },
        { oid: "new", path: "src/file.ts", fallbackToDisk: false },
      ],
    });
  });

  test("returns no snapshot when the selected staged or committed view has no changes", async () => {
    expect(
      await loadWorkspaceFileComparison(
        { ...input, source: { kind: "staged" } },
        fakeWorker().read,
      ),
    ).toBeNull();
  });

  test("reads the branch merge-base blob for files changed only in the working tree", async () => {
    const worker = fakeWorker();
    await loadWorkspaceFileComparison(
      { ...input, source: { kind: "branch", baseBranch: "main" } },
      worker.read,
    );
    expect(worker.calls.at(-1)?.params).toMatchObject({
      requests: [{ oid: "merge:src/file.ts", path: "src/file.ts", fallbackToDisk: false }],
    });
  });

  test("rejects unresolved conflicts and stale snapshots without mixing generations", async () => {
    await expect(
      loadWorkspaceFileComparison(
        input,
        fakeWorker({ unstaged: [{ ...file, status: "unmerged" }] }).read,
      ),
    ).rejects.toThrow("File comparison has unresolved conflicts");
    const worker = fakeWorker({ unstaged: [file] });
    const read: WorkspaceFileGitRead = async (method, params) =>
      method === "review-cat-file"
        ? ({ type: "stale-snapshot" } as GitWorkerMethodMap[typeof method]["result"])
        : await worker.read(method, params);
    await expect(loadWorkspaceFileComparison(input, read)).rejects.toBeInstanceOf(
      WorkspaceFileGitStaleError,
    );
  });

  test("remote hosts never fall back to local Git", async () => {
    const worker = fakeWorker();
    expect(
      await loadWorkspaceFileComparison({ ...input, hostId: "remote" }, worker.read),
    ).toBeNull();
    expect(worker.calls).toEqual([]);
    expect(
      workspaceFileComparisonQueryOptions(
        { ...input, hostId: "remote" },
        {
          request: async () => {
            throw Error("local request");
          },
        },
      ).enabled,
    ).toBe(false);
  });

  test("query identity changes after save and cancellation reaches every worker read", async () => {
    const worker = fakeWorker({ unstaged: [file] });
    const signals: Array<AbortSignal | undefined> = [];
    const client = {
      request: async <Method extends GitWorkerMethod>(request: {
        method: Method;
        params: GitWorkerMethodMap[Method]["params"];
        signal?: AbortSignal;
      }) => {
        signals.push(request.signal);
        return await worker.read(request.method, request.params);
      },
    };
    const first = workspaceFileComparisonQueryOptions(input, client);
    const saved = workspaceFileComparisonQueryOptions({ ...input, savedRevision: 2 }, client);
    expect(first.queryKey).not.toEqual(saved.queryKey);
    expect(workspaceFileBlameQueryOptions(input, client).queryKey).not.toEqual(
      workspaceFileBlameQueryOptions({ ...input, savedRevision: 2 }, client).queryKey,
    );
    const queryClient = new QueryClient();
    try {
      await queryClient.fetchQuery(first);
      await queryClient.fetchQuery(saved);
      expect(worker.calls.filter((call) => call.method === "review-cat-file")).toHaveLength(2);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    } finally {
      queryClient.clear();
    }
  });
});

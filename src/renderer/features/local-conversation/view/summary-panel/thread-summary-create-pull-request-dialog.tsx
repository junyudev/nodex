import {
  BranchStatusIcon,
  BrowserExternalIcon,
  EditIcon,
  ThreadSummaryCreatePullRequestIcon,
} from "@/components/shared/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getGitWorkerClient, invoke } from "@/lib/api";
import type {
  GhCliAvailability,
  GhPrMutationResult,
  GhPrStatusResult,
  GitActionMutationResult,
  GitActionStatusResult,
  GitCommitMessageGenerateResult,
  GitPullRequestMessageGenerateResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  createGitActionOperationId,
  type SummaryGitActionWorkflowState,
} from "./thread-summary-git-action-dialog";

interface ThreadSummaryCreatePullRequestDialogProps {
  open: boolean;
  cwd: string | null;
  hostId?: string;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
  onErrorMessage: (message: string | null) => void;
  onWorkflowChange?: (state: SummaryGitActionWorkflowState | null) => void;
}

interface CreatePrReadState {
  loading: boolean;
  status: GitActionStatusResult | null;
  pullRequest: GhPrStatusResult | null;
}

const EMPTY_READ_STATE: CreatePrReadState = {
  loading: false,
  status: null,
  pullRequest: null,
};

function getGitActionResultError(result: GitActionMutationResult): string | null {
  if (result.status === "success") return null;
  return result.errorMessage ?? (result.stderr.trim() || "Git action failed.");
}

function getCommitMessageResultError(result: GitCommitMessageGenerateResult): string | null {
  if (result.status === "success" && result.message) return null;
  return result.errorMessage ?? (result.stderr.trim() || "Could not generate a commit message.");
}

function getPullRequestMessageResultError(
  result: GitPullRequestMessageGenerateResult,
): string | null {
  if (result.status === "success" && result.title && result.body) return null;
  return (
    result.errorMessage ??
    (result.stderr.trim() || "Could not generate pull request title and body.")
  );
}

function getPullRequestMutationError(result: GhPrMutationResult): string | null {
  if (result.available && !result.message) return null;
  return result.message ?? "Could not create pull request.";
}

function getGhAvailabilityMessage(reason: GhCliAvailability | null): string | null {
  if (reason === "missing-gh") return "Install GitHub CLI (gh) to create PRs.";
  if (reason === "not-authenticated") return "Authenticate GitHub CLI: run `gh auth login`.";
  if (reason === "missing-remote") return "GitHub pull requests require a Git remote.";
  if (reason === "error") return "GitHub CLI status unavailable.";
  return null;
}

function getCreatePullRequestStatusMessage({
  loading,
  status,
  pullRequest,
}: CreatePrReadState): string {
  if (loading) return "Checking pull request";
  if (!status) return "Checking Git state";
  if (!status.isGitRepository) return "Git repository is required.";
  if (!status.currentBranch) return "Branch information unavailable.";
  if (!status.defaultBranch) return "Default branch information unavailable.";
  if (pullRequest?.available === false) {
    return (
      getGhAvailabilityMessage(pullRequest.disabledReason) ??
      pullRequest.message ??
      "GitHub CLI unavailable."
    );
  }
  if (pullRequest?.status === "ready") return "A pull request already exists for this branch.";
  if (status.hasUncommittedChanges) return "Commit and push local changes before creating a PR.";
  if (status.canPush) return "Push branch commits before creating a PR.";
  return "Create pull request";
}

function shouldPushBeforePullRequest(status: GitActionStatusResult): boolean {
  if (status.canPush) return true;
  return status.pushNeedsUpstream && status.remotes.includes("origin");
}

function openPullRequestUrl(url: string | null): void {
  if (!url) return;
  window.open(url, "_blank", "noopener,noreferrer");
}

export function ThreadSummaryCreatePullRequestDialog({
  open,
  cwd,
  hostId = "local",
  onOpenChange,
  onCompleted,
  onErrorMessage,
  onWorkflowChange,
}: ThreadSummaryCreatePullRequestDialogProps) {
  const [readState, setReadState] = useState<CreatePrReadState>(EMPTY_READ_STATE);
  const [busy, setBusy] = useState(false);
  const [activeOperationId, setActiveOperationId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [includeLocalChanges, setIncludeLocalChanges] = useState(true);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setActiveOperationId(null);
      setInlineError(null);
      setTitle("");
      setBody("");
      setIncludeLocalChanges(true);
      setReadState(EMPTY_READ_STATE);
      onWorkflowChange?.(null);
      return;
    }

    if (!cwd) {
      setReadState(EMPTY_READ_STATE);
      setInlineError("Working directory is required.");
      return;
    }

    let cancelled = false;
    setReadState((current) => ({ ...current, loading: true }));
    setInlineError(null);

    void getGitWorkerClient()
      .request({ method: "action-status", params: { cwd } })
      .then(async (result) => {
        if (cancelled) return;
        const status = result as GitActionStatusResult;
        let pullRequest: GhPrStatusResult | null = null;
        if (status.isGitRepository && status.currentBranch) {
          pullRequest = (await invoke("gh-pr-status", { cwd })) as GhPrStatusResult;
        }
        if (!cancelled) setReadState({ loading: false, status, pullRequest });
      })
      .catch((error) => {
        if (cancelled) return;
        setReadState({ loading: false, status: null, pullRequest: null });
        setInlineError(error instanceof Error ? error.message : "Could not read Git state.");
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, onWorkflowChange, open]);

  const statusMessage = getCreatePullRequestStatusMessage(readState);
  const existingPullRequestUrl =
    readState.pullRequest?.status === "ready" ? readState.pullRequest.url : null;
  const ghBlocked = Boolean(readState.pullRequest?.available === false);
  const canCreate = Boolean(
    cwd &&
    readState.status?.isGitRepository &&
    readState.status.currentBranch &&
    readState.status.defaultBranch &&
    !readState.loading &&
    !busy &&
    !existingPullRequestUrl &&
    !ghBlocked,
  );
  const effectiveIncludeLocalChanges = Boolean(
    includeLocalChanges && readState.status?.hasUncommittedChanges,
  );

  const branchLabel = useMemo(() => {
    const head = readState.status?.currentBranch ?? "-";
    const base = readState.status?.defaultBranch ?? "-";
    return `${head} -> ${base}`;
  }, [readState.status?.currentBranch, readState.status?.defaultBranch]);

  const handleTitleInput = useCallback((event: FormEvent<HTMLInputElement>) => {
    setTitle(event.currentTarget.value);
  }, []);

  const handleBodyInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    setBody(event.currentTarget.value);
  }, []);

  const cancelActiveOperation = useCallback(() => {
    if (!activeOperationId) return;
    const operationId = activeOperationId;
    void invoke("git:action:cancel", { operationId }).finally(() => {
      setActiveOperationId((current) => (current === operationId ? null : current));
      onWorkflowChange?.(null);
      onOpenChange(false);
    });
  }, [activeOperationId, onOpenChange, onWorkflowChange]);

  const finishWithError = useCallback(
    (message: string) => {
      setInlineError(message);
      onErrorMessage(message);
    },
    [onErrorMessage],
  );

  const runCreatePullRequest = useCallback(
    async ({ draft, openInBrowser }: { draft: boolean; openInBrowser: boolean }) => {
      const initialStatus = readState.status;
      if (
        !cwd ||
        busy ||
        !canCreate ||
        !initialStatus?.currentBranch ||
        !initialStatus.defaultBranch
      )
        return;

      const operationId = createGitActionOperationId();
      setBusy(true);
      setActiveOperationId(operationId);
      setInlineError(null);
      onErrorMessage(null);

      try {
        let latestStatus = initialStatus;
        let nextTitle = title.trim();
        let nextBody = body.trim();

        if (effectiveIncludeLocalChanges) {
          onWorkflowChange?.({
            workflow: "create-pull-request",
            phase: "generating-commit-message",
            operationId,
          });
          const generatedCommit = (await invoke("git:action:commit-message:generate", {
            cwd,
            hostId,
            draftMessage: "",
            includeUnstaged: true,
            operationId,
          })) as GitCommitMessageGenerateResult;
          const commitMessageError = getCommitMessageResultError(generatedCommit);
          if (commitMessageError) {
            finishWithError(commitMessageError);
            return;
          }

          onWorkflowChange?.({
            workflow: "create-pull-request",
            phase: "committing",
            operationId,
          });
          const commitResult = (await invoke("git:action:commit", {
            cwd,
            hostId,
            message: generatedCommit.message ?? "",
            includeUnstaged: false,
            nextStep: "commit",
            operationId,
          })) as GitActionMutationResult;
          const commitError = getGitActionResultError(commitResult);
          if (commitError) {
            finishWithError(commitError);
            return;
          }

          latestStatus = await getGitWorkerClient().request({
            method: "action-status",
            params: { cwd },
          });
        }

        if (shouldPushBeforePullRequest(latestStatus)) {
          onWorkflowChange?.({
            workflow: "create-pull-request",
            phase: "pushing",
            operationId,
          });
          const pushResult = (await invoke("git:action:push", {
            cwd,
            operationId,
          })) as GitActionMutationResult;
          const pushError = getGitActionResultError(pushResult);
          if (pushError) {
            finishWithError(pushError);
            return;
          }

          latestStatus = await getGitWorkerClient().request({
            method: "action-status",
            params: { cwd },
          });
        }

        if (!nextTitle || !nextBody) {
          onWorkflowChange?.({
            workflow: "create-pull-request",
            phase: "generating-pr-message",
            operationId,
          });
          const generatedPullRequest = (await invoke("git:action:pull-request-message:generate", {
            cwd,
            hostId,
            title: nextTitle,
            body: nextBody,
            headBranch: latestStatus.currentBranch,
            baseBranch: latestStatus.defaultBranch,
            operationId,
          })) as GitPullRequestMessageGenerateResult;
          const pullRequestMessageError = getPullRequestMessageResultError(generatedPullRequest);
          if (pullRequestMessageError) {
            finishWithError(pullRequestMessageError);
            return;
          }

          nextTitle = generatedPullRequest.title ?? "";
          nextBody = generatedPullRequest.body ?? "";
          setTitle(nextTitle);
          setBody(nextBody);
        }

        onWorkflowChange?.({
          workflow: "create-pull-request",
          phase: "creating-pr",
          operationId,
        });
        const result = (await invoke("gh-pr-create", {
          cwd,
          title: nextTitle,
          body: nextBody,
          base: latestStatus.defaultBranch,
          head: latestStatus.currentBranch,
          draft,
        })) as GhPrMutationResult;
        const createError = getPullRequestMutationError(result);
        if (createError) {
          finishWithError(createError);
          return;
        }

        if (openInBrowser) openPullRequestUrl(result.url);
        onCompleted?.();
        onOpenChange(false);
      } catch (error) {
        finishWithError(error instanceof Error ? error.message : "Could not create pull request.");
      } finally {
        setBusy(false);
        setActiveOperationId((current) => (current === operationId ? null : current));
        onWorkflowChange?.(null);
      }
    },
    [
      body,
      busy,
      canCreate,
      cwd,
      effectiveIncludeLocalChanges,
      finishWithError,
      hostId,
      onCompleted,
      onErrorMessage,
      onOpenChange,
      onWorkflowChange,
      readState.status,
      title,
    ],
  );

  return (
    <NodexDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogTitle className="sr-only">Create PR</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">{statusMessage}</NodexDialogDescription>
        <div className="flex h-9 items-center justify-between gap-3 px-3 text-sm text-token-description-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <BranchStatusIcon className="icon-xs shrink-0" />
            <span className="truncate">{branchLabel}</span>
          </span>
          <span className="shrink-0 text-size-chat">{statusMessage}</span>
        </div>
        {existingPullRequestUrl ? (
          <div className="min-h-32 px-3 py-2 text-token-description-foreground">
            A pull request already exists for this branch.
          </div>
        ) : (
          <div className="flex min-h-32 flex-col gap-2 text-token-description-foreground">
            <input
              autoFocus
              id="create-pr-title"
              aria-label="Title"
              placeholder="Title"
              value={title}
              disabled={busy || readState.loading || ghBlocked}
              onInput={handleTitleInput}
              onChange={handleTitleInput}
              className="w-full bg-transparent px-3 pt-2 font-semibold text-token-input-foreground outline-none placeholder:text-token-description-foreground disabled:opacity-60"
            />
            <textarea
              id="create-pr-message"
              rows={3}
              aria-label="Message"
              placeholder="Description (leave empty to generate)…"
              value={body}
              disabled={busy || readState.loading || ghBlocked}
              onInput={handleBodyInput}
              onChange={handleBodyInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                  event.stopPropagation();
                }
              }}
              className="min-h-0 w-full flex-1 resize-none bg-transparent px-3 pb-2 text-token-input-foreground outline-none placeholder:text-token-description-foreground disabled:opacity-60"
            />
            <label
              className={cn(
                "relative flex items-center gap-2 px-3 pt-2 pb-3 text-token-foreground",
                (busy || readState.loading || !readState.status?.hasUncommittedChanges) &&
                  "opacity-60",
              )}
            >
              <Input
                type="checkbox"
                checked={includeLocalChanges}
                disabled={busy || readState.loading || !readState.status?.hasUncommittedChanges}
                onChange={(event) => setIncludeLocalChanges(event.currentTarget.checked)}
                className="size-4 w-4 shrink-0 rounded border-token-border p-0"
              />
              <span>Commit and push local changes</span>
            </label>
          </div>
        )}
        {inlineError ? (
          <p className="px-3 pb-3 text-xs text-token-error-foreground">{inlineError}</p>
        ) : null}
        <NodexDialogFooter
          bodyClassName="!pt-0"
          className="border-t border-token-border-default px-3 py-2"
        >
          <NodexButton
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy && !activeOperationId}
            onClick={busy ? cancelActiveOperation : () => onOpenChange(false)}
          >
            {busy ? "Cancel" : "Close"}
          </NodexButton>
          {existingPullRequestUrl ? (
            <NodexButton
              type="button"
              size="sm"
              disabled={!existingPullRequestUrl}
              onClick={() => openPullRequestUrl(existingPullRequestUrl)}
            >
              <BrowserExternalIcon className="icon-xs" />
              Open PR in browser
            </NodexButton>
          ) : (
            <>
              <NodexButton
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canCreate}
                onClick={() => void runCreatePullRequest({ draft: true, openInBrowser: false })}
              >
                <EditIcon className="icon-xs" />
                Create draft PR
              </NodexButton>
              <NodexButton
                type="button"
                size="sm"
                disabled={!canCreate}
                onClick={() => void runCreatePullRequest({ draft: false, openInBrowser: false })}
              >
                <ThreadSummaryCreatePullRequestIcon className="icon-xs" />
                Create PR
              </NodexButton>
              <NodexButton
                type="button"
                variant="secondary"
                size="sm"
                disabled={!canCreate}
                onClick={() => void runCreatePullRequest({ draft: false, openInBrowser: true })}
              >
                <BrowserExternalIcon className="icon-xs" />
                Open PR in browser
              </NodexButton>
            </>
          )}
        </NodexDialogFooter>
      </NodexDialogContent>
    </NodexDialog>
  );
}

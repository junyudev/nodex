import {
  BranchStatusIcon,
  ReviewCommitOrPushIcon,
  ThreadSummaryCommitIcon,
} from "@/components/shared/icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { getGitWorkerClient, invoke } from "@/lib/api";
import type {
  GitActionMutationResult,
  GitActionStatusResult,
  GitCommitMessageGenerateResult,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export type SummaryGitActionDialogMode = "commit" | "push";
export type SummaryGitActionWorkflowKind = SummaryGitActionDialogMode | "create-pull-request";
export type SummaryGitActionWorkflowPhase =
  | "generating-commit-message"
  | "generating-pr-message"
  | "committing"
  | "pushing"
  | "creating-pr";

export interface SummaryGitActionWorkflowState {
  workflow: SummaryGitActionWorkflowKind;
  phase: SummaryGitActionWorkflowPhase;
  operationId: string;
}

interface ThreadSummaryGitActionDialogProps {
  open: boolean;
  cwd: string | null;
  hostId?: string;
  initialMode: SummaryGitActionDialogMode;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
  onErrorMessage: (message: string | null) => void;
  onWorkflowChange?: (state: SummaryGitActionWorkflowState | null) => void;
}

const EMPTY_COMMIT_MESSAGE = "";

export function createGitActionOperationId(): string {
  return `summary-git-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getGitActionStatusMessage(
  status: GitActionStatusResult | null,
  mode: SummaryGitActionDialogMode,
): string {
  if (!status) return "Checking Git state";
  if (!status.isGitRepository) return "Git repository is required.";
  if (mode === "push" && status.canPush) {
    return status.pushNeedsUpstream
      ? `Push ${status.currentBranch ?? "this branch"} and set upstream.`
      : `Push ${status.commitsAhead} commit${status.commitsAhead === 1 ? "" : "s"}.`;
  }
  if (mode === "push") return "No commits are ready to push.";
  if (status.hasUncommittedChanges) return "Commit local changes.";
  if (status.canPush) return "No local changes. Push branch commits instead.";
  return "No changes to commit or push.";
}

function getResultError(result: GitActionMutationResult): string | null {
  if (result.status === "success") return null;
  return result.errorMessage ?? (result.stderr.trim() || "Git action failed.");
}

function getGenerationResultError(result: GitCommitMessageGenerateResult): string | null {
  if (result.status === "success" && result.message) return null;
  return result.errorMessage ?? (result.stderr.trim() || "Could not generate a commit message.");
}

function getGitActionSelectionSummary(
  status: GitActionStatusResult | null,
  mode: SummaryGitActionDialogMode,
): string {
  if (!status) return "Checking Git state";
  if (!status.isGitRepository) return "No repository";
  if (mode === "push") {
    if (status.commitsAhead > 0) {
      return `${status.commitsAhead} commit${status.commitsAhead === 1 ? "" : "s"}`;
    }
    return status.pushNeedsUpstream ? "Set upstream" : "No commits";
  }
  if (status.hasUncommittedChanges) return "Local changes";
  if (status.canPush) {
    return `${status.commitsAhead} commit${status.commitsAhead === 1 ? "" : "s"} ahead`;
  }
  return "No changes";
}

function ThreadSummaryGitActionCommand({
  children,
  disabled,
  icon,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "group flex h-8 w-full min-w-0 cursor-interaction items-center gap-2 rounded-sm px-3 text-left text-sm text-token-foreground outline-none",
        "hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
        disabled && "cursor-not-allowed text-token-text-secondary opacity-60 hover:bg-transparent",
      )}
      onClick={onClick}
    >
      <span className="shrink-0 text-token-text-tertiary">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </button>
  );
}

export function ThreadSummaryGitActionDialog({
  open,
  cwd,
  hostId = "local",
  initialMode,
  onOpenChange,
  onCompleted,
  onErrorMessage,
  onWorkflowChange,
}: ThreadSummaryGitActionDialogProps) {
  const [status, setStatus] = useState<GitActionStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(EMPTY_COMMIT_MESSAGE);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [inlineError, setInlineError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      if (busy) return;
      setBusy(false);
      setInlineError(null);
      setMessage(EMPTY_COMMIT_MESSAGE);
      setIncludeUnstaged(true);
      onWorkflowChange?.(null);
      return;
    }

    if (!cwd) {
      setStatus(null);
      setInlineError("Working directory is required.");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setInlineError(null);
    void getGitWorkerClient()
      .request({ method: "action-status", params: { cwd } })
      .then((result) => {
        if (cancelled) return;
        setStatus(result as GitActionStatusResult);
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus(null);
        setInlineError(error instanceof Error ? error.message : "Could not read Git state.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [busy, cwd, onWorkflowChange, open]);

  const mode = useMemo<SummaryGitActionDialogMode>(() => {
    if (initialMode === "push") return "push";
    if (status?.hasUncommittedChanges) return "commit";
    if (status?.canPush) return "push";
    return "commit";
  }, [initialMode, status]);
  const canCommit = Boolean(status?.isGitRepository && status.hasUncommittedChanges);
  const canCommitAndPush =
    canCommit && Boolean(status?.upstreamBranch || status?.remotes.includes("origin"));
  const canPush = Boolean(status?.isGitRepository && status.canPush);
  const statusMessage = getGitActionStatusMessage(status, mode);
  const selectionSummary = getGitActionSelectionSummary(status, mode);
  const handleMessageInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    setMessage(event.currentTarget.value);
  }, []);

  const handleMutationResult = useCallback(
    (result: GitActionMutationResult) => {
      const error = getResultError(result);
      if (error) {
        setInlineError(error);
        onErrorMessage(error);
        return;
      }

      onErrorMessage(null);
      onCompleted?.();
      onOpenChange(false);
    },
    [onCompleted, onErrorMessage, onOpenChange],
  );

  const runCommit = useCallback(
    async (nextStep: "commit" | "commit-and-push") => {
      if (!cwd || busy || !canCommit) return;
      const operationId = createGitActionOperationId();
      const trimmedMessage = message.trim();
      setBusy(true);
      setInlineError(null);
      onWorkflowChange?.({
        workflow: "commit",
        phase: trimmedMessage ? "committing" : "generating-commit-message",
        operationId,
      });
      onOpenChange(false);
      try {
        let commitMessage = trimmedMessage;
        let commitIncludeUnstaged = includeUnstaged;
        if (!commitMessage) {
          const generatedResult = (await invoke("git:action:commit-message:generate", {
            cwd,
            hostId,
            draftMessage: trimmedMessage,
            includeUnstaged,
            operationId,
          })) as GitCommitMessageGenerateResult;
          const generationError = getGenerationResultError(generatedResult);
          if (generationError) {
            setInlineError(generationError);
            onErrorMessage(generationError);
            return;
          }

          commitMessage = generatedResult.message ?? "";
          commitIncludeUnstaged = false;
          setMessage(commitMessage);
          onWorkflowChange?.({
            workflow: "commit",
            phase: "committing",
            operationId,
          });
        }

        const result = (await invoke("git:action:commit", {
          cwd,
          hostId,
          message: commitMessage,
          includeUnstaged: commitIncludeUnstaged,
          nextStep: "commit",
          operationId,
        })) as GitActionMutationResult;

        const commitError = getResultError(result);
        if (commitError) {
          handleMutationResult(result);
          return;
        }

        if (nextStep === "commit-and-push") {
          onWorkflowChange?.({
            workflow: "commit",
            phase: "pushing",
            operationId,
          });
          const pushResult = (await invoke("git:action:push", {
            cwd,
            operationId,
          })) as GitActionMutationResult;
          handleMutationResult(pushResult);
          return;
        }

        handleMutationResult(result);
      } catch (error) {
        const nextError = error instanceof Error ? error.message : "Could not commit changes.";
        setInlineError(nextError);
        onErrorMessage(nextError);
      } finally {
        setBusy(false);
        onWorkflowChange?.(null);
      }
    },
    [
      busy,
      canCommit,
      cwd,
      handleMutationResult,
      hostId,
      includeUnstaged,
      message,
      onErrorMessage,
      onOpenChange,
      onWorkflowChange,
    ],
  );

  const runPush = useCallback(async () => {
    if (!cwd || busy || !canPush) return;
    const operationId = createGitActionOperationId();
    setBusy(true);
    setInlineError(null);
    onWorkflowChange?.({
      workflow: "push",
      phase: "pushing",
      operationId,
    });
    onOpenChange(false);
    try {
      const result = (await invoke("git:action:push", {
        cwd,
        operationId,
      })) as GitActionMutationResult;
      handleMutationResult(result);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "Could not push changes.";
      setInlineError(nextError);
      onErrorMessage(nextError);
    } finally {
      setBusy(false);
      onWorkflowChange?.(null);
    }
  }, [busy, canPush, cwd, handleMutationResult, onErrorMessage, onOpenChange, onWorkflowChange]);

  return (
    <NodexDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogTitle className="sr-only">Commit or push</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">{statusMessage}</NodexDialogDescription>
        <div className="flex h-9 items-center justify-between gap-3 px-3 text-sm text-token-description-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <BranchStatusIcon className="icon-xs shrink-0" />
            <span className="truncate">{status?.currentBranch ?? "-"}</span>
          </span>
          <span className="shrink-0 text-size-chat">
            {loading ? "Checking Git state" : selectionSummary}
          </span>
        </div>
        {mode === "commit" ? (
          <div className="flex min-h-32 flex-col gap-2 text-token-description-foreground">
            <textarea
              autoFocus
              rows={3}
              aria-label="Commit message"
              placeholder="Commit message (leave blank to generate)…"
              value={message}
              disabled={busy || loading}
              onInput={handleMessageInput}
              onChange={handleMessageInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                  event.stopPropagation();
                }
              }}
              className="h-20 w-full resize-none bg-transparent px-3 py-2 text-token-input-foreground outline-none placeholder:text-token-description-foreground disabled:opacity-60"
            />
            <label
              className={cn(
                "relative flex items-center gap-2 px-3 pt-2 pb-3 text-token-foreground",
                (busy || loading) && "opacity-60",
              )}
            >
              <Input
                type="checkbox"
                checked={includeUnstaged}
                disabled={busy || loading}
                onChange={(event) => setIncludeUnstaged(event.currentTarget.checked)}
                className="size-4 w-4 shrink-0 rounded border-token-border p-0"
              />
              <span>Include unstaged changes</span>
            </label>
          </div>
        ) : (
          <div className="min-h-24 px-3 py-3 text-sm text-token-description-foreground">
            {statusMessage}
          </div>
        )}
        {inlineError ? (
          <p className="px-3 pb-3 text-xs text-token-error-foreground">{inlineError}</p>
        ) : null}
        <div className="border-t border-token-border-default py-1">
          {mode === "push" ? (
            <ThreadSummaryGitActionCommand
              disabled={busy || loading || !canPush}
              icon={<ReviewCommitOrPushIcon className="icon-xs" />}
              onClick={() => void runPush()}
            >
              Push
            </ThreadSummaryGitActionCommand>
          ) : (
            <>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canCommit}
                icon={<ThreadSummaryCommitIcon className="icon-xs" />}
                onClick={() => void runCommit("commit")}
              >
                Commit
              </ThreadSummaryGitActionCommand>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canCommitAndPush}
                icon={<ReviewCommitOrPushIcon className="icon-xs" />}
                onClick={() => void runCommit("commit-and-push")}
              >
                Commit and push
              </ThreadSummaryGitActionCommand>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canPush}
                icon={<ReviewCommitOrPushIcon className="icon-xs" />}
                onClick={() => void runPush()}
              >
                Push
              </ThreadSummaryGitActionCommand>
            </>
          )}
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}

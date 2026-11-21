import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { toastFailure } from "@/lib/failure-toast";
import { runWithCleanup } from "@/lib/run-with-cleanup";
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
import {
  formatGitDraftError,
  threadSummaryGitOperations,
} from "../../thread-summary-git-operations";
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
  chatThreadId?: string;
  initialMode: SummaryGitActionDialogMode;
  onOpenChange: (open: boolean) => void;
  onCompleted?: () => void;
  onWorkflowChange?: (state: SummaryGitActionWorkflowState | null) => void;
}

const EMPTY_COMMIT_MESSAGE = "";

export function createGitActionOperationId(): string {
  return `summary-git-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function getGitActionStatusMessage(
  intl: IntlShape,
  status: GitActionStatusResult | null,
  mode: SummaryGitActionDialogMode,
): string {
  if (!status)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.checkingGit",
      defaultMessage: "Checking Git state",
    });
  if (!status.isGitRepository)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.needsRepository",
      defaultMessage: "Git repository is required.",
    });
  if (mode === "push" && status.canPush) {
    return status.pushNeedsUpstream
      ? intl.formatMessage(
          {
            id: "conversation.threadSummaryGitActionDialog.pushAndSetUpstream",
            defaultMessage: "Push {branch} and set upstream.",
          },
          {
            branch:
              status.currentBranch ??
              intl.formatMessage({
                id: "conversation.threadSummaryGitActionDialog.thisBranch",
                defaultMessage: "this branch",
              }),
          },
        )
      : intl.formatMessage(
          {
            id: "conversation.threadSummaryGitActionDialog.pushCommits",
            defaultMessage: "Push {count, plural, one {# commit} other {# commits}}.",
          },
          { count: status.commitsAhead },
        );
  }
  if (mode === "push")
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.noCommitsToPush",
      defaultMessage: "No commits are ready to push.",
    });
  if (status.hasUncommittedChanges)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.commitLocal",
      defaultMessage: "Commit local changes.",
    });
  if (status.canPush)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.pushInstead",
      defaultMessage: "No local changes. Push branch commits instead.",
    });
  return intl.formatMessage({
    id: "conversation.threadSummaryGitActionDialog.noChangesToCommitOrPush",
    defaultMessage: "No changes to commit or push.",
  });
}

function getResultError(result: GitActionMutationResult): string | null {
  if (result.status === "success") return null;
  return (
    formatGitDraftError(result.errorCode) ??
    result.errorMessage ??
    (result.stderr.trim() ||
      getIntl().formatMessage({
        id: "conversation.threadSummaryGitActionDialog.gitError",
        defaultMessage: "Git action failed.",
      }))
  );
}

function getGenerationResultError(result: GitCommitMessageGenerateResult): string | null {
  if (result.status === "success" && result.message) return null;
  return (
    formatGitDraftError(result.errorCode) ??
    result.errorMessage ??
    (result.stderr.trim() ||
      getIntl().formatMessage({
        id: "conversation.threadSummaryGitActionDialog.generateErrorPeriod",
        defaultMessage: "Could not generate a commit message.",
      }))
  );
}

function getGitActionSelectionSummary(
  intl: IntlShape,
  status: GitActionStatusResult | null,
  mode: SummaryGitActionDialogMode,
): string {
  if (!status)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.checkingGit",
      defaultMessage: "Checking Git state",
    });
  if (!status.isGitRepository)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.noRepo",
      defaultMessage: "No repository",
    });
  if (mode === "push") {
    if (status.commitsAhead > 0) {
      return intl.formatMessage(
        {
          id: "conversation.threadSummaryGitActionDialog.commits",
          defaultMessage: "{count, plural, one {# commit} other {# commits}}",
        },
        { count: status.commitsAhead },
      );
    }
    return status.pushNeedsUpstream
      ? intl.formatMessage({
          id: "conversation.threadSummaryGitActionDialog.setUpstream",
          defaultMessage: "Set upstream",
        })
      : intl.formatMessage({
          id: "conversation.threadSummaryGitActionDialog.noCommits",
          defaultMessage: "No commits",
        });
  }
  if (status.hasUncommittedChanges)
    return intl.formatMessage({
      id: "conversation.threadSummaryGitActionDialog.localChanges",
      defaultMessage: "Local changes",
    });
  if (status.canPush) {
    return intl.formatMessage(
      {
        id: "conversation.threadSummaryGitActionDialog.commitsAhead",
        defaultMessage: "{count, plural, one {# commit} other {# commits}} ahead",
      },
      { count: status.commitsAhead },
    );
  }
  return intl.formatMessage({
    id: "conversation.threadSummaryGitActionDialog.noChanges",
    defaultMessage: "No changes",
  });
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
  chatThreadId,
  initialMode,
  onOpenChange,
  onCompleted,
  onWorkflowChange,
}: ThreadSummaryGitActionDialogProps) {
  const intl = useIntl();
  const [status, setStatus] = useState<GitActionStatusResult | null>(null);
  const [loading, setLoading] = useState(Boolean(open && cwd));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(EMPTY_COMMIT_MESSAGE);
  const [includeUnstaged, setIncludeUnstaged] = useState(true);
  const [inlineError, setInlineError] = useState<string | null>(
    open && !cwd
      ? intl.formatMessage({
          id: "conversation.threadSummaryGitActionDialog.needsWorkingDirectory",
          defaultMessage: "Working directory is required.",
        })
      : null,
  );
  const [previousRead, setPreviousRead] = useState({ open, cwd, busy, onWorkflowChange });
  if (
    previousRead.open !== open ||
    previousRead.cwd !== cwd ||
    previousRead.busy !== busy ||
    previousRead.onWorkflowChange !== onWorkflowChange
  ) {
    setPreviousRead({ open, cwd, busy, onWorkflowChange });
    if (!open && !busy) {
      setInlineError(null);
      setMessage(EMPTY_COMMIT_MESSAGE);
      setIncludeUnstaged(true);
    }
    if (open) {
      setLoading(Boolean(cwd));
      setInlineError(
        cwd
          ? null
          : intl.formatMessage({
              id: "conversation.threadSummaryGitActionDialog.needsWorkingDirectory",
              defaultMessage: "Working directory is required.",
            }),
      );
      if (!cwd) setStatus(null);
    }
  }

  useEffect(() => {
    if (!open) {
      if (busy) return;
      onWorkflowChange?.(null);
      return;
    }

    if (!cwd) return;

    let cancelled = false;
    void threadSummaryGitOperations
      .readStatus(cwd)
      .then((result) => {
        if (cancelled) return;
        setStatus(result as GitActionStatusResult);
      })
      .catch((error) => {
        if (cancelled) return;
        setStatus(null);
        setInlineError(
          error instanceof Error
            ? error.message
            : getIntl().formatMessage({
                id: "conversation.threadSummaryGitActionDialog.readGitError",
                defaultMessage: "Could not read Git state.",
              }),
        );
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
  const statusMessage = getGitActionStatusMessage(intl, status, mode);
  const selectionSummary = getGitActionSelectionSummary(intl, status, mode);
  const handleMessageInput = useCallback((event: FormEvent<HTMLTextAreaElement>) => {
    setMessage(event.currentTarget.value);
  }, []);

  const handleMutationResult = useCallback(
    (result: GitActionMutationResult, failureTitle: string) => {
      const error = getResultError(result);
      if (error) {
        toastFailure(failureTitle, error);
        return;
      }
      onCompleted?.();
      onOpenChange(false);
    },
    [onCompleted, onOpenChange],
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
      let failureTitle = getIntl().formatMessage({
        id: "conversation.threadSummaryGitActionDialog.commitError",
        defaultMessage: "Couldn’t commit changes",
      });
      return runWithCleanup(
        async () => {
          let commitMessage = trimmedMessage;
          if (!commitMessage) {
            failureTitle = getIntl().formatMessage({
              id: "conversation.threadSummaryGitActionDialog.generateError",
              defaultMessage: "Couldn’t generate a commit message",
            });
            const generatedResult = await threadSummaryGitOperations.generateCommitMessage({
              cwd,
              chatThreadId,
              draftMessage: trimmedMessage,
              includeUnstaged,
              operationId,
            });
            const generationError = getGenerationResultError(generatedResult);
            if (generationError) {
              toastFailure(failureTitle, generationError);
              return;
            }

            commitMessage = generatedResult.message ?? "";
            setMessage(commitMessage);
            onWorkflowChange?.({
              workflow: "commit",
              phase: "committing",
              operationId,
            });
          }

          failureTitle = getIntl().formatMessage({
            id: "conversation.threadSummaryGitActionDialog.commitError",
            defaultMessage: "Couldn’t commit changes",
          });
          const result = await threadSummaryGitOperations.commit({
            cwd,
            chatThreadId,
            message: commitMessage,
            includeUnstaged,
            nextStep: "commit",
            operationId,
          });

          const commitError = getResultError(result);
          if (commitError) {
            handleMutationResult(result, failureTitle);
            return;
          }

          if (nextStep === "commit-and-push") {
            failureTitle = getIntl().formatMessage({
              id: "conversation.threadSummaryGitActionDialog.pushError",
              defaultMessage: "Couldn’t push changes",
            });
            onWorkflowChange?.({
              workflow: "commit",
              phase: "pushing",
              operationId,
            });
            const pushResult = await threadSummaryGitOperations.push({
              cwd,
              operationId,
            });
            handleMutationResult(pushResult, failureTitle);
            return;
          }

          handleMutationResult(result, failureTitle);
        },
        {
          cleanup: () => {
            setBusy(false);
            onWorkflowChange?.(null);
          },
          onError: (error) => {
            toastFailure(failureTitle, error);
          },
        },
      );
    },
    [
      busy,
      canCommit,
      cwd,
      handleMutationResult,
      chatThreadId,
      includeUnstaged,
      message,
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
    return runWithCleanup(
      async () => {
        const result = await threadSummaryGitOperations.push({
          cwd,
          operationId,
        });
        handleMutationResult(
          result,
          getIntl().formatMessage({
            id: "conversation.threadSummaryGitActionDialog.pushError",
            defaultMessage: "Couldn’t push changes",
          }),
        );
      },
      {
        cleanup: () => {
          setBusy(false);
          onWorkflowChange?.(null);
        },
        onError: (error) => {
          toastFailure(
            getIntl().formatMessage({
              id: "conversation.threadSummaryGitActionDialog.pushError",
              defaultMessage: "Couldn’t push changes",
            }),
            error,
          );
        },
      },
    );
  }, [busy, canPush, cwd, handleMutationResult, onOpenChange, onWorkflowChange]);

  return (
    <NodexDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && busy) return;
        onOpenChange(nextOpen);
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogTitle className="sr-only">
          {intl.formatMessage({
            id: "conversation.threadSummaryGitActionDialog.commitOrPush",
            defaultMessage: "Commit or push",
          })}
        </NodexDialogTitle>
        <NodexDialogDescription className="sr-only">{statusMessage}</NodexDialogDescription>
        <div className="flex h-9 items-center justify-between gap-3 px-3 text-sm text-token-description-foreground">
          <span className="flex min-w-0 items-center gap-2">
            <BranchStatusIcon className="icon-xs shrink-0" />
            <span className="truncate">{status?.currentBranch ?? "-"}</span>
          </span>
          <span className="shrink-0 text-size-chat">
            {loading
              ? intl.formatMessage({
                  id: "conversation.threadSummaryGitActionDialog.checkingGit",
                  defaultMessage: "Checking Git state",
                })
              : selectionSummary}
          </span>
        </div>
        {mode === "commit" ? (
          <div className="flex min-h-32 flex-col gap-2 text-token-description-foreground">
            <textarea
              autoFocus
              rows={3}
              aria-label={intl.formatMessage({
                id: "conversation.threadSummaryGitActionDialog.commitMessage",
                defaultMessage: "Commit message",
              })}
              placeholder={intl.formatMessage({
                id: "conversation.threadSummaryGitActionDialog.messagePlaceholder",
                defaultMessage: "Commit message (leave blank to generate)…",
              })}
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
              <span>
                {intl.formatMessage({
                  id: "conversation.threadSummaryGitActionDialog.includeUnstaged",
                  defaultMessage: "Include unstaged changes",
                })}
              </span>
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
              {intl.formatMessage({
                id: "conversation.threadSummaryGitActionDialog.push",
                defaultMessage: "Push",
              })}
            </ThreadSummaryGitActionCommand>
          ) : (
            <>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canCommit}
                icon={<ThreadSummaryCommitIcon className="icon-xs" />}
                onClick={() => void runCommit("commit")}
              >
                {intl.formatMessage({
                  id: "conversation.threadSummaryGitActionDialog.commit",
                  defaultMessage: "Commit",
                })}
              </ThreadSummaryGitActionCommand>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canCommitAndPush}
                icon={<ReviewCommitOrPushIcon className="icon-xs" />}
                onClick={() => void runCommit("commit-and-push")}
              >
                {intl.formatMessage({
                  id: "conversation.threadSummaryGitActionDialog.commitAndPush",
                  defaultMessage: "Commit and push",
                })}
              </ThreadSummaryGitActionCommand>
              <ThreadSummaryGitActionCommand
                disabled={busy || loading || !canPush}
                icon={<ReviewCommitOrPushIcon className="icon-xs" />}
                onClick={() => void runPush()}
              >
                {intl.formatMessage({
                  id: "conversation.threadSummaryGitActionDialog.push",
                  defaultMessage: "Push",
                })}
              </ThreadSummaryGitActionCommand>
            </>
          )}
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}

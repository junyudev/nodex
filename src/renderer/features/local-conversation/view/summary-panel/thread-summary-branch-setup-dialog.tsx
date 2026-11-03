import { GitBranchPlus } from "@/components/shared/icons/generic-icons";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  buildWorktreeThreadSlug,
  readWorktreeAutoBranchPrefix,
} from "@/lib/worktree-branch-prefix";
import {
  validateCreateBranchName,
  type BranchCreateValidation,
} from "../shared/branch-selector-popover";

interface ThreadSummaryBranchSetupDialogProps {
  branches: readonly string[];
  currentBranch: string | null;
  defaultBranch: string | null;
  open: boolean;
  threadTitle?: string | null;
  onCreateBranch: (branch: string) => Promise<boolean>;
  onCreated: (branch: string) => void;
  onOpenChange: (open: boolean) => void;
}

function buildDefaultSummaryBranchName(threadTitle: string | null | undefined): string {
  return `${readWorktreeAutoBranchPrefix()}${buildWorktreeThreadSlug(threadTitle)}`;
}

function getCreateBranchValidationMessage(validation: BranchCreateValidation): string | null {
  if (validation === "trailing-slash") return "Branch name cannot end with “/”.";
  if (validation === "exists") return "Branch already exists.";
  return null;
}

export function ThreadSummaryBranchSetupDialog({
  branches,
  currentBranch,
  defaultBranch,
  open,
  threadTitle,
  onCreateBranch,
  onCreated,
  onOpenChange,
}: ThreadSummaryBranchSetupDialogProps) {
  const defaultBranchName = useMemo(
    () => buildDefaultSummaryBranchName(threadTitle),
    [threadTitle],
  );
  const [branchName, setBranchName] = useState(defaultBranchName);
  const [busy, setBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  const existingBranchNames = useMemo(
    () =>
      new Set([
        ...branches,
        ...(currentBranch ? [currentBranch] : []),
        ...(defaultBranch ? [defaultBranch] : []),
      ]),
    [branches, currentBranch, defaultBranch],
  );
  const normalizedBranchName = branchName.trim();
  const validation = validateCreateBranchName(branchName, existingBranchNames);
  const validationMessage = getCreateBranchValidationMessage(validation);
  const canSubmit = validation === null && !busy;

  useEffect(() => {
    if (!open) return;
    setBranchName(defaultBranchName);
    setInlineError(null);
  }, [defaultBranchName, open]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && busy) return;
      if (nextOpen) {
        setBranchName(defaultBranchName);
        setInlineError(null);
      }

      onOpenChange(nextOpen);
    },
    [busy, defaultBranchName, onOpenChange],
  );

  const handleSubmit = useCallback(
    async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault();
      if (!canSubmit) return;

      setBusy(true);
      setInlineError(null);

      try {
        const didCreate = await onCreateBranch(normalizedBranchName);
        if (!didCreate) {
          setInlineError("Could not create branch.");
          return;
        }

        onCreated(normalizedBranchName);
        onOpenChange(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Could not create branch.";
        setInlineError(message);
      } finally {
        setBusy(false);
      }
    },
    [canSubmit, normalizedBranchName, onCreateBranch, onCreated, onOpenChange],
  );

  return (
    <NodexDialog open={open} onOpenChange={handleOpenChange}>
      <NodexDialogContent size="compact" showCloseButton={!busy}>
        <NodexDialogForm onSubmit={(event) => void handleSubmit(event)}>
          <NodexDialogHeader>
            <div className="flex size-8 items-center justify-center rounded-lg bg-token-surface-secondary text-token-foreground">
              <GitBranchPlus className="icon-sm" aria-hidden="true" />
            </div>
            <NodexDialogTitle>Work here</NodexDialogTitle>
            <NodexDialogDescription>
              Create a branch to commit changes, push, and create a PR from this checkout.
            </NodexDialogDescription>
          </NodexDialogHeader>

          <NodexDialogBody className="gap-2">
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm font-medium text-token-foreground">Branch name</span>
            </div>
            <Input
              autoFocus
              aria-label="Branch name"
              placeholder={readWorktreeAutoBranchPrefix() || "Create a new branch"}
              value={branchName}
              disabled={busy}
              onChange={(event) => setBranchName(event.currentTarget.value)}
            />
            {validationMessage ? (
              <p className="text-xs text-token-charts-red">{validationMessage}</p>
            ) : inlineError ? (
              <p className="text-xs text-token-charts-red">{inlineError}</p>
            ) : null}
          </NodexDialogBody>

          <NodexDialogFooter>
            <NodexDialogAction disabled={busy} onClick={() => handleOpenChange(false)}>
              Close
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={!canSubmit}>
              {busy ? "Creating…" : "Create"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

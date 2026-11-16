import { FormattedMessage, useIntl } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
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

export interface StableWorktreeCreateDialogProps {
  open: boolean;
  initialProjectName: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (projectName: string) => void | Promise<void>;
}

export function StableWorktreeCreateDialog({
  open,
  initialProjectName,
  onOpenChange,
  onCreate,
}: StableWorktreeCreateDialogProps) {
  const intl = useIntl();
  const [projectName, setProjectName] = useState(initialProjectName);
  const [errorDetail, setErrorDetail] = useState<{ reason: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const trimmedProjectName = projectName.trim();
  const createDisabled = creating || trimmedProjectName.length === 0;

  const [previousInput, setPreviousInput] = useState({ open, initialProjectName });
  if (previousInput.open !== open || previousInput.initialProjectName !== initialProjectName) {
    setPreviousInput({ open, initialProjectName });
    if (open) {
      setProjectName(initialProjectName);
      setErrorDetail(null);
      setCreating(false);
    }
  }

  const createWorktree = async () => {
    if (createDisabled) return;

    setErrorDetail(null);
    setCreating(true);
    await runWithCleanup(
      async () => {
        await onCreate(trimmedProjectName);
        onOpenChange(false);
      },
      {
        onError: (error) => {
          setErrorDetail({ reason: error instanceof Error ? error.message : String(error) });
        },
        cleanup: () => {
          setCreating(false);
        },
      },
    );
  };

  return (
    <NodexDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onOpenChange(false);
      }}
    >
      <NodexDialogContent size="compact" showCloseButton={false}>
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            void createWorktree();
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>
              <FormattedMessage
                id="workbench.stableWorktreeCreateDialog.title"
                defaultMessage="Create worktree and save as a project"
              />
            </NodexDialogTitle>
            <NodexDialogDescription>
              <FormattedMessage
                id="workbench.stableWorktreeCreateDialog.description"
                defaultMessage="Create a new git worktree from HEAD, add it as a project, and keep it until you remove it"
              />
            </NodexDialogDescription>
          </NodexDialogHeader>

          <NodexDialogBody className="gap-2">
            <input
              aria-label={intl.formatMessage({
                id: "workbench.stableWorktreeCreateDialog.projectName",
                defaultMessage: "Project name",
              })}
              autoFocus
              className="rounded-xl border border-token-border px-3 py-2 text-base text-token-input-foreground shadow-sm outline-none"
              placeholder={intl.formatMessage({
                id: "workbench.stableWorktreeCreateDialog.projectName",
                defaultMessage: "Project name",
              })}
              value={projectName}
              onChange={(event) => setProjectName(event.currentTarget.value)}
              onInput={(event) => setProjectName(event.currentTarget.value)}
            />
            {errorDetail ? (
              <p role="alert" className="text-sm text-token-charts-red">
                {intl.formatMessage(
                  {
                    id: "workbench.stableWorktreeCreateDialog.createFailed",
                    defaultMessage: "Failed to create permanent worktree: {reason}",
                  },
                  errorDetail,
                )}
              </p>
            ) : null}
          </NodexDialogBody>

          <NodexDialogFooter>
            <NodexDialogAction disabled={creating} onClick={() => onOpenChange(false)}>
              <FormattedMessage
                id="workbench.stableWorktreeCreateDialog.cancel"
                defaultMessage="Cancel"
              />
            </NodexDialogAction>
            <NodexDialogAction type="submit" tone="primary" disabled={createDisabled}>
              <FormattedMessage
                id="workbench.stableWorktreeCreateDialog.create"
                defaultMessage="Create"
              />
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

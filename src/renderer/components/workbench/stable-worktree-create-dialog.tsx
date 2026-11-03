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

const STABLE_WORKTREE_CREATE_ERROR_PREFIX = "Failed to create permanent worktree:";

function createErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${STABLE_WORKTREE_CREATE_ERROR_PREFIX} ${message}`;
}

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
  const [projectName, setProjectName] = useState(initialProjectName);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const trimmedProjectName = projectName.trim();
  const createDisabled = creating || trimmedProjectName.length === 0;

  const [previousInput, setPreviousInput] = useState({ open, initialProjectName });
  if (previousInput.open !== open || previousInput.initialProjectName !== initialProjectName) {
    setPreviousInput({ open, initialProjectName });
    if (open) {
      setProjectName(initialProjectName);
      setErrorMessage(null);
      setCreating(false);
    }
  }

  const createWorktree = async () => {
    if (createDisabled) return;

    setErrorMessage(null);
    setCreating(true);
    await runWithCleanup(
      async () => {
        await onCreate(trimmedProjectName);
        onOpenChange(false);
      },
      {
        onError: (error) => {
          setErrorMessage(createErrorMessage(error));
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
            <NodexDialogTitle>Create worktree and save as a project</NodexDialogTitle>
            <NodexDialogDescription>
              Create a new git worktree from HEAD, add it as a project, and keep it until you remove
              it
            </NodexDialogDescription>
          </NodexDialogHeader>

          <NodexDialogBody className="gap-2">
            <input
              aria-label="Project name"
              autoFocus
              className="rounded-xl border border-token-border px-3 py-2 text-base text-token-input-foreground shadow-sm outline-none"
              placeholder="Project name"
              value={projectName}
              onChange={(event) => setProjectName(event.currentTarget.value)}
              onInput={(event) => setProjectName(event.currentTarget.value)}
            />
            {errorMessage ? (
              <p role="alert" className="text-sm text-token-charts-red">
                {errorMessage}
              </p>
            ) : null}
          </NodexDialogBody>

          <NodexDialogFooter>
            <NodexDialogAction disabled={creating} onClick={() => onOpenChange(false)}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction type="submit" tone="primary" disabled={createDisabled}>
              Create
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

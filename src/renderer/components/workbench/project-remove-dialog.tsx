import { useState, type FormEvent } from "react";
import type { Project, ProjectArchiveBlocker, ProjectLifecycleMutationResult } from "@/lib/types";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
  NodexDialogDescription,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

export function describeProjectArchiveBlockers(blockers: readonly ProjectArchiveBlocker[]): string {
  const kinds = new Set(blockers.map((blocker) => blocker.kind));
  if (kinds.has("execution-handoff"))
    return "Wait for the chat’s workspace move to finish before removing this project.";
  const hasTask = kinds.has("active-turn") || kinds.has("pending-request");
  const hasProcess = kinds.has("terminal") || kinds.has("background-process");
  if (hasTask && hasProcess) {
    return "Stop the active task and close its terminals before removing this project.";
  }
  if (hasTask) return "Stop the active task before removing this project.";
  if (hasProcess)
    return "Close the project’s terminals and background processes before removing it.";
  return "This project still has active work. Stop it before removing the project.";
}

function blockerAccessibleLabel(blocker: ProjectArchiveBlocker): string {
  if (blocker.kind === "execution-handoff") return `Workspace move in thread ${blocker.threadId}`;
  if (blocker.kind === "terminal") {
    return `Live terminal ${blocker.terminalSessionId}`;
  }
  if (blocker.kind === "background-process") {
    return blocker.label
      ? `Background process in ${blocker.label}`
      : `Background process in thread ${blocker.threadId}`;
  }
  const label = blocker.label ?? blocker.threadId;
  return blocker.kind === "active-turn" ? `Active task in ${label}` : `Pending request in ${label}`;
}

export function ProjectRemoveDialog({
  open,
  project,
  onOpenChange,
  onArchiveProject,
}: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
}) {
  const [pending, setPending] = useState(false);
  const [blockers, setBlockers] = useState<readonly ProjectArchiveBlocker[]>([]);

  const setOpen = (nextOpen: boolean) => {
    if (pending) return;
    if (!nextOpen) setBlockers([]);
    onOpenChange(nextOpen);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending) return;

    setPending(true);
    setBlockers([]);
    try {
      const result = await onArchiveProject(project.id);
      if (result.kind === "blocked") {
        setBlockers(result.blockers);
        return;
      }
      if (result.kind === "not-found") {
        toast.danger(`Could not remove ${project.name}`, {
          description: "The project could not be found.",
        });
        return;
      }
      onOpenChange(false);
    } catch (error) {
      toast.danger(`Could not remove ${project.name}`, {
        description: error instanceof Error ? error.message : "Unknown error",
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <NodexDialog
      open={open}
      disablePointerDismissal={pending}
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && pending) {
          details.cancel();
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <NodexDialogContent size="compact">
        <NodexDialogForm onSubmit={(event) => void submit(event)}>
          <NodexDialogHeader>
            <NodexDialogTitle>Remove {project.name}?</NodexDialogTitle>
            <NodexDialogDescription>
              This removes the project from the app. Files on your computer and existing chats won’t
              be deleted.
            </NodexDialogDescription>
          </NodexDialogHeader>

          {blockers.length > 0 ? (
            <NodexDialogBody>
              <div
                role="alert"
                className="rounded-lg bg-token-charts-red/10 px-3 py-2 text-sm text-token-charts-red"
              >
                {describeProjectArchiveBlockers(blockers)}
                <ul className="sr-only">
                  {blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}:${index}`}>{blockerAccessibleLabel(blocker)}</li>
                  ))}
                </ul>
              </div>
            </NodexDialogBody>
          ) : null}

          <NodexDialogFooter>
            <NodexDialogAction type="button" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="danger" type="submit" disabled={pending}>
              {pending ? "Removing…" : "Remove project"}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

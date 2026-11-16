import { FormattedMessage, getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { runWithCleanup } from "@/lib/run-with-cleanup";
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

export function describeProjectArchiveBlockers(
  blockers: readonly ProjectArchiveBlocker[],
  intl: IntlShape = getIntl(),
): string {
  const kinds = new Set(blockers.map((blocker) => blocker.kind));
  if (kinds.has("execution-handoff"))
    return intl.formatMessage({
      id: "workbench.projectRemoveDialog.workspaceMove",
      defaultMessage: "Wait for the chat’s workspace move to finish before removing this project.",
    });
  const hasTask = kinds.has("active-turn") || kinds.has("pending-request");
  const hasProcess = kinds.has("terminal") || kinds.has("background-process");
  if (hasTask && hasProcess) {
    return intl.formatMessage({
      id: "workbench.projectRemoveDialog.activeTaskAndTerminals",
      defaultMessage: "Stop the active task and close its terminals before removing this project.",
    });
  }
  if (hasTask)
    return intl.formatMessage({
      id: "workbench.projectRemoveDialog.activeTask",
      defaultMessage: "Stop the active task before removing this project.",
    });
  if (hasProcess)
    return intl.formatMessage({
      id: "workbench.projectRemoveDialog.terminalsAndProcesses",
      defaultMessage: "Close the project’s terminals and background processes before removing it.",
    });
  return intl.formatMessage({
    id: "workbench.projectRemoveDialog.workActive",
    defaultMessage: "This project still has active work. Stop it before removing the project.",
  });
}

function blockerAccessibleLabel(intl: IntlShape, blocker: ProjectArchiveBlocker): string {
  if (blocker.kind === "execution-handoff")
    return intl.formatMessage(
      {
        id: "workbench.projectRemoveDialog.threadWorkspaceMove",
        defaultMessage: "Workspace move in thread {thread}",
      },
      { thread: blocker.threadId },
    );
  if (blocker.kind === "terminal") {
    return intl.formatMessage(
      {
        id: "workbench.projectRemoveDialog.liveTerminal",
        defaultMessage: "Live terminal {terminal}",
      },
      { terminal: blocker.terminalSessionId },
    );
  }
  if (blocker.kind === "background-process") {
    return blocker.label
      ? intl.formatMessage(
          {
            id: "workbench.projectRemoveDialog.namedBackgroundProcess",
            defaultMessage: "Background process in {label}",
          },
          { label: blocker.label },
        )
      : intl.formatMessage(
          {
            id: "workbench.projectRemoveDialog.threadBackgroundProcess",
            defaultMessage: "Background process in thread {thread}",
          },
          { thread: blocker.threadId },
        );
  }
  const label = blocker.label ?? blocker.threadId;
  return blocker.kind === "active-turn"
    ? intl.formatMessage(
        { id: "workbench.projectRemoveDialog.taskIn", defaultMessage: "Active task in {label}" },
        { label },
      )
    : intl.formatMessage(
        {
          id: "workbench.projectRemoveDialog.requestIn",
          defaultMessage: "Pending request in {label}",
        },
        { label },
      );
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
  const intl = useIntl();
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
    await runWithCleanup(
      async () => {
        const result = await onArchiveProject(project.id);
        if (result.kind === "blocked") {
          setBlockers(result.blockers);
          return;
        }
        if (result.kind === "not-found") {
          toast.danger(
            getIntl().formatMessage(
              {
                id: "workbench.projectRemoveDialog.removeFailed",
                defaultMessage: "Could not remove {project}",
              },
              { project: project.name },
            ),
            {
              description: getIntl().formatMessage({
                id: "workbench.projectRemoveDialog.projectNotFound",
                defaultMessage: "The project could not be found.",
              }),
            },
          );
          return;
        }
        onOpenChange(false);
      },
      {
        onError: (error) => {
          toast.danger(
            getIntl().formatMessage(
              {
                id: "workbench.projectRemoveDialog.removeFailed",
                defaultMessage: "Could not remove {project}",
              },
              { project: project.name },
            ),
            {
              description:
                error instanceof Error
                  ? error.message
                  : getIntl().formatMessage({
                      id: "workbench.projectRemoveDialog.unknownError",
                      defaultMessage: "Unknown error",
                    }),
            },
          );
        },
        cleanup: () => {
          setPending(false);
        },
      },
    );
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
            <NodexDialogTitle>
              <FormattedMessage
                id="workbench.projectRemoveDialog.title"
                defaultMessage={"Remove {project}?"}
                values={{ project: project.name }}
              />
            </NodexDialogTitle>
            <NodexDialogDescription>
              <FormattedMessage
                id="workbench.projectRemoveDialog.description"
                defaultMessage={
                  "This removes the project from the app. Files on your computer and existing chats won’t be deleted."
                }
              />
            </NodexDialogDescription>
          </NodexDialogHeader>

          {blockers.length > 0 ? (
            <NodexDialogBody>
              <div
                role="alert"
                className="rounded-lg bg-token-charts-red/10 px-3 py-2 text-sm text-token-charts-red"
              >
                {describeProjectArchiveBlockers(blockers, intl)}
                <ul className="sr-only">
                  {blockers.map((blocker, index) => (
                    <li key={`${blocker.kind}:${index}`}>
                      {blockerAccessibleLabel(intl, blocker)}
                    </li>
                  ))}
                </ul>
              </div>
            </NodexDialogBody>
          ) : null}

          <NodexDialogFooter>
            <NodexDialogAction type="button" disabled={pending} onClick={() => setOpen(false)}>
              <FormattedMessage
                id="workbench.projectRemoveDialog.cancel"
                defaultMessage={"Cancel"}
              />
            </NodexDialogAction>
            <NodexDialogAction tone="danger" type="submit" disabled={pending}>
              {pending
                ? intl.formatMessage({
                    id: "workbench.projectRemoveDialog.removing",
                    defaultMessage: "Removing…",
                  })
                : intl.formatMessage({
                    id: "workbench.projectRemoveDialog.removeProject",
                    defaultMessage: "Remove project",
                  })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}

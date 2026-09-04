import { useState } from "react";

import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  buildLibraryProjectAccessOperation,
  buildLibraryProjectGrantOperation,
} from "@/lib/library-operations";
import type { ModalCloseProps } from "@/lib/modal-registry";
import {
  useApplyLibraryOperation,
  useLibraryResourceProjectAccess,
} from "@/lib/use-library-navigation";
import { LibraryResourceAccessDialog } from "./library-resource-access-dialog";
import {
  libraryResourceTargetKey,
  type LibraryProjectOption,
  type LibraryResourceTarget as PlacedLibraryResourceTarget,
  type OpenLibraryResourceInProject,
} from "./library-resource-action-types";
import type { LibraryResourceTarget } from "../../../shared/library-module";

interface LibraryResourceAccessModalProps extends ModalCloseProps {
  readonly target: LibraryResourceTarget;
  readonly title: string;
}

function LibraryResourceAccessModalContent({
  target,
  title,
  onClose,
}: LibraryResourceAccessModalProps) {
  const { mutation } = useApplyLibraryOperation();
  const projectAccess = useLibraryResourceProjectAccess(target);

  const applyProjectAccess = async (
    changes: Parameters<typeof buildLibraryProjectAccessOperation>[0]["changes"],
  ) => {
    try {
      await mutation.mutateAsync(buildLibraryProjectAccessOperation({ target, changes }));
      onClose();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not update Project access");
    }
  };

  return (
    <LibraryResourceAccessDialog
      open
      title={title}
      projects={projectAccess.data?.value.projects ?? []}
      isLoading={projectAccess.isPending}
      error={projectAccess.error}
      isSaving={mutation.isPending}
      onOpenChange={(open) => !open && onClose()}
      onRetry={() => void projectAccess.refetch()}
      onSave={applyProjectAccess}
    />
  );
}

const accessTargetKey = (target: LibraryResourceTarget): string => {
  if (target.kind === "file") return `file:${target.fileId}`;
  if (target.kind === "canvas") return `canvas:${target.canvasId}`;
  return libraryResourceTargetKey(target);
};

export function LibraryResourceAccessModal(props: LibraryResourceAccessModalProps) {
  return <LibraryResourceAccessModalContent key={accessTargetKey(props.target)} {...props} />;
}

interface LibraryOpenInProjectModalProps extends ModalCloseProps {
  readonly target: PlacedLibraryResourceTarget;
  readonly title: string;
  readonly projects: readonly LibraryProjectOption[];
  readonly onOpenInProject: OpenLibraryResourceInProject;
}

function LibraryOpenInProjectModalContent({
  target,
  title,
  projects,
  onOpenInProject,
  onClose,
}: LibraryOpenInProjectModalProps) {
  const [requestedProjectId, setRequestedProjectId] = useState(projects[0]?.id ?? "");
  const [access, setAccess] = useState<"read" | "read_write">("read_write");
  const { mutation } = useApplyLibraryOperation();
  const projectId = projects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : (projects[0]?.id ?? "");

  const applyGrant = async () => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) {
      toast.danger("Choose an active Project");
      return;
    }
    try {
      const receipt = await mutation.mutateAsync(
        buildLibraryProjectGrantOperation({
          projectId: project.id,
          target,
          access,
        }),
      );
      if (!receipt.didMutate) toast.info(`${project.name} already has this access`);
      onClose();
      await onOpenInProject(project.id, target, title);
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not grant Project access");
    }
  };

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="compact">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Open in Project</NodexDialogTitle>
            <NodexDialogDescription>
              The grant applies recursively to {title}. Ownership and the Project&apos;s primary
              Database do not change.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogBody className="gap-3">
            <label className="grid gap-1.5 text-sm text-token-text-primary">
              Project
              <select
                value={projectId}
                className="h-9 rounded-lg bg-token-bg-secondary px-3 outline-none focus:ring-2 focus:ring-token-border"
                onChange={(event) => setRequestedProjectId(event.target.value)}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="grid gap-1.5 text-sm text-token-text-primary">
              <legend className="mb-1">Access</legend>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="library-project-access"
                  checked={access === "read"}
                  onChange={() => setAccess("read")}
                />
                Read
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="library-project-access"
                  checked={access === "read_write"}
                  onChange={() => setAccess("read_write")}
                />
                Read &amp; write
              </label>
            </fieldset>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              disabled={!projectId || mutation.isPending}
              onClick={() => void applyGrant()}
            >
              Grant and open
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

export function LibraryOpenInProjectModal(props: LibraryOpenInProjectModalProps) {
  return (
    <LibraryOpenInProjectModalContent key={libraryResourceTargetKey(props.target)} {...props} />
  );
}

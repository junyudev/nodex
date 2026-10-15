import { useState } from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { ModalCloseProps } from "@/lib/modal-registry";
import {
  libraryResourceTargetKey,
  type LibraryProjectOption,
  type LibraryResourceTarget as PlacedLibraryResourceTarget,
  type OpenLibraryResourceInProject,
} from "./library-resource-action-types";

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
  const [isOpening, setIsOpening] = useState(false);
  const projectId = projects.some((project) => project.id === requestedProjectId)
    ? requestedProjectId
    : (projects[0]?.id ?? "");

  const openInProject = async () => {
    if (!projectId || isOpening) return;
    setIsOpening(true);
    try {
      await onOpenInProject(projectId, target, title);
      onClose();
    } catch (error) {
      toast.danger(error instanceof Error ? error.message : "Could not open in Project");
    } finally {
      setIsOpening(false);
    }
  };

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent size="compact">
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Open in Project</NodexDialogTitle>
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
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onClose}>Cancel</NodexDialogAction>
            <NodexDialogAction
              tone="primary"
              disabled={!projectId || isOpening}
              onClick={() => void openInProject()}
            >
              Open
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

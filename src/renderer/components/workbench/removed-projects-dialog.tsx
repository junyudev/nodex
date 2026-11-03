import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useState } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import { useRemovedProjects } from "@/lib/use-projects";
import type { Project } from "@/lib/types";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { ProjectMarker } from "./project-marker";

function ProjectIdentity({ project }: { project: Project }) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-token-foreground/6 text-sm">
        <ProjectMarker appearance={project.appearance} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-token-foreground">
          {project.name}
        </span>
        {project.primaryWorkspaceRoot ? (
          <span className="block truncate text-xs text-token-description-foreground">
            {project.primaryWorkspaceRoot}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function RemovedProjectsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!open) return null;
  return <OpenRemovedProjectsDialog onOpenChange={onOpenChange} />;
}

function OpenRemovedProjectsDialog({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const {
    projects,
    loading,
    error,
    retry,
    restoreProject,
    hasMoreProjects,
    loadingMoreProjects,
    loadMoreProjects,
  } = useRemovedProjects(true);
  const [restoringProjectIds, setRestoringProjectIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const restore = async (project: Project) => {
    if (restoringProjectIds.has(project.id)) return;
    setRestoringProjectIds((current) => new Set(current).add(project.id));
    await runWithCleanup(
      async () => {
        const result = await restoreProject(project.id);
        if (result.kind !== "updated") {
          throw new Error(
            result.kind === "not-found"
              ? "The project could not be found."
              : "The project could not be restored while work is active.",
          );
        }
        toast.success(`Restored “${project.name}”`);
      },
      {
        onError: (restoreError) => {
          toast.danger(`Could not restore ${project.name}`, {
            description: restoreError instanceof Error ? restoreError.message : "Unknown error",
          });
        },
        cleanup: () => {
          setRestoringProjectIds((current) => {
            const next = new Set(current);
            next.delete(project.id);
            return next;
          });
        },
      },
    );
  };

  return (
    <NodexDialog open onOpenChange={onOpenChange}>
      <RemovedProjectsDialogView
        projects={projects}
        loading={loading}
        error={error}
        restoringProjectIds={restoringProjectIds}
        hasMoreProjects={hasMoreProjects}
        loadingMoreProjects={loadingMoreProjects}
        onLoadMoreProjects={() => void loadMoreProjects()}
        onRetry={() => void retry()}
        onRestore={(project) => void restore(project)}
      />
    </NodexDialog>
  );
}

export function RemovedProjectsDialogView({
  projects,
  loading,
  error,
  restoringProjectIds,
  hasMoreProjects = false,
  loadingMoreProjects = false,
  onLoadMoreProjects,
  onRetry,
  onRestore,
}: {
  projects: readonly Project[];
  loading: boolean;
  error: string | null;
  restoringProjectIds: ReadonlySet<string>;
  hasMoreProjects?: boolean;
  loadingMoreProjects?: boolean;
  onLoadMoreProjects?: () => void;
  onRetry: () => void;
  onRestore: (project: Project) => void;
}) {
  return (
    <NodexDialogContent className="max-h-[min(620px,calc(100vh-3rem))]">
      <NodexDialogFrame className="max-h-[min(620px,calc(100vh-3rem))] min-h-0">
        <NodexDialogHeader>
          <NodexDialogTitle>Removed projects</NodexDialogTitle>
          <NodexDialogDescription>
            Restore projects to return them and their chats to the sidebar.
          </NodexDialogDescription>
        </NodexDialogHeader>

        <NodexDialogBody className="min-h-0">
          <div className="min-h-28 overflow-y-auto pr-1">
            {loading ? (
              <div
                aria-label="Loading removed projects"
                className="flex min-h-28 items-center justify-center text-token-description-foreground"
                role="status"
              >
                <ActivitySpinnerIcon className="size-4" />
              </div>
            ) : error ? (
              <div className="flex min-h-28 flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-token-description-foreground">
                  Could not load removed projects.
                </p>
                <NodexButton size="sm" variant="secondary" onClick={onRetry}>
                  Retry
                </NodexButton>
              </div>
            ) : projects.length === 0 ? (
              <p className="flex min-h-28 items-center justify-center text-sm text-token-description-foreground">
                No removed projects
              </p>
            ) : (
              <ul className="divide-y divide-token-border/70">
                {projects.map((project) => {
                  const restoring = restoringProjectIds.has(project.id);
                  return (
                    <li
                      key={project.id}
                      className="flex min-w-0 items-center justify-between gap-4 py-3 first:pt-1 last:pb-1"
                    >
                      <ProjectIdentity project={project} />
                      <NodexButton
                        size="sm"
                        variant="secondary"
                        disabled={restoring}
                        onClick={() => onRestore(project)}
                      >
                        {restoring ? "Restoring…" : "Restore"}
                      </NodexButton>
                    </li>
                  );
                })}
              </ul>
            )}
            {!loading && !error && hasMoreProjects ? (
              <div className="flex justify-center pt-3">
                <NodexButton
                  size="sm"
                  variant="ghost"
                  disabled={loadingMoreProjects}
                  onClick={onLoadMoreProjects}
                >
                  {loadingMoreProjects ? "Loading…" : "Show more"}
                </NodexButton>
              </div>
            ) : null}
          </div>
        </NodexDialogBody>
      </NodexDialogFrame>
    </NodexDialogContent>
  );
}

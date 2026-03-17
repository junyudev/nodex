import { useMemo, useState } from "react";
import { invoke } from "../../lib/api";
import type { Project } from "../../lib/types";
import type { SpaceRef } from "../../lib/use-workbench-state";
import { cn } from "../../lib/utils";
import { ChevronDown, FolderOpen, Plus } from "lucide-react";
import {
  ProjectManagerPopover,
  ProjectMark,
  type SidebarProjectManagerDataProps,
} from "./left-sidebar-project-manager";

interface SidebarProjectsSectionProps extends SidebarProjectManagerDataProps {
  expanded: boolean;
  onToggleExpanded: () => void;
}

function resolveOrderedProjects(projects: Project[], spaces: SpaceRef[]) {
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const seen = new Set<string>();
  const orderedProjects: Array<{ project: Project; colorToken?: string }> = [];

  for (const space of spaces) {
    const project = projectById.get(space.projectId);
    if (!project || seen.has(project.id)) continue;
    seen.add(project.id);
    orderedProjects.push({ project, colorToken: space.colorToken });
  }

  for (const project of projects) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    orderedProjects.push({ project });
  }

  return orderedProjects;
}

export function SidebarProjectsSection({
  projects,
  spaces,
  activeProjectId,
  expanded,
  onToggleExpanded,
  onSelectSpace,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
}: SidebarProjectsSectionProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const orderedProjects = useMemo(
    () => resolveOrderedProjects(projects, spaces),
    [projects, spaces],
  );
  const visibleProjects = expanded
    ? orderedProjects
    : orderedProjects.filter(({ project }) => project.id === activeProjectId);

  const handleSetProjectWorkspacePath = async (project: Project) => {
    try {
      const pickedPath = (await invoke("pty:pick-cwd")) as string | null;
      if (!pickedPath) return;

      await onRenameProject(project.id, project.id, project.name, undefined, pickedPath);
    } catch {
      // Keep the manager popover as the fallback path editor.
    }
  };

  return (
    <section className="mb-2">
      <div
        className={cn(
          "group/top-header flex min-h-7.5 items-center gap-1 rounded-lg pl-(--sidebar-header-padding-x) pr-1 py-(--sidebar-row-padding-tight-y)",
          "text-token-input-placeholder-foreground hover:bg-sidebar-accent hover:text-(--sidebar-foreground) font-medium",
        )}
      >
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          className="mr-auto flex min-w-0 flex-1 items-center gap-2 text-left text-xs outline-none"
        >
          <div className="flex min-w-0 items-center gap-1">
            <span className="truncate">Projects</span>
            <span className="shrink-0 text-[11px]/5 text-(--sidebar-foreground-tertiary)">
              {orderedProjects.length}
            </span>
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-(--sidebar-foreground) transition-all duration-150",
                "opacity-0 group-hover/top-header:opacity-100 group-focus-visible/top-header:opacity-100",
                !expanded && "-rotate-90",
              )}
            />
          </div>
        </button>
        <ProjectManagerPopover
          projects={projects}
          spaces={spaces}
          activeProjectId={activeProjectId}
          onSelectSpace={onSelectSpace}
          onCreateProject={onCreateProject}
          onDeleteProject={onDeleteProject}
          onRenameProject={onRenameProject}
          open={manageOpen}
          onOpenChange={setManageOpen}
          side="bottom"
          align="end"
          sideOffset={8}
          contentClassName="w-80"
          trigger={(
            <button
              type="button"
              className={cn(
                "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md outline-none",
                "text-(--sidebar-foreground-tertiary) hover:bg-[color-mix(in_srgb,var(--sidebar-foreground)_8%,transparent)] hover:text-(--sidebar-foreground)",
                "focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
              )}
              title="Manage projects"
              aria-label="Manage projects"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        />
      </div>

      <div className="mt-px flex min-h-0 flex-col gap-px overflow-hidden">
        {visibleProjects.map(({ project, colorToken }) => {
          const workspacePath = project.workspacePath?.trim() ?? "";
          const workspaceLabel = workspacePath || "Choose project folder";
          const workspaceTitle = workspacePath || `Choose a workspace folder for ${project.name}`;
          const isActive = project.id === activeProjectId;

          return (
            <div
              key={project.id}
              data-active={isActive ? "true" : undefined}
              className={cn(
                "group/project rounded-xl pr-(--sidebar-header-padding-x) pl-(--sidebar-row-padding-x) py-1 min-h-7.5",
                isActive
                  ? "bg-[color-mix(in_srgb,var(--sidebar-accent)_68%,transparent)] text-(--sidebar-foreground)"
                  : "text-(--sidebar-foreground) hover:bg-(--sidebar-accent)",
              )}
            >
              <div className="min-w-0">
                <button
                  type="button"
                  onClick={() => onSelectSpace(project.id)}
                  className="flex w-full min-w-0 items-start gap-1.5 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35"
                >
                  <span
                    className={cn(
                      "ml-[-0.1rem] mt-0.5 inline-flex size-4.5 shrink-0 items-center justify-center rounded-md",
                      isActive
                        ? "opacity-100"
                        : "opacity-40 grayscale",
                    )}
                  >
                    <ProjectMark
                      icon={project.icon}
                      colorToken={colorToken}
                      className="text-sm leading-none"
                      dotClassName="h-2.5 w-2.5"
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-sm">{project.name}</span>
                      <span className="shrink-0 text-[11px]/4 text-(--sidebar-foreground-tertiary)">
                        /{project.id}
                      </span>
                    </span>
                  </span>
                </button>

                {isActive && (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSetProjectWorkspacePath(project);
                    }}
                    title={workspaceTitle}
                    aria-label={workspaceTitle}
                    className={cn(
                      "mt-0.5 ml-6 flex min-w-0 max-w-full items-center gap-1 rounded-md text-[11px]/4 outline-none focus-visible:ring-2 focus-visible:ring-(--sidebar-ring)/35",
                      "text-(--sidebar-foreground-secondary) hover:text-(--sidebar-foreground)",
                    )}
                  >
                    <FolderOpen className="size-3 shrink-0" />
                    <span className="truncate">{workspaceLabel}</span>
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

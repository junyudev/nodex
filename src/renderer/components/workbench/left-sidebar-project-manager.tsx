import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useMemo, useRef, useState } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { invoke } from "@/lib/api";
import { handleFormSubmit } from "@/lib/forms";
import { normalizeProjectIcon } from "@/lib/project-icon";
import {
  type ProjectFormValues,
  resolveProjectIconValue,
  sanitizeProjectIdInput,
  validateProjectIdInput,
  validateProjectNameInput,
} from "@/lib/project-form";
import type { Project } from "@/lib/types";
import type { SpaceRef } from "@/lib/use-workbench-state";
import { cn } from "@/lib/utils";
import { Pencil, Plus, Settings, Smile, Trash2 } from "lucide-react";
import {
  EMPTY_PROJECT_MANAGER_FORM_VALUES,
  resolveProjectManagerFormValues,
} from "./left-sidebar-project-manager-form-values";
import { shouldOpenProjectManagerForRequest } from "./left-sidebar-project-manager-open-request";

const PROJECT_DOT_FALLBACK_COLOR = "var(--accent-blue)";

function ProjectMark({
  icon,
  colorToken,
  className,
  dotClassName,
}: {
  icon?: string;
  colorToken?: string;
  className?: string;
  dotClassName?: string;
}) {
  const normalizedIcon = normalizeProjectIcon(icon);
  if (normalizedIcon) {
    return <span className={className}>{normalizedIcon}</span>;
  }

  return (
    <span
      aria-hidden
      className={cn("inline-block rounded-full", dotClassName)}
      style={{ backgroundColor: colorToken ?? PROJECT_DOT_FALLBACK_COLOR }}
    />
  );
}

interface LeftSidebarProjectManagerProps {
  projects: Project[];
  spaces: SpaceRef[];
  activeProjectId: string;
  onSelectSpace: (projectId: string) => void;
  onOpenSettings: () => void;
  projectPickerOpenTick: number;
  onCreateProject: (
    id: string,
    name: string,
    description?: string,
    icon?: string,
    workspacePath?: string | null,
  ) => Promise<Project | null>;
  onDeleteProject: (projectId: string) => Promise<boolean>;
  onRenameProject: (
    oldId: string,
    newId: string,
    name?: string,
    icon?: string,
    workspacePath?: string | null,
  ) => Promise<Project | null>;
}

export function LeftSidebarProjectManager({
  projects,
  spaces,
  activeProjectId,
  onSelectSpace,
  onOpenSettings,
  projectPickerOpenTick,
  onCreateProject,
  onDeleteProject,
  onRenameProject,
}: LeftSidebarProjectManagerProps) {
  const [manageOpen, setManageOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [editProjectError, setEditProjectError] = useState<string | null>(null);
  const [confirmDeleteProjectId, setConfirmDeleteProjectId] = useState<string | null>(null);
  const createIconInputRef = useRef<HTMLInputElement>(null);
  const editIconInputRef = useRef<HTMLInputElement>(null);
  const lastHandledProjectPickerOpenTickRef = useRef(projectPickerOpenTick);
  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );
  const spaceColorByProjectId = useMemo(
    () => new Map(spaces.map((space) => [space.projectId, space.colorToken])),
    [spaces],
  );
  const activeProject = projectById.get(activeProjectId);

  const createProjectForm = useForm({
    defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES satisfies ProjectFormValues,
    onSubmit: async ({ value }) => {
      const createdProject = await onCreateProject(
        value.id.trim(),
        value.name.trim(),
        undefined,
        resolveProjectIconValue(value.icon),
        value.workspacePath.trim() || null,
      );
      if (!createdProject) {
        setCreateProjectError("Could not create project. The ID may already exist.");
        return;
      }

      onSelectSpace(createdProject.id);
      setManageOpen(false);
    },
  });
  const editProjectForm = useForm({
    defaultValues: EMPTY_PROJECT_MANAGER_FORM_VALUES satisfies ProjectFormValues,
    onSubmit: async ({ value }) => {
      if (!editingProjectId) return;

      const renamedProject = await onRenameProject(
        editingProjectId,
        value.id.trim(),
        value.name.trim(),
        resolveProjectIconValue(value.icon),
        value.workspacePath.trim() || null,
      );
      if (!renamedProject) {
        setEditProjectError("Could not rename project.");
        return;
      }

      setEditingProjectId(null);
      setEditProjectError(null);

      if (editingProjectId !== activeProjectId) return;
      onSelectSpace(renamedProject.id);
    },
  });
  const createProjectValues = useStore(createProjectForm.store, (state) => state.values);
  const editProjectValues = useStore(editProjectForm.store, (state) => state.values);
  const createProjectMeta = useStore(createProjectForm.store, (state) => ({
    isSubmitting: state.isSubmitting,
    submissionAttempts: state.submissionAttempts,
  }));
  const editProjectMeta = useStore(editProjectForm.store, (state) => ({
    isSubmitting: state.isSubmitting,
    submissionAttempts: state.submissionAttempts,
  }));

  useEffect(() => {
    if (!shouldOpenProjectManagerForRequest(projectPickerOpenTick, lastHandledProjectPickerOpenTickRef.current)) {
      return;
    }

    lastHandledProjectPickerOpenTickRef.current = projectPickerOpenTick;
    setManageOpen(true);
  }, [projectPickerOpenTick]);

  useEffect(() => {
    if (manageOpen) return;
    setCreatingProject(false);
    createProjectForm.reset();
    setCreateProjectError(null);
    setEditingProjectId(null);
    editProjectForm.reset();
    setEditProjectError(null);
    setConfirmDeleteProjectId(null);
  }, [createProjectForm, editProjectForm, manageOpen]);

  useEffect(() => {
    if (!editingProjectId) return;
    if (projects.some((project) => project.id === editingProjectId)) return;
    setEditingProjectId(null);
    setEditProjectError(null);
  }, [editingProjectId, projects]);

  const manageInputClass = cn(
    "h-7 w-full rounded-md px-2 text-xs",
    "bg-(--background-secondary) text-(--foreground)",
    "border border-(--border) outline-none",
    "placeholder:text-(--foreground-tertiary)",
    "focus:border-(--accent-blue)",
  );
  const createProjectValidationError = createProjectMeta.submissionAttempts > 0
    ? validateProjectIdInput(createProjectValues.id) ?? validateProjectNameInput(createProjectValues.name)
    : undefined;
  const editProjectValidationError = editProjectMeta.submissionAttempts > 0
    ? validateProjectIdInput(editProjectValues.id) ?? validateProjectNameInput(editProjectValues.name)
    : undefined;

  const openCreateForm = () => {
    setEditingProjectId(null);
    setEditProjectError(null);
    setConfirmDeleteProjectId(null);
    createProjectForm.reset(
      resolveProjectManagerFormValues({
        id: "",
        name: "",
        icon: activeProject?.icon,
        workspacePath: activeProject?.workspacePath,
      }),
      { keepDefaultValues: true },
    );
    setCreatingProject(true);
    setCreateProjectError(null);
  };

  const openEditForm = (project: Project) => {
    setCreatingProject(false);
    setCreateProjectError(null);
    setConfirmDeleteProjectId(null);
    editProjectForm.reset(resolveProjectManagerFormValues(project), { keepDefaultValues: true });
    setEditingProjectId(project.id);
    setEditProjectError(null);
  };

  const handleDeleteProject = async (project: Project) => {
    const success = await onDeleteProject(project.id);
    if (!success) return;

    setConfirmDeleteProjectId(null);
    if (project.id !== activeProjectId) return;

    const fallback = projects.find((candidate) => candidate.id !== project.id);
    if (!fallback) return;
    onSelectSpace(fallback.id);
  };

  const handleOpenCreateEmojiPanel = async () => {
    createIconInputRef.current?.focus();
    try {
      await invoke("window:show-emoji-panel");
    } catch {
      // no-op: keep manual text input available as fallback
    }
  };

  const handleOpenEditEmojiPanel = async () => {
    editIconInputRef.current?.focus();
    try {
      await invoke("window:show-emoji-panel");
    } catch {
      // no-op: keep manual text input available as fallback
    }
  };

  return (
    <div className="border-t border-(--sidebar-border) px-(--sidebar-shell-padding-x) py-(--sidebar-row-padding-y)">
      <div className="grid grid-cols-[28px_1fr_28px] items-center gap-1.5">
        <button
          type="button"
          onClick={onOpenSettings}
          className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-(--sidebar-foreground-secondary) hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)"
          title="Settings"
        >
          <Settings className="size-3.5" />
        </button>

        <div className="hide-scrollbar flex min-w-0 items-center justify-center gap-1 overflow-x-auto">
          {spaces.map((space) => {
            const spaceProject = projectById.get(space.projectId);
            return (
              <button
                type="button"
                key={space.projectId}
                onClick={() => onSelectSpace(space.projectId)}
                className={cn(
                  "inline-flex h-7 w-7 items-center justify-center rounded-lg text-sm",
                  space.projectId === activeProjectId
                    ? "bg-(--sidebar-accent) text-(--sidebar-foreground)"
                    : "text-(--sidebar-foreground-secondary) opacity-55 hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground) hover:opacity-100",
                )}
                title={spaceProject?.name ?? space.projectId}
              >
                <ProjectMark
                  icon={spaceProject?.icon}
                  colorToken={space.colorToken}
                  className="leading-none"
                  dotClassName="h-2.5 w-2.5"
                />
              </button>
            );
          })}
        </div>

        <PopoverPrimitive.Root open={manageOpen} onOpenChange={setManageOpen}>
          <PopoverPrimitive.Trigger asChild>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-(--sidebar-foreground-secondary) hover:bg-(--sidebar-accent) hover:text-(--sidebar-foreground)"
              title="Manage spaces"
            >
              <Plus className="size-3.5" />
            </button>
          </PopoverPrimitive.Trigger>
          <PopoverPrimitive.Portal>
            <PopoverPrimitive.Content
              side="top"
              align="end"
              sideOffset={8}
              className="z-50 w-72 rounded-lg border border-(--border) bg-(--popover) p-2 shadow-lg"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              <div className="px-1 py-1.5 text-xs text-(--foreground-tertiary)">Projects</div>
              <div className="max-h-60 space-y-1 overflow-auto">
                {projects.map((project) => {
                  const isEditing = editingProjectId === project.id;
                  const isConfirmingDelete = confirmDeleteProjectId === project.id;

                  if (isEditing) {
                    return (
                      <form
                        key={project.id}
                        className="space-y-1.5 rounded-md border border-(--border) p-2"
                        onSubmit={(event) => handleFormSubmit(event, editProjectForm.handleSubmit)}
                      >
                        <input
                          type="text"
                          placeholder="project-id"
                          value={editProjectValues.id}
                          onChange={(event) => {
                            editProjectForm.setFieldValue("id", sanitizeProjectIdInput(event.target.value));
                            setEditProjectError(null);
                          }}
                          className={manageInputClass}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            setEditingProjectId(null);
                          }}
                          autoFocus
                        />
                        <input
                          type="text"
                          placeholder="Project name"
                          value={editProjectValues.name}
                          onChange={(event) => {
                            editProjectForm.setFieldValue("name", event.target.value);
                            setEditProjectError(null);
                          }}
                          className={manageInputClass}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            setEditingProjectId(null);
                          }}
                        />
                        <input
                          type="text"
                          placeholder="Workspace path (for Codex threads)"
                          value={editProjectValues.workspacePath}
                          onChange={(event) => {
                            editProjectForm.setFieldValue("workspacePath", event.target.value);
                            setEditProjectError(null);
                          }}
                          className={manageInputClass}
                          onKeyDown={(event) => {
                            if (event.key !== "Escape") return;
                            setEditingProjectId(null);
                          }}
                        />
                        <div className="flex items-center gap-1.5">
                          <input
                            ref={editIconInputRef}
                            type="text"
                            placeholder="Emoji icon (optional)"
                            value={editProjectValues.icon}
                            onChange={(event) => {
                              editProjectForm.setFieldValue("icon", event.target.value);
                              setEditProjectError(null);
                            }}
                            className={cn(manageInputClass, "flex-1")}
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return;
                              setEditingProjectId(null);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void handleOpenEditEmojiPanel()}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--border) text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)"
                            title="Open emoji picker"
                          >
                            <Smile className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              editProjectForm.setFieldValue("icon", "");
                              setEditProjectError(null);
                            }}
                            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--border) text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--destructive)"
                            title="Clear icon"
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        </div>
                        <div className="text-xs text-(--foreground-tertiary)">
                          Click the smile button to open the native emoji picker.
                        </div>
                        {(editProjectValidationError || editProjectError) && (
                          <div className="text-xs text-(--destructive)">
                            {editProjectValidationError ?? editProjectError}
                          </div>
                        )}
                        <div className="flex items-center gap-1.5">
                          <button
                            type="submit"
                            className="h-6 rounded-md bg-(--accent-blue) px-2 text-xs text-white transition-filter hover:brightness-95"
                            disabled={editProjectMeta.isSubmitting}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingProjectId(null)}
                            className="h-6 rounded-md px-2 text-xs text-(--foreground-secondary) hover:bg-(--background-secondary)"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    );
                  }

                  return (
                    <div
                      key={project.id}
                      className="flex items-center gap-1 rounded-md px-1 py-1 hover:bg-(--background-secondary)"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSelectSpace(project.id);
                          setManageOpen(false);
                        }}
                        className="min-w-0 flex-1 truncate text-left text-sm text-(--foreground)"
                      >
                        <span className="mr-1.5 inline-flex w-4 justify-center">
                          <ProjectMark
                            icon={project.icon}
                            colorToken={spaceColorByProjectId.get(project.id)}
                            className="leading-none"
                            dotClassName="h-2 w-2 self-center"
                          />
                        </span>
                        {project.name}
                        <span className="ml-1 text-xs text-(--foreground-tertiary)">/{project.id}</span>
                      </button>
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleDeleteProject(project)}
                            className="h-6 rounded-sm bg-(--destructive) px-1.5 text-xs text-white transition-filter hover:brightness-95"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteProjectId(null)}
                            className="h-6 rounded-sm px-1.5 text-xs text-(--foreground-secondary) hover:bg-(--background-tertiary)"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => openEditForm(project)}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-(--foreground-tertiary) hover:bg-(--background-tertiary) hover:text-(--foreground)"
                            title="Rename"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingProjectId(null);
                              setConfirmDeleteProjectId(project.id);
                            }}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-(--foreground-tertiary) hover:bg-(--background-tertiary) hover:text-(--destructive)"
                            title="Delete"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              {creatingProject ? (
                <form
                  className="mt-2 space-y-1.5 rounded-md border border-(--border) p-2"
                  onSubmit={(event) => handleFormSubmit(event, createProjectForm.handleSubmit)}
                >
                  <input
                    type="text"
                    placeholder="project-id"
                    value={createProjectValues.id}
                    onChange={(event) => {
                      createProjectForm.setFieldValue("id", sanitizeProjectIdInput(event.target.value));
                      setCreateProjectError(null);
                    }}
                    className={manageInputClass}
                    autoFocus
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      setCreatingProject(false);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Project name"
                    value={createProjectValues.name}
                    onChange={(event) => {
                      createProjectForm.setFieldValue("name", event.target.value);
                      setCreateProjectError(null);
                    }}
                    className={manageInputClass}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      setCreatingProject(false);
                    }}
                  />
                  <input
                    type="text"
                    placeholder="Workspace path (for Codex threads)"
                    value={createProjectValues.workspacePath}
                    onChange={(event) => {
                      createProjectForm.setFieldValue("workspacePath", event.target.value);
                      setCreateProjectError(null);
                    }}
                    className={manageInputClass}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      setCreatingProject(false);
                    }}
                  />
                  <div className="flex items-center gap-1.5">
                    <input
                      ref={createIconInputRef}
                      type="text"
                      placeholder="Emoji icon (optional)"
                      value={createProjectValues.icon}
                      onChange={(event) => {
                        createProjectForm.setFieldValue("icon", event.target.value);
                        setCreateProjectError(null);
                      }}
                      className={cn(manageInputClass, "flex-1")}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        setCreatingProject(false);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handleOpenCreateEmojiPanel()}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--border) text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)"
                      title="Open emoji picker"
                    >
                      <Smile className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        createProjectForm.setFieldValue("icon", "");
                        setCreateProjectError(null);
                      }}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-(--border) text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--destructive)"
                      title="Clear icon"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="text-xs text-(--foreground-tertiary)">
                    Click the smile button to open the native emoji picker.
                  </div>
                  {(createProjectValidationError || createProjectError) && (
                    <div className="text-xs text-(--destructive)">
                      {createProjectValidationError ?? createProjectError}
                    </div>
                  )}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="submit"
                      className="h-7 rounded-md bg-(--accent-blue) px-2.5 text-xs text-white transition-filter hover:brightness-95"
                      disabled={createProjectMeta.isSubmitting}
                    >
                      Create
                    </button>
                    <button
                      type="button"
                      onClick={() => setCreatingProject(false)}
                      className="h-7 rounded-md px-2.5 text-xs text-(--foreground-secondary) hover:bg-(--background-secondary)"
                    >
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={openCreateForm}
                  className="mt-2 inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-(--border) text-sm text-(--foreground-secondary) hover:bg-(--background-secondary) hover:text-(--foreground)"
                >
                  <Plus className="size-3.5" />
                  New Project
                </button>
              )}
            </PopoverPrimitive.Content>
          </PopoverPrimitive.Portal>
        </PopoverPrimitive.Root>
      </div>
    </div>
  );
}

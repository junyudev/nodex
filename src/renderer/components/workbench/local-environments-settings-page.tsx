import { startTransition, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivitySpinnerIcon,
  ChevronRightIcon,
  EditIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { localEnvironmentSnapshotQueryOptions } from "@/lib/query-options";
import {
  useLocalEnvironmentConfigs,
  useLocalEnvironmentSnapshot,
  useSaveLocalEnvironmentConfigMutation,
} from "@/lib/use-local-environment-queries";
import { useQueryClient } from "@tanstack/react-query";
import type {
  Project,
  WorktreeEnvironmentConfigRecord,
  WorktreeEnvironmentDefinition,
} from "@/lib/types";
import { ProjectMarker } from "./project-marker";
import { LocalEnvironmentEditor } from "./local-environment-editor";
import { LocalEnvironmentSummary } from "./local-environment-summary";

interface LocalEnvironmentsSettingsPageProps {
  open: boolean;
  active: boolean;
  projects: Project[];
  activeProjectId: string | null;
  initialProjectId?: string | null;
  initialConfigPath?: string | null;
  onAddProject?: () => void;
  renderShell?: (shell: LocalEnvironmentsSettingsShellProps) => ReactNode;
}

type LocalEnvironmentsPageMode = "workspace" | "summary" | "edit";

export interface LocalEnvironmentsSettingsShellProps {
  title: string;
  subtitle?: ReactNode;
  backSlot?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}

function getPrimaryWorkspaceRoot(project: Project): string {
  return project.primaryWorkspaceRoot?.trim() || project.sources[0]?.root.trim() || "";
}

function createEmptyEnvironment(project: Project): WorktreeEnvironmentDefinition {
  const workspaceName = getPrimaryWorkspaceRoot(project).split(/[\\/]/).filter(Boolean).at(-1);
  return {
    version: 1,
    name: workspaceName?.trim() || project.name.trim() || "local",
    setup: { script: null, platformScripts: {} },
    cleanup: { script: null, platformScripts: {} },
    actions: [],
  };
}

function environmentLabel(config: WorktreeEnvironmentConfigRecord): string {
  if (config.state === "tooLarge") return "Environment file is too large";
  if (config.state !== "success") return "Environment needs attention";
  return config.environment?.name || config.name || config.fileName;
}

function WorkspaceProjectEnvironmentGroup({
  project,
  onCreate,
  onSelect,
}: {
  project: Project;
  onCreate: (projectId: string) => void;
  onSelect: (projectId: string, configPath: string) => void;
}) {
  const configsQuery = useLocalEnvironmentConfigs(project.id);
  const configs = configsQuery.data ?? [];

  return (
    <section className="overflow-hidden rounded-lg border-[0.5px] border-token-border">
      <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <ProjectMarker
            appearance={project.appearance}
            className="icon-sm shrink-0 text-token-text-secondary"
          />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="truncate text-sm font-medium text-token-text-primary">
              {project.name}
            </span>
            <span className="truncate text-xs text-token-text-secondary">
              {getPrimaryWorkspaceRoot(project)}
            </span>
          </div>
        </div>
        <NodexButton
          size="icon-sm"
          variant="secondary"
          aria-label={`Add environment for ${project.name}`}
          onClick={() => onCreate(project.id)}
        >
          <PlusIcon className="icon-sm" />
        </NodexButton>
      </div>

      {configsQuery.isPending ? (
        <div className="flex items-center gap-2 border-t-[0.5px] border-token-border px-4 py-3 text-sm text-token-text-secondary">
          <ActivitySpinnerIcon className="icon-xs" />
          Loading environment
        </div>
      ) : configsQuery.isError ? (
        <div className="border-t-[0.5px] border-token-border px-4 py-3 text-sm text-token-error-foreground">
          Environment needs attention
        </div>
      ) : configs.length > 0 ? (
        <div className="divide-y-[0.5px] divide-token-border border-t-[0.5px] border-token-border">
          {configs.map((config) => (
            <button
              key={config.configPath}
              type="button"
              className="flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-token-focus"
              onClick={() => onSelect(project.id, config.configPath)}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={
                    config.state === "success"
                      ? "truncate text-sm text-token-text-primary"
                      : "truncate text-sm text-token-error-foreground"
                  }
                >
                  {environmentLabel(config)}
                </span>
                <span className="truncate text-xs text-token-text-secondary">
                  {config.fileName}
                </span>
              </div>
              <ChevronRightIcon className="icon-xs shrink-0 text-token-text-secondary" />
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function EnvironmentBreadcrumb({
  projectName,
  mode,
  onWorkspace,
  onSummary,
}: {
  projectName: string;
  mode: "summary" | "edit";
  onWorkspace: () => void;
  onSummary: () => void;
}) {
  return (
    <nav
      className="flex min-w-0 items-center gap-1.5 text-sm text-token-text-secondary"
      aria-label="Environment breadcrumb"
    >
      <button
        type="button"
        className="rounded-md outline-hidden hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus"
        onClick={onWorkspace}
      >
        Environments
      </button>
      <ChevronRightIcon className="icon-2xs shrink-0" />
      <button
        type="button"
        className="truncate rounded-md text-token-text-primary outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-token-focus"
        onClick={mode === "edit" ? onSummary : undefined}
      >
        {projectName}
      </button>
      {mode === "edit" ? (
        <>
          <ChevronRightIcon className="icon-2xs shrink-0" />
          <span>edit</span>
        </>
      ) : null}
    </nav>
  );
}

function DefaultShell({
  title,
  subtitle,
  backSlot,
  action,
  children,
}: LocalEnvironmentsSettingsShellProps) {
  return (
    <div className="flex flex-col gap-8">
      {backSlot}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-token-text-primary">{title}</h1>
          {subtitle ? <div className="text-base text-token-text-secondary">{subtitle}</div> : null}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

export function LocalEnvironmentsSettingsPage({
  open,
  active,
  projects,
  activeProjectId,
  initialProjectId,
  initialConfigPath,
  onAddProject,
  renderShell = DefaultShell,
}: LocalEnvironmentsSettingsPageProps) {
  const queryClient = useQueryClient();
  const workspaceProjects = useMemo(
    () => projects.filter((project) => getPrimaryWorkspaceRoot(project)),
    [projects],
  );
  const [mode, setMode] = useState<LocalEnvironmentsPageMode>("workspace");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedConfigPath, setSelectedConfigPath] = useState<string | null>(null);
  const [initializedContext, setInitializedContext] = useState<string | null>(null);
  const selectedProject =
    workspaceProjects.find((project) => project.id === selectedProjectId) ?? null;
  const snapshotQuery = useLocalEnvironmentSnapshot(selectedProjectId ?? "", selectedConfigPath, {
    enabled: mode !== "workspace" && Boolean(selectedProjectId),
  });
  const saveMutation = useSaveLocalEnvironmentConfigMutation();

  useEffect(() => {
    if (!open || !active) return;
    const targetProjectId = initialProjectId ?? (initialConfigPath ? activeProjectId : null);
    const validProjectId = workspaceProjects.some((project) => project.id === targetProjectId)
      ? targetProjectId
      : null;
    const contextKey = `${validProjectId ?? "workspace"}:${initialConfigPath ?? ""}`;
    if (contextKey === initializedContext) return;

    setInitializedContext(contextKey);
    if (!validProjectId) {
      setMode("workspace");
      setSelectedProjectId(null);
      setSelectedConfigPath(null);
      return;
    }

    setSelectedProjectId(validProjectId);
    setSelectedConfigPath(initialConfigPath ?? null);
    setMode("summary");
  }, [
    active,
    activeProjectId,
    initialConfigPath,
    initialProjectId,
    initializedContext,
    open,
    workspaceProjects,
  ]);

  function selectEnvironment(projectId: string, configPath: string): void {
    startTransition(() => {
      setSelectedProjectId(projectId);
      setSelectedConfigPath(configPath);
      setMode("summary");
    });
  }

  function openWorkspace(): void {
    startTransition(() => {
      setMode("workspace");
      setSelectedProjectId(null);
      setSelectedConfigPath(null);
    });
  }

  function openSummary(): void {
    setMode("summary");
  }

  async function createEnvironment(projectId: string): Promise<void> {
    const snapshot = await queryClient.fetchQuery(
      localEnvironmentSnapshotQueryOptions(projectId, null),
    );
    startTransition(() => {
      setSelectedProjectId(projectId);
      setSelectedConfigPath(
        snapshot.configExists || snapshot.configs.length > 0
          ? snapshot.nextConfigPath
          : snapshot.configPath,
      );
      setMode("edit");
    });
  }

  const snapshot = snapshotQuery.data;
  const canEdit = Boolean(
    snapshot &&
    !snapshot.readErrorMessage &&
    !snapshot.tooLargeMessage &&
    (snapshot.environment || snapshot.revision),
  );
  const title =
    mode === "workspace"
      ? "Environments"
      : mode === "edit"
        ? "Edit local environment"
        : snapshot?.environment?.name || selectedProject?.name || "Local environment";
  const subtitle =
    mode === "workspace" ? (
      <>
        Local environments tell Nodex how to set up worktrees for a project.{" "}
        <a
          href="https://developers.openai.com/codex/app/local-environments"
          target="_blank"
          rel="noreferrer"
          className="text-token-text-link-foreground hover:underline"
        >
          Learn more.
        </a>
      </>
    ) : undefined;
  const backSlot =
    mode !== "workspace" && selectedProject ? (
      <EnvironmentBreadcrumb
        projectName={selectedProject.name}
        mode={mode}
        onWorkspace={openWorkspace}
        onSummary={openSummary}
      />
    ) : undefined;
  const action =
    mode === "summary" && canEdit ? (
      <NodexButton
        size="composer"
        variant="secondary"
        aria-label="Edit local environment"
        onClick={() => setMode("edit")}
      >
        <EditIcon className="icon-xs" />
        Edit
      </NodexButton>
    ) : undefined;

  let content: ReactNode;
  if (mode === "workspace") {
    content = (
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium text-token-text-primary">Select a project</h2>
          <NodexButton
            size="composer"
            variant="secondary"
            disabled={!onAddProject}
            onClick={onAddProject}
          >
            Add project
          </NodexButton>
        </div>
        <div className="flex flex-col gap-3">
          {workspaceProjects.map((project) => (
            <WorkspaceProjectEnvironmentGroup
              key={project.id}
              project={project}
              onCreate={(projectId) => void createEnvironment(projectId)}
              onSelect={selectEnvironment}
            />
          ))}
          {workspaceProjects.length === 0 ? (
            <p className="text-sm text-token-text-secondary">
              No projects yet. Add one to configure local environments.
            </p>
          ) : null}
        </div>
      </section>
    );
  } else if (snapshotQuery.isPending) {
    content = (
      <div role="status" className="flex items-center gap-2 text-sm text-token-text-secondary">
        <ActivitySpinnerIcon className="icon-xs" />
        Loading environment
      </div>
    );
  } else if (!snapshot || !selectedProject) {
    content = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-token-error-foreground">Could not load local environment.</p>
        <NodexButton size="composer" onClick={() => void snapshotQuery.refetch()}>
          Retry
        </NodexButton>
      </div>
    );
  } else if (mode === "edit") {
    const environment = snapshot.environment ?? createEmptyEnvironment(selectedProject);
    content = (
      <LocalEnvironmentEditor
        key={`${snapshot.projectId}:${snapshot.configPath}:${snapshot.revision ?? "new"}`}
        environment={environment}
        parseErrorMessage={snapshot.parseErrorMessage}
        onSave={(nextEnvironment) =>
          saveMutation.mutateAsync({
            projectId: snapshot.projectId,
            configPath: snapshot.configPath,
            expectedRevision: snapshot.revision,
            environment: nextEnvironment,
          })
        }
        onSaved={async () => {
          const refreshed = await snapshotQuery.refetch();
          if (refreshed.isError) throw refreshed.error;
          setMode("summary");
        }}
        onDiscard={async () => {
          const refreshed = await snapshotQuery.refetch();
          if (refreshed.isError) throw refreshed.error;
          setMode("summary");
        }}
      />
    );
  } else if (snapshot.environment) {
    content = <LocalEnvironmentSummary environment={snapshot.environment} />;
  } else {
    content = (
      <div className="flex flex-col gap-2 rounded-lg border-[0.5px] border-token-border px-3 py-3">
        <p className="text-sm font-medium text-token-text-primary">Environment needs attention</p>
        <p className="text-sm text-token-text-secondary">
          {snapshot.tooLargeMessage ??
            snapshot.readErrorMessage ??
            snapshot.parseErrorMessage ??
            "The environment file could not be read."}
        </p>
      </div>
    );
  }

  return renderShell({ title, subtitle, backSlot, action, children: content });
}

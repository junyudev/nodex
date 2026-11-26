import { settingsMessages } from "./workbench-settings-search-catalog";
import { useIntl } from "@/lib/i18n";
import { localProjectSourceRoots } from "../../../shared/project-sources";
import { startTransition, useMemo, useState, type ReactNode } from "react";
import {
  ActivitySpinnerIcon,
  ChevronRightIcon,
  EditIcon,
  PlusIcon,
} from "@/components/shared/icons";
import {
  ToolbarBreadcrumb,
  type ToolbarBreadcrumbAncestor,
} from "@/components/ui/toolbar-breadcrumb";
import { NodexSettingsPageSurface, NodexSettingsSection } from "@/components/ui/settings";
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
  return (
    project.primaryWorkspaceRoot?.trim() ||
    localProjectSourceRoots(project.sources)[0]?.trim() ||
    ""
  );
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

function environmentLabel(
  config: WorktreeEnvironmentConfigRecord,
  intl: ReturnType<typeof useIntl>,
): string {
  if (config.state === "tooLarge")
    return intl.formatMessage({
      id: "settings.environments.environmentFileIsTooLarge",
      defaultMessage: "Environment file is too large",
    });
  if (config.state !== "success")
    return intl.formatMessage({
      id: "settings.environments.environmentNeedsAttention",
      defaultMessage: "Environment needs attention",
    });
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
  const intl = useIntl();
  const configsQuery = useLocalEnvironmentConfigs(project.id);
  const configs = configsQuery.data ?? [];

  return (
    <NodexSettingsSection
      title={project.name}
      action={
        <NodexButton
          size="icon-sm"
          variant="secondary"
          aria-label={intl.formatMessage(
            {
              id: "settings.environments.addEnvironmentFor",
              defaultMessage: "Add environment for {name}",
            },
            { name: project.name },
          )}
          onClick={() => onCreate(project.id)}
        >
          <PlusIcon className="icon-sm" />
        </NodexButton>
      }
    >
      <div className="flex min-w-0 items-center gap-2 py-2 text-sm text-token-text-secondary">
        <ProjectMarker appearance={project.appearance} className="icon-sm shrink-0" />
        <span className="truncate">{getPrimaryWorkspaceRoot(project)}</span>
      </div>
      {configsQuery.isPending ? (
        <div className="flex items-center gap-2 py-2 text-sm text-token-text-secondary">
          <ActivitySpinnerIcon className="icon-xs" />
          {intl.formatMessage({
            id: "settings.environments.loadingEnvironment",
            defaultMessage: "Loading environment",
          })}
        </div>
      ) : configsQuery.isError ? (
        <div className="py-2 text-sm text-token-error-foreground">
          {intl.formatMessage({
            id: "settings.environments.environmentNeedsAttention",
            defaultMessage: "Environment needs attention",
          })}
        </div>
      ) : configs.length > 0 ? (
        <div className="divide-y divide-(--color-border)">
          {configs.map((config) => (
            <button
              key={config.configPath}
              type="button"
              className="flex min-h-12 w-full items-center gap-3 py-2 text-start hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-token-focus-border"
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
                  {environmentLabel(config, intl)}
                </span>
                <span className="truncate text-sm text-token-text-secondary">
                  {config.fileName}
                </span>
              </div>
              <ChevronRightIcon className="icon-xs shrink-0 text-token-text-secondary" />
            </button>
          ))}
        </div>
      ) : null}
    </NodexSettingsSection>
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
  const intl = useIntl();
  const ancestors: ToolbarBreadcrumbAncestor[] = [
    {
      id: "environments",
      label: intl.formatMessage(settingsMessages.environmentsTitle),
      onSelect: onWorkspace,
    },
  ];
  if (mode === "edit") {
    ancestors.push({ id: "project", label: projectName, onSelect: onSummary });
  }
  return (
    <ToolbarBreadcrumb
      variant="settings"
      ariaLabel={intl.formatMessage({
        id: "settings.environments.environmentBreadcrumb",
        defaultMessage: "Environment breadcrumb",
      })}
      ancestors={ancestors}
      current={
        mode === "edit"
          ? intl.formatMessage({
              id: "settings.environments.editBreadcrumb",
              defaultMessage: "edit",
            })
          : projectName
      }
    />
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
    <NodexSettingsPageSurface title={title} subtitle={subtitle} backSlot={backSlot} action={action}>
      {children}
    </NodexSettingsPageSurface>
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
  const intl = useIntl();
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

  const targetProjectId = initialProjectId ?? (initialConfigPath ? activeProjectId : null);
  const validProjectId = workspaceProjects.some((project) => project.id === targetProjectId)
    ? targetProjectId
    : null;
  const contextKey = `${validProjectId ?? "workspace"}:${initialConfigPath ?? ""}`;
  if (open && active && contextKey !== initializedContext) {
    setInitializedContext(contextKey);
    setSelectedProjectId(validProjectId);
    setSelectedConfigPath(validProjectId ? (initialConfigPath ?? null) : null);
    setMode(validProjectId ? "summary" : "workspace");
  }

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
      ? intl.formatMessage(settingsMessages.environmentsTitle)
      : mode === "edit"
        ? intl.formatMessage(settingsMessages.environmentsEditLocalEnvironment)
        : snapshot?.environment?.name ||
          selectedProject?.name ||
          intl.formatMessage({
            id: "settings.environments.localEnvironment",
            defaultMessage: "Local environment",
          });
  const subtitle =
    mode === "workspace" ? (
      <>
        {intl.formatMessage({
          id: "settings.environments.localEnvironmentsTellNodexHowTo",
          defaultMessage: "Local environments tell Nodex how to set up worktrees for a project.",
        })}{" "}
        <a
          href="https://developers.openai.com/codex/app/local-environments"
          target="_blank"
          rel="noreferrer"
          className="text-token-text-link-foreground hover:underline"
        >
          {intl.formatMessage({
            id: "settings.environments.learnMore",
            defaultMessage: "Learn more.",
          })}
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
        size="toolbar"
        variant="secondary"
        aria-label={intl.formatMessage(settingsMessages.environmentsEditLocalEnvironment)}
        onClick={() => setMode("edit")}
      >
        <EditIcon className="icon-xs" />
        {intl.formatMessage({ id: "settings.environments.edit", defaultMessage: "Edit" })}
      </NodexButton>
    ) : undefined;

  let content: ReactNode;
  if (mode === "workspace") {
    content = (
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium text-token-text-primary">
            {intl.formatMessage(settingsMessages.environmentsSelectAProject)}
          </h2>
          <NodexButton
            size="toolbar"
            variant="secondary"
            disabled={!onAddProject}
            onClick={onAddProject}
          >
            {intl.formatMessage(settingsMessages.environmentsAddProject)}
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
              {intl.formatMessage(settingsMessages.environmentsNoProjectsYetAddOneTo)}
            </p>
          ) : null}
        </div>
      </section>
    );
  } else if (snapshotQuery.isPending) {
    content = (
      <div role="status" className="flex items-center gap-2 text-sm text-token-text-secondary">
        <ActivitySpinnerIcon className="icon-xs" />
        {intl.formatMessage({
          id: "settings.environments.loadingEnvironment",
          defaultMessage: "Loading environment",
        })}
      </div>
    );
  } else if (!snapshot || !selectedProject) {
    content = (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-token-error-foreground">
          {intl.formatMessage({
            id: "settings.environments.couldNotLoadLocalEnvironment",
            defaultMessage: "Could not load local environment.",
          })}
        </p>
        <NodexButton size="toolbar" onClick={() => void snapshotQuery.refetch()}>
          {intl.formatMessage({ id: "settings.environments.retry", defaultMessage: "Retry" })}
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
      <div className="flex flex-col gap-2 py-2">
        <p className="text-sm font-medium text-token-text-primary">
          {intl.formatMessage({
            id: "settings.environments.environmentNeedsAttention",
            defaultMessage: "Environment needs attention",
          })}
        </p>
        <p className="text-sm text-token-text-secondary">
          {snapshot.tooLargeMessage ??
            snapshot.readErrorMessage ??
            snapshot.parseErrorMessage ??
            intl.formatMessage({
              id: "settings.environments.theEnvironmentFileCouldNotBe",
              defaultMessage: "The environment file could not be read.",
            })}
        </p>
      </div>
    );
  }

  return renderShell({ title, subtitle, backSlot, action, children: content });
}

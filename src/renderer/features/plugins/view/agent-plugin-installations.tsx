import { useId, useState } from "react";
import { NodexButton, NodexSwitch } from "@/components/ui/button";
import type {
  AgentPluginFailure,
  InstalledAgentPlugin,
  PluginPreview,
} from "../../../../shared/agent-plugins/ipc";
import {
  useAgentPluginInstallations,
  useAgentPluginManagement,
  type AgentPluginAction,
} from "../agent-plugin-management";
import { describeInstallation } from "../model/plugin-installation-presentation";
import {
  AgentPluginError,
  AgentPluginPackageReview,
  PluginRejectionReasons,
} from "./agent-plugin-package-review";

type ProjectChoice = { readonly id: string; readonly name: string };

function InstallationRow({
  installation,
  projectId,
  disabled,
  apply,
}: {
  readonly installation: InstalledAgentPlugin;
  readonly projectId: string | null;
  readonly disabled: boolean;
  readonly apply: (action: AgentPluginAction) => Promise<void>;
}) {
  const { id, projectEnabled } = installation;
  const { title, description, sourceLabel } = describeInstallation({
    source: "nodex-installed",
    installation,
  });
  const [confirmingUninstall, setConfirmingUninstall] = useState(false);
  return (
    <li className="space-y-2 py-2">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <div className="min-w-0 flex-1">
          <h3 className="wrap-anywhere text-base font-medium">{title}</h3>
          {description ? (
            <p className="line-clamp-2 text-sm text-token-text-secondary">{description}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`Reload ${title}`}
            onClick={() => void apply({ kind: "reload", id })}
          >
            Reload
          </NodexButton>
          <NodexButton
            size="sm"
            variant="ghost"
            disabled={disabled}
            aria-label={`Uninstall ${title}`}
            aria-expanded={confirmingUninstall}
            onClick={() => setConfirmingUninstall((open) => !open)}
          >
            Uninstall
          </NodexButton>
          {projectId === null ? null : (
            <NodexSwitch
              ariaLabel={`Enable ${title} for this Project`}
              checked={projectEnabled}
              disabled={disabled}
              onCheckedChange={(enabled) =>
                void apply({ kind: "set-project-enabled", id, projectId, enabled })
              }
            />
          )}
        </div>
      </div>
      <details className="text-sm">
        <summary className="cursor-interaction text-token-text-secondary">Package details</summary>
        <div className="space-y-2 pt-2">
          <p className="wrap-anywhere text-token-text-secondary">
            {sourceLabel} · {installation.source.locator}
          </p>
          <AgentPluginPackageReview pkg={installation.package} />
        </div>
      </details>
      {confirmingUninstall ? (
        <div role="group" aria-label={`Uninstall ${title}`} className="space-y-2">
          <p className="text-sm text-token-text-secondary">
            Remove {title} from this Profile and all Projects?
          </p>
          <div className="flex flex-wrap gap-2">
            <NodexButton
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setConfirmingUninstall(false)}
            >
              Cancel
            </NodexButton>
            <NodexButton
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() => void apply({ kind: "uninstall", id, data: "keep" })}
            >
              Uninstall and keep plugin data
            </NodexButton>
            <NodexButton
              size="sm"
              variant="destructive"
              disabled={disabled}
              onClick={() => void apply({ kind: "uninstall", id, data: "delete" })}
            >
              Uninstall and delete plugin data
            </NodexButton>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AgentPluginInstallations({
  defaultProjectId,
  projects,
}: {
  readonly defaultProjectId: string | null;
  readonly projects: readonly ProjectChoice[];
}) {
  const headingId = useId();
  const [selectedProject, setSelectedProject] = useState<string | null | undefined>(undefined);
  const candidate = selectedProject === undefined ? defaultProjectId : selectedProject;
  const projectId = projects.find(({ id }) => id === candidate)?.id ?? null;
  const list = useAgentPluginInstallations(projectId);
  const management = useAgentPluginManagement();
  const [picking, setPicking] = useState(false);
  const [review, setReview] = useState<{ directory: string; preview: PluginPreview } | null>(null);
  const [error, setError] = useState<AgentPluginFailure | null>(null);
  const disabled = picking || management.pending;
  const beginReview = async () => {
    setPicking(true);
    setError(null);
    const result = await management.reviewFolder();
    setPicking(false);
    if (!result.ok) return setError(result.error);
    if (result.value) setReview(result.value);
  };
  const apply = async (action: AgentPluginAction) => {
    setError(null);
    const result = await management.apply(action);
    if (!result.ok) {
      if (result.error.code === "staged-digest-mismatch") setReview(null);
      setError(result.error);
      return;
    }
    if (action.kind === "install") setReview(null);
  };
  const data = list.data?.ok ? list.data.value : null;
  const listError = list.data?.ok === false ? list.data.error : null;

  return (
    <section
      aria-labelledby={headingId}
      className="mx-2 space-y-2 border-b-[0.5px] border-token-border pb-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="text-lg font-medium">
          Nodex-installed
        </h2>
        <NodexButton
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() => void beginReview()}
        >
          {picking ? "Reviewing folder…" : "Install from folder"}
        </NodexButton>
      </div>
      <p className="text-sm text-token-text-secondary">
        Installed in this Profile. Agent delivery is not yet available.
      </p>
      {data?.writerStatus === "stale" ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span role="status">The plugin registry has a stale lock.</span>
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => void apply({ kind: "repair-writer" })}
          >
            Repair lock
          </NodexButton>
        </div>
      ) : null}
      {error ? <AgentPluginError error={error} /> : null}
      {review ? (
        <section
          aria-label="Package review"
          className="space-y-2 border-y-[0.5px] border-token-border py-3"
        >
          <h3 className="text-base font-medium">
            {review.preview.status === "loaded"
              ? `Review ${review.preview.package.displayName ?? review.preview.package.identity.name}`
              : "This folder can’t be installed"}
          </h3>
          <p className="wrap-anywhere text-sm text-token-text-secondary">{review.directory}</p>
          {review.preview.status === "loaded" ? (
            <AgentPluginPackageReview pkg={review.preview.package} />
          ) : (
            <PluginRejectionReasons reasons={review.preview.reasons} />
          )}
          <div className="flex gap-2">
            <NodexButton
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => setReview(null)}
            >
              Cancel
            </NodexButton>
            {review.preview.status === "loaded" ? (
              <NodexButton
                size="sm"
                variant="primary"
                disabled={disabled}
                onClick={() => {
                  if (review.preview.status !== "loaded") return;
                  void apply({
                    kind: "install",
                    directory: review.directory,
                    previewDigest: review.preview.package.digest,
                  });
                }}
              >
                Confirm install
              </NodexButton>
            ) : null}
          </div>
        </section>
      ) : null}
      {projects.length > 0 ? (
        <label className="flex w-fit items-center gap-2 text-sm">
          <span className="text-token-text-secondary">Enable for Project</span>
          <select
            className="max-w-56 truncate rounded-md border-[0.5px] border-token-border bg-token-dropdown-background px-2 py-1 text-token-foreground"
            value={projectId ?? ""}
            disabled={disabled}
            onChange={(event) => setSelectedProject(event.target.value || null)}
          >
            <option value="">Select a Project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {listError || list.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <AgentPluginError
            error={
              listError ?? { code: "unavailable", message: "Could not load installed plugins." }
            }
          />
          <NodexButton
            size="sm"
            variant="secondary"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            Retry
          </NodexButton>
        </div>
      ) : null}
      {list.isPending ? (
        <p role="status" className="text-sm text-token-text-secondary">
          Loading installations…
        </p>
      ) : null}
      {data?.installations.length === 0 ? (
        <p className="text-sm text-token-text-secondary">No Nodex plugins installed</p>
      ) : null}
      {data?.installations.length ? (
        <ul className="divide-y-[0.5px] divide-token-border">
          {data.installations.map((installation) => (
            <InstallationRow
              key={installation.id}
              installation={installation}
              projectId={projectId}
              disabled={disabled}
              apply={apply}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

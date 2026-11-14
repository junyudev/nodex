import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { DetailProperty, DetailSection } from "@/components/ui/detail-page";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import { localPathPresentationContextQueryOptions } from "@/lib/query-options";
import { abbreviateHomeDirectory } from "../../../../shared/local-path-presentation";
import type { PluginProjectScope } from "../../../../shared/agent-plugins/session-plugins";
import {
  describeAgentSupport,
  describeProjectScope,
  toggleProjectInScope,
} from "../model/plugin-agent-support";
import { pluginMutationSucceeded } from "../model/mutation-result";
import {
  usePluginManagement,
  type PluginContext,
  type PluginDetailView,
} from "../plugin-management";

type Project = { readonly id: string; readonly name: string };

function ProjectScopeMenu({
  scope,
  projects,
  onChange,
}: {
  readonly scope: PluginProjectScope;
  readonly projects: readonly Project[];
  readonly onChange: (scope: PluginProjectScope) => void;
}) {
  const chosen = (id: string) => scope.kind === "projects" && scope.projectIds.includes(id);
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="sm"
      contentMaxHeight="list"
      triggerButton={
        <NodexDropdownButtonTrigger size="sm" chrome="transparent" className="-ms-2">
          {describeProjectScope(scope, projects)}
        </NodexDropdownButtonTrigger>
      }
    >
      <NodexDropdownItem
        rightSlot={scope.kind === "all" ? <NodexDropdownSelectedIcon /> : null}
        onSelect={() => onChange({ kind: "all" })}
      >
        All projects
      </NodexDropdownItem>
      {projects.length > 0 ? <NodexDropdownSeparator /> : null}
      {projects.map((project) => (
        <NodexDropdownItem
          key={project.id}
          closeOnClick={false}
          rightSlot={chosen(project.id) ? <NodexDropdownSelectedIcon /> : null}
          onSelect={() => onChange(toggleProjectInScope(scope, project.id))}
        >
          {project.name}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}

/**
 * Where an installed plugin comes from, which Projects it applies to, and which Agents can
 * use it. Only plugins that are installed show this section.
 */
export function PluginInstallationSection({
  view,
  context,
  projects,
}: {
  readonly view: PluginDetailView;
  readonly context: PluginContext;
  readonly projects: readonly Project[];
}) {
  const management = usePluginManagement(context);
  const pathContext = useQuery(localPathPresentationContextQueryOptions()).data ?? null;
  // The scope shows the person's choice at once; a failed write puts the saved scope back.
  const [pendingScope, setPendingScope] = useState<PluginProjectScope | null>(null);
  if (!view.row.summary.installed) return null;

  const scope = pendingScope ?? view.projectScope;
  const { agents, codexOnly } = describeAgentSupport(view.agentSupport, "kinds");
  const folder = view.row.localFolder;

  const changeScope = async (next: PluginProjectScope) => {
    setPendingScope(next);
    const result = await management.setProjectScope({ pluginId: view.row.nativeId, scope: next });
    setPendingScope(null);
    if (!pluginMutationSucceeded(result)) toast.danger("Couldn’t change where this plugin applies");
  };

  return (
    <DetailSection id="plugin-installation" title="Installation">
      <dl>
        {folder == null ? null : (
          <DetailProperty label="Folder">
            <NodexTooltip tooltipContent={folder} side="top">
              <span className="truncate font-mono text-sm">
                {abbreviateHomeDirectory(folder, pathContext)}
              </span>
            </NodexTooltip>
          </DetailProperty>
        )}
        <DetailProperty label="Projects">
          <ProjectScopeMenu
            scope={scope}
            projects={projects}
            onChange={(next) => void changeScope(next)}
          />
        </DetailProperty>
        <DetailProperty label="Agents" align={codexOnly == null ? "center" : "start"}>
          <div className="flex min-w-0 flex-col">
            <span>{agents}</span>
            {codexOnly == null ? null : (
              <span className="text-sm text-token-description-foreground">{codexOnly}</span>
            )}
          </div>
        </DetailProperty>
      </dl>
    </DetailSection>
  );
}

import {
  selectPluginAppEntries,
  type PluginAppBinding,
} from "../../../shared/agent-plugins/app-entrypoints";
import { usePluginAppCatalogChanges, usePluginAppEntries } from "@/lib/plugin-app-adapter";
import { PluginAppLogo } from "@/features/plugins/view/plugin-logo";
import { Fragment, type ReactNode } from "react";
import { PluginsIcon } from "@/components/shared/icons";
import {
  WorkbenchHomeIcon,
  WorkbenchInsightsIcon,
  WorkbenchAutomationsIcon,
  WorkbenchSpaceIcon,
} from "@/components/shared/icons/workbench-navigation-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE,
  type WorkbenchSidebarPeekArea,
} from "@/lib/workbench-sidebar-peek";
import type { WorkbenchPrimaryDestination } from "../../../shared/workbench-layout";

/** Every rail control shares the destinations' quiet ghost treatment. */
export const WORKBENCH_RAIL_BUTTON_CLASS =
  "no-drag rounded-lg text-(--color-text-secondary-ghost) hover:text-(--color-text-secondary-ghost-hover)";

/** A short hairline between the rail's groups. */
export function WorkbenchRailDivider() {
  return <div role="separator" aria-hidden className="my-0.5 h-px w-6 bg-(--color-border)" />;
}

export interface WorkbenchAppRailProps {
  contentOnly?: boolean;
  destination: WorkbenchPrimaryDestination;
  pluginProjectId?: string | null;
  activePlugin?: Extract<PluginAppBinding, { kind: "global" }>;
  onOpenPluginApp?: (binding: Extract<PluginAppBinding, { kind: "global" }>, title: string) => void;
  onHome: () => void;
  onSpace: () => void;
  onAutomations: () => void;
  onInsights: () => void;
  onPlugins: () => void;
  /** App-wide controls pinned to the foot of the rail. */
  footer?: ReactNode;
}

interface WorkbenchRailEntry {
  readonly id: WorkbenchPrimaryDestination;
  readonly label: string;
  readonly peekArea: WorkbenchSidebarPeekArea;
  /** Places are where work happens; tools, below the hairline, read across it. */
  readonly group: "places" | "tools";
  readonly icon: (active: boolean) => ReactNode;
  readonly onSelect: () => void;
}

export function WorkbenchAppRail({
  destination,
  pluginProjectId,
  activePlugin,
  onOpenPluginApp,
  onHome,
  onSpace,
  onAutomations,
  onInsights,
  onPlugins,
  footer,
  contentOnly = false,
}: WorkbenchAppRailProps) {
  const destinations: readonly WorkbenchRailEntry[] = [
    {
      id: "home",
      label: "Home",
      peekArea: "home",
      group: "places",
      icon: (active) => <WorkbenchHomeIcon filled={active} />,
      onSelect: onHome,
    },
    {
      id: "space",
      label: "Space",
      peekArea: "space",
      group: "places",
      icon: (active) => <WorkbenchSpaceIcon filled={active} />,
      onSelect: onSpace,
    },
    {
      id: "automations",
      label: "Automations",
      peekArea: "automations",
      group: "places",
      icon: (active) => <WorkbenchAutomationsIcon filled={active} />,
      onSelect: onAutomations,
    },
    {
      id: "insights",
      label: "Insights",
      peekArea: "insights",
      group: "tools",
      icon: (active) => <WorkbenchInsightsIcon filled={active} />,
      onSelect: onInsights,
    },
    {
      id: "plugins",
      label: "Plugins",
      peekArea: "plugins",
      group: "places",
      icon: () => <PluginsIcon className="size-5" />,
      onSelect: onPlugins,
    },
  ];

  // A team window offers what its Space shares; Automations run on its host, and Plugins and
  // Insights are this desktop's own Agents.
  const visible = destinations.filter(
    (entry) =>
      !contentOnly ||
      (entry.id !== "automations" && entry.id !== "plugins" && entry.id !== "insights"),
  );
  const groups = (["places", "tools"] as const)
    .map((group) => visible.filter((entry) => entry.group === group))
    .filter((entries) => entries.length > 0);

  return (
    <nav
      aria-label="App navigation"
      data-app-navigation-rail
      className="flex h-full min-h-0 w-13 shrink-0 flex-col items-center gap-2 bg-transparent px-2 pt-2 pb-1 select-none"
    >
      {groups.map((entries, index) => (
        <Fragment key={entries[0]?.group}>
          {index > 0 ? <WorkbenchRailDivider /> : null}
          <div className="flex flex-col items-center gap-2">
            {entries.map(({ id, label, peekArea, icon, onSelect }) => {
              const active = !activePlugin && destination === id;
              return (
                <NodexTooltip key={id} tooltipContent={label} side="right">
                  <NodexButton
                    aria-label={label}
                    aria-current={active ? "page" : undefined}
                    data-workbench-destination={id}
                    {...{ [WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE]: peekArea }}
                    variant="ghostSecondary"
                    size="icon"
                    className={cn(
                      WORKBENCH_RAIL_BUTTON_CLASS,
                      active &&
                        "bg-(--color-background-secondary-ghost-hover) text-(--color-text-secondary-ghost-hover)",
                    )}
                    onClick={onSelect}
                  >
                    {icon(active)}
                  </NodexButton>
                </NodexTooltip>
              );
            })}
          </div>
        </Fragment>
      ))}
      {!contentOnly && pluginProjectId !== undefined && onOpenPluginApp && (
        <PluginAppRailEntries
          projectId={pluginProjectId}
          activePlugin={activePlugin}
          onOpen={onOpenPluginApp}
        />
      )}
      {footer}
    </nav>
  );
}

function PluginAppRailEntries({
  projectId,
  activePlugin,
  onOpen,
}: {
  readonly projectId: string | null;
  readonly activePlugin: WorkbenchAppRailProps["activePlugin"];
  readonly onOpen: NonNullable<WorkbenchAppRailProps["onOpenPluginApp"]>;
}) {
  usePluginAppCatalogChanges();
  const pluginEntries = selectPluginAppEntries(usePluginAppEntries(projectId), { kind: "global" });
  if (pluginEntries.length === 0) return null;
  // Plugin apps form their own group below the built-in destinations.
  const buttons = pluginEntries.map(({ pluginId, entry, ...presentation }) => {
    const label = pluginEntries.some(
      (item) => item.pluginId === pluginId && item.entry.id !== entry.id,
    )
      ? `${presentation.pluginName} · ${entry.title}`
      : presentation.pluginName;
    const active =
      activePlugin?.pluginId === pluginId &&
      activePlugin.entryId === entry.id &&
      activePlugin.projectId === projectId;
    return (
      <NodexTooltip key={JSON.stringify([pluginId, entry.id])} tooltipContent={label} side="right">
        <NodexButton
          aria-label={label}
          aria-current={active ? "page" : undefined}
          variant="ghostSecondary"
          size="icon"
          className={cn(
            WORKBENCH_RAIL_BUTTON_CLASS,
            "group",
            active &&
              "bg-(--color-background-secondary-ghost-hover) text-(--color-text-secondary-ghost-hover)",
          )}
          onClick={() =>
            onOpen({ kind: "global", pluginId, entryId: entry.id, projectId, presentation }, label)
          }
        >
          <span
            className={cn(
              "icon-sm",
              !active && "grayscale opacity-75 group-hover:grayscale-0 group-hover:opacity-100",
            )}
          >
            <PluginAppLogo presentation={presentation} composer className="icon-sm" />
          </span>
        </NodexButton>
      </NodexTooltip>
    );
  });
  return (
    <>
      <WorkbenchRailDivider />
      <div className="flex flex-col items-center gap-2">{buttons}</div>
    </>
  );
}

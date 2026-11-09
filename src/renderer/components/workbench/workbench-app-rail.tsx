import type { ReactNode } from "react";
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

export interface WorkbenchAppRailProps {
  contentOnly?: boolean;
  destination: WorkbenchPrimaryDestination;
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
  readonly icon: (active: boolean) => ReactNode;
  readonly onSelect: () => void;
}

export function WorkbenchAppRail({
  destination,
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
      icon: (active) => <WorkbenchHomeIcon filled={active} />,
      onSelect: onHome,
    },
    {
      id: "space",
      label: "Space",
      peekArea: "space",
      icon: (active) => <WorkbenchSpaceIcon filled={active} />,
      onSelect: onSpace,
    },
    {
      id: "automations",
      label: "Automations",
      peekArea: "automations",
      icon: (active) => <WorkbenchAutomationsIcon filled={active} />,
      onSelect: onAutomations,
    },
    {
      id: "insights",
      label: "Insights",
      peekArea: "insights",
      icon: (active) => <WorkbenchInsightsIcon filled={active} />,
      onSelect: onInsights,
    },
    {
      id: "plugins",
      label: "Plugins",
      peekArea: "plugins",
      icon: () => <PluginsIcon className="size-5" />,
      onSelect: onPlugins,
    },
  ];

  return (
    <nav
      aria-label="App navigation"
      data-app-navigation-rail
      className="flex h-full min-h-0 w-13 shrink-0 flex-col items-center gap-2 bg-transparent px-2 pt-2 pb-1 select-none"
    >
      {destinations
        // A team window offers what its Space shares; Automations run on its host, and Plugins and
        // Insights are this desktop's own Agents.
        .filter(
          (entry) =>
            !contentOnly ||
            (entry.id !== "automations" && entry.id !== "plugins" && entry.id !== "insights"),
        )
        .map(({ id, label, peekArea, icon, onSelect }) => {
          const active = destination === id;
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
      {footer}
    </nav>
  );
}

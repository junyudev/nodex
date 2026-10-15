import type { ReactNode } from "react";
import {
  WorkbenchHomeIcon,
  WorkbenchSpaceIcon,
} from "@/components/shared/icons/workbench-navigation-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE } from "@/lib/workbench-sidebar-peek";

/** Every rail control shares the destinations' quiet ghost treatment. */
export const WORKBENCH_RAIL_BUTTON_CLASS =
  "no-drag rounded-lg text-token-text-secondary hover:text-token-foreground";

export interface WorkbenchAppRailProps {
  destination: "home" | "space";
  onHome: () => void;
  onSpace: () => void;
  /** App-wide controls pinned to the foot of the rail. */
  footer?: ReactNode;
}

export function WorkbenchAppRail({ destination, onHome, onSpace, footer }: WorkbenchAppRailProps) {
  const destinations = [
    { id: "home", label: "Home", Icon: WorkbenchHomeIcon, onSelect: onHome },
    { id: "space", label: "Space", Icon: WorkbenchSpaceIcon, onSelect: onSpace },
  ] as const;

  return (
    <nav
      aria-label="App navigation"
      data-app-navigation-rail
      className="flex h-full min-h-0 w-13 shrink-0 flex-col items-center gap-2 bg-transparent px-2 pt-2 pb-1 select-none"
    >
      {destinations.map(({ id, label, Icon, onSelect }) => {
        const active = destination === id;
        return (
          <NodexTooltip key={id} tooltipContent={label} side="right">
            <NodexButton
              aria-label={label}
              aria-current={active ? "page" : undefined}
              data-workbench-destination={id}
              {...{ [WORKBENCH_SIDEBAR_PEEK_AREA_ATTRIBUTE]: id }}
              variant="ghost"
              size="icon"
              className={cn(
                WORKBENCH_RAIL_BUTTON_CLASS,
                active && "bg-token-list-hover-background text-token-foreground",
              )}
              onClick={onSelect}
            >
              <Icon filled={active} />
            </NodexButton>
          </NodexTooltip>
        );
      })}
      {footer}
    </nav>
  );
}

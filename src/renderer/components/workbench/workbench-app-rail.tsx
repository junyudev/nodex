import {
  WorkbenchHomeIcon,
  WorkbenchSpaceIcon,
} from "@/components/shared/icons/workbench-navigation-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface WorkbenchAppRailProps {
  destination: "home" | "space";
  onHome: () => void;
  onSpace: () => void;
  onDestinationHover?: (destination: "home" | "space" | null) => void;
}

export function WorkbenchAppRail({
  destination,
  onHome,
  onSpace,
  onDestinationHover,
}: WorkbenchAppRailProps) {
  const destinations = [
    { id: "home", label: "Home", Icon: WorkbenchHomeIcon, onSelect: onHome },
    { id: "space", label: "Space", Icon: WorkbenchSpaceIcon, onSelect: onSpace },
  ] as const;

  return (
    <nav
      aria-label="App navigation"
      data-app-navigation-rail
      className="flex h-full min-h-0 w-13 shrink-0 flex-col items-center gap-2 bg-transparent p-2 select-none"
    >
      {destinations.map(({ id, label, Icon, onSelect }) => {
        const active = destination === id;
        return (
          <NodexTooltip key={id} tooltipContent={label} side="right">
            <NodexButton
              aria-label={label}
              aria-current={active ? "page" : undefined}
              data-workbench-destination={id}
              variant="ghost"
              size="icon"
              className={cn(
                "no-drag rounded-lg",
                active
                  ? "bg-token-list-hover-background text-token-foreground"
                  : "text-token-text-secondary hover:text-token-foreground",
              )}
              onClick={onSelect}
              onPointerEnter={() => onDestinationHover?.(id)}
              onPointerLeave={() => onDestinationHover?.(null)}
            >
              <Icon filled={active} />
            </NodexButton>
          </NodexTooltip>
        );
      })}
    </nav>
  );
}

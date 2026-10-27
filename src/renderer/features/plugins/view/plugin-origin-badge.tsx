import type { ComponentType } from "react";
import {
  BranchIcon,
  BuildingIcon,
  FolderIcon,
  LaptopIcon,
  LaptopSmallIcon,
  PersonCircleIcon,
  type IconGlyphProps,
} from "@/components/shared/icons/customize-action-icons";
import {
  BranchIcon20,
  BuildingIcon20,
  FolderIcon20,
  PersonCircleIcon20,
} from "@/components/shared/icons/plugin-detail-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { PluginRow } from "../plugin-management";

type PluginOrigin = "workspace" | "user-cloud" | "local" | "git-marketplace" | "folder-marketplace";

/** Where a plugin comes from, when that is worth a badge: official plugins have none. */
export function pluginOrigin(row: PluginRow): PluginOrigin | null {
  const { marketplace, summary } = row;
  if (marketplace.name.startsWith("workspace-")) return "workspace";
  if (marketplace.name === "created-by-me-remote") return "user-cloud";
  if (summary.source.type === "remote") return row.isPersonal ? "user-cloud" : null;
  if (row.isPersonal) return "local";
  if (row.isOfficial || marketplace.path === null) return null;
  return summary.source.type === "git" ? "git-marketplace" : "folder-marketplace";
}

const ORIGIN_PRESENTATION: Record<
  PluginOrigin,
  {
    readonly label: string;
    readonly icons: Record<"default" | "large", ComponentType<IconGlyphProps>>;
    readonly tooltip: (marketplaceName: string) => string;
    readonly showsPath: boolean;
  }
> = {
  workspace: {
    label: "Workspace plugin",
    icons: { default: BuildingIcon, large: BuildingIcon20 },
    tooltip: () => "From your workspace",
    showsPath: false,
  },
  "user-cloud": {
    label: "Your cloud plugin",
    icons: { default: PersonCircleIcon, large: PersonCircleIcon20 },
    tooltip: () => "Created by you in the cloud",
    showsPath: false,
  },
  local: {
    label: "Local plugin",
    icons: { default: LaptopSmallIcon, large: LaptopIcon },
    tooltip: () => "From your personal marketplace on this machine",
    showsPath: true,
  },
  "git-marketplace": {
    label: "Git marketplace plugin",
    icons: { default: BranchIcon, large: BranchIcon20 },
    tooltip: (name) => `From the ${name} Git marketplace`,
    showsPath: false,
  },
  "folder-marketplace": {
    label: "Folder marketplace plugin",
    icons: { default: FolderIcon, large: FolderIcon20 },
    tooltip: (name) => `From ${name}`,
    showsPath: true,
  },
};

/** The small origin icon after a plugin's name, explained by its tooltip. */
export function PluginOriginBadge({
  row,
  size = "default",
}: {
  readonly row: PluginRow;
  readonly size?: "default" | "large";
}) {
  const origin = pluginOrigin(row);
  if (origin == null) return null;
  const presentation = ORIGIN_PRESENTATION[origin];
  const Icon = presentation.icons[size];
  const tooltip = presentation.tooltip(row.marketplace.displayName ?? row.marketplace.name);
  return (
    <NodexTooltip
      side="top"
      tooltipContent={
        presentation.showsPath && row.marketplace.path != null ? (
          <div className="flex flex-col gap-1">
            {tooltip}
            <span className="opacity-70">{row.marketplace.path}</span>
          </div>
        ) : (
          tooltip
        )
      }
    >
      <button type="button" onClick={(event) => event.stopPropagation()}>
        <span role="img" aria-label={presentation.label}>
          <Icon className="text-(--color-text-secondary)" />
        </span>
      </button>
    </NodexTooltip>
  );
}

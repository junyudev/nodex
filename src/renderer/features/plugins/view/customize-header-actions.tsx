import { useState, type ReactNode } from "react";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import {
  ChevronDownMdIcon,
  GearIcon,
  RefreshArrowsIcon,
} from "@/components/shared/icons/customize-action-icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { pluginMutationSucceeded } from "../model/mutation-result";
import { usePluginManagement, type PluginContext } from "../plugin-management";

export interface CustomizeAddAction {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly onSelect?: () => void;
}

/**
 * The Add button: it runs its only action directly, opens a menu of several, and is hidden
 * when none can run.
 */
export function AddActionsMenu({
  addActions,
  trailingAction,
}: {
  readonly addActions: readonly CustomizeAddAction[];
  /** An action set apart after a divider, such as Record a skill. */
  readonly trailingAction?: CustomizeAddAction;
}) {
  const available = addActions.filter((action) => !action.disabled);
  const single = addActions.length === 1 && trailingAction == null ? available[0] : undefined;
  if (single != null) {
    return (
      <ToolbarButton aria-label="Add" color="primary" onClick={single.onSelect}>
        Add
      </ToolbarButton>
    );
  }
  if (available.length === 0 && trailingAction == null) return null;
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="icon"
      triggerButton={
        <ToolbarButton aria-label="Add" color="primary">
          <span>Add</span>
          <ChevronDownMdIcon />
        </ToolbarButton>
      }
    >
      {addActions.map((action) => (
        <NodexDropdownItem
          key={action.id}
          leftSlot={action.icon}
          disabled={action.disabled}
          onSelect={action.onSelect}
        >
          {action.label}
        </NodexDropdownItem>
      ))}
      {trailingAction == null ? null : (
        <>
          <NodexDropdownSeparator />
          <NodexDropdownItem
            leftSlot={trailingAction.icon}
            disabled={trailingAction.disabled}
            onSelect={trailingAction.onSelect}
          >
            {trailingAction.label}
          </NodexDropdownItem>
        </>
      )}
    </NodexDropdownMenu>
  );
}

/** A Customize page's header actions: Refresh, Manage, and Add. */
export function CustomizeHeaderActions({
  context,
  addActions,
  trailingAction,
  onManage,
}: {
  readonly context: PluginContext;
  readonly addActions: readonly CustomizeAddAction[];
  readonly trailingAction?: CustomizeAddAction;
  /** Opens Settings › Plugins. */
  readonly onManage: () => void;
}) {
  const management = usePluginManagement(context);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await management.refresh();
      if (!pluginMutationSucceeded(result)) toast.danger("Failed to refresh skills and apps");
    } catch {
      toast.danger("Failed to refresh skills and apps");
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <div className="ms-auto flex min-w-0 items-center justify-end gap-2">
        <NodexTooltip tooltipContent="Refresh" side="bottom">
          <ToolbarButton
            aria-label="Refresh"
            color="ghost"
            uniform
            disabled={refreshing}
            className="hidden md:inline-flex"
            onClick={() => void refresh()}
          >
            {refreshing ? <ActivitySpinnerIcon className="icon-sm" /> : <RefreshArrowsIcon />}
          </ToolbarButton>
        </NodexTooltip>
        <NodexTooltip tooltipContent="Manage" side="bottom">
          <ToolbarButton aria-label="Manage" color="ghost" uniform onClick={() => onManage()}>
            <GearIcon />
          </ToolbarButton>
        </NodexTooltip>
        <AddActionsMenu addActions={addActions} trailingAction={trailingAction} />
      </div>
    </div>
  );
}

import { useState } from "react";
import { SidePanelPlusIcon } from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import {
  isNodexPanelOptionAction,
  isPanelDestinationAction,
  resolvePanelActionShortcutLabel,
  type PanelNewTabAction,
  type PanelNewTabActionKind,
} from "@/lib/workbench-panel-actions";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import type { PanelId, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PanelDestinationPicker } from "./panel-destination-picker";
import type {
  PanelDestination,
  PanelDestinationPickerScope,
} from "./panel-destination-picker-model";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";

interface WorkbenchPanelNewTabButtonProps {
  readonly actions: readonly PanelNewTabAction[];
  readonly projects: readonly Project[];
  readonly panelId: PanelId;
  readonly currentProjectId: string | null;
  readonly currentProjectDbViewExists: boolean;
  readonly isMac: boolean;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly onAction: (kind: PanelNewTabActionKind) => void | Promise<void>;
  readonly onOpenDestination: (destination: PanelDestination) => void | Promise<void>;
}

/**
 * The panel group's `+`. In the side panel a click opens a New tab, which presents every
 * tool, and a right-click opens the action menu directly. The bottom panel opens the menu.
 * The menu owns its transient open state and delegates choices to the owning panel host.
 */
export function WorkbenchPanelNewTabButton({
  actions,
  projects,
  panelId,
  currentProjectId,
  currentProjectDbViewExists,
  isMac,
  commandKeymapState,
  onAction,
  onOpenDestination,
}: WorkbenchPanelNewTabButtonProps) {
  const [open, setOpen] = useState(false);
  if (actions.length === 0) return null;
  const newTabAction =
    panelId === "right" ? actions.find((action) => action.kind === "browser") : undefined;
  const title = newTabAction ? "New tab" : "Open bottom panel tab";

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={(next) => {
        // A New tab trigger opens its menu only from the context menu.
        if (newTabAction && next) return;
        setOpen(next);
      }}
      align="start"
      sideOffset={6}
      contentWidth="menuWide"
      triggerTooltipContent={title}
      triggerTooltipShortcutLabel={
        newTabAction
          ? (resolvePanelActionShortcutLabel(newTabAction, isMac, commandKeymapState) ?? undefined)
          : undefined
      }
      triggerButton={
        <button
          type="button"
          className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
          aria-label={title}
          onClick={
            newTabAction
              ? () => {
                  void onAction(newTabAction.kind);
                }
              : undefined
          }
          onContextMenu={
            newTabAction
              ? (event) => {
                  event.preventDefault();
                  setOpen(true);
                }
              : undefined
          }
        >
          <SidePanelPlusIcon className="icon-xs" />
        </button>
      }
    >
      {actions.map((action, index) => {
        const Icon = action.Icon;
        const showNodexSeparator =
          isNodexPanelOptionAction(action) &&
          !isNodexPanelOptionAction(actions[index - 1] ?? action);
        const shouldCreateCurrentProjectDbView =
          action.kind === "db_view" && currentProjectId !== null && !currentProjectDbViewExists;

        return (
          <div key={action.kind}>
            {showNodexSeparator ? <NodexDropdownSeparator /> : null}
            {shouldCreateCurrentProjectDbView ? (
              <NodexDropdownItem
                leftSlot={<Icon className="icon-sm" />}
                keyboardShortcut={resolvePanelActionShortcutLabel(
                  action,
                  isMac,
                  commandKeymapState,
                )}
                onSelect={() => {
                  void onAction(action.kind);
                }}
              >
                {action.label}
              </NodexDropdownItem>
            ) : isPanelDestinationAction(action) ? (
              <NodexDropdownFlyoutSubmenuItem
                label={action.label}
                leftSlot={<Icon className="icon-sm" />}
                contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
              >
                <PanelDestinationPicker
                  projects={projects}
                  scope={
                    (action.kind === "db_view"
                      ? "db-only"
                      : "page-only") as PanelDestinationPickerScope
                  }
                  ariaLabel={action.kind === "db_view" ? "Open DB view" : "Open Page"}
                  placeholder={action.kind === "db_view" ? "Open DB…" : "Open Page…"}
                  currentProjectId={currentProjectId}
                  onClose={() => setOpen(false)}
                  onAccept={async (destination) => {
                    await onOpenDestination(destination);
                    setOpen(false);
                  }}
                />
              </NodexDropdownFlyoutSubmenuItem>
            ) : (
              <NodexDropdownItem
                leftSlot={<Icon className="icon-sm" />}
                keyboardShortcut={resolvePanelActionShortcutLabel(
                  action,
                  isMac,
                  commandKeymapState,
                )}
                onSelect={() => {
                  void onAction(action.kind);
                }}
              >
                {action.label}
              </NodexDropdownItem>
            )}
          </div>
        );
      })}
    </NodexDropdownMenu>
  );
}

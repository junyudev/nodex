import { forwardRef, useState, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { PanelDestinationPicker } from "./panel-destination-picker";
import type {
  PanelDestination,
  PanelDestinationPickerScope,
} from "./panel-destination-picker-model";
import { NodexDropdownMenu } from "@/components/ui/dropdown";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import {
  isNodexPanelOptionAction,
  isPanelDestinationAction,
  resolvePanelActionShortcutLabel,
  type PanelNewTabAction,
  type PanelNewTabActionKind,
} from "@/lib/workbench-panel-actions";
import {
  PANEL_TOOL_KEYCAP_CLASS,
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
  TOOLBAR_BUTTON_SECONDARY_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const PANEL_ACTION_ROW_CLASS =
  "cursor-interaction flex min-h-10 w-full items-center gap-2 rounded-md bg-[var(--color-background-primary-soft-alpha)] px-2.5 py-2 text-left hover:bg-token-list-hover-background aria-expanded:bg-token-list-hover-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-token-border-xstrong";
type PanelActionCardProps = ComponentPropsWithoutRef<"button"> & {
  action: PanelNewTabAction;
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
};

const PanelActionCard = forwardRef<HTMLButtonElement, PanelActionCardProps>(
  function PanelActionCard({ action, isMac, commandKeymapState, className, ...buttonProps }, ref) {
    const shortcut = resolvePanelActionShortcutLabel(action, isMac, commandKeymapState);
    const Icon = action.Icon;
    return (
      <button
        ref={ref}
        type="button"
        className={cn(PANEL_ACTION_ROW_CLASS, className)}
        {...buttonProps}
      >
        <span className="icon-xs flex shrink-0 items-center justify-center text-token-text-secondary">
          <Icon className="icon-xs" />
        </span>
        <span
          data-thread-side-panel-new-tab-action-label="true"
          className="min-w-0 flex-1 truncate text-sm font-normal text-token-text-primary"
        >
          {action.label}
        </span>
        {shortcut ? (
          <span className="ml-auto shrink-0 pl-2 text-token-text-secondary">
            <ShortcutKeycaps keys={[shortcut]} tone="current" className={PANEL_TOOL_KEYCAP_CLASS} />
          </span>
        ) : null}
      </button>
    );
  },
);

function PanelDestinationActionMenu({
  action,
  projects,
  isMac,
  commandKeymapState,
  currentProjectId,
  onOpenDestination,
}: {
  action: PanelNewTabAction & { kind: "db_view" | "page_stage" };
  projects: readonly Project[];
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
  currentProjectId?: string | null;
  onOpenDestination: (destination: PanelDestination) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const scope: PanelDestinationPickerScope = action.kind === "db_view" ? "db-only" : "page-only";
  const ariaLabel = action.kind === "db_view" ? "Open DB view" : "Open Page";
  const placeholder = action.kind === "db_view" ? "Open DB…" : "Open Page…";

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={setOpen}
      align="center"
      sideOffset={8}
      contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
      triggerButton={
        <PanelActionCard action={action} isMac={isMac} commandKeymapState={commandKeymapState} />
      }
    >
      <PanelDestinationPicker
        projects={projects}
        scope={scope}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        currentProjectId={currentProjectId}
        onClose={() => {
          setOpen(false);
        }}
        onAccept={async (destination) => {
          await onOpenDestination(destination);
          setOpen(false);
        }}
      />
    </NodexDropdownMenu>
  );
}

export function EmptyRightPane({
  actions,
  projects,
  isMac,
  commandKeymapState,
  currentProjectId,
  currentProjectDbViewExists,
  onAction,
  onOpenDestination,
}: {
  actions: PanelNewTabAction[];
  projects: readonly Project[];
  isMac: boolean;
  commandKeymapState?: CommandKeymapState | null;
  currentProjectId?: string | null;
  currentProjectDbViewExists: boolean;
  onAction: (kind: PanelNewTabActionKind) => void;
  onOpenDestination: (destination: PanelDestination) => Promise<void> | void;
}) {
  const codexActions = actions.filter((action) => !isNodexPanelOptionAction(action));
  const nodexActions = actions.filter(isNodexPanelOptionAction);
  const renderAction = (action: PanelNewTabAction) => {
    if (action.kind === "db_view" && !currentProjectDbViewExists) {
      return (
        <PanelActionCard
          key={action.kind}
          action={action}
          isMac={isMac}
          commandKeymapState={commandKeymapState}
          onClick={() => onAction(action.kind)}
        />
      );
    }

    if (isPanelDestinationAction(action)) {
      return (
        <PanelDestinationActionMenu
          key={action.kind}
          action={action}
          projects={projects}
          isMac={isMac}
          commandKeymapState={commandKeymapState}
          currentProjectId={currentProjectId}
          onOpenDestination={onOpenDestination}
        />
      );
    }

    return (
      <PanelActionCard
        key={action.kind}
        action={action}
        isMac={isMac}
        commandKeymapState={commandKeymapState}
        onClick={() => onAction(action.kind)}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-token-main-surface-primary p-2 select-none">
      <div className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center">
        <div className="sticky top-0 z-10 flex flex-col gap-6 bg-token-main-surface-primary">
          <div
            data-thread-side-panel-new-tab-action-grid="true"
            className="flex w-full flex-col gap-1 px-panel"
          >
            {codexActions.map(renderAction)}
            {nodexActions.length > 0 ? (
              <div aria-hidden="true" className="px-2.5 py-1">
                <div className="h-px w-full bg-token-menu-border" />
              </div>
            ) : null}
            {nodexActions.map(renderAction)}
          </div>
        </div>
      </div>
    </div>
  );
}

export function ToolbarIconButton({
  label,
  pressed,
  className,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="bottom">
      <button
        type="button"
        className={cn(
          TOOLBAR_BUTTON_BASE_CLASS,
          pressed ? TOOLBAR_BUTTON_SECONDARY_CLASS : TOOLBAR_BUTTON_GHOST_CLASS,
          className,
        )}
        aria-label={label}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

export function WindowNavigationToolbarButton({
  label,
  shortcutLabel,
  disabled,
  onClick,
  children,
}: {
  label: "Back" | "Forward";
  shortcutLabel: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip delayOpen tooltipContent={label} shortcutLabel={shortcutLabel} side="bottom">
      <button
        type="button"
        className={`${TOOLBAR_BUTTON_BASE_CLASS} ${TOOLBAR_BUTTON_GHOST_CLASS}`}
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

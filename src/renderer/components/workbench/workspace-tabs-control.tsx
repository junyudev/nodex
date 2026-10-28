import { useRef, useState, type KeyboardEvent } from "react";
import {
  EnterFullViewIcon,
  ExitFullViewIcon,
  PanelRightVisibleIcon,
} from "@/components/shared/icons";
import { OpenTabsIcon } from "@/components/shared/icons/open-tabs-icon";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
  TOOLBAR_BUTTON_SECONDARY_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import {
  makeAppShellTabAccessibleLabel,
  makeAppShellTabIcon,
  useAppShellTabTitle,
  type AppShellTabPresentation,
} from "./app-shell-tabs";

export interface WorkspaceTabsControlProps {
  mode: "chat" | "split" | "full";
  tabs: readonly AppShellTabPresentation[];
  activeTabId?: string | null;
  /** Hide the content pane from split view, or restore split view. */
  onToggle: () => void;
  /** Show the content pane at full width, or return it to split view. */
  onFullViewChange: (full: boolean) => void;
  onSelect: (tabId: string, mode: "split" | "full") => void;
  /**
   * Whether the full-view toggle leads this group. A content pane on the left carries the toggle
   * at the end of its own tab strip instead.
   */
  fullViewToggleInGroup?: boolean;
  fullViewShortcutLabel?: string | null;
}

/**
 * The workspace presentation group: a full-view toggle and the tabs toggle. Both
 * change presentation only; the retained tabs and their leaf placement persist.
 */
export function WorkspaceTabsControl(props: WorkspaceTabsControlProps) {
  const {
    mode,
    tabs,
    onToggle,
    onFullViewChange,
    fullViewToggleInGroup = true,
    fullViewShortcutLabel,
  } = props;
  // A toggle click can leave the pointer resting on the retained-tabs button;
  // its chooser opens on a later hover, not as a side effect of hiding tabs.
  const [hoverOpenSuppressed, setHoverOpenSuppressed] = useState(false);
  const toggle = () => {
    setHoverOpenSuppressed(true);
    onToggle();
  };

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      onPointerLeave={() => setHoverOpenSuppressed(false)}
    >
      {fullViewToggleInGroup && (tabs.length > 0 || mode === "full") ? (
        <>
          <span aria-hidden="true" className="h-4 w-px shrink-0 bg-token-border" />
          <WorkspaceFullViewToggle
            full={mode === "full"}
            shortcutLabel={fullViewShortcutLabel}
            onFullViewChange={onFullViewChange}
          />
        </>
      ) : null}
      {mode === "chat" && tabs.length > 0 ? (
        <RetainedWorkspaceTabsControl
          {...props}
          onToggle={toggle}
          hoverOpenEnabled={!hoverOpenSuppressed}
        />
      ) : (
        <WorkspaceTabsToggle mode={mode} tabCount={tabs.length} onToggle={toggle} />
      )}
    </div>
  );
}

/** Enters full view with the selected content, or returns a full view to split view. */
export function WorkspaceFullViewToggle({
  full,
  shortcutLabel,
  onFullViewChange,
}: {
  full: boolean;
  shortcutLabel?: string | null;
  onFullViewChange: (full: boolean) => void;
}) {
  const label = full ? "Exit full view" : "Enter full view";
  return (
    <NodexTooltip tooltipContent={label} shortcutLabel={shortcutLabel ?? undefined}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={full}
        data-workbench-full-view-toggle=""
        className={cn(
          TOOLBAR_BUTTON_BASE_CLASS,
          full ? TOOLBAR_BUTTON_SECONDARY_CLASS : TOOLBAR_BUTTON_GHOST_CLASS,
        )}
        onClick={() => onFullViewChange(!full)}
      >
        {full ? <ExitFullViewIcon /> : <EnterFullViewIcon />}
      </button>
    </NodexTooltip>
  );
}

function WorkspaceTabsToggle({
  mode,
  tabCount,
  onToggle,
}: {
  mode: WorkspaceTabsControlProps["mode"];
  tabCount: number;
  onToggle: () => void;
}) {
  const label = mode === "chat" ? "New tab" : mode === "full" ? "Enter split view" : "Hide tabs";
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        type="button"
        aria-label={label}
        aria-description={`${tabCount} open ${tabCount === 1 ? "tab" : "tabs"}`}
        aria-pressed={mode === "split"}
        data-workbench-workspace-tabs-control=""
        className={cn(
          TOOLBAR_BUTTON_BASE_CLASS,
          mode === "split" ? TOOLBAR_BUTTON_SECONDARY_CLASS : TOOLBAR_BUTTON_GHOST_CLASS,
        )}
        onClick={onToggle}
      >
        {mode === "chat" ? (
          <OpenTabsIcon count={0} />
        ) : (
          <PanelRightVisibleIcon className="size-4" />
        )}
      </button>
    </NodexTooltip>
  );
}

function RetainedWorkspaceTabsControl({
  tabs,
  activeTabId,
  onToggle,
  onSelect,
  hoverOpenEnabled,
}: WorkspaceTabsControlProps & { hoverOpenEnabled: boolean }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const focusEdgeRef = useRef<"first" | "last" | null>(null);
  const restoreTriggerFocusRef = useRef(false);
  const focusMenuEdge = (edge: "first" | "last") => {
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
    return edge === "last" ? items?.[items.length - 1] : items?.[0];
  };
  const selectTab = (tabId: string, mode: "split" | "full") => {
    restoreTriggerFocusRef.current = false;
    setOpen(false);
    onSelect(tabId, mode);
  };

  return (
    <NodexPopover
      open={open}
      modal={false}
      onOpenChange={(next, details) => {
        if (!next && details.reason === "escape") restoreTriggerFocusRef.current = true;
        if (next) focusEdgeRef.current = null;
        setOpen(next);
      }}
    >
      <NodexPopoverTrigger
        openOnHover={hoverOpenEnabled}
        delay={0}
        closeDelay={100}
        onClick={(event) => {
          event.preventBaseUIHandler();
          restoreTriggerFocusRef.current = false;
          setOpen(false);
          onToggle();
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          event.preventBaseUIHandler();
          const edge = event.key === "ArrowUp" ? "last" : "first";
          restoreTriggerFocusRef.current = true;
          focusEdgeRef.current = edge;
          if (open) focusMenuEdge(edge)?.focus();
          setOpen(true);
        }}
      >
        <button
          ref={triggerRef}
          type="button"
          aria-label="Show tabs"
          aria-description={`${tabs.length} open ${tabs.length === 1 ? "tab" : "tabs"}`}
          aria-haspopup="menu"
          aria-pressed={false}
          data-workbench-workspace-tabs-control=""
          className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
        >
          <OpenTabsIcon count={tabs.length} />
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent
        ref={menuRef}
        role="menu"
        aria-label="Open tabs"
        align="end"
        sideOffset={8}
        className="w-65 select-none"
        initialFocus={() => (focusEdgeRef.current ? focusMenuEdge(focusEdgeRef.current) : false)}
        finalFocus={() => (restoreTriggerFocusRef.current ? triggerRef.current : false)}
        onFocusCapture={() => {
          restoreTriggerFocusRef.current = true;
        }}
        onKeyDown={handleMenuNavigation}
      >
        <div className="px-2 py-1.5 text-[length:calc(var(--text-xs)*11/12)] leading-normal text-token-text-tertiary">
          Open tabs
        </div>
        {tabs.map((tab) => (
          <WorkspaceTabMenuRow
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={selectTab}
          />
        ))}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

function handleMenuNavigation(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const items = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  );
  if (items.length === 0) return;
  if (event.key === "Home" || event.key === "End") {
    items[event.key === "Home" ? 0 : items.length - 1]?.focus();
    return;
  }
  const currentIndex = items.indexOf(
    event.currentTarget.ownerDocument.activeElement as HTMLButtonElement,
  );
  const direction = event.key === "ArrowDown" ? 1 : -1;
  items[(currentIndex + direction + items.length) % items.length]?.focus();
}

function WorkspaceTabMenuRow({
  tab,
  active,
  onSelect,
}: {
  tab: AppShellTabPresentation;
  active: boolean;
  onSelect: WorkspaceTabsControlProps["onSelect"];
}) {
  const title = useAppShellTabTitle(tab);
  const label = makeAppShellTabAccessibleLabel(tab, title);
  return (
    <div className="group/workspace-tab relative flex h-8 min-w-0 shrink-0 items-center rounded-lg hover:bg-token-list-hover-background focus-within:bg-token-list-hover-background">
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-label={label}
        aria-current={active ? "true" : undefined}
        disabled={tab.disabled}
        className="no-drag flex h-full min-w-0 flex-1 cursor-interaction items-center gap-2 rounded-lg ps-2 pe-9 text-start text-[length:calc(var(--text-xs)*11/12)] leading-normal text-token-text-primary outline-hidden disabled:cursor-default disabled:opacity-40"
        onClick={() => onSelect(tab.id, "split")}
      >
        {makeAppShellTabIcon(tab)}
        <span className={cn("truncate", tab.preview && "italic")}>{title}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        aria-label={`Open ${label} in full view`}
        disabled={tab.disabled}
        className={cn(
          TOOLBAR_BUTTON_BASE_CLASS,
          TOOLBAR_BUTTON_GHOST_CLASS,
          "pointer-events-none absolute end-1 top-1/2 size-6 -translate-y-1/2 opacity-0 group-focus-within/workspace-tab:pointer-events-auto group-focus-within/workspace-tab:opacity-100 group-hover/workspace-tab:pointer-events-auto group-hover/workspace-tab:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
        )}
        onClick={() => onSelect(tab.id, "full")}
      >
        <EnterFullViewIcon />
      </button>
    </div>
  );
}

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useId,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  ChatActionsIcon,
  DragHandleDotsIcon,
  SelectedCircleIcon,
  ToolPinIcon,
  ToolPinnedIcon,
  UnselectedCircleIcon,
} from "@/components/shared/icons";
import { SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import { NodexDropdownSeparator } from "@/components/ui/dropdown";
import { NodexMenuRowContent, nodexMenuRowClassName } from "@/components/ui/menu-row";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { NodexOverflowTooltip, NodexTooltip } from "@/components/ui/tooltip";
import { useIntl, type IntlShape } from "@/lib/i18n";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  reorderNewTabShortcuts,
  resolveNewTabShortcutLayout,
  toggleNewTabShortcutPin,
  type NewTabShortcutPreference,
} from "@/lib/workbench-new-tab-model";
import {
  getPanelNewTabAction,
  resolvePanelActionShortcutLabel,
  type PanelNewTabAction,
  type PanelNewTabActionKind,
} from "@/lib/workbench-panel-actions";
import {
  PANEL_TOOL_KEYCAP_CLASS,
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import { PanelDestinationPicker } from "./panel-destination-picker";
import type { PanelDestination } from "./panel-destination-picker-model";

/** The stored arrangement a New tab reads and writes; see `useNewTabShortcutPreference`. */
export interface NewTabShortcutBinding {
  readonly preference: NewTabShortcutPreference | null;
  readonly ready: boolean;
  readonly update: (next: NewTabShortcutPreference | null) => void;
}

export interface NewTabOpenSectionProps {
  /** The tools this New tab's Scene and panel offer, in capability order. */
  readonly tools: readonly PanelNewTabAction[];
  readonly shortcuts: NewTabShortcutBinding;
  readonly isMac: boolean;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly projects: readonly Project[];
  readonly currentProjectId: string | null;
  readonly onSelectAction: (kind: PanelNewTabActionKind) => void;
  readonly onOpenDestination: (destination: PanelDestination) => void;
  /** Present when Terminal can also open in the bottom panel. */
  readonly bottomTerminal: { readonly shortcut: string | null; readonly onOpen: () => void } | null;
}

export const NEW_TAB_SECTION_HEADING_CLASS = "text-sm font-medium text-token-text-secondary";
const GRID_CLASS = "grid grid-cols-2 gap-2 @md:grid-cols-4";
const TILE_SHELL_CLASS =
  "flex min-h-22 w-full min-w-0 flex-col items-start justify-center gap-3 rounded-2xl bg-[var(--color-background-secondary-soft)] px-4 text-start select-none hover:bg-[var(--color-background-secondary-soft-hover)] @md:px-6";
const TILE_FOCUS_CLASS =
  "cursor-interaction rounded-2xl outline-none focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-token-border-xstrong";
const TILE_LABEL_CLASS = "max-w-full truncate text-sm text-token-text-primary";
const PAGE_PICKER_CONTENT_CLASS = "w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0";

type SectionMode = "tiles" | "menu" | "customize";

/**
 * The New tab's `Open` section: the tools a person pinned, as tiles. Its menu lists every
 * tool with a pin toggle, and Customize lets them check and drag tiles into order.
 */
export function NewTabOpenSection({
  tools,
  shortcuts,
  isMac,
  commandKeymapState,
  projects,
  currentProjectId,
  onSelectAction,
  onOpenDestination,
  bottomTerminal,
}: NewTabOpenSectionProps) {
  const intl = useIntl();
  const headingId = useId();
  const [mode, setMode] = useState<SectionMode>("tiles");
  const [menuPagePickerOpen, setMenuPagePickerOpen] = useState(false);
  const [moreButton, setMoreButton] = useState<HTMLButtonElement | null>(null);
  const deferredSelectionRef = useRef<PanelNewTabActionKind | null>(null);
  // Switching between the menu button and Done swaps the focused control; focus follows it.
  const focusHeaderButtonRef = useRef(false);
  const takeFocusOnMount = (node: HTMLButtonElement | null) => {
    if (!node || !focusHeaderButtonRef.current) return;
    focusHeaderButtonRef.current = false;
    node.focus();
  };

  if (!shortcuts.ready) return null;
  const { preference, update } = shortcuts;
  const layout = resolveNewTabShortcutLayout(tools, preference);
  if (layout.tools.length === 0 && !bottomTerminal) return null;
  const customizing = mode === "customize";
  const pinnedKinds = new Set(layout.pinned.map((tool) => tool.kind));
  const shortcutFor = (tool: PanelNewTabAction) =>
    resolvePanelActionShortcutLabel(tool, isMac, commandKeymapState);
  const togglePin = (kind: PanelNewTabActionKind) =>
    update(toggleNewTabShortcutPin(layout, preference, kind));
  const pagePicker = (onDone: () => void) => (
    <PanelDestinationPicker
      projects={projects}
      scope="page-only"
      ariaLabel={intl.formatMessage({
        id: "workbench.newTabOpenSection.openPage",
        defaultMessage: "Open Page",
      })}
      placeholder={intl.formatMessage({
        id: "workbench.newTabOpenSection.openPagePlaceholder",
        defaultMessage: "Open Page…",
      })}
      currentProjectId={currentProjectId}
      onClose={onDone}
      onAccept={(destination) => {
        onDone();
        onOpenDestination(destination);
      }}
    />
  );
  // A menu choice that opens its own surface waits until the menu has closed and returned
  // focus, so the new surface keeps it.
  const runSelection = (kind: PanelNewTabActionKind) => {
    if (kind === "page_stage") setMenuPagePickerOpen(true);
    else onSelectAction(kind);
  };
  const exitCustomize = () => {
    focusHeaderButtonRef.current = true;
    setMode("tiles");
  };

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      onKeyDown={(event) => {
        if (
          !customizing ||
          event.key !== "Escape" ||
          event.defaultPrevented ||
          // A keyboard drag owns Escape until it is cancelled.
          (event.target instanceof Element && event.target.closest('[aria-pressed="true"]'))
        ) {
          return;
        }
        event.stopPropagation();
        exitCustomize();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 id={headingId} className={NEW_TAB_SECTION_HEADING_CLASS}>
          {customizing
            ? intl.formatMessage({
                id: "workbench.newTabOpenSection.customize",
                defaultMessage: "Customize",
              })
            : intl.formatMessage({
                id: "workbench.newTabOpenSection.heading",
                defaultMessage: "Open",
              })}
        </h3>
        {customizing ? (
          <button
            ref={takeFocusOnMount}
            type="button"
            className="cursor-interaction no-drag h-token-button-composer rounded-lg px-2 text-sm text-token-text-secondary hover:bg-(--color-background-secondary-ghost-hover) hover:text-token-text-primary"
            onClick={exitCustomize}
          >
            {intl.formatMessage({ id: "workbench.newTabOpenSection.done", defaultMessage: "Done" })}
          </button>
        ) : (
          <NodexPopover
            open={mode === "menu"}
            onOpenChange={(open) => setMode(open ? "menu" : "tiles")}
            onOpenChangeComplete={(open) => {
              const deferred = deferredSelectionRef.current;
              if (open || deferred === null) return;
              deferredSelectionRef.current = null;
              runSelection(deferred);
            }}
          >
            <NodexPopoverTrigger>
              <button
                ref={(node) => {
                  setMoreButton(node);
                  takeFocusOnMount(node);
                }}
                type="button"
                aria-label={intl.formatMessage({
                  id: "workbench.newTabOpenSection.options",
                  defaultMessage: "More tools and shortcut options",
                })}
                className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
              >
                <ChatActionsIcon />
              </button>
            </NodexPopoverTrigger>
            <ShortcutMenu
              tools={layout.tools}
              pinnedKinds={pinnedKinds}
              shortcutFor={shortcutFor}
              bottomTerminal={bottomTerminal}
              canReset={preference !== null}
              onSelect={(kind) => {
                deferredSelectionRef.current = kind;
                setMode("tiles");
              }}
              onTogglePin={togglePin}
              onCustomize={() => {
                focusHeaderButtonRef.current = true;
                setMode("customize");
              }}
              onReset={() => {
                update(null);
                setMode("tiles");
              }}
              onClose={() => setMode("tiles")}
            />
          </NodexPopover>
        )}
        {/* `Open page…` chosen from the menu shows its picker beneath the menu button. */}
        <NodexPopover
          open={menuPagePickerOpen}
          onOpenChange={(open) => setMenuPagePickerOpen(open)}
        >
          <NodexPopoverContent
            anchor={moreButton}
            align="end"
            className={PAGE_PICKER_CONTENT_CLASS}
          >
            {menuPagePickerOpen ? pagePicker(() => setMenuPagePickerOpen(false)) : null}
          </NodexPopoverContent>
        </NodexPopover>
      </div>
      {customizing ? (
        <CustomizeGrid
          tools={layout.tools}
          pinnedKinds={pinnedKinds}
          onToggle={togglePin}
          onReorder={(kinds) => update(reorderNewTabShortcuts(layout, preference, kinds))}
        />
      ) : layout.pinned.length > 0 ? (
        <div className={GRID_CLASS}>
          {layout.pinned.map((tool) =>
            tool.kind === "page_stage" ? (
              <PageTile key={tool.kind} tool={tool} renderPicker={pagePicker} />
            ) : (
              <NodexOverflowTooltip key={tool.kind} content={tool.label}>
                <ToolTile tool={tool} onClick={() => onSelectAction(tool.kind)} />
              </NodexOverflowTooltip>
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

/** `Open page…` names the Page picker it opens. */
function toolTitle(tool: PanelNewTabAction, intl: IntlShape): string {
  return tool.kind === "page_stage"
    ? intl.formatMessage(
        { id: "workbench.newTabOpenSection.openPageTool", defaultMessage: "{label}…" },
        { label: tool.label },
      )
    : tool.label;
}

function TileShell({
  leading,
  children,
}: {
  readonly leading: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <span className={TILE_SHELL_CLASS}>
      <span className="flex h-4 w-full items-center justify-between gap-1 text-token-text-primary">
        {leading}
      </span>
      <span data-tooltip-overflow-target="" className={TILE_LABEL_CLASS}>
        {children}
      </span>
    </span>
  );
}

function ToolTile({
  tool,
  ...buttonProps
}: { readonly tool: PanelNewTabAction } & ComponentProps<"button">) {
  const intl = useIntl();
  const title = toolTitle(tool, intl);
  return (
    <button
      type="button"
      aria-label={title}
      className={cn("min-w-0", TILE_FOCUS_CLASS)}
      {...buttonProps}
    >
      <TileShell leading={<tool.Icon className="icon-xs" />}>{title}</TileShell>
    </button>
  );
}

/** A pinned `Open page…` opens the Page picker beneath its tile. */
function PageTile({
  tool,
  renderPicker,
}: {
  readonly tool: PanelNewTabAction;
  readonly renderPicker: (onDone: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <ToolTile tool={tool} />
      </NodexPopoverTrigger>
      <NodexPopoverContent align="start" className={PAGE_PICKER_CONTENT_CLASS}>
        {open ? renderPicker(() => setOpen(false)) : null}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

const MENU_ROW_BUTTON_CLASS = cn(
  nodexMenuRowClassName,
  "cursor-interaction flex min-w-0 flex-1 items-center text-start",
);
const MENU_ACTION_SELECTOR = "[data-new-tab-menu-action]";

function ShortcutMenu({
  tools,
  pinnedKinds,
  shortcutFor,
  bottomTerminal,
  canReset,
  onSelect,
  onTogglePin,
  onCustomize,
  onReset,
  onClose,
}: {
  readonly tools: readonly PanelNewTabAction[];
  readonly pinnedKinds: ReadonlySet<PanelNewTabActionKind>;
  readonly shortcutFor: (tool: PanelNewTabAction) => string | null;
  readonly bottomTerminal: NewTabOpenSectionProps["bottomTerminal"];
  readonly canReset: boolean;
  readonly onSelect: (kind: PanelNewTabActionKind) => void;
  readonly onTogglePin: (kind: PanelNewTabActionKind) => void;
  readonly onCustomize: () => void;
  readonly onReset: () => void;
  readonly onClose: () => void;
}) {
  const intl = useIntl();
  const TerminalIcon = getPanelNewTabAction("terminal").Icon;
  // Arrow keys move between the menu's actions; Tab still reaches each pin toggle.
  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const actions = [...event.currentTarget.querySelectorAll<HTMLElement>(MENU_ACTION_SELECTOR)];
    if (actions.length === 0) return;
    event.preventDefault();
    const current = actions.findIndex((action) => action.contains(document.activeElement));
    const delta = event.key === "ArrowDown" ? 1 : -1;
    const next = current < 0 ? (delta > 0 ? 0 : actions.length - 1) : current + delta;
    actions[(next + actions.length) % actions.length]?.focus();
  };

  return (
    <NodexPopoverContent
      align="end"
      aria-label={intl.formatMessage({
        id: "workbench.newTabOpenSection.shortcuts",
        defaultMessage: "Shortcuts",
      })}
      className="w-72"
      onKeyDown={moveFocus}
    >
      <div className="flex flex-col gap-px">
        {tools.map((tool) => {
          const pinned = pinnedKinds.has(tool.kind);
          const title = toolTitle(tool, intl);
          const shortcut = shortcutFor(tool);
          const pinLabel = pinned
            ? intl.formatMessage(
                { id: "workbench.newTabOpenSection.unpin", defaultMessage: "Unpin {tool}" },
                { tool: title },
              )
            : intl.formatMessage(
                { id: "workbench.newTabOpenSection.pin", defaultMessage: "Pin {tool}" },
                { tool: title },
              );
          return (
            <div
              key={tool.kind}
              className="group flex items-center rounded-lg hover:bg-token-list-hover-background has-[[data-new-tab-menu-action]:focus-visible]:bg-token-list-hover-background"
            >
              <button
                type="button"
                data-new-tab-menu-action=""
                className={MENU_ROW_BUTTON_CLASS}
                onClick={() => onSelect(tool.kind)}
              >
                <NodexMenuRowContent
                  leading={<tool.Icon className="icon-xs" />}
                  trailing={
                    shortcut ? (
                      <ShortcutKeycaps
                        aria-hidden
                        keys={[shortcut]}
                        className={cn(PANEL_TOOL_KEYCAP_CLASS, "ms-2")}
                      />
                    ) : null
                  }
                >
                  {title}
                </NodexMenuRowContent>
              </button>
              <NodexTooltip tooltipContent={pinLabel} side="right">
                <button
                  type="button"
                  aria-label={pinLabel}
                  className={cn(
                    "cursor-interaction me-1 flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-secondary outline-none hover:text-token-foreground focus-visible:text-token-foreground focus-visible:outline-2 focus-visible:outline-token-border-xstrong",
                    !pinned &&
                      "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100",
                  )}
                  onClick={() => onTogglePin(tool.kind)}
                >
                  {pinned ? <ToolPinnedIcon /> : <ToolPinIcon />}
                </button>
              </NodexTooltip>
            </div>
          );
        })}
        {bottomTerminal ? (
          <button
            type="button"
            data-new-tab-menu-action=""
            className={cn(
              MENU_ROW_BUTTON_CLASS,
              "group pe-[calc(var(--padding-row-x)+1.75rem)] hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background",
            )}
            onClick={() => {
              onClose();
              bottomTerminal.onOpen();
            }}
          >
            <NodexMenuRowContent
              leading={<TerminalIcon className="icon-xs" />}
              trailing={
                bottomTerminal.shortcut ? (
                  <ShortcutKeycaps
                    aria-hidden
                    keys={[bottomTerminal.shortcut]}
                    className={cn(PANEL_TOOL_KEYCAP_CLASS, "ms-2")}
                  />
                ) : null
              }
            >
              {intl.formatMessage({
                id: "workbench.newTabOpenSection.openBottomTerminal",
                defaultMessage: "Open bottom terminal",
              })}
            </NodexMenuRowContent>
          </button>
        ) : null}
      </div>
      <NodexDropdownSeparator />
      <MenuCommand icon={<SlidersHorizontal />} onClick={onCustomize}>
        {intl.formatMessage({
          id: "workbench.newTabOpenSection.customize",
          defaultMessage: "Customize",
        })}
      </MenuCommand>
      {canReset ? (
        <MenuCommand onClick={onReset}>
          {intl.formatMessage({
            id: "workbench.newTabOpenSection.reset",
            defaultMessage: "Reset to default",
          })}
        </MenuCommand>
      ) : null}
    </NodexPopoverContent>
  );
}

function MenuCommand({
  icon,
  onClick,
  children,
}: {
  readonly icon?: ReactNode;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-new-tab-menu-action=""
      className={cn(
        MENU_ROW_BUTTON_CLASS,
        "group hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background",
      )}
      onClick={onClick}
    >
      <NodexMenuRowContent leading={icon}>{children}</NodexMenuRowContent>
    </button>
  );
}

/** Customize: every tool as a tile to check or drag into place. */
function CustomizeGrid({
  tools,
  pinnedKinds,
  onToggle,
  onReorder,
}: {
  readonly tools: readonly PanelNewTabAction[];
  readonly pinnedKinds: ReadonlySet<PanelNewTabActionKind>;
  readonly onToggle: (kind: PanelNewTabActionKind) => void;
  readonly onReorder: (kinds: readonly PanelNewTabActionKind[]) => void;
}) {
  const kinds = tools.map((tool) => tool.kind);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorder = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = kinds.indexOf(active.id as PanelNewTabActionKind);
    const to = kinds.indexOf(over.id as PanelNewTabActionKind);
    if (from >= 0 && to >= 0) onReorder(arrayMove(kinds, from, to));
  };
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorder}>
      <SortableContext items={kinds} strategy={rectSortingStrategy}>
        <div className={GRID_CLASS}>
          {tools.map((tool) => (
            <CustomizeTile
              key={tool.kind}
              tool={tool}
              checked={pinnedKinds.has(tool.kind)}
              onToggle={() => onToggle(tool.kind)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

function CustomizeTile({
  tool,
  checked,
  onToggle,
}: {
  readonly tool: PanelNewTabAction;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  const intl = useIntl();
  const title = toolTitle(tool, intl);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tool.kind });
  const CheckIcon = checked ? SelectedCircleIcon : UnselectedCircleIcon;
  return (
    <div
      ref={setNodeRef}
      className={cn("relative min-w-0", isDragging && "z-10")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={title}
        // The whole tile drags; a press that never travels stays a toggle.
        onPointerDown={(event) => listeners?.onPointerDown?.(event)}
        onClick={onToggle}
        className={cn("block w-full touch-manipulation", TILE_FOCUS_CLASS)}
      >
        <TileShell
          leading={
            <CheckIcon
              className={checked ? "text-(--color-text-info)" : "text-token-text-tertiary"}
            />
          }
        >
          {title}
        </TileShell>
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        ref={setActivatorNodeRef}
        aria-label={intl.formatMessage(
          { id: "workbench.newTabOpenSection.move", defaultMessage: "Move {tool}" },
          { tool: title },
        )}
        className="absolute end-2.5 top-3.5 flex size-7 cursor-grab touch-none items-center justify-center rounded-md text-token-text-tertiary outline-none focus-visible:outline-2 focus-visible:outline-token-border-xstrong active:cursor-grabbing @md:end-4.5"
      >
        <DragHandleDotsIcon className="icon-xs" />
      </button>
    </div>
  );
}

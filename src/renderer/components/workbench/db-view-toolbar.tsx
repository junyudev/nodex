import { forwardRef, useState, type ButtonHTMLAttributes, type ComponentType, type RefObject } from "react";
import {
  ArrowUpDown,
  ListFilter,
  Search,
  SlidersHorizontal,
  XCircle,
} from "lucide-react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import {
  getAvailableSortFields,
  hasActiveDbViewFilters,
  hasActiveDbViewRules,
  hasActiveDbViewSorts,
  viewSupportsDbViewDisplay,
  type DbViewPrefs,
  type SupportedDbView,
} from "../../lib/db-view-prefs";
import { cn } from "@/lib/utils";
import {
  DbViewFilterPopover,
  DbViewDisplayPopover,
  DbViewRulesSummaryRow,
  DbViewSortPopover,
} from "./db-view-toolbar-rules";

export const DB_VIEW_TOOLBAR_TEST_ID = "db-view-toolbar";

export interface DbViewToolbarItem {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
  active?: boolean;
  onSelect: () => void;
}

interface DbViewToolbarProps {
  items: DbViewToolbarItem[];
  activeSearchQuery: string;
  taskSearchOpen: boolean;
  searchShortcutLabel: string;
  taskSearchInputRef: RefObject<HTMLInputElement | null>;
  rulesView: SupportedDbView | null;
  dbViewPrefs: DbViewPrefs | null;
  availableTags: string[];
  onUpdateDbViewPrefs: ((update: (prev: DbViewPrefs) => DbViewPrefs) => void) | null;
  onSearchQueryChange: (value: string) => void;
  onOpenTaskSearch: (selectQuery?: boolean) => void;
  onCloseTaskSearch: () => void;
}

export function resolveDbViewToolbarClearAction(hasActiveSearchQuery: boolean): {
  shouldClear: boolean;
  shouldClose: boolean;
} {
  if (!hasActiveSearchQuery) {
    return {
      shouldClear: false,
      shouldClose: true,
    };
  }

  return {
    shouldClear: true,
    shouldClose: true,
  };
}

const ToolbarIconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    icon: ComponentType<{ className?: string }>;
    active?: boolean;
    ariaLabel: string;
    title: string;
  }
>(function ToolbarIconButton(
  {
    icon: Icon,
    active = false,
    disabled = false,
    className,
    ariaLabel,
    title,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      disabled={disabled}
      aria-label={ariaLabel}
      title={title}
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-md",
        "hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]",
        active
          ? "text-(--accent-blue)"
          : "text-[color-mix(in_srgb,var(--foreground)_62%,transparent)] hover:text-(--foreground)",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  );
});

export function DbViewToolbar({
  items,
  activeSearchQuery,
  taskSearchOpen,
  searchShortcutLabel,
  taskSearchInputRef,
  rulesView,
  dbViewPrefs,
  availableTags,
  onUpdateDbViewPrefs,
  onSearchQueryChange,
  onOpenTaskSearch,
  onCloseTaskSearch,
}: DbViewToolbarProps) {
  const activeItem = items.find((item) => item.active) ?? items[0] ?? null;
  const [openPanel, setOpenPanel] = useState<"filter" | "sort" | "display" | null>(null);
  if (!activeItem) return null;

  const hasActiveSearchQuery = activeSearchQuery.trim().length > 0;
  const showSearchField = taskSearchOpen || hasActiveSearchQuery;
  const filterActive = rulesView && dbViewPrefs ? hasActiveDbViewFilters(rulesView, dbViewPrefs.rules) : false;
  const sortActive = rulesView && dbViewPrefs ? hasActiveDbViewSorts(rulesView, dbViewPrefs.rules) : false;
  const summaryVisible = Boolean(
    rulesView
    && dbViewPrefs
    && dbViewPrefs.summaryExpanded
    && hasActiveDbViewRules(rulesView, dbViewPrefs.rules),
  );

  const toggleRulePanel = (panel: "filter" | "sort" | "display") => {
    if (!rulesView || !dbViewPrefs || !onUpdateDbViewPrefs) return;
    setOpenPanel((current) => {
      const nextOpen = current === panel ? null : panel;
      if (current === panel && panel !== "display" && summaryVisible) {
        onUpdateDbViewPrefs((prev) => ({ ...prev, summaryExpanded: false }));
      }
      if (current !== panel && !dbViewPrefs.summaryExpanded && hasActiveDbViewRules(rulesView, dbViewPrefs.rules)) {
        onUpdateDbViewPrefs((prev) => ({ ...prev, summaryExpanded: true }));
      }
      return nextOpen;
    });
  };

  const rulesButtons = rulesView && dbViewPrefs && onUpdateDbViewPrefs ? (
    <>
      <DbViewFilterPopover
        open={openPanel === "filter"}
        onOpenChange={(open) => setOpenPanel(open ? "filter" : null)}
        prefs={dbViewPrefs}
        availableTags={availableTags}
        onChange={onUpdateDbViewPrefs}
      >
        <ToolbarIconButton
          icon={ListFilter}
          active={filterActive}
          ariaLabel="Filter"
          title="Filter"
          onClick={() => toggleRulePanel("filter")}
        />
      </DbViewFilterPopover>
      <DbViewSortPopover
        open={openPanel === "sort"}
        onOpenChange={(open) => setOpenPanel(open ? "sort" : null)}
        view={rulesView}
        prefs={dbViewPrefs}
        availableSortFields={getAvailableSortFields(rulesView)}
        onChange={onUpdateDbViewPrefs}
      >
        <ToolbarIconButton
          icon={ArrowUpDown}
          active={sortActive}
          ariaLabel="Sort"
          title="Sort"
          onClick={() => toggleRulePanel("sort")}
        />
      </DbViewSortPopover>
      {viewSupportsDbViewDisplay(rulesView) ? (
        <DbViewDisplayPopover
          open={openPanel === "display"}
          onOpenChange={(open) => setOpenPanel(open ? "display" : null)}
          view={rulesView}
          prefs={dbViewPrefs}
          onChange={onUpdateDbViewPrefs}
        >
          <ToolbarIconButton
            icon={SlidersHorizontal}
            active={openPanel === "display"}
            ariaLabel="Display"
            title="Display"
            onClick={() => toggleRulePanel("display")}
          />
        </DbViewDisplayPopover>
      ) : (
        <ToolbarIconButton
          icon={SlidersHorizontal}
          ariaLabel="Display"
          title="Display"
          disabled
        />
      )}
    </>
  ) : (
    <>
      <ToolbarIconButton icon={ListFilter} ariaLabel="Filter" title="Filter" disabled />
      <ToolbarIconButton icon={ArrowUpDown} ariaLabel="Sort" title="Sort" disabled />
      <ToolbarIconButton icon={SlidersHorizontal} ariaLabel="Display" title="Display" disabled />
    </>
  );

  return (
    <header
      className={cn(
        "sticky top-0 z-20 shrink-0",
        "bg-[color-mix(in_srgb,var(--background)_94%,transparent)] backdrop-blur-sm",
      )}
      data-testid={DB_VIEW_TOOLBAR_TEST_ID}
    >
      <div className="pl-4 pr-2 pb-2">
        <div className="flex min-h-11 items-center gap-4">
          <TabsPrimitive.Root
            value={activeItem.id}
            onValueChange={(value) => {
              const nextItem = items.find((item) => item.id === value);
              nextItem?.onSelect();
            }}
          >
            <TabsPrimitive.List
              aria-label="Database views"
              className="hide-scrollbar -ml-1 flex min-w-0 items-center overflow-x-auto"
            >
              {items.map((item) => {
                const isActive = item.id === activeItem.id;
                const Icon = item.icon;
                return (
                  <TabsPrimitive.Trigger
                    key={item.id}
                    value={item.id}
                    aria-label={item.label}
                    title={item.label}
                    className={cn(
                      "group/view mx-0.5 inline-flex h-8 shrink-0 items-center justify-center rounded-full",
                      "text-sm font-medium leading-none whitespace-nowrap outline-none",
                      "focus-visible:ring-2 focus-visible:ring-(--ring)/35",
                      isActive
                        ? "bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] px-3 text-(--foreground)"
                        : "w-8 text-(--foreground-secondary) hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-(--foreground)",
                    )}
                  >
                    {Icon ? (
                      <Icon
                        className={cn(
                          "size-4 shrink-0",
                          isActive
                            ? "text-current"
                            : "text-[color-mix(in_srgb,var(--foreground)_62%,transparent)] group-hover/view:text-current",
                        )}
                      />
                    ) : null}
                    <span
                      aria-hidden={!isActive}
                      data-tab-label-visible={isActive ? "true" : "false"}
                      className={cn(
                        "grid min-w-0 overflow-hidden",
                        isActive ? "grid-cols-[1fr]" : "grid-cols-[0fr]",
                      )}
                    >
                      <span className="min-w-0 overflow-hidden">
                        <span className="block pl-1.5 pt-px text-left">{item.label}</span>
                      </span>
                    </span>
                  </TabsPrimitive.Trigger>
                );
              })}
            </TabsPrimitive.List>
          </TabsPrimitive.Root>

          <div className="ml-auto flex h-full items-center justify-end gap-0.5">
            {rulesButtons}

            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onOpenTaskSearch(true)}
                aria-label="Search"
                title={`Task search (${searchShortcutLabel})`}
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-md",
                  "text-[color-mix(in_srgb,var(--foreground)_62%,transparent)] hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-(--foreground)",
                )}
              >
                <Search className="size-4" />
              </button>

              <div
                aria-hidden={!showSearchField}
                className={cn(
                  "overflow-hidden transition-[width,opacity,margin] duration-200 ease-out",
                  showSearchField ? "ml-1 w-[150px] opacity-100" : "ml-0 w-0 opacity-0",
                )}
              >
                <div className="flex items-center overflow-hidden">
                  <div className="mb-px flex w-full items-center pr-1 text-sm text-(--foreground)">
                    <input
                      ref={taskSearchInputRef}
                      type="text"
                      value={activeSearchQuery}
                      onChange={(event) => onSearchQueryChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== "Escape") return;
                        event.preventDefault();
                        onCloseTaskSearch();
                      }}
                      placeholder="Type to search..."
                      aria-label="Search tasks"
                      tabIndex={showSearchField ? 0 : -1}
                      className={cn(
                        "w-full border-none bg-transparent p-0 text-sm text-(--foreground) outline-none",
                        "placeholder:text-(--foreground-tertiary)",
                      )}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const nextAction = resolveDbViewToolbarClearAction(hasActiveSearchQuery);
                        if (nextAction.shouldClear) {
                          onSearchQueryChange("");
                        }
                        if (nextAction.shouldClose) {
                          onCloseTaskSearch();
                        }
                      }}
                      aria-label={hasActiveSearchQuery ? "Clear search" : "Close search"}
                      className={cn(
                        "inline-flex size-6 shrink-0 items-center justify-center rounded-full",
                        "text-(--foreground-tertiary) hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-(--foreground-secondary)",
                      )}
                    >
                      <XCircle className="size-4" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        {rulesView && dbViewPrefs && summaryVisible ? (
          <div className="py-2 border-t border-token-border">
            <DbViewRulesSummaryRow
              view={rulesView}
              prefs={dbViewPrefs}
              onOpenFilter={() => setOpenPanel("filter")}
              onOpenSort={() => setOpenPanel("sort")}
            />
          </div>
        ) : null}
      </div>
    </header>
  );
}

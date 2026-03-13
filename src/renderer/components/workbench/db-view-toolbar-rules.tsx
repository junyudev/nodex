import { useMemo } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Eye, EyeOff, Plus, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "../ui/select";
import {
  SELECTOR_MENU_CONTENT_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_CLASS_NAME,
  SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME,
} from "./stage-threads/selector-popover-primitives";
import {
  DB_VIEW_DISPLAY_PROPERTY_LABELS,
  DB_VIEW_SORT_FIELD_LABELS,
  DB_VIEW_SORT_FIELDS,
  getAvailableDisplayProperties,
  summarizeFilterClauses,
  summarizeSorts,
  viewSupportsDbViewDisplay,
  type DbViewDisplayPropertyKey,
  type DbViewFilterClause,
  type DbViewFilterGroup,
  type DbViewPrefs,
  type DbViewSortDirection,
  type DbViewSortField,
  type SupportedDbView,
} from "../../lib/db-view-prefs";
import {
  TOGGLE_LIST_EMPTY_PRIORITY_LABEL,
  TOGGLE_LIST_PRIORITY_CHIP_LABELS,
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_STATUS_LABELS,
  TOGGLE_LIST_STATUS_ORDER,
} from "../../lib/toggle-list/types";
import { cn } from "../../lib/utils";

const PANEL_CLASS_NAME = "min-w-96 max-w-[min(34rem,calc(100vw-2rem))] outline-none";
const SECTION_LABEL =
  "text-xs font-medium uppercase tracking-label text-token-description-foreground select-none";
const ROW_LABEL =
  "w-18 shrink-0 pt-0.75 text-xs text-token-description-foreground select-none";
const CHIP_BASE =
  "inline-flex h-6 items-center rounded-md px-2 text-xs font-medium text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground";
const CHIP_ACTIVE =
  "bg-[color-mix(in_srgb,var(--accent-blue)_18%,transparent)] text-(--accent-blue) hover:bg-[color-mix(in_srgb,var(--accent-blue)_22%,transparent)] hover:text-(--accent-blue)";
const ICON_BTN =
  "inline-flex size-5 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground disabled:cursor-not-allowed disabled:opacity-40";
const TEXT_BTN = "inline-flex items-center gap-1 text-xs font-medium text-token-description-foreground hover:text-token-foreground";
const SELECT_TRIGGER = "h-6 min-w-24 rounded-md border-transparent bg-token-foreground/5 px-2 py-0! text-xs shadow-none [&_svg]:size-3";

function ToolbarPopoverContent({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="bottom"
        align="end"
        sideOffset={8}
        collisionPadding={12}
        className={cn(SELECTOR_MENU_CONTENT_CLASS_NAME, PANEL_CLASS_NAME, className)}
      >
        <div className="flex flex-col gap-3 p-2">{children}</div>
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

function updateGroup(
  groups: DbViewFilterGroup[],
  index: number,
  nextGroup: DbViewFilterGroup,
): DbViewFilterGroup[] {
  const next = [...groups];
  next[index] = nextGroup;
  return next;
}

function removeGroup(groups: DbViewFilterGroup[], index: number): DbViewFilterGroup[] {
  if (groups.length <= 1) return [createDefaultFilterGroup()];
  return groups.filter((_, groupIndex) => groupIndex !== index);
}

function createDefaultFilterGroup(): DbViewFilterGroup {
  return {
    all: [
      { field: "status", op: "in", values: [...TOGGLE_LIST_STATUS_ORDER] },
      { field: "priority", op: "in", values: [...TOGGLE_LIST_PRIORITY_ORDER], includeEmpty: true },
    ],
  };
}

function replaceClause(group: DbViewFilterGroup, clause: DbViewFilterClause): DbViewFilterGroup {
  return {
    ...group,
    all: [...group.all.filter((candidate) => candidate.field !== clause.field), clause],
  };
}

function removeClause(group: DbViewFilterGroup, field: DbViewFilterClause["field"]): DbViewFilterGroup {
  return {
    ...group,
    all: group.all.filter((candidate) => candidate.field !== field),
  };
}

function getStatusValues(group: DbViewFilterGroup) {
  const clause = group.all.find(
    (candidate): candidate is Extract<DbViewFilterClause, { field: "status" }> => candidate.field === "status",
  );
  return clause?.values ?? [...TOGGLE_LIST_STATUS_ORDER];
}

function getPriorityValues(group: DbViewFilterGroup) {
  const clause = group.all.find(
    (candidate): candidate is Extract<DbViewFilterClause, { field: "priority" }> => candidate.field === "priority",
  );
  return clause?.values ?? [...TOGGLE_LIST_PRIORITY_ORDER];
}

function getPriorityIncludesEmpty(group: DbViewFilterGroup) {
  const clause = group.all.find(
    (candidate): candidate is Extract<DbViewFilterClause, { field: "priority" }> => candidate.field === "priority",
  );
  if (!clause) return true;
  return clause.includeEmpty ?? clause.values.length === TOGGLE_LIST_PRIORITY_ORDER.length;
}

function getTagClause(group: DbViewFilterGroup) {
  return group.all.find(
    (candidate): candidate is Extract<DbViewFilterClause, { field: "tags" }> => candidate.field === "tags",
  ) ?? null;
}

function FilterGroupEditor({
  group,
  groupIndex,
  availableTags,
  onChange,
  onRemove,
  removable,
}: {
  group: DbViewFilterGroup;
  groupIndex: number;
  availableTags: string[];
  onChange: (group: DbViewFilterGroup) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const statusValues = getStatusValues(group);
  const priorityValues = getPriorityValues(group);
  const priorityIncludesEmpty = getPriorityIncludesEmpty(group);
  const tagClause = getTagClause(group);
  const tagValues = tagClause?.values ?? [];
  const tagMode = tagClause?.op ?? "hasAny";

  const toggleStatus = (status: (typeof TOGGLE_LIST_STATUS_ORDER)[number]) => {
    const nextValues = statusValues.includes(status)
      ? statusValues.filter((candidate) => candidate !== status)
      : [...statusValues, status];
    onChange(replaceClause(group, { field: "status", op: "in", values: nextValues }));
  };

  const togglePriority = (priority: (typeof TOGGLE_LIST_PRIORITY_ORDER)[number]) => {
    const nextValues = priorityValues.includes(priority)
      ? priorityValues.filter((candidate) => candidate !== priority)
      : [...priorityValues, priority];
    onChange(replaceClause(group, {
      field: "priority",
      op: "in",
      values: nextValues,
      includeEmpty: priorityIncludesEmpty,
    }));
  };

  const toggleEmptyPriority = () => {
    onChange(replaceClause(group, {
      field: "priority",
      op: "in",
      values: priorityValues,
      includeEmpty: !priorityIncludesEmpty,
    }));
  };

  const toggleTag = (tag: string) => {
    const nextValues = tagValues.includes(tag)
      ? tagValues.filter((candidate) => candidate !== tag)
      : [...tagValues, tag];
    if (nextValues.length === 0) {
      onChange(removeClause(group, "tags"));
      return;
    }
    onChange(replaceClause(group, { field: "tags", op: tagMode, values: nextValues }));
  };

  const setTagMode = (mode: Extract<DbViewFilterClause, { field: "tags" }>["op"]) => {
    if (tagValues.length === 0) {
      onChange(removeClause(group, "tags"));
      return;
    }
    onChange(replaceClause(group, { field: "tags", op: mode, values: tagValues }));
  };

  return (
    <div className="relative flex flex-col gap-1.5">
      {removable ? (
        <button type="button" className={cn(ICON_BTN, "absolute -top-0.5 -right-0.5")} onClick={onRemove} title="Remove group">
          <X className="size-3" />
        </button>
      ) : null}
      <div className="flex items-start gap-2">
        <span className={ROW_LABEL}>Status</span>
        <div className="flex flex-wrap gap-1">
          {TOGGLE_LIST_STATUS_ORDER.map((status) => (
            <button
              key={`${groupIndex}:status:${status}`}
              type="button"
              className={cn(CHIP_BASE, statusValues.includes(status) && CHIP_ACTIVE)}
              onClick={() => toggleStatus(status)}
            >
              {TOGGLE_LIST_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-start gap-2">
        <span className={ROW_LABEL}>Priority</span>
        <div className="flex flex-wrap gap-1">
          {TOGGLE_LIST_PRIORITY_ORDER.map((priority) => (
            <button
              key={`${groupIndex}:priority:${priority}`}
              type="button"
              className={cn(CHIP_BASE, priorityValues.includes(priority) && CHIP_ACTIVE)}
              onClick={() => togglePriority(priority)}
            >
              {TOGGLE_LIST_PRIORITY_CHIP_LABELS[priority]}
            </button>
          ))}
          <button
            key={`${groupIndex}:priority:empty`}
            type="button"
            className={cn(CHIP_BASE, priorityIncludesEmpty && CHIP_ACTIVE)}
            onClick={toggleEmptyPriority}
            title="Empty priority"
            aria-label="Empty priority"
          >
            {TOGGLE_LIST_EMPTY_PRIORITY_LABEL}
          </button>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <span className={ROW_LABEL}>Tags</span>
        <div className="flex flex-wrap items-start gap-1.5">
          <Select value={tagMode} onValueChange={(value) => setTagMode(value as Extract<DbViewFilterClause, { field: "tags" }>["op"])}>
            <SelectTrigger className={cn(SELECT_TRIGGER, "w-18")}>
              {tagMode === "hasAny" ? "Any" : tagMode === "hasAll" ? "All" : "None"}
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              <SelectItem value="hasAny">Any</SelectItem>
              <SelectItem value="hasAll">All</SelectItem>
              <SelectItem value="hasNone">None</SelectItem>
            </SelectContent>
          </Select>
          {availableTags.length === 0 ? (
            <span className="pt-1 text-xs text-token-description-foreground italic">No tags in project</span>
          ) : (
            availableTags.map((tag) => (
              <button
                key={`${groupIndex}:tag:${tag}`}
                type="button"
                className={cn(CHIP_BASE, tagValues.includes(tag) && CHIP_ACTIVE)}
                onClick={() => toggleTag(tag)}
              >
                {tag}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function DbViewFilterPopover({
  open,
  onOpenChange,
  prefs,
  availableTags,
  onChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prefs: DbViewPrefs;
  availableTags: string[];
  onChange: (update: (prev: DbViewPrefs) => DbViewPrefs) => void;
  children: React.ReactNode;
}) {
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <ToolbarPopoverContent>
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL}>Filters</span>
          <button
            type="button"
            className={TEXT_BTN}
            onClick={() => onChange((prev) => ({
              ...prev,
              rules: {
                ...prev.rules,
                filter: {
                  any: [...prev.rules.filter.any, createDefaultFilterGroup()],
                },
              },
            }))}
          >
            <Plus className="size-3" />
            Group
          </button>
        </div>
        {prefs.rules.filter.any.map((group, groupIndex) => (
          <div key={`filter-group-${groupIndex}`} className="flex flex-col gap-2">
            {groupIndex > 0 ? (
              <div className={SELECTOR_MENU_DIVIDER_WRAPPER_CLASS_NAME}>
                <div className={SELECTOR_MENU_DIVIDER_CLASS_NAME} />
              </div>
            ) : null}
            <FilterGroupEditor
              group={group}
              groupIndex={groupIndex}
              availableTags={availableTags}
              removable={prefs.rules.filter.any.length > 1}
              onRemove={() => onChange((prev) => ({
                ...prev,
                rules: {
                  ...prev.rules,
                  filter: {
                    any: removeGroup(prev.rules.filter.any, groupIndex),
                  },
                },
              }))}
              onChange={(nextGroup) => onChange((prev) => ({
                ...prev,
                rules: {
                  ...prev.rules,
                  filter: {
                    any: updateGroup(prev.rules.filter.any, groupIndex, nextGroup),
                  },
                },
              }))}
            />
          </div>
        ))}
      </ToolbarPopoverContent>
    </PopoverPrimitive.Root>
  );
}

export function DbViewSortPopover({
  open,
  onOpenChange,
  view,
  prefs,
  availableSortFields,
  onChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: SupportedDbView;
  prefs: DbViewPrefs;
  availableSortFields: DbViewSortField[];
  onChange: (update: (prev: DbViewPrefs) => DbViewPrefs) => void;
  children: React.ReactNode;
}) {
  const unusedSortFields = useMemo(
    () => availableSortFields.filter((field) => !prefs.rules.sort.some((entry) => entry.field === field)),
    [availableSortFields, prefs.rules.sort],
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <ToolbarPopoverContent>
        <div className="flex items-center justify-between">
          <span className={SECTION_LABEL}>Sort</span>
          <button
            type="button"
            className={TEXT_BTN}
            onClick={() => onChange((prev) => ({
              ...prev,
              rules: {
                ...prev.rules,
                sort: [
                  ...prev.rules.sort,
                  {
                    field: unusedSortFields[0] ?? availableSortFields[0] ?? DB_VIEW_SORT_FIELDS[0],
                    direction: "asc",
                  },
                ],
              },
            }))}
          >
            <Plus className="size-3" />
            Sort
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {prefs.rules.sort.map((entry, index) => (
            <div key={`${entry.field}:${index}`} className="flex items-center gap-1.5">
              <Select
                value={entry.field}
                onValueChange={(value) =>
                  onChange((prev) => {
                    const nextSort = [...prev.rules.sort];
                    nextSort[index] = { ...nextSort[index], field: value as DbViewSortField };
                    return {
                      ...prev,
                      rules: {
                        ...prev.rules,
                        sort: nextSort,
                      },
                    };
                  })}
              >
                <SelectTrigger className={cn(SELECT_TRIGGER, "min-w-28 max-w-36")}>
                  {DB_VIEW_SORT_FIELD_LABELS[entry.field]}
                </SelectTrigger>
                <SelectContent sideOffset={4}>
                  {availableSortFields.map((field) => (
                    <SelectItem key={`${view}:${field}`} value={field}>
                      {DB_VIEW_SORT_FIELD_LABELS[field]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={entry.direction}
                onValueChange={(value) =>
                  onChange((prev) => {
                    const nextSort = [...prev.rules.sort];
                    nextSort[index] = { ...nextSort[index], direction: value as DbViewSortDirection };
                    return {
                      ...prev,
                      rules: {
                        ...prev.rules,
                        sort: nextSort,
                      },
                    };
                  })}
              >
                <SelectTrigger className={cn(SELECT_TRIGGER, "w-18")}>
                  {entry.direction === "asc" ? "Asc" : "Desc"}
                </SelectTrigger>
                <SelectContent sideOffset={4}>
                  <SelectItem value="asc">Ascending</SelectItem>
                  <SelectItem value="desc">Descending</SelectItem>
                </SelectContent>
              </Select>
              <div className="ml-auto flex items-center gap-0.5">
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() =>
                    onChange((prev) => {
                      const nextSort = [...prev.rules.sort];
                      const previousEntry = nextSort[index - 1];
                      if (!previousEntry) return prev;
                      nextSort[index - 1] = nextSort[index];
                      nextSort[index] = previousEntry;
                      return { ...prev, rules: { ...prev.rules, sort: nextSort } };
                    })}
                  disabled={index === 0}
                  title="Move up"
                >
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() =>
                    onChange((prev) => {
                      const nextSort = [...prev.rules.sort];
                      const nextEntry = nextSort[index + 1];
                      if (!nextEntry) return prev;
                      nextSort[index + 1] = nextSort[index];
                      nextSort[index] = nextEntry;
                      return { ...prev, rules: { ...prev.rules, sort: nextSort } };
                    })}
                  disabled={index === prefs.rules.sort.length - 1}
                  title="Move down"
                >
                  <ArrowDown className="size-3" />
                </button>
                <button
                  type="button"
                  className={ICON_BTN}
                  onClick={() =>
                    onChange((prev) => ({
                      ...prev,
                      rules: {
                        ...prev.rules,
                        sort: prev.rules.sort.length > 1
                          ? prev.rules.sort.filter((_, sortIndex) => sortIndex !== index)
                          : prev.rules.sort,
                      },
                    }))}
                  disabled={prefs.rules.sort.length <= 1}
                  title="Remove sort"
                >
                  <X className="size-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      </ToolbarPopoverContent>
    </PopoverPrimitive.Root>
  );
}

export function DbViewDisplayPopover({
  open,
  onOpenChange,
  view,
  prefs,
  onChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  view: SupportedDbView;
  prefs: DbViewPrefs;
  onChange: (update: (prev: DbViewPrefs) => DbViewPrefs) => void;
  children: React.ReactNode;
}) {
  const displayProperties = getAvailableDisplayProperties(view);
  const supportsPlaceholderToggle = view === "toggle-list" || view === "kanban";

  if (!viewSupportsDbViewDisplay(view)) {
    return <>{children}</>;
  }

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <PopoverPrimitive.Trigger asChild>{children}</PopoverPrimitive.Trigger>
      <ToolbarPopoverContent className="min-w-80">
        <div className="flex flex-col gap-3">
          <span className={SECTION_LABEL}>Display</span>
          <div className="flex flex-col gap-1">
            {prefs.display.propertyOrder
              .filter((property) => displayProperties.includes(property))
              .map((property, index, orderedProperties) => {
                const hidden = prefs.display.hiddenProperties.includes(property);
                const showEmptyKey =
                  supportsPlaceholderToggle && property === "estimate" ? "showEmptyEstimate" as const
                    : supportsPlaceholderToggle && property === "priority" ? "showEmptyPriority" as const
                      : null;
                const showEmpty = showEmptyKey ? prefs.display[showEmptyKey] : false;
                return (
                  <div key={property} className="group flex items-center gap-1">
                    <span className={cn("w-22 shrink-0 truncate text-xs font-medium", hidden ? "text-token-description-foreground/50" : "text-token-foreground")}>
                      {DB_VIEW_DISPLAY_PROPERTY_LABELS[property as DbViewDisplayPropertyKey]}
                    </span>
                    <button
                      type="button"
                      className={ICON_BTN}
                      onClick={() =>
                        onChange((prev) => ({
                          ...prev,
                          display: {
                            ...prev.display,
                            hiddenProperties: hidden
                              ? prev.display.hiddenProperties.filter((item) => item !== property)
                              : [...prev.display.hiddenProperties, property],
                          },
                        }))}
                      title={hidden ? "Show" : "Hide"}
                    >
                      {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                    </button>
                    <button
                      type="button"
                      className={cn(ICON_BTN, "opacity-0 group-hover:opacity-100")}
                      onClick={() =>
                        onChange((prev) => {
                          if (index === 0) return prev;
                          const nextOrder = [...prev.display.propertyOrder];
                          const swap = nextOrder[index - 1];
                          nextOrder[index - 1] = property;
                          nextOrder[index] = swap;
                          return {
                            ...prev,
                            display: {
                              ...prev.display,
                              propertyOrder: nextOrder,
                            },
                          };
                        })}
                      disabled={index === 0}
                      title="Move up"
                    >
                      <ArrowUp className="size-3" />
                    </button>
                    <button
                      type="button"
                      className={cn(ICON_BTN, "opacity-0 group-hover:opacity-100")}
                      onClick={() =>
                        onChange((prev) => {
                          if (index === orderedProperties.length - 1) return prev;
                          const nextOrder = [...prev.display.propertyOrder];
                          const swap = nextOrder[index + 1];
                          nextOrder[index + 1] = property;
                          nextOrder[index] = swap;
                          return {
                            ...prev,
                            display: {
                              ...prev.display,
                              propertyOrder: nextOrder,
                            },
                          };
                        })}
                      disabled={index === orderedProperties.length - 1}
                      title="Move down"
                    >
                      <ArrowDown className="size-3" />
                    </button>
                    {showEmptyKey && (
                      <button
                        type="button"
                        className={cn(
                          "ml-0.5 inline-flex h-5 items-center rounded-md px-1 font-mono text-[10px] leading-none",
                          showEmpty
                            ? "bg-token-foreground/8 text-token-foreground"
                            : "text-token-description-foreground/50 hover:bg-token-foreground/5 hover:text-token-description-foreground",
                        )}
                        onClick={() =>
                          onChange((prev) => ({
                            ...prev,
                            display: {
                              ...prev.display,
                              [showEmptyKey]: !prev.display[showEmptyKey],
                            },
                          }))}
                        title={showEmpty ? "Hide placeholder when empty" : "Show placeholder when empty"}
                      >
                        [-]
                      </button>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      </ToolbarPopoverContent>
    </PopoverPrimitive.Root>
  );
}

function SummaryChip({
  label,
  value,
  onClick,
}: {
  label: string;
  value: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-0.5 rounded-full bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] px-2 text-xs font-medium text-(--accent-blue) hover:bg-[color-mix(in_srgb,var(--accent-blue)_18%,transparent)]"
      onClick={onClick}
    >
      <span className="font-medium">{label}:</span>
      <span className="max-w-56 truncate">{value}</span>
    </button>
  );
}

function SummaryButton({
  children,
  onClick,
}: {
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-6 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] px-2 text-xs font-medium text-(--accent-blue) hover:bg-[color-mix(in_srgb,var(--accent-blue)_18%,transparent)]"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function DbViewRulesSummaryRow({
  view,
  prefs,
  onOpenFilter,
  onOpenSort,
}: {
  view: SupportedDbView;
  prefs: DbViewPrefs;
  onOpenFilter: () => void;
  onOpenSort: () => void;
}) {
  const filterSummaries = summarizeFilterClauses(prefs.rules);
  const sortSummaries = summarizeSorts(prefs.rules);
  const primarySort = sortSummaries[0] ?? null;
  if (filterSummaries.length === 0 && sortSummaries.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {sortSummaries.length > 0 ? (
        <SummaryButton onClick={onOpenSort}>
          {sortSummaries.length === 1 && primarySort ? (
            <>
              {primarySort.value === "Ascending" ? (
                <ArrowUp className="size-3.5" aria-hidden="true" />
              ) : (
                <ArrowDown className="size-3.5" aria-hidden="true" />
              )}
              <span className="max-w-44 truncate">{primarySort.label}</span>
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </>
          ) : (
            <>
              <ArrowUpDown className="size-3.5" aria-hidden="true" />
              <span>{sortSummaries.length} sorts</span>
              <ChevronDown className="size-3.5" aria-hidden="true" />
            </>
          )}
        </SummaryButton>
      ) : null}
      {sortSummaries.length > 0 && filterSummaries.length > 0 ? (
        <div
          aria-hidden="true"
          className="h-5 w-px shrink-0 bg-[color-mix(in_srgb,var(--foreground)_16%,transparent)]"
        />
      ) : null}
      {filterSummaries.map((summary) => (
        <SummaryChip key={`${view}:${summary.key}`} label={summary.label} value={summary.value} onClick={onOpenFilter} />
      ))}
    </div>
  );
}

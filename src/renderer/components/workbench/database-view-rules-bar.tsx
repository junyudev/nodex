import { DndContext, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useRef,
  useState,
  type ComponentType,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import {
  ChevronDownIcon,
  ClockIcon,
  CloseIcon,
  DeleteIcon,
  DragHandleDotsIcon,
  FilterIcon,
  MoreActionsIcon,
  PlusIcon,
  ResetIcon,
  SortAscendingIcon,
  SortDescendingIcon,
} from "@/components/shared/icons";
import { ArrowUpDown, UploadCloud } from "@/components/shared/icons/generic-icons";
import { NodexIconButton } from "@/components/ui/button";
import {
  ContinuousSortableDragOverlay,
  useContinuousSortable,
  useContinuousSortableDnd,
} from "@/components/ui/continuous-sortable";
import {
  NodexPopover,
  NodexPopoverAnchor,
  NodexPopoverContent,
  NodexPopoverTrigger,
} from "@/components/ui/popover";
import { dataSourcePropertyIcon } from "@/components/database/data-source-property-presentation";
import {
  databaseFilterClauseWithOperator,
  databaseFilterClauseWithProperty,
  filterOperatorsForProperty,
  readDatabasePropertyOptions,
} from "@/lib/database-view-authoring";
import {
  databaseViewSortDirectionLabels,
  databaseViewSortFieldLabel,
  hasCustomDatabaseViewSort,
  summarizeDatabaseViewFilter,
} from "@/lib/database-view-rule-summary";
import {
  databaseViewRulesHaveVisibleFilters,
  databaseViewRulesHaveVisibleSorts,
  type DatabaseViewRulesController,
} from "@/lib/use-database-view-rules-controller";
import type { DatabaseViewAccessContext } from "@/lib/database-view-render-model";
import { cn } from "@/lib/utils";
import {
  databaseViewFilterClauseIsEmpty,
  databaseViewFilterNodeRuleCount,
  databaseViewFilterOperatorLabel,
} from "../../../shared/database-view-rules";
import type { DatabaseViewRuleScope } from "../../../shared/database-view-rules";
import { compactDatabaseViewRulesOverride } from "../../../shared/database-view-presentation";
import type {
  DatabasePropertyOption,
  DatabaseViewConfigV6,
  DatabaseViewFilterClause,
  DatabaseViewPropertyFilter,
  DatabaseViewSort,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import {
  DatabaseViewAdvancedFilterEditor,
  DatabaseViewFilterValueField,
  DatabaseRulePropertyLabel,
} from "./database-view-filter-editors";
import { DatabaseViewSelect } from "./database-view-select";

interface DatabaseViewRulesBarProps {
  readonly controller: DatabaseViewRulesController;
  readonly config: DatabaseViewConfigV6;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries?: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly accessContext?: DatabaseViewAccessContext;
}

interface DatabaseViewRuleToolbarControlsProps {
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
}

const EMPTY_OPTIONS: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {};
const TOKEN_CLASS = cn(
  "group/rule inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium",
  "bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] text-(--accent-blue)",
  "hover:bg-[color-mix(in_srgb,var(--accent-blue)_19%,transparent)]",
  "focus-visible:ring-2 focus-visible:ring-token-focus focus-visible:outline-none",
);

const MENU_ROW = cn(
  "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-token-foreground",
  "hover:bg-token-foreground/6 focus-visible:bg-token-foreground/6 focus-visible:outline-none",
);

type PersonalRuleActionKind = "reset" | "publish";
type PersonalRulePreviewSource = "pointer" | "focus";

const RULE_ACTION_PREVIEW_CLASS: Record<PersonalRuleActionKind, string> = {
  publish: cn(
    "bg-[color-mix(in_srgb,var(--accent-blue)_22%,transparent)]",
    "ring-1 ring-inset ring-[color-mix(in_srgb,var(--accent-blue)_55%,transparent)]",
  ),
  reset: cn(
    "bg-token-foreground/8 text-token-foreground",
    "ring-1 ring-inset ring-token-foreground/20",
  ),
};

const sortKey = (sort: DatabaseViewSort): string =>
  sort.field.kind === "property" ? `property:${sort.field.propertyId}` : sort.field.kind;

function SortFooterActionLabel({
  icon: Icon,
  children,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly children: ReactNode;
}) {
  return (
    <span data-slot="sort-footer-action-label" className="flex items-center gap-2">
      <Icon className="size-4 shrink-0" />
      <span>{children}</span>
    </span>
  );
}

const quickFilterEditorWidthClassName = (property: DataSourcePropertyRecordV2 | null): string =>
  property?.valueType === "text" ||
  property?.valueType === "number" ||
  property?.valueType === "checkbox"
    ? "w-[220px]"
    : "w-[260px]";

function RuleToken({
  children,
  className,
  actionPreview,
  ...props
}: ComponentPropsWithoutRef<"button"> & {
  readonly actionPreview?: PersonalRuleActionKind;
}) {
  return (
    <button
      type="button"
      data-personal-action-preview={actionPreview}
      className={cn(
        TOKEN_CLASS,
        className,
        actionPreview && RULE_ACTION_PREVIEW_CLASS[actionPreview],
      )}
      {...props}
    >
      {children}
    </button>
  );
}

function PersonalRuleAction({
  kind,
  scopes,
  busy,
  onAction,
  onPreviewChange,
}: {
  readonly kind: PersonalRuleActionKind;
  readonly scopes: readonly DatabaseViewRuleScope[];
  readonly busy: boolean;
  readonly onAction: (scope: DatabaseViewRuleScope) => void;
  readonly onPreviewChange: (
    source: PersonalRulePreviewSource,
    kind: PersonalRuleActionKind | null,
  ) => void;
}) {
  if (scopes.length === 0) return null;

  const label = kind === "reset" ? "Reset my changes" : "Save for everyone";
  const Icon = kind === "reset" ? ResetIcon : UploadCloud;
  const scopeLabel = scopes.includes("all")
    ? "filter and sort"
    : scopes[0] === "filters"
      ? "filter"
      : "sort";
  const tooltip =
    kind === "reset"
      ? `Discard these ${scopeLabel} changes\nRestore shared rules`
      : `Save these ${scopeLabel} changes\nFor everyone`;

  return (
    <NodexIconButton
      icon={Icon}
      size="xs"
      active={kind === "publish"}
      ariaLabel={label}
      title={tooltip}
      disabled={busy}
      onMouseEnter={() => onPreviewChange("pointer", kind)}
      onMouseLeave={() => onPreviewChange("pointer", null)}
      onFocus={() => onPreviewChange("focus", kind)}
      onBlur={() => onPreviewChange("focus", null)}
      onClick={() => {
        onPreviewChange("pointer", null);
        onPreviewChange("focus", null);
        onAction("all");
      }}
    />
  );
}

function QuickFilterEditor({
  filter,
  controller,
  properties,
  optionRegistries,
  onRequestPropertyOptions,
  accessContext,
  busy,
}: {
  readonly filter: DatabaseViewPropertyFilter;
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly accessContext?: DatabaseViewAccessContext;
  readonly busy: boolean;
}) {
  const property =
    properties.find((candidate) => candidate.propertyId === filter.clause.propertyId) ?? null;
  if (!property) {
    return (
      <div className="flex items-center gap-2 p-2 text-sm">
        <span className="min-w-0 flex-1 truncate">This Property no longer exists.</span>
        <NodexIconButton
          icon={DeleteIcon}
          size="xs"
          tone="danger"
          ariaLabel="Remove missing filter"
          onClick={() => controller.removeQuickFilter(filter.filterId)}
        />
      </div>
    );
  }
  const update = (clause: DatabaseViewFilterClause) =>
    controller.updateQuickFilter(filter.filterId, clause);
  return (
    <div className="w-full max-w-full overflow-hidden">
      <div className="grid min-h-8 grid-cols-[minmax(0,1fr)_auto_20px] items-center gap-0.5 px-2 pb-0.5 pt-1 text-xs text-token-description-foreground">
        <DatabaseViewSelect
          ariaLabel="Filter property"
          search="filter"
          searchPlaceholder="Search properties…"
          value={property.propertyId}
          valueLabel={property.name}
          disabled={busy}
          onValueChange={(propertyId) => {
            const next = properties.find((candidate) => candidate.propertyId === propertyId);
            if (next) update(databaseFilterClauseWithProperty(filter.clause, next));
          }}
          options={properties.map((candidate) => ({
            value: candidate.propertyId,
            label: <DatabaseRulePropertyLabel property={candidate} />,
            searchText: candidate.name,
          }))}
          chrome="transparent"
          className="h-5 w-full min-w-0 px-1 text-xs"
        />
        <DatabaseViewSelect
          ariaLabel="Filter operator"
          value={filter.clause.operator}
          valueLabel={databaseViewFilterOperatorLabel(filter.clause.operator)}
          disabled={busy}
          onValueChange={(operator) =>
            update(
              databaseFilterClauseWithOperator(
                property,
                operator as DatabaseViewFilterClause["operator"],
              ),
            )
          }
          options={filterOperatorsForProperty(property)
            .map((operator) => ({
              value: operator,
              label: databaseViewFilterOperatorLabel(operator),
            }))
            .filter((option) => option.value !== "multi_select_contains_all")}
          chrome="transparent"
          className="h-5 w-auto max-w-[100px] px-1 text-xs"
        />
        <NodexPopover>
          <NodexPopoverTrigger>
            <button
              type="button"
              aria-label="More actions"
              disabled={busy}
              className="grid size-5 shrink-0 place-items-center rounded-md text-token-description-foreground hover:bg-token-foreground/6 hover:text-token-foreground disabled:opacity-50"
            >
              <MoreActionsIcon className="size-3.5" />
            </button>
          </NodexPopoverTrigger>
          <NodexPopoverContent className="w-60 p-1" align="start" side="right" sideOffset={2}>
            <button
              type="button"
              className={cn(MENU_ROW, "text-token-error-foreground")}
              onClick={() => controller.removeQuickFilter(filter.filterId)}
            >
              <DeleteIcon className="size-4" /> Delete filter
            </button>
            <button
              type="button"
              className={MENU_ROW}
              onClick={() => controller.moveQuickFilterToAdvanced(filter.filterId)}
            >
              <FilterIcon className="size-4" /> Add to advanced filter
            </button>
          </NodexPopoverContent>
        </NodexPopover>
      </div>
      <div
        className={cn(
          (property.valueType === "text" || property.valueType === "number") && "px-2 pb-2",
        )}
      >
        <DatabaseViewFilterValueField
          clause={filter.clause}
          property={property}
          options={optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property)}
          onRequestOptions={onRequestPropertyOptions}
          accessContext={accessContext}
          disabled={busy}
          presentation="quick"
          onChange={(value) => update({ ...filter.clause, value })}
        />
      </div>
    </div>
  );
}

function SortableQuickFilterToken({
  filter,
  controller,
  properties,
  optionRegistries,
  onRequestPropertyOptions,
  accessContext,
  busy,
  actionPreview,
}: {
  readonly filter: DatabaseViewPropertyFilter;
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly accessContext?: DatabaseViewAccessContext;
  readonly busy: boolean;
  readonly actionPreview?: PersonalRuleActionKind;
}) {
  const sortable = useContinuousSortable({ id: filter.filterId, disabled: busy });
  const property = properties.find(
    (candidate) => candidate.propertyId === filter.clause.propertyId,
  );
  const Icon = property ? dataSourcePropertyIcon(property) : FilterIcon;
  const summary = summarizeDatabaseViewFilter(filter.clause, properties, optionRegistries)[0];
  const empty = databaseViewFilterClauseIsEmpty(filter.clause);
  const open =
    controller.popover?.kind === "quick_filter" && controller.popover.filterId === filter.filterId;
  return (
    <div ref={sortable.setNodeRef} style={sortable.style} className="flex shrink-0 items-center">
      <NodexPopover
        open={open}
        onOpenChange={(next) =>
          controller.setPopoverOpen({ kind: "quick_filter", filterId: filter.filterId }, next)
        }
      >
        <NodexPopoverTrigger>
          <RuleToken
            aria-label={`Edit filter ${property?.name ?? "Missing property"}`}
            className={empty ? "bg-token-foreground/5 text-token-text-secondary" : undefined}
            actionPreview={actionPreview}
          >
            <span
              {...sortable.attributes}
              {...sortable.listeners}
              className="-ml-1 inline-flex cursor-grab touch-none items-center opacity-55 active:cursor-grabbing"
              aria-label={`Reorder filter ${property?.name ?? "Missing property"}`}
            >
              <DragHandleDotsIcon className="size-3" />
            </span>
            <Icon className="size-3.5" />
            <span className="max-w-56 truncate">
              {summary
                ? `${summary.label}: ${summary.value}`
                : (property?.name ?? "Missing property")}
            </span>
            <ChevronDownIcon className="size-3" />
          </RuleToken>
        </NodexPopoverTrigger>
        <NodexPopoverContent
          className={cn(
            quickFilterEditorWidthClassName(property ?? null),
            "max-w-[calc(100vw-16px)] p-0",
          )}
          align="start"
        >
          <QuickFilterEditor
            filter={filter}
            controller={controller}
            properties={properties}
            optionRegistries={optionRegistries}
            onRequestPropertyOptions={onRequestPropertyOptions}
            accessContext={accessContext}
            busy={busy}
          />
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}

function SortableSortRow({
  sort,
  properties,
  unavailableFieldKeys,
  busy,
  onChange,
  onDelete,
}: {
  readonly sort: DatabaseViewSort;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly unavailableFieldKeys: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onChange: (sort: DatabaseViewSort) => void;
  readonly onDelete: () => void;
}) {
  const id = sortKey(sort);
  const sortable = useContinuousSortable({ id, disabled: busy });
  const [ascending, descending] = databaseViewSortDirectionLabels(sort, properties);
  const selectedPropertyId = sort.field.kind === "property" ? sort.field.propertyId : null;
  const selectedProperty = selectedPropertyId
    ? (properties.find((property) => property.propertyId === selectedPropertyId) ?? null)
    : null;
  const selectedLabel = selectedProperty ? (
    <DatabaseRulePropertyLabel property={selectedProperty} />
  ) : sort.field.kind === "created" ? (
    <span className="flex items-center gap-1.5">
      <ClockIcon className="size-4 shrink-0 text-token-text-secondary" /> Created time
    </span>
  ) : sort.field.kind === "manual" ? (
    <span>Manual order</span>
  ) : (
    <span className="flex items-center gap-1.5">
      <NamePropertyIcon className="size-4 shrink-0 text-token-text-secondary" /> Name
    </span>
  );
  const fields = [
    {
      value: "title",
      label: (
        <span className="flex items-center gap-1.5">
          <NamePropertyIcon className="size-4 shrink-0 text-token-text-secondary" /> Name
        </span>
      ),
      searchText: "Name",
    },
    {
      value: "created",
      label: (
        <span className="flex items-center gap-1.5">
          <ClockIcon className="size-4 shrink-0 text-token-text-secondary" /> Created time
        </span>
      ),
      searchText: "Created time",
    },
    ...(sort.field.kind === "manual"
      ? [{ value: "manual", label: "Manual order", searchText: "Manual order" }]
      : []),
    ...properties
      .filter((candidate) => candidate.lifecycle === "active" && candidate.capabilities.sortable)
      .map((candidate) => ({
        value: `property:${candidate.propertyId}`,
        label: <DatabaseRulePropertyLabel property={candidate} />,
        searchText: candidate.name,
      })),
  ].filter((field) => field.value === id || !unavailableFieldKeys.has(field.value));
  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      className="grid min-h-8 w-full grid-cols-[24px_max-content_max-content_minmax(32px,1fr)_24px] items-center gap-2 px-1"
    >
      <span
        {...sortable.attributes}
        {...sortable.listeners}
        className="inline-flex size-6 cursor-grab touch-none items-center justify-center text-token-description-foreground active:cursor-grabbing"
        aria-label={`Reorder sort ${databaseViewSortFieldLabel(sort, properties)}`}
      >
        <DragHandleDotsIcon className="size-3.5" />
      </span>
      <DatabaseViewSelect
        ariaLabel="Sort property"
        search="filter"
        searchPlaceholder="Search sort fields…"
        value={id}
        valueLabel={selectedLabel}
        disabled={busy}
        options={fields}
        onValueChange={(value) =>
          onChange({
            ...sort,
            field: value.startsWith("property:")
              ? { kind: "property", propertyId: value.slice("property:".length) }
              : value === "manual"
                ? { kind: "manual" }
                : value === "created"
                  ? { kind: "created" }
                  : { kind: "title" },
          })
        }
        size="rule"
        triggerWidth="content"
      />
      <DatabaseViewSelect
        ariaLabel="Sort direction"
        value={sort.direction}
        valueLabel={sort.direction === "asc" ? ascending : descending}
        disabled={busy}
        options={[
          { value: "asc", label: ascending },
          { value: "desc", label: descending },
        ]}
        onValueChange={(direction) =>
          onChange({ ...sort, direction: direction as DatabaseViewSort["direction"] })
        }
        size="rule"
        triggerWidth="content"
      />
      <span aria-hidden="true" />
      <NodexIconButton
        icon={CloseIcon}
        size="xs"
        ariaLabel={`Delete sort ${databaseViewSortFieldLabel(sort, properties)}`}
        disabled={busy}
        onClick={onDelete}
      />
    </div>
  );
}

function SortPopover({
  controller,
  properties,
  busy,
}: {
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dnd = useContinuousSortableDnd({ axis: "vertical", containerRef });
  const [activeId, setActiveId] = useState<string | null>(null);
  const visibleSorts = hasCustomDatabaseViewSort(controller.rules.sorts)
    ? controller.rules.sorts
    : [];
  const ids = visibleSorts.map(sortKey);
  const setVisibleSorts = (sorts: readonly DatabaseViewSort[]) => controller.setSorts(sorts);
  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    if (!event.over || event.active.id === event.over.id) return;
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    setVisibleSorts(arrayMove([...visibleSorts], from, to));
  };
  const availableFields = [
    {
      value: "title",
      label: (
        <span className="flex items-center gap-1.5">
          <NamePropertyIcon className="size-4 shrink-0 text-token-text-secondary" /> Name
        </span>
      ),
      searchText: "Name",
    },
    {
      value: "created",
      label: (
        <span className="flex items-center gap-1.5">
          <ClockIcon className="size-4 shrink-0 text-token-text-secondary" /> Created time
        </span>
      ),
      searchText: "Created time",
    },
    ...properties
      .filter((property) => property.lifecycle === "active" && property.capabilities.sortable)
      .map((property) => ({
        value: `property:${property.propertyId}`,
        label: <DatabaseRulePropertyLabel property={property} />,
        searchText: property.name,
      })),
  ].filter((field) => !ids.includes(field.value));
  const activeSort = visibleSorts.find((sort) => sortKey(sort) === activeId) ?? null;
  return (
    <div className="w-max min-w-[360px] max-w-[calc(100vw-16px)] p-1">
      <DndContext
        sensors={dnd.sensors}
        collisionDetection={dnd.collisionDetection}
        modifiers={dnd.modifiers}
        onDragStart={(event: DragStartEvent) => setActiveId(String(event.active.id))}
        onDragCancel={() => setActiveId(null)}
        onDragEnd={handleDragEnd}
      >
        <div ref={containerRef} className="space-y-1">
          <SortableContext items={ids} strategy={verticalListSortingStrategy}>
            {visibleSorts.map((sort, index) => (
              <SortableSortRow
                key={sortKey(sort)}
                sort={sort}
                properties={properties}
                unavailableFieldKeys={new Set(ids.filter((id) => id !== sortKey(sort)))}
                busy={busy}
                onChange={(next) =>
                  setVisibleSorts(
                    visibleSorts.map((candidate, candidateIndex) =>
                      candidateIndex === index ? next : candidate,
                    ),
                  )
                }
                onDelete={() =>
                  setVisibleSorts(
                    visibleSorts.filter((_, candidateIndex) => candidateIndex !== index),
                  )
                }
              />
            ))}
          </SortableContext>
        </div>
        <ContinuousSortableDragOverlay>
          {activeSort ? (
            <div className="flex h-9 items-center rounded-lg bg-token-dropdown-background px-3 text-sm shadow-lg ring-[0.5px] ring-token-border">
              {databaseViewSortFieldLabel(activeSort, properties)}
            </div>
          ) : null}
        </ContinuousSortableDragOverlay>
      </DndContext>
      <div data-slot="sort-footer" className="pt-1">
        <DatabaseViewSelect
          ariaLabel="Add sort"
          search="filter"
          searchPlaceholder="Search sort fields…"
          value=""
          valueLabel={<SortFooterActionLabel icon={PlusIcon}>Add sort</SortFooterActionLabel>}
          disabled={busy || availableFields.length === 0}
          options={availableFields}
          onValueChange={(value) => {
            const field: DatabaseViewSort["field"] = value.startsWith("property:")
              ? { kind: "property", propertyId: value.slice("property:".length) }
              : value === "created"
                ? { kind: "created" }
                : { kind: "title" };
            setVisibleSorts([...visibleSorts, { field, direction: "asc", nulls: "last" }]);
          }}
          className="w-full border-0 text-token-text-secondary"
          chrome="transparent"
          size="sm"
          showChevron={false}
        />
        {visibleSorts.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            className={cn(MENU_ROW, "min-h-7 text-token-text-secondary")}
            onClick={() => setVisibleSorts([])}
          >
            <SortFooterActionLabel icon={DeleteIcon}>Delete sort</SortFooterActionLabel>
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface RulePropertyPickerOption {
  readonly key: string;
  readonly label: string;
  readonly Icon: ComponentType<{ className?: string }>;
  readonly onSelect: () => void;
}

type BaseUiMouseEvent = ReactMouseEvent<HTMLButtonElement> & {
  preventBaseUIHandler?: () => void;
};

function NamePropertyIcon({ className }: { readonly className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex items-center justify-center text-[11px] font-semibold tracking-[-0.08em]",
        className,
      )}
    >
      Aa
    </span>
  );
}

function RulePropertyPicker({
  title,
  inputPlaceholder,
  searchAriaLabel,
  emptyMessage,
  options,
  footer,
}: {
  readonly title: string;
  readonly inputPlaceholder: string;
  readonly searchAriaLabel: string;
  readonly emptyMessage: string;
  readonly options: readonly RulePropertyPickerOption[];
  readonly footer?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const candidates = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(normalizedQuery),
  );
  const showSearch = query.length > 0 || options.length > 6;
  return (
    <div className="w-72 p-1">
      <div className="px-2 py-1.5 text-sm font-medium text-token-foreground">{title}</div>
      {showSearch ? (
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={inputPlaceholder}
          aria-label={searchAriaLabel}
          className="mb-1 h-8 w-full rounded-lg border-[0.5px] border-token-border bg-token-input-background px-2 text-sm text-token-foreground outline-none placeholder:text-token-description-foreground focus:border-token-focus-border"
        />
      ) : null}
      <div className="max-h-72 overflow-y-auto">
        {candidates.map(({ key, label, Icon, onSelect }) => (
          <button key={key} type="button" className={MENU_ROW} onClick={onSelect}>
            <Icon className="size-4" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </button>
        ))}
        {candidates.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-token-description-foreground">
            {emptyMessage}
          </p>
        ) : null}
      </div>
      {footer}
    </div>
  );
}

function FilterPropertyPicker({
  controller,
  properties,
}: {
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
}) {
  const existing = new Set(
    controller.rules.propertyFilters.map((filter) => filter.clause.propertyId),
  );
  const candidates = properties.filter(
    (property) =>
      property.lifecycle === "active" &&
      !existing.has(property.propertyId) &&
      property.capabilities.filterOperators.length > 0,
  );
  const advancedCount = databaseViewFilterNodeRuleCount(controller.rules.advancedFilter);
  const openAdvancedFilter = () => {
    if (!controller.rules.advancedFilter) {
      const seedProperty =
        properties.find((property) => property.name.toLocaleLowerCase() === "name") ??
        properties.find(
          (property) =>
            property.lifecycle === "active" && property.capabilities.filterOperators.length > 0,
        );
      if (!seedProperty) return;
      const seedOperator = filterOperatorsForProperty(seedProperty).includes("text_contains")
        ? "text_contains"
        : (filterOperatorsForProperty(seedProperty)[0] ?? "is_empty");
      controller.setAdvancedFilter({
        kind: "group",
        operator: "and",
        children: [databaseFilterClauseWithOperator(seedProperty, seedOperator)],
      });
    }
    controller.editAdvancedFilter();
  };
  return (
    <RulePropertyPicker
      title="Add filter"
      inputPlaceholder="Filter by…"
      searchAriaLabel="Search filter properties"
      emptyMessage="No more filterable Properties"
      options={candidates.map((property) => ({
        key: property.propertyId,
        label: property.name,
        Icon: dataSourcePropertyIcon(property),
        onSelect: () => controller.addQuickFilter(property),
      }))}
      footer={
        <div className="mt-1 border-t-[0.5px] border-token-border/70 pt-1">
          <button
            type="button"
            className={MENU_ROW}
            disabled={properties.length === 0}
            onClick={openAdvancedFilter}
          >
            <FilterIcon className="size-4" />
            <span className="min-w-0 flex-1">Advanced filter</span>
            {advancedCount > 0 ? (
              <span className="text-token-description-foreground">{advancedCount}</span>
            ) : null}
          </button>
        </div>
      }
    />
  );
}

function SortPropertyPicker({
  controller,
  properties,
}: {
  readonly controller: DatabaseViewRulesController;
  readonly properties: readonly DataSourcePropertyRecordV2[];
}) {
  const existing = new Set(
    hasCustomDatabaseViewSort(controller.rules.sorts) ? controller.rules.sorts.map(sortKey) : [],
  );
  const candidates: RulePropertyPickerOption[] = [
    {
      key: "title",
      label: "Name",
      Icon: NamePropertyIcon,
      onSelect: () => controller.addSort({ kind: "title" }),
    },
    {
      key: "created",
      label: "Created time",
      Icon: ClockIcon,
      onSelect: () => controller.addSort({ kind: "created" }),
    },
    ...properties
      .filter((property) => property.lifecycle === "active" && property.capabilities.sortable)
      .map((property) => ({
        key: `property:${property.propertyId}`,
        label: property.name,
        Icon: dataSourcePropertyIcon(property),
        onSelect: () => controller.addSort({ kind: "property", propertyId: property.propertyId }),
      })),
  ].filter((option) => !existing.has(option.key));
  return (
    <RulePropertyPicker
      title="New sort"
      inputPlaceholder="Sort by…"
      searchAriaLabel="Search sort properties"
      emptyMessage="No more sortable Properties"
      options={candidates}
    />
  );
}

export function DatabaseViewRuleToolbarControls({
  controller,
  properties,
}: DatabaseViewRuleToolbarControlsProps) {
  const filterPickerOpen =
    controller.popover?.kind === "create_filter" && controller.popover.origin === "toolbar";
  const sortPickerOpen = controller.popover?.kind === "create_sort";
  return (
    <>
      <NodexPopover
        open={filterPickerOpen}
        onOpenChange={(open) =>
          controller.setPopoverOpen({ kind: "create_filter", origin: "toolbar" }, open)
        }
      >
        <NodexPopoverTrigger>
          <NodexIconButton
            icon={FilterIcon}
            size="sm"
            active={databaseViewRulesHaveVisibleFilters(controller.rules) || filterPickerOpen}
            ariaLabel="Filter View"
            aria-expanded={filterPickerOpen}
            aria-haspopup="dialog"
            title="Filter"
            onClick={(event: BaseUiMouseEvent) => {
              event.preventBaseUIHandler?.();
              controller.invokeFilterToolbar();
            }}
          />
        </NodexPopoverTrigger>
        <NodexPopoverContent className="w-72 p-0" align="start">
          <FilterPropertyPicker controller={controller} properties={properties} />
        </NodexPopoverContent>
      </NodexPopover>
      <NodexPopover
        open={sortPickerOpen}
        onOpenChange={(open) => controller.setPopoverOpen({ kind: "create_sort" }, open)}
      >
        <NodexPopoverTrigger>
          <NodexIconButton
            icon={ArrowUpDown}
            size="sm"
            active={databaseViewRulesHaveVisibleSorts(controller.rules) || sortPickerOpen}
            ariaLabel="Sort View"
            aria-expanded={sortPickerOpen}
            aria-haspopup="dialog"
            title="Sort"
            onClick={(event: BaseUiMouseEvent) => {
              event.preventBaseUIHandler?.();
              controller.invokeSortToolbar();
            }}
          />
        </NodexPopoverTrigger>
        <NodexPopoverContent className="w-72 p-0" align="start">
          <SortPropertyPicker controller={controller} properties={properties} />
        </NodexPopoverContent>
      </NodexPopover>
    </>
  );
}

export function DatabaseViewRulesBar({
  controller,
  config,
  properties,
  optionRegistries = EMPTY_OPTIONS,
  onRequestPropertyOptions,
  accessContext,
}: DatabaseViewRulesBarProps) {
  const {
    filtersPersonal,
    sortsPersonal,
    busy,
    error,
    reset: onReset,
    publish: onPublish,
  } = controller;
  const quickContainerRef = useRef<HTMLDivElement | null>(null);
  const dnd = useContinuousSortableDnd({ axis: "horizontal", containerRef: quickContainerRef });
  const [activeFilterId, setActiveFilterId] = useState<string | null>(null);
  const [pointerActionPreview, setPointerActionPreview] = useState<PersonalRuleActionKind | null>(
    null,
  );
  const [focusActionPreview, setFocusActionPreview] = useState<PersonalRuleActionKind | null>(null);
  if (!controller.barOpen) return null;

  const customSort = hasCustomDatabaseViewSort(controller.rules.sorts);
  const primarySort = customSort ? (controller.rules.sorts[0] ?? null) : null;
  const advancedCount = databaseViewFilterNodeRuleCount(controller.rules.advancedFilter);
  const quickIds = controller.rules.propertyFilters.map((filter) => filter.filterId);
  const activeFilter =
    controller.rules.propertyFilters.find((filter) => filter.filterId === activeFilterId) ?? null;
  const personal = filtersPersonal || sortsPersonal;
  const actionPreview = personal ? (pointerActionPreview ?? focusActionPreview) : null;
  const personalRuleBranches = compactDatabaseViewRulesOverride(config.rules, controller.rules);
  const sortActionPreview =
    actionPreview && sortsPersonal && personalRuleBranches?.sorts !== undefined
      ? actionPreview
      : undefined;
  const advancedFilterActionPreview =
    actionPreview && filtersPersonal && personalRuleBranches?.advancedFilter !== undefined
      ? actionPreview
      : undefined;
  const quickFilterActionPreview =
    actionPreview && filtersPersonal && personalRuleBranches?.propertyFilters !== undefined
      ? actionPreview
      : undefined;
  const personalScopes: readonly DatabaseViewRuleScope[] =
    filtersPersonal && sortsPersonal
      ? ["filters", "sorts", "all"]
      : filtersPersonal
        ? ["filters"]
        : ["sorts"];
  const advancedConfig: DatabaseViewConfigV6 = {
    ...config,
    rules: { ...controller.rules, advancedFilter: controller.rules.advancedFilter },
  };
  const handleQuickDragEnd = (event: DragEndEvent) => {
    setActiveFilterId(null);
    if (!event.over || event.active.id === event.over.id) return;
    const from = quickIds.indexOf(String(event.active.id));
    const to = quickIds.indexOf(String(event.over.id));
    if (from < 0 || to < 0) return;
    controller.reorderQuickFilters(arrayMove(quickIds, from, to));
  };
  const switchPopoverOnPointerDown = (
    event: ReactPointerEvent,
    target: Exclude<DatabaseViewRulesController["popover"], null>,
  ) => {
    const current = controller.popover;
    if (!current) return;
    const sameTarget =
      current.kind === target.kind &&
      (current.kind === "quick_filter"
        ? target.kind === "quick_filter" && current.filterId === target.filterId
        : current.kind === "create_filter"
          ? target.kind === "create_filter" && current.origin === target.origin
          : true);
    if (sameTarget) return;
    event.preventDefault();
    controller.setPopoverOpen(target, true);
  };
  const handleActionPreviewChange = (
    source: PersonalRulePreviewSource,
    kind: PersonalRuleActionKind | null,
  ) => {
    if (source === "pointer") {
      setPointerActionPreview(kind);
      return;
    }
    setFocusActionPreview(kind);
  };

  return (
    <div
      data-testid="database-view-rules-bar"
      data-pulse={controller.pulse}
      className="relative animate-in border-t-[0.5px] border-token-border/60 pt-1 fade-in-0 slide-in-from-top-1 duration-200 motion-reduce:duration-[1ms]"
    >
      {controller.pulse > 0 ? (
        <span
          key={controller.pulse}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 animate-[pulse_1.2s_ease-in-out_1] bg-[color-mix(in_srgb,var(--accent-blue)_6%,transparent)]"
        />
      ) : null}
      <div className="flex min-h-8 items-center gap-1.5 px-3 pb-1">
        <NodexPopover
          open={controller.popover?.kind === "sort"}
          onOpenChange={(open) => controller.setPopoverOpen({ kind: "sort" }, open)}
        >
          {customSort && primarySort ? (
            <NodexPopoverTrigger>
              <RuleToken
                aria-label="Edit sorts"
                actionPreview={sortActionPreview}
                onPointerDown={(event) => switchPopoverOnPointerDown(event, { kind: "sort" })}
              >
                {controller.rules.sorts.length === 1 ? (
                  primarySort.direction === "asc" ? (
                    <SortAscendingIcon className="size-3.5" />
                  ) : (
                    <SortDescendingIcon className="size-3.5" />
                  )
                ) : (
                  <ArrowUpDown className="size-3.5" />
                )}
                <span className="max-w-44 truncate">
                  {controller.rules.sorts.length === 1
                    ? databaseViewSortFieldLabel(primarySort, properties)
                    : `${controller.rules.sorts.length} sorts`}
                </span>
                <ChevronDownIcon className="size-3" />
              </RuleToken>
            </NodexPopoverTrigger>
          ) : controller.popover?.kind === "sort" ? (
            <NodexPopoverAnchor>
              <span className="size-px" aria-hidden="true" />
            </NodexPopoverAnchor>
          ) : null}
          <NodexPopoverContent
            className="w-max min-w-[360px] max-w-[calc(100vw-16px)] p-0"
            align="start"
          >
            <SortPopover controller={controller} properties={properties} busy={busy} />
          </NodexPopoverContent>
        </NodexPopover>

        {customSort && (advancedCount > 0 || quickIds.length > 0) ? (
          <div className="h-5 w-px shrink-0 bg-token-border" />
        ) : null}

        <NodexPopover
          open={controller.popover?.kind === "advanced_filter"}
          onOpenChange={(open) => controller.setPopoverOpen({ kind: "advanced_filter" }, open)}
        >
          {advancedCount > 0 ? (
            <NodexPopoverTrigger>
              <RuleToken
                aria-label="Edit advanced filter"
                actionPreview={advancedFilterActionPreview}
                onPointerDown={(event) =>
                  switchPopoverOnPointerDown(event, { kind: "advanced_filter" })
                }
              >
                <FilterIcon className="size-3.5" />
                <span>
                  {advancedCount} {advancedCount === 1 ? "rule" : "rules"}
                </span>
                <ChevronDownIcon className="size-3" />
              </RuleToken>
            </NodexPopoverTrigger>
          ) : controller.popover?.kind === "advanced_filter" ? (
            <NodexPopoverAnchor>
              <span className="size-px" aria-hidden="true" />
            </NodexPopoverAnchor>
          ) : null}
          <NodexPopoverContent
            className="w-max max-w-[calc(100vw-16px)] overflow-hidden p-0"
            align="start"
          >
            <DatabaseViewAdvancedFilterEditor
              config={advancedConfig}
              properties={properties}
              optionRegistries={optionRegistries}
              onRequestPropertyOptions={onRequestPropertyOptions}
              accessContext={accessContext}
              disabled={busy}
              onChange={(next) => controller.setAdvancedFilter(next.rules.advancedFilter)}
            />
            <div className="border-t-[0.5px] border-token-border/70 p-1">
              <button
                type="button"
                disabled={busy}
                className={cn(MENU_ROW, "text-token-error-foreground")}
                onClick={() => controller.setAdvancedFilter(null)}
              >
                <DeleteIcon className="size-4" />
                <span>Delete filter</span>
              </button>
            </div>
          </NodexPopoverContent>
        </NodexPopover>

        <DndContext
          sensors={dnd.sensors}
          collisionDetection={dnd.collisionDetection}
          modifiers={dnd.modifiers}
          onDragStart={(event) => setActiveFilterId(String(event.active.id))}
          onDragCancel={() => setActiveFilterId(null)}
          onDragEnd={handleQuickDragEnd}
        >
          <div
            ref={quickContainerRef}
            className="hide-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto"
          >
            <SortableContext items={quickIds} strategy={horizontalListSortingStrategy}>
              {controller.rules.propertyFilters.map((filter) => (
                <SortableQuickFilterToken
                  key={filter.filterId}
                  filter={filter}
                  controller={controller}
                  properties={properties}
                  optionRegistries={optionRegistries}
                  onRequestPropertyOptions={onRequestPropertyOptions}
                  accessContext={accessContext}
                  busy={busy}
                  actionPreview={quickFilterActionPreview}
                />
              ))}
            </SortableContext>
          </div>
          <ContinuousSortableDragOverlay>
            {activeFilter ? (
              <div className={TOKEN_CLASS}>
                {properties.find(
                  (property) => property.propertyId === activeFilter.clause.propertyId,
                )?.name ?? "Filter"}
              </div>
            ) : null}
          </ContinuousSortableDragOverlay>
        </DndContext>

        <NodexPopover
          open={controller.popover?.kind === "create_filter" && controller.popover.origin === "bar"}
          onOpenChange={(open) =>
            controller.setPopoverOpen({ kind: "create_filter", origin: "bar" }, open)
          }
        >
          <NodexPopoverTrigger>
            <button
              type="button"
              onPointerDown={(event) =>
                switchPopoverOnPointerDown(event, { kind: "create_filter", origin: "bar" })
              }
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
            >
              <PlusIcon className="size-3.5" /> Filter
            </button>
          </NodexPopoverTrigger>
          <NodexPopoverContent className="w-72 p-0" align="start">
            <FilterPropertyPicker controller={controller} properties={properties} />
          </NodexPopoverContent>
        </NodexPopover>

        <div
          data-testid="database-view-rules-bar-tail"
          className="ml-auto flex shrink-0 items-center gap-0.5"
        >
          {personal ? (
            <>
              <PersonalRuleAction
                kind="reset"
                scopes={personalScopes}
                busy={busy}
                onAction={onReset}
                onPreviewChange={handleActionPreviewChange}
              />
              <PersonalRuleAction
                kind="publish"
                scopes={personalScopes}
                busy={busy}
                onAction={onPublish}
                onPreviewChange={handleActionPreviewChange}
              />
            </>
          ) : null}
          <NodexIconButton
            icon={CloseIcon}
            size="xs"
            ariaLabel="Close filter and sort bar"
            onClick={() => controller.setBarOpen(false)}
          />
        </div>
      </div>
      {error ? (
        <p
          role="alert"
          className="border-t-[0.5px] border-token-border/55 px-3 py-1.5 text-xs text-token-error-foreground"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

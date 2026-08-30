import {
  DndContext,
  type DragEndEvent,
  type DragStartEvent,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  startTransition,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type FormEvent,
  type ReactNode,
} from "react";

import {
  BoardIcon,
  ChevronRightIcon,
  CloseIcon,
  CopyIcon,
  DatabaseIcon,
  DeleteIcon,
  DragHandleDotsIcon,
  ListLayoutIcon,
  MoreActionsIcon,
  MoveDownIcon,
  MoveUpIcon,
  PlusIcon,
  TagsIcon,
  VisibilityIcon,
  VisibilityOffIcon,
} from "@/components/shared/icons";
import { ChevronLeft, Rows3, SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import { NodexButton, NodexIconButton, NodexSwitch } from "@/components/ui/button";
import {
  ContinuousSortableDragOverlay,
  useContinuousSortable,
  useContinuousSortableDnd,
} from "@/components/ui/continuous-sortable";
import { NodexContextMenuRoot, NodexContextMenuTrigger } from "@/components/ui/context-menu";
import { Input, NodexCompactFramedInput } from "@/components/ui/input";
import { databasePropertyOptionDotColor } from "@/components/database/property-value-chip";
import { SemanticPropertyOptionIcon } from "@/components/database/semantic-property-editors";
import {
  DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
  databaseViewDisplayFromPropertyVisibilityKeys,
  moveDatabaseViewPropertyToSortableTarget,
  normalizedDatabaseViewPropertyOrder,
  toggleDatabaseViewPropertyVisibility,
} from "@/lib/database-view-property-visibility";
import {
  changeDatabaseViewLayoutOperation,
  createDataSourcePropertyOperation,
  createDatabaseViewOperation,
  changeDataSourcePropertyTypeOperation,
  deleteDataSourcePropertyOperations,
  duplicateDataSourcePropertyOperation,
  moveDataSourcePropertyOperation,
  permanentlyDeleteDataSourcePropertyOperation,
  putDataSourcePropertyOperation,
  putDatabaseViewOperation,
  restoreDataSourcePropertyOperation,
} from "@/lib/database-settings-operations";
import type { DatabaseViewRenderModel } from "@/lib/database-view-render-model";
import type { DatabaseViewPresentationActivity } from "@/lib/database-view-presentation-activity";
import { cn } from "@/lib/utils";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import type {
  DatabasePropertySchemaV2,
  DatabasePagePropertyVisibilityV2,
  DatabaseViewRecordV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import type {
  DatabasePropertyOption,
  DatabasePropertyFilterOperator,
  DatabasePropertyValueType,
  DatabaseViewCompletedRange,
  DatabaseViewConditionalColorRule,
  DatabaseViewFilterClause,
  DatabaseViewFilterOperator,
  DatabaseViewLayout,
  EffectiveDatabaseView,
} from "../../../../shared/database-kernel";
import {
  createCustomOptionId,
  parseDataSourceOptionId,
  parseDatabaseViewId,
  type DataSourceId,
} from "../../../../shared/database-identities";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import {
  DATA_SOURCE_PROPERTY_TYPE_LABELS,
  dataSourcePropertyIcon,
  dataSourcePropertyTypeIcon,
} from "../../database/data-source-property-presentation";
import { DatabaseViewSelect } from "../database-view-select";
import {
  DatabaseViewFilterValueField,
  FILTER_OPERATOR_LABELS,
} from "../database-view-filter-editors";
import {
  createDatabaseViewFilterClause,
  databaseFilterClauseWithOperator,
  databaseFilterClauseWithProperty,
  filterOperatorsForProperty,
  readDatabasePropertyOptions,
} from "@/lib/database-view-authoring";
import type { DatabaseSettingsRuntime } from "./use-database-settings-runtime";
import {
  DatabaseViewActionMenuOverlay,
  type DatabaseViewActionMenuSession,
} from "../database-view-action-menu";
import { DatabaseViewChangeAction } from "../database-view-change-action";
import {
  databaseSettingsRouteTitle,
  type DatabaseSettingsRoute,
  type DatabaseSettingsRouteStack,
} from "./database-settings-route";

const PROPERTY_TYPES = Object.entries(DATA_SOURCE_PROPERTY_TYPE_LABELS).map(([value, label]) => ({
  value: value as DatabasePropertyValueType,
  label,
}));

const OPTION_COLORS = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
] as const;

const NUMBER_FORMAT_OPTIONS = [
  { value: "plain", label: "Number" },
  { value: "percent", label: "Percent" },
  { value: "usd", label: "US dollar" },
  { value: "eur", label: "Euro" },
  { value: "gbp", label: "British pound" },
  { value: "jpy", label: "Japanese yen" },
  { value: "cny", label: "Chinese yuan" },
] as const;

const DATE_FORMAT_OPTIONS = [
  { value: "full", label: "Full date" },
  { value: "month_day_year", label: "Month / day / year" },
  { value: "day_month_year", label: "Day / month / year" },
  { value: "year_month_day", label: "Year / month / day" },
  { value: "relative", label: "Relative" },
] as const;

const TIME_FORMAT_OPTIONS = [
  { value: "twelve_hour", label: "12 hour" },
  { value: "twenty_four_hour", label: "24 hour" },
] as const;

const numberFormatValue = (
  schema: Extract<DatabasePropertySchemaV2, { readonly kind: "number" }>,
): (typeof NUMBER_FORMAT_OPTIONS)[number]["value"] =>
  schema.format.kind === "currency" ? schema.format.currencyCode : schema.format.kind;

const propertySchemaForType = (
  type: DatabasePropertyValueType,
  relationTargetDataSourceId: DataSourceId,
  relationCardinality: "one" | "many" = "many",
): DatabasePropertySchemaV2 => {
  if (type === "relation") {
    return {
      kind: "relation",
      targetDataSourceId: relationTargetDataSourceId,
      cardinality: relationCardinality,
    };
  }
  if (type === "number") return { kind: "number", format: { kind: "plain" } };
  if (type === "date") return { kind: "date", dateFormat: "full" };
  if (type === "datetime") {
    return { kind: "datetime", dateFormat: "full", timeFormat: "twelve_hour" };
  }
  return { kind: type };
};

const viewLayoutIcon = (layout: DatabaseViewLayout): ComponentType<{ className?: string }> =>
  layout === "board" ? BoardIcon : ListLayoutIcon;

function RailSection({
  title,
  children,
  divided = false,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly divided?: boolean;
}) {
  return (
    <section className="pb-2">
      {divided ? <div className="mx-2 mt-2 border-t-[0.5px] border-token-border/65" /> : null}
      <h3
        className={cn(
          "mx-2 mb-2 px-2 text-xs font-medium leading-[14px] text-token-description-foreground",
          divided ? "pt-3" : "pt-1",
        )}
      >
        {title}
      </h3>
      <div>{children}</div>
    </section>
  );
}

function RailRow({
  icon: Icon,
  label,
  value,
  disabled = false,
  muted = false,
  trailing,
  onClick,
}: {
  readonly icon?: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly value?: ReactNode;
  readonly disabled?: boolean;
  readonly muted?: boolean;
  readonly trailing?: ReactNode;
  readonly onClick?: () => void;
}) {
  const content = (
    <>
      {Icon ? (
        <Icon className="icon-xs shrink-0 text-current" />
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value ? (
        <span className="max-w-[44%] truncate text-sm text-token-text-secondary">{value}</span>
      ) : null}
      {trailing}
      {onClick ? (
        <ChevronRightIcon className="icon-xs shrink-0 text-token-description-foreground" />
      ) : null}
    </>
  );
  if (!onClick) {
    return (
      <div
        className={cn(
          "mx-2 flex h-7 items-center gap-2 rounded-md px-2 text-left text-sm leading-[16.8px]",
          muted ? "text-token-description-foreground" : "text-token-text-primary",
          disabled && "opacity-45",
        )}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left text-sm leading-[16.8px] outline-none",
        "hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-token-focus-border/60",
        muted ? "text-token-description-foreground" : "text-token-text-primary",
        disabled && "cursor-not-allowed opacity-45 hover:bg-transparent",
      )}
    >
      {content}
    </button>
  );
}

function InlineNameEditor({
  value,
  label,
  busy,
  variant = "inline",
  focusRequest = 0,
  onCommit,
}: {
  readonly value: string;
  readonly label: string;
  readonly busy: boolean;
  readonly variant?: "inline" | "framed";
  readonly focusRequest?: number;
  readonly onCommit: (value: string) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    if (focusRequest <= 0) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest]);
  const commit = () => {
    const normalized = draft.trim();
    if (!normalized || normalized === value) {
      setDraft(value);
      return;
    }
    void onCommit(normalized);
  };
  const NameInput = variant === "framed" ? NodexCompactFramedInput : Input;
  return (
    <NameInput
      ref={inputRef}
      aria-label={label}
      value={draft}
      disabled={busy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key !== "Escape") return;
        event.preventDefault();
        setDraft(value);
        event.currentTarget.blur();
      }}
      className={
        variant === "inline"
          ? "h-7 rounded-md border-transparent bg-transparent px-1.5 text-sm shadow-none hover:bg-token-foreground/5 focus:bg-transparent focus:ring-1 focus:ring-token-focus-border"
          : undefined
      }
    />
  );
}

function CreateViewRoute({
  runtime,
  onSelectView,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly onSelectView: (viewId: string, title: string) => void;
}) {
  const authority = runtime.authority;
  const [name, setName] = useState("New view");
  const [layout, setLayout] = useState<DatabaseViewLayout>("list");
  const [dataSourceId, setDataSourceId] = useState<DataSourceId | null>(
    authority?.dataSource.dataSourceId ?? null,
  );
  if (!authority || !dataSourceId) return null;
  const activeSources = authority.database.dataSources.filter(
    (source) => source.lifecycle === "active",
  );
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized = name.trim();
    if (!normalized) return;
    const viewId = parseDatabaseViewId(createUuidV7());
    const next = await runtime.mutate({
      pendingKey: `create-view:${viewId}`,
      preferredViewId: viewId,
      buildOperations: (current) => [
        createDatabaseViewOperation({
          databaseId: current.database.database.databaseId,
          dataSourceId,
          viewId,
          name: normalized,
          layout,
        }),
      ],
    });
    const created = next?.database.views.find((view) => view.viewId === viewId);
    if (created) onSelectView(created.viewId, created.name);
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="px-3 py-3">
      <label className="block text-xs font-medium text-token-description-foreground">
        Name
        <Input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="mt-1.5 h-8 text-[13px]"
        />
      </label>
      <div className="mt-4 text-xs font-medium text-token-description-foreground">Layout</div>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        {(["list", "board"] as const).map((candidate) => {
          const Icon = viewLayoutIcon(candidate);
          return (
            <button
              key={candidate}
              type="button"
              aria-pressed={layout === candidate}
              onClick={() => setLayout(candidate)}
              className={cn(
                "flex h-9 items-center gap-2 rounded-md px-2 text-[13px] outline-none ring-[0.5px] ring-inset",
                layout === candidate
                  ? "bg-token-foreground/7 text-token-text-primary ring-token-border-heavy"
                  : "text-token-text-secondary ring-token-border hover:bg-token-foreground/5",
              )}
            >
              <Icon className="size-4" />
              {candidate === "list" ? "List" : "Board"}
            </button>
          );
        })}
      </div>
      {activeSources.length > 1 ? (
        <div className="mt-4">
          <div className="mb-1.5 text-xs font-medium text-token-description-foreground">
            Data source
          </div>
          <DatabaseViewSelect
            ariaLabel="Data source"
            value={dataSourceId}
            valueLabel={
              activeSources.find((source) => source.dataSourceId === dataSourceId)?.name ??
              "Data source"
            }
            onValueChange={(value) => setDataSourceId(value as DataSourceId)}
            options={activeSources.map((source) => ({
              value: source.dataSourceId,
              label: source.name,
            }))}
            className="w-full"
          />
        </div>
      ) : null}
      <NodexButton
        type="submit"
        size="sm"
        className="mt-5 w-full"
        disabled={!name.trim() || runtime.pendingKey !== null}
      >
        {runtime.pendingKey?.startsWith("create-view:") ? "Creating…" : "Create view"}
      </NodexButton>
    </form>
  );
}

function ViewOverview({
  runtime,
  activeView,
  push,
  onSelectView,
  onProjectionCommitted,
  viewNameFocusRequest,
  viewActionMenu,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly activeView: DatabaseViewRecordV2;
  readonly push: (route: DatabaseSettingsRoute) => void;
  readonly onSelectView: (viewId: string, title: string) => void;
  readonly onProjectionCommitted: () => void | Promise<void>;
  readonly viewNameFocusRequest: number;
  readonly viewActionMenu?: DatabaseViewActionMenuSession;
}) {
  const authority = runtime.authority!;
  const [actionsOpen, setActionsOpen] = useState(false);
  const mutateView = async (
    pendingKey: string,
    view: DatabaseViewRecordV2,
    operation: ReturnType<typeof putDatabaseViewOperation>,
  ) => {
    const next = await runtime.mutate({
      pendingKey,
      preferredViewId: view.viewId,
      buildOperations: () => [operation],
    });
    if (next) void onProjectionCommitted();
    return next;
  };
  const ActiveViewIcon = viewLayoutIcon(activeView.layout);
  return (
    <>
      <div
        className="mx-2 flex h-11 items-center gap-2 px-2"
        data-testid="database-settings-view-identity"
      >
        <div
          className="-ml-1 flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-primary ring-[0.5px] ring-inset ring-token-border"
          data-testid="database-settings-view-identity-icon"
        >
          <ActiveViewIcon className="icon-xs" />
        </div>
        <div className="min-w-0 flex-1">
          <InlineNameEditor
            label="View name"
            value={activeView.name}
            busy={runtime.pendingKey !== null}
            variant="framed"
            focusRequest={viewNameFocusRequest}
            onCommit={async (name) => {
              const next = await mutateView(
                `rename-view:${activeView.viewId}`,
                activeView,
                putDatabaseViewOperation(activeView, { name }),
              );
              const renamed = next?.database.views.find(
                (view) => view.viewId === activeView.viewId,
              );
              if (renamed) onSelectView(renamed.viewId, renamed.name);
            }}
          />
        </div>
        {viewActionMenu ? (
          <NodexContextMenuRoot open={actionsOpen} onOpenChange={setActionsOpen}>
            <NodexContextMenuTrigger>
              <button
                type="button"
                aria-label="View actions"
                aria-expanded={actionsOpen}
                className="flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border/60"
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  event.currentTarget.dispatchEvent(
                    new MouseEvent("contextmenu", {
                      bubbles: true,
                      cancelable: true,
                      clientX: rect.left,
                      clientY: rect.bottom,
                    }),
                  );
                }}
              >
                <MoreActionsIcon className="icon-xs" />
              </button>
            </NodexContextMenuTrigger>
            <DatabaseViewActionMenuOverlay
              session={viewActionMenu}
              onMenuOpenChange={setActionsOpen}
            />
          </NodexContextMenuRoot>
        ) : null}
      </div>
      <div className="pb-2">
        <RailRow
          icon={viewLayoutIcon(activeView.layout)}
          label="Layout"
          value={activeView.layout === "board" ? "Board" : "List"}
          onClick={() => push({ kind: "view_layout", viewId: activeView.viewId })}
        />
        <RailRow
          icon={VisibilityIcon}
          label="Property visibility"
          value={`${1 + activeView.config.presentation.display.fields.filter((field) => field.kind === "property").length}`}
          onClick={() => push({ kind: "view_properties", viewId: activeView.viewId })}
        />
        <RailRow
          icon={SlidersHorizontal}
          label="Group"
          value={
            activeView.config.presentation.group
              ? (authority.source.properties.find(
                  (property) =>
                    property.propertyId === activeView.config.presentation.group?.propertyId,
                )?.name ?? "Grouped")
              : "Not grouped"
          }
          onClick={() => push({ kind: "view_group", viewId: activeView.viewId })}
        />
        <RailRow
          icon={SlidersHorizontal}
          label="Sub-group"
          value={
            activeView.config.presentation.subgroup
              ? (authority.source.properties.find(
                  (property) =>
                    property.propertyId === activeView.config.presentation.subgroup?.propertyId,
                )?.name ?? "Sub-grouped")
              : "None"
          }
          onClick={() => push({ kind: "view_subgroup", viewId: activeView.viewId })}
        />
        <RailRow
          icon={TagsIcon}
          label="Conditional color"
          value={`${activeView.config.presentation.conditionalColors.length}`}
          onClick={() => push({ kind: "view_conditional_color", viewId: activeView.viewId })}
        />
        <RailRow
          icon={CopyIcon}
          label="Copy link to view"
          disabled={!viewActionMenu || runtime.pendingKey !== null}
          onClick={() => void viewActionMenu?.onCopyLink()}
        />
      </div>

      <RailSection title="Data source settings" divided>
        <RailRow icon={DatabaseIcon} label="Source" value={authority.dataSource.name} />
        <RailRow
          icon={TagsIcon}
          label="Edit properties"
          value={`${authority.source.properties.filter((property) => property.lifecycle === "active").length}`}
          onClick={() =>
            push({ kind: "source_properties", dataSourceId: authority.dataSource.dataSourceId })
          }
        />
        <RailRow
          icon={Rows3}
          label="Customize page layout"
          onClick={() =>
            push({ kind: "page_layout", dataSourceId: authority.dataSource.dataSourceId })
          }
        />
      </RailSection>
    </>
  );
}

function ViewLayoutRoute({
  runtime,
  onProjectionCommitted,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly onProjectionCommitted: () => void | Promise<void>;
}) {
  const view = runtime.authority?.view;
  const [pendingLayout, setPendingLayout] = useState<DatabaseViewRecordV2["layout"] | null>(null);
  if (!view) return null;
  return (
    <div className="py-2">
      <div className="grid grid-cols-3 gap-2 px-2">
        {(["list", "board"] as const).map((layout) => {
          const Icon = viewLayoutIcon(layout);
          return (
            <button
              key={layout}
              type="button"
              aria-label={layout === "list" ? "List" : "Board"}
              aria-pressed={view.layout === layout}
              disabled={runtime.pendingKey !== null}
              onClick={() => {
                if (view.layout === layout) return;
                setPendingLayout(layout);
              }}
              className={cn(
                "flex h-14 flex-col items-center justify-center gap-1 rounded-md px-1 text-[11px] leading-4 outline-none ring-[0.5px] ring-inset",
                "hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus-border/60",
                view.layout === layout
                  ? "bg-token-primary/10 text-token-primary ring-token-primary"
                  : "text-token-description-foreground ring-token-border",
              )}
            >
              <Icon className="icon-sm" />
              <span>{layout === "list" ? "List" : "Board"}</span>
            </button>
          );
        })}
      </div>
      {pendingLayout ? (
        <div className="mx-2 mt-3 border-t-[0.5px] border-token-border/70 px-2 pt-3">
          <p className="text-xs leading-5 text-token-description-foreground">
            Convert to {pendingLayout === "board" ? "Board" : "List"}? Settings that only apply to
            {view.layout === "board" ? " Board" : " List"} will be discarded.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <NodexButton size="sm" variant="ghost" onClick={() => setPendingLayout(null)}>
              Cancel
            </NodexButton>
            <NodexButton
              size="sm"
              onClick={async () => {
                const next = await runtime.mutate({
                  pendingKey: `layout:${view.viewId}`,
                  preferredViewId: view.viewId,
                  buildOperations: () => [changeDatabaseViewLayoutOperation(view, pendingLayout)],
                });
                if (!next) return;
                setPendingLayout(null);
                void onProjectionCommitted();
              }}
            >
              Convert
            </NodexButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PropertyVisibilityRowContent({
  property,
  visible,
  busy,
  canReorder,
  overlay = false,
  dragListeners,
  setActivatorNodeRef,
  onToggle,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly visible: boolean;
  readonly busy: boolean;
  readonly canReorder: boolean;
  readonly overlay?: boolean;
  readonly dragListeners?: DraggableSyntheticListeners;
  readonly setActivatorNodeRef?: (element: HTMLElement | null) => void;
  readonly onToggle?: () => void;
}) {
  const Icon = dataSourcePropertyIcon(property);
  const propertyId = String(property.propertyId);
  const VisibilityStateIcon = visible ? VisibilityIcon : VisibilityOffIcon;
  return (
    <>
      <span
        ref={setActivatorNodeRef}
        data-property-drag-handle={propertyId}
        {...(canReorder ? dragListeners : undefined)}
        className={cn(
          "flex h-6 w-[18px] shrink-0 touch-none items-center justify-center rounded",
          canReorder
            ? overlay
              ? "cursor-grabbing text-token-text-primary"
              : "cursor-grab text-token-description-foreground active:cursor-grabbing"
            : "cursor-default text-token-description-foreground/50",
        )}
      >
        <DragHandleDotsIcon className="icon-2xs" />
      </span>
      <Icon className="ml-1 icon-xs shrink-0 text-token-text-primary" />
      <span className="ml-2 min-w-0 flex-1 truncate text-token-text-primary">{property.name}</span>
      {overlay ? (
        <span
          aria-hidden
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            visible ? "text-token-text-primary" : "text-token-description-foreground",
          )}
        >
          <VisibilityStateIcon className="size-4" />
        </span>
      ) : (
        <button
          type="button"
          aria-label={`${visible ? "Hide" : "Show"} ${property.name}`}
          disabled={busy}
          onClick={onToggle}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-token-foreground/5",
            visible ? "text-token-text-primary" : "text-token-description-foreground",
          )}
        >
          <VisibilityStateIcon className="size-4" />
        </button>
      )}
    </>
  );
}

function SortablePropertyVisibilityRow({
  property,
  visible,
  busy,
  canReorder,
  onToggle,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly visible: boolean;
  readonly busy: boolean;
  readonly canReorder: boolean;
  readonly onToggle: () => void;
}) {
  const propertyId = String(property.propertyId);
  const sortable = useContinuousSortable({ id: propertyId, disabled: !canReorder });
  return (
    <div
      ref={sortable.setNodeRef}
      style={sortable.style}
      data-property-id={property.propertyId}
      data-property-sortable={property.propertyId}
      data-property-dragging={sortable.isDragging ? "true" : "false"}
      className={cn(
        "mx-2 flex h-7 items-center rounded-md px-1 text-sm leading-[16.8px] hover:bg-token-foreground/5",
        sortable.isDragging && "opacity-0",
      )}
    >
      <PropertyVisibilityRowContent
        property={property}
        visible={visible}
        busy={busy}
        canReorder={canReorder}
        dragListeners={sortable.listeners}
        setActivatorNodeRef={sortable.setActivatorNodeRef}
        onToggle={onToggle}
      />
    </div>
  );
}

function SortablePropertyVisibilityBoundary({
  disabled,
  children,
}: {
  readonly disabled: boolean;
  readonly children: ReactNode;
}) {
  const sortable = useContinuousSortable({
    id: DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
    disabled,
  });
  return (
    <div ref={sortable.setNodeRef} style={sortable.style} data-property-visibility-boundary="true">
      {children}
    </div>
  );
}

function PropertyVisibilityDragOverlay({
  property,
  visible,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly visible: boolean;
}) {
  return (
    <div
      className="flex h-7 w-full items-center rounded-md bg-token-main-surface-primary px-1 text-sm leading-[16.8px] shadow-[0_4px_12px_rgb(0_0_0/0.18)] ring-[0.5px] ring-token-border"
      data-property-visibility-drag-overlay={property.propertyId}
    >
      <PropertyVisibilityRowContent property={property} visible={visible} busy canReorder overlay />
    </div>
  );
}

function ViewPropertiesRoute({
  effective,
  properties,
  busy,
  onChange,
  personalActions,
}: {
  readonly effective: EffectiveDatabaseView;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy: boolean;
  readonly onChange: (next: EffectiveDatabaseView) => void;
  readonly personalActions: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const [draggedPropertyId, setDraggedPropertyId] = useState<string | null>(null);
  const [dragOverPropertyId, setDragOverPropertyId] = useState<string | null>(null);
  const propertyListRef = useRef<HTMLDivElement | null>(null);
  const propertyDnd = useContinuousSortableDnd({
    axis: "vertical",
    containerRef: propertyListRef,
  });
  const activeProperties = properties.filter((property) => property.lifecycle === "active");
  const activePropertyIds = activeProperties.map((property) => String(property.propertyId));
  const propertyById = new Map(
    activeProperties.map((property) => [String(property.propertyId), property]),
  );
  const display = effective.presentation.display;
  const fields = display.fields;
  const propertyOrder = normalizedDatabaseViewPropertyOrder(display, activePropertyIds);
  const visiblePropertyIds = new Set(
    fields.flatMap((field) => (field.kind === "property" ? [String(field.propertyId)] : [])),
  );
  const orderedProperties = propertyOrder.flatMap((propertyId) => {
    const property = propertyById.get(propertyId);
    return property ? [property] : [];
  });
  const shownProperties = orderedProperties.filter((property) =>
    visiblePropertyIds.has(String(property.propertyId)),
  );
  const shown = new Set(shownProperties.map((property) => String(property.propertyId)));
  const hiddenProperties = orderedProperties.filter(
    (property) => !visiblePropertyIds.has(String(property.propertyId)),
  );
  const sortablePropertyKeys = [
    ...shownProperties.map((property) => String(property.propertyId)),
    DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY,
    ...hiddenProperties.map((property) => String(property.propertyId)),
  ];
  const draggedProperty = draggedPropertyId ? propertyById.get(draggedPropertyId) : undefined;
  const setDisplay = (nextDisplay: typeof display) =>
    onChange({
      ...effective,
      presentation: {
        ...effective.presentation,
        display: nextDisplay,
      },
    });
  const toggle = (property: DataSourcePropertyRecordV2, visible: boolean) => {
    setDisplay(
      toggleDatabaseViewPropertyVisibility(
        display,
        activePropertyIds,
        String(property.propertyId),
        visible,
      ),
    );
  };
  const clearDragState = () => {
    setDraggedPropertyId(null);
    setDragOverPropertyId(null);
  };
  const handleDragStart = (event: DragStartEvent) => {
    setDraggedPropertyId(String(event.active.id));
    setDragOverPropertyId(String(event.active.id));
    document.getSelection()?.removeAllRanges();
  };
  const handleDragEnd = (event: DragEndEvent) => {
    clearDragState();
    const sourceId = String(event.active.id);
    const targetKey = event.over ? String(event.over.id) : null;
    if (!targetKey || sourceId === targetKey) return;
    setDisplay(
      moveDatabaseViewPropertyToSortableTarget(display, activePropertyIds, sourceId, targetKey),
    );
  };
  const matchesQuery = (property: DataSourcePropertyRecordV2) =>
    !deferredQuery || property.name.toLocaleLowerCase().includes(deferredQuery);
  const filteredShown = shownProperties.filter(matchesQuery);
  const filteredHidden = hiddenProperties.filter(matchesQuery);
  const showName = !deferredQuery || "name".includes(deferredQuery);
  const canReorder = !busy && !deferredQuery;
  const layoutLabel = effective.layout === "board" ? "board" : "list";
  return (
    <DndContext
      sensors={propertyDnd.sensors}
      modifiers={propertyDnd.modifiers}
      collisionDetection={propertyDnd.collisionDetection}
      onDragStart={handleDragStart}
      onDragOver={(event) => setDragOverPropertyId(event.over ? String(event.over.id) : null)}
      onDragCancel={clearDragState}
      onDragEnd={handleDragEnd}
    >
      <div className="py-2" data-property-visibility-drag-over={dragOverPropertyId ?? undefined}>
        <div className="px-2 pb-3">
          <Input
            type="search"
            aria-label="Search properties"
            value={query}
            placeholder="Search for a property…"
            onChange={(event) => startTransition(() => setQuery(event.target.value))}
            className="h-7 rounded-md border-token-border/70 bg-token-foreground/3 px-2 text-sm shadow-none"
          />
        </div>
        <div ref={propertyListRef}>
          <SortableContext items={sortablePropertyKeys} strategy={verticalListSortingStrategy}>
            <section className="pb-2">
              <div className="mx-2 mb-1 flex h-7 items-center px-2 text-xs leading-[14px]">
                <h3 className="font-medium text-token-description-foreground">
                  Shown in {layoutLabel}
                </h3>
                <button
                  type="button"
                  disabled={busy || shown.size === 0}
                  onClick={() =>
                    setDisplay(
                      databaseViewDisplayFromPropertyVisibilityKeys(
                        display,
                        [DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY, ...propertyOrder],
                        activePropertyIds,
                      ),
                    )
                  }
                  className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-token-primary hover:bg-token-primary/10 disabled:opacity-40"
                >
                  Hide all
                </button>
              </div>
              {showName ? (
                <div
                  data-property-id="name"
                  className="mx-2 flex h-7 items-center rounded-md px-1 text-sm leading-[16.8px] hover:bg-token-foreground/5"
                >
                  <span className="w-[18px] shrink-0" />
                  <span className="ml-1 flex size-4 shrink-0 items-center justify-center text-[13px] font-medium tracking-[-0.03em] text-token-text-primary">
                    Aa
                  </span>
                  <span className="ml-2 min-w-0 flex-1 truncate text-token-text-primary">Name</span>
                  <button
                    type="button"
                    aria-label="Name is always visible"
                    disabled
                    className="flex size-6 shrink-0 items-center justify-center rounded-md text-token-description-foreground"
                  >
                    <VisibilityIcon className="size-4" />
                  </button>
                </div>
              ) : null}
              {filteredShown.map((property) => (
                <SortablePropertyVisibilityRow
                  key={property.propertyId}
                  property={property}
                  visible
                  busy={busy}
                  canReorder={canReorder}
                  onToggle={() => toggle(property, false)}
                />
              ))}
              {!showName && filteredShown.length === 0 ? (
                <p className="px-4 py-1 text-xs text-token-description-foreground">
                  No shown properties
                </p>
              ) : null}
            </section>
            <section className="pb-2">
              <SortablePropertyVisibilityBoundary disabled={!canReorder}>
                <div className="mx-2 mb-1 flex h-7 items-center px-2 text-xs leading-[14px]">
                  <h3 className="font-medium text-token-description-foreground">
                    Hidden in {layoutLabel}
                  </h3>
                  <button
                    type="button"
                    disabled={
                      busy || activeProperties.every((property) => shown.has(property.propertyId))
                    }
                    onClick={() =>
                      setDisplay(
                        databaseViewDisplayFromPropertyVisibilityKeys(
                          display,
                          [...propertyOrder, DATABASE_VIEW_HIDDEN_PROPERTY_BOUNDARY],
                          activePropertyIds,
                        ),
                      )
                    }
                    className="ml-auto rounded-md px-1.5 py-0.5 text-xs text-token-primary hover:bg-token-primary/10 disabled:opacity-40"
                  >
                    Show all
                  </button>
                </div>
              </SortablePropertyVisibilityBoundary>
              {filteredHidden.map((property) => (
                <SortablePropertyVisibilityRow
                  key={property.propertyId}
                  property={property}
                  visible={false}
                  busy={busy}
                  canReorder={canReorder}
                  onToggle={() => toggle(property, true)}
                />
              ))}
              {filteredHidden.length === 0 ? (
                <p className="px-4 py-1 text-xs text-token-description-foreground">
                  No hidden properties
                </p>
              ) : null}
            </section>
          </SortableContext>
        </div>
        {personalActions}
        <ContinuousSortableDragOverlay>
          {draggedProperty ? (
            <PropertyVisibilityDragOverlay
              property={draggedProperty}
              visible={visiblePropertyIds.has(String(draggedProperty.propertyId))}
            />
          ) : null}
        </ContinuousSortableDragOverlay>
      </div>
    </DndContext>
  );
}

function PersonalViewActions({
  changed,
  busy,
  error,
  onReset,
  onPublish,
}: {
  readonly changed: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onReset: () => void;
  readonly onPublish: () => void | Promise<void>;
}) {
  if (!changed && !error) return null;
  return (
    <div className="mt-2 border-t-[0.5px] border-token-border/70">
      {error ? (
        <p role="alert" className="px-3 pt-2 text-xs text-token-error-foreground">
          {error}
        </p>
      ) : null}
      <div className="flex min-h-8 items-center justify-end gap-0.5 px-2 py-1">
        <DatabaseViewChangeAction
          kind="reset"
          label="Reset my changes"
          tooltip={"Discard my view changes\nRestore shared settings"}
          disabled={busy || !changed}
          onClick={onReset}
        />
        <DatabaseViewChangeAction
          kind="publish"
          label="Save for everyone"
          tooltip={"Save my view changes\nFor everyone"}
          disabled={busy || !changed}
          onClick={() => void onPublish()}
        />
      </div>
    </div>
  );
}

function ViewGroupingRoute({
  kind,
  effective,
  properties,
  busy,
  onChange,
  personalActions,
}: {
  readonly kind: "group" | "subgroup";
  readonly effective: EffectiveDatabaseView;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy: boolean;
  readonly onChange: (next: EffectiveDatabaseView) => void;
  readonly personalActions: ReactNode;
}) {
  const presentation = effective.presentation;
  const groupable = properties.filter(
    (property) => property.lifecycle === "active" && property.capabilities.groupable,
  );
  const selected = kind === "group" ? presentation.group : presentation.subgroup;
  const candidates =
    kind === "subgroup"
      ? groupable.filter((property) => property.propertyId !== presentation.group?.propertyId)
      : groupable;
  const disabled = busy || (kind === "subgroup" && presentation.group === null);
  return (
    <div className="py-2">
      <RailSection title={kind === "group" ? "Group Pages by" : "Sub-group Pages by"}>
        <div className="px-3">
          <DatabaseViewSelect
            ariaLabel={kind === "group" ? "Group by" : "Subgroup by"}
            search="filter"
            searchPlaceholder="Search Properties…"
            value={selected?.propertyId ?? ""}
            valueLabel={
              candidates.find((property) => property.propertyId === selected?.propertyId)?.name ??
              (kind === "group" ? "No grouping" : "No sub-group")
            }
            disabled={disabled}
            onValueChange={(propertyId) => {
              const next = propertyId ? { propertyId } : null;
              onChange({
                ...effective,
                presentation: {
                  ...presentation,
                  ...(kind === "group"
                    ? {
                        group: next,
                        subgroup:
                          next?.propertyId === presentation.subgroup?.propertyId
                            ? null
                            : presentation.subgroup,
                      }
                    : { subgroup: next }),
                },
              });
            }}
            options={[
              { value: "", label: kind === "group" ? "No grouping" : "No sub-group" },
              ...candidates.map((property) => ({
                value: property.propertyId,
                label: property.name,
              })),
            ]}
            className="w-full"
          />
        </div>
      </RailSection>
      {kind === "group" && presentation.group ? (
        <RailSection title="Group order">
          <div className="px-3">
            <DatabaseViewSelect
              ariaLabel="Group order"
              value={presentation.groupDirection}
              valueLabel={presentation.groupDirection === "asc" ? "Ascending" : "Descending"}
              disabled={busy}
              onValueChange={(groupDirection) =>
                onChange({
                  ...effective,
                  presentation: {
                    ...presentation,
                    groupDirection: groupDirection as "asc" | "desc",
                  },
                })
              }
              options={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
              ]}
              className="w-full"
            />
          </div>
        </RailSection>
      ) : null}
      {kind === "subgroup" && presentation.group === null ? (
        <p className="px-3 text-xs leading-5 text-token-description-foreground">
          Choose a primary group before adding a sub-group.
        </p>
      ) : null}
      {personalActions}
    </div>
  );
}

const completedRangeLabel = (range: DatabaseViewCompletedRange): string => {
  if (range === "past_month") return "Past month";
  if (range === "past_week") return "Past week";
  if (range === "past_day") return "Past day";
  if (range === "none") return "None";
  return "All";
};

function ViewLayoutOptionsRoute({
  effective,
  properties,
  busy,
  onChange,
  personalActions,
}: {
  readonly effective: EffectiveDatabaseView;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy: boolean;
  readonly onChange: (next: EffectiveDatabaseView) => void;
  readonly personalActions: ReactNode;
}) {
  const presentation = effective.presentation;
  const display = presentation.display;
  const updatePresentation = (next: Partial<typeof presentation>) =>
    onChange({ ...effective, presentation: { ...presentation, ...next } });
  const statusCapable = properties.some(
    (property) => property.lifecycle === "active" && property.systemRole === "status",
  );
  return (
    <div className="py-2">
      {statusCapable ? (
        <RailSection title="Completed pages">
          <div className="space-y-1 px-2">
            <DatabaseViewSelect
              ariaLabel="Completed Page range"
              value={presentation.completion.range}
              valueLabel={completedRangeLabel(presentation.completion.range)}
              disabled={busy}
              onValueChange={(range) =>
                updatePresentation({
                  completion: {
                    ...presentation.completion,
                    range: range as DatabaseViewCompletedRange,
                  },
                })
              }
              options={[
                { value: "all", label: "All" },
                { value: "past_month", label: "Past month" },
                { value: "past_week", label: "Past week" },
                { value: "past_day", label: "Past day" },
                { value: "none", label: "None" },
              ]}
              className="w-full"
            />
            <div className="flex h-7 items-center gap-2 px-2 text-sm leading-[16.8px]">
              <span className="flex-1 text-token-text-primary">Order by completion recency</span>
              <NodexSwitch
                size="compact"
                ariaLabel="Order completed by recency"
                checked={presentation.completion.orderByRecency}
                disabled={busy}
                onCheckedChange={(orderByRecency) =>
                  updatePresentation({
                    completion: { ...presentation.completion, orderByRecency },
                  })
                }
              />
            </div>
          </div>
        </RailSection>
      ) : null}
      <RailSection title="Hierarchy">
        <div className="px-2">
          <div className="flex h-7 items-center gap-2 px-2 text-sm leading-[16.8px]">
            <span className="flex-1 text-token-text-primary">Show sub-pages</span>
            <NodexSwitch
              size="compact"
              ariaLabel="Show sub-pages"
              checked={presentation.hierarchy.showSubPages}
              disabled={busy}
              onCheckedChange={(showSubPages) =>
                updatePresentation({
                  hierarchy: {
                    showSubPages,
                    nestedSubPages: showSubPages && presentation.hierarchy.nestedSubPages,
                  },
                })
              }
            />
          </div>
          {effective.layout === "list" ? (
            <div className="flex h-7 items-center gap-2 px-2 text-sm leading-[16.8px]">
              <span className="flex-1 text-token-text-primary">Nest sub-pages</span>
              <NodexSwitch
                size="compact"
                ariaLabel="Nested sub-pages"
                checked={presentation.hierarchy.nestedSubPages}
                disabled={busy || !presentation.hierarchy.showSubPages}
                onCheckedChange={(nestedSubPages) =>
                  updatePresentation({
                    hierarchy: { ...presentation.hierarchy, nestedSubPages },
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </RailSection>
      <RailSection title={effective.layout === "board" ? "Board" : "List"}>
        <div className="px-2">
          <div className="flex h-7 items-center gap-2 px-2 text-sm leading-[16.8px]">
            <span className="flex-1 text-token-text-primary">Show empty groups</span>
            <NodexSwitch
              size="compact"
              ariaLabel="Show empty groups"
              checked={display.showEmptyGroups}
              disabled={busy || presentation.group === null}
              onCheckedChange={(showEmptyGroups) =>
                updatePresentation({ display: { ...display, showEmptyGroups } })
              }
            />
          </div>
          {effective.layout === "board" ? (
            <div className="flex h-7 items-center gap-2 px-2 text-sm leading-[16.8px]">
              <span className="flex-1 text-token-text-primary">Show Page preview</span>
              <NodexSwitch
                size="compact"
                ariaLabel="Show Page preview"
                checked={display.showDescription !== false}
                disabled={busy}
                onCheckedChange={(showDescription) =>
                  updatePresentation({ display: { ...display, showDescription } })
                }
              />
            </div>
          ) : null}
        </div>
      </RailSection>
      {personalActions}
    </div>
  );
}

const conditionalColorRuleClause = (
  rule: DatabaseViewConditionalColorRule,
): DatabaseViewFilterClause => ({
  kind: "clause",
  propertyId: rule.propertyId,
  operator: rule.operator,
  ...(rule.value === undefined ? {} : { value: rule.value }),
});

const conditionalColorOperator = (
  operator: DatabaseViewFilterOperator,
): DatabasePropertyFilterOperator => {
  if (operator === "is_empty" || operator === "is_not_empty") return operator;
  if (operator.includes("does_not") || operator.endsWith("_is_not")) {
    return operator.includes("contain") ? "not_contains" : "not_equals";
  }
  if (operator.includes("contain")) return "contains";
  return "equals";
};

const conditionalColorRuleWithClause = (
  rule: DatabaseViewConditionalColorRule,
  clause: DatabaseViewFilterClause,
): DatabaseViewConditionalColorRule => ({
  ruleId: rule.ruleId,
  propertyId: clause.propertyId,
  operator: conditionalColorOperator(clause.operator),
  ...(clause.value === undefined ? {} : { value: clause.value }),
  color: rule.color,
});

const moveConditionalColorRule = (
  rules: readonly DatabaseViewConditionalColorRule[],
  index: number,
  direction: "up" | "down",
): readonly DatabaseViewConditionalColorRule[] => {
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rules.length) return rules;
  const next = [...rules];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
};

function ViewConditionalColorRoute({
  runtime,
  activeView,
  properties,
  optionRegistries,
  onRequestPropertyOptions,
  onProjectionCommitted,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly activeView: DatabaseViewRecordV2;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly onProjectionCommitted: () => void | Promise<void>;
}) {
  const eligibleProperties = properties.filter(
    (property) =>
      property.lifecycle === "active" && property.capabilities.filterOperators.length > 0,
  );
  const [rules, setRules] = useState(activeView.config.presentation.conditionalColors);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRules(activeView.config.presentation.conditionalColors);
    setError(null);
  }, [activeView.config.presentation.conditionalColors, activeView.revision]);
  const changed =
    JSON.stringify(rules) !== JSON.stringify(activeView.config.presentation.conditionalColors);
  const updateRule = (
    ruleId: string,
    update: (rule: DatabaseViewConditionalColorRule) => DatabaseViewConditionalColorRule,
  ) => setRules((current) => current.map((rule) => (rule.ruleId === ruleId ? update(rule) : rule)));
  const save = async () => {
    if (!changed || runtime.pendingKey !== null) return;
    setError(null);
    const next = await runtime.mutate({
      pendingKey: `conditional-colors:${activeView.viewId}`,
      preferredViewId: activeView.viewId,
      buildOperations: (authority) => {
        const current = authority.database.views.find(
          (view) => view.lifecycle === "active" && view.viewId === activeView.viewId,
        );
        if (!current) return [];
        return [
          putDatabaseViewOperation(current, {
            config: {
              ...current.config,
              presentation: { ...current.config.presentation, conditionalColors: rules },
            },
          }),
        ];
      },
    });
    if (!next) {
      setError("Couldn’t save conditional colors. Review the latest View and try again.");
      return;
    }
    void onProjectionCommitted();
  };
  return (
    <div className="flex min-h-full flex-col">
      <div className="px-3 pb-2 pt-3">
        <p className="text-xs leading-5 text-token-description-foreground">
          The first matching rule colors the whole {activeView.layout === "board" ? "card" : "row"}
          in this View only.
        </p>
      </div>
      <div className="space-y-2 px-2 pb-3">
        {rules.map((rule, index) => {
          const property = eligibleProperties.find(
            (candidate) => candidate.propertyId === rule.propertyId,
          );
          if (!property) {
            return (
              <div
                key={rule.ruleId}
                className="flex min-h-9 items-center gap-2 border-l-2 border-token-error-foreground px-2 text-xs text-token-error-foreground"
              >
                <span className="min-w-0 flex-1 truncate">Referenced property is unavailable</span>
                <NodexIconButton
                  icon={DeleteIcon}
                  size="xs"
                  tone="danger"
                  ariaLabel="Remove invalid conditional color rule"
                  onClick={() => setRules((current) => current.filter((item) => item !== rule))}
                />
              </div>
            );
          }
          const clause = conditionalColorRuleClause(rule);
          return (
            <div
              key={rule.ruleId}
              className="border-l-2 px-2 py-2"
              style={{ borderColor: `var(--${rule.color}-text)` }}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <DatabaseViewSelect
                  ariaLabel={`Conditional color property ${property.name}`}
                  search="filter"
                  searchPlaceholder="Search properties…"
                  value={property.propertyId}
                  valueLabel={property.name}
                  disabled={runtime.pendingKey !== null}
                  onValueChange={(propertyId) => {
                    const nextProperty = eligibleProperties.find(
                      (candidate) => candidate.propertyId === propertyId,
                    );
                    if (!nextProperty) return;
                    updateRule(rule.ruleId, (current) =>
                      conditionalColorRuleWithClause(
                        current,
                        databaseFilterClauseWithProperty(clause, nextProperty),
                      ),
                    );
                  }}
                  options={eligibleProperties.map((candidate) => ({
                    value: candidate.propertyId,
                    label: candidate.name,
                  }))}
                  className="min-w-28 max-w-40"
                />
                <DatabaseViewSelect
                  ariaLabel={`Conditional color operator for ${property.name}`}
                  value={rule.operator}
                  valueLabel={FILTER_OPERATOR_LABELS[rule.operator]}
                  disabled={runtime.pendingKey !== null}
                  onValueChange={(operator) =>
                    updateRule(rule.ruleId, (current) =>
                      conditionalColorRuleWithClause(
                        current,
                        databaseFilterClauseWithOperator(
                          property,
                          operator as DatabaseViewFilterOperator,
                        ),
                      ),
                    )
                  }
                  options={filterOperatorsForProperty(property).map((operator) => ({
                    value: operator,
                    label: FILTER_OPERATOR_LABELS[operator],
                  }))}
                  className="min-w-24"
                />
                <DatabaseViewFilterValueField
                  clause={clause}
                  property={property}
                  options={
                    optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property)
                  }
                  onRequestOptions={onRequestPropertyOptions}
                  disabled={runtime.pendingKey !== null}
                  onChange={(value) =>
                    updateRule(rule.ruleId, (current) => ({ ...current, value }))
                  }
                />
              </div>
              <div className="mt-2 flex items-center gap-1">
                {OPTION_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    aria-label={`Use ${color} for conditional color rule`}
                    aria-pressed={rule.color === color}
                    disabled={runtime.pendingKey !== null}
                    className={cn(
                      "size-5 rounded-full border outline-none transition-transform focus-visible:ring-2 focus-visible:ring-token-focus-border",
                      rule.color === color
                        ? "scale-100 border-token-text-primary"
                        : "scale-75 border-transparent hover:scale-90",
                    )}
                    style={{ background: `var(--${color}-bg)` }}
                    onClick={() => updateRule(rule.ruleId, (current) => ({ ...current, color }))}
                  />
                ))}
                <span className="ml-auto flex items-center gap-0.5">
                  <NodexIconButton
                    icon={MoveUpIcon}
                    size="xs"
                    ariaLabel="Move conditional color rule up"
                    disabled={index === 0 || runtime.pendingKey !== null}
                    onClick={() =>
                      setRules((current) => moveConditionalColorRule(current, index, "up"))
                    }
                  />
                  <NodexIconButton
                    icon={MoveDownIcon}
                    size="xs"
                    ariaLabel="Move conditional color rule down"
                    disabled={index === rules.length - 1 || runtime.pendingKey !== null}
                    onClick={() =>
                      setRules((current) => moveConditionalColorRule(current, index, "down"))
                    }
                  />
                  <NodexIconButton
                    icon={DeleteIcon}
                    size="xs"
                    tone="danger"
                    ariaLabel="Delete conditional color rule"
                    disabled={runtime.pendingKey !== null}
                    onClick={() => setRules((current) => current.filter((item) => item !== rule))}
                  />
                </span>
              </div>
            </div>
          );
        })}
        {rules.length === 0 ? (
          <p className="py-6 text-center text-xs text-token-description-foreground">
            No color rules yet
          </p>
        ) : null}
        <NodexButton
          size="sm"
          variant="ghost"
          className="w-full justify-start"
          disabled={eligibleProperties.length === 0 || runtime.pendingKey !== null}
          onClick={() => {
            const property = eligibleProperties[0];
            if (!property) return;
            const clause = createDatabaseViewFilterClause(property);
            setRules((current) => [
              ...current,
              {
                ruleId: createUuidV7(),
                propertyId: clause.propertyId,
                operator: conditionalColorOperator(clause.operator),
                ...(clause.value === undefined ? {} : { value: clause.value }),
                color: "blue",
              },
            ]);
          }}
        >
          <PlusIcon className="mr-2 size-4" /> Add rule
        </NodexButton>
      </div>
      {error ? (
        <p role="alert" className="px-3 pb-2 text-xs text-token-error-foreground">
          {error}
        </p>
      ) : null}
      <div className="sticky bottom-0 mt-auto flex min-h-8 items-center justify-end gap-0.5 border-t-[0.5px] border-token-border/70 bg-token-main-surface-primary px-2 py-1">
        <DatabaseViewChangeAction
          kind="reset"
          label="Reset conditional color changes"
          tooltip={"Discard these color changes\nRestore saved colors"}
          disabled={!changed || runtime.pendingKey !== null}
          onClick={() => setRules(activeView.config.presentation.conditionalColors)}
        />
        <DatabaseViewChangeAction
          kind="publish"
          label="Save conditional color changes"
          tooltip={"Save these color changes\nFor everyone"}
          disabled={!changed || runtime.pendingKey !== null}
          onClick={() => void save()}
        />
      </div>
    </div>
  );
}

function SourcePropertiesRoute({
  runtime,
  push,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly push: (route: DatabaseSettingsRoute) => void;
}) {
  const source = runtime.authority?.source;
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  if (!source) return null;
  const properties = source.properties.filter(
    (property) =>
      property.lifecycle === "active" &&
      (!deferredQuery || property.name.toLocaleLowerCase().includes(deferredQuery)),
  );
  const deletedCount = source.properties.filter(
    (property) => property.lifecycle === "deleted",
  ).length;
  return (
    <div className="py-2">
      <div className="px-2 pb-3">
        <Input
          type="search"
          aria-label="Search properties"
          value={query}
          placeholder="Search for a property…"
          onChange={(event) => startTransition(() => setQuery(event.target.value))}
          className="h-7 rounded-md border-token-border/70 bg-token-foreground/3 px-2 text-sm shadow-none"
        />
      </div>
      {properties.map((property) => {
        const Icon = dataSourcePropertyIcon(property);
        return (
          <RailRow
            key={property.propertyId}
            icon={Icon}
            label={property.name}
            onClick={() =>
              push({
                kind: "property",
                dataSourceId: source.dataSource.dataSourceId,
                propertyId: property.propertyId,
              })
            }
          />
        );
      })}
      {properties.length === 0 ? (
        <p className="px-3 py-4 text-center text-xs text-token-description-foreground">
          No matching properties
        </p>
      ) : null}
      <div className="mt-2 border-t-[0.5px] border-token-border/65 pt-2">
        <RailRow
          icon={PlusIcon}
          label="New property"
          muted
          onClick={() =>
            push({ kind: "create_property", dataSourceId: source.dataSource.dataSourceId })
          }
        />
        <RailRow
          icon={DeleteIcon}
          label="Deleted properties"
          value={`${deletedCount}`}
          muted
          onClick={() =>
            push({ kind: "deleted_properties", dataSourceId: source.dataSource.dataSourceId })
          }
        />
      </div>
    </div>
  );
}

function CreatePropertyRoute({
  runtime,
  replace,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly replace: (route: DatabaseSettingsRoute) => void;
}) {
  const source = runtime.authority?.source;
  const [name, setName] = useState("");
  const [type, setType] = useState<DatabasePropertyValueType>("text");
  const [relationTargetId, setRelationTargetId] = useState<DataSourceId | null>(
    source?.dataSource.dataSourceId ?? null,
  );
  const [relationCardinality, setRelationCardinality] = useState<"one" | "many">("many");
  if (!source || !relationTargetId) return null;
  const createProperty = async (selectedType: DatabasePropertyValueType) => {
    const normalized = name.trim();
    if (!normalized) return;
    let propertyId: DataSourcePropertyRecordV2["propertyId"] | null = null;
    const next = await runtime.mutate({
      pendingKey: "create-property",
      buildOperations: (authority) => {
        const operation = createDataSourcePropertyOperation({
          source: authority.source,
          name: normalized,
          schema: propertySchemaForType(selectedType, relationTargetId, relationCardinality),
        });
        if (operation.kind === "put_property") propertyId = operation.propertyId;
        return [operation];
      },
    });
    if (!next || !propertyId) return;
    replace({
      kind: "property",
      dataSourceId: next.source.dataSource.dataSourceId,
      propertyId,
    });
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await createProperty(type);
  };
  const activeSources = runtime.authority?.database.dataSources.filter(
    (candidate) => candidate.lifecycle === "active",
  );
  return (
    <form onSubmit={(event) => void submit(event)} className="py-2">
      <div className="mx-2 flex h-11 items-center gap-2 px-2">
        <div className="-ml-1 mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-primary ring-[0.5px] ring-inset ring-token-border">
          <Rows3 className="icon-xs" />
        </div>
        <NodexCompactFramedInput
          autoFocus
          aria-label="Name"
          placeholder="Property name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="min-w-0 flex-1"
        />
      </div>
      <div className="mx-2 mt-2 border-t-[0.5px] border-token-border/65 px-2 pt-3 text-xs font-medium leading-[14px] text-token-description-foreground">
        Type
      </div>
      <div className="mt-2">
        {PROPERTY_TYPES.map((candidate) => {
          const Icon = dataSourcePropertyTypeIcon(candidate.value);
          return (
            <button
              key={candidate.value}
              type="button"
              aria-pressed={type === candidate.value}
              disabled={runtime.pendingKey !== null}
              onClick={() => {
                setType(candidate.value);
                if (name.trim()) void createProperty(candidate.value);
              }}
              className={cn(
                "mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left text-sm leading-[16.8px] outline-none",
                type === candidate.value
                  ? "bg-token-foreground/7 text-token-text-primary"
                  : "text-token-text-primary hover:bg-token-foreground/5",
              )}
            >
              <Icon className="icon-xs" />
              {candidate.label}
              {type === candidate.value ? <span className="ml-auto">✓</span> : null}
            </button>
          );
        })}
      </div>
      {type === "relation" && activeSources ? (
        <div className="mx-2 mt-3 space-y-3 border-t-[0.5px] border-token-border/65 px-2 pt-3">
          <div className="mb-1.5 text-xs font-medium text-token-description-foreground">
            Related source
          </div>
          <DatabaseViewSelect
            ariaLabel="Related Data Source"
            value={relationTargetId}
            valueLabel={
              activeSources.find((candidate) => candidate.dataSourceId === relationTargetId)
                ?.name ?? "Data source"
            }
            onValueChange={(value) => setRelationTargetId(value as DataSourceId)}
            options={activeSources.map((candidate) => ({
              value: candidate.dataSourceId,
              label: candidate.name,
            }))}
            className="w-full"
          />
          <div>
            <div className="mb-1.5 text-xs font-medium text-token-description-foreground">
              Relation limit
            </div>
            <DatabaseViewSelect
              ariaLabel="Relation cardinality"
              value={relationCardinality}
              valueLabel={relationCardinality === "one" ? "One Page" : "No limit"}
              onValueChange={(value) => setRelationCardinality(value as "one" | "many")}
              options={[
                { value: "many", label: "No limit" },
                { value: "one", label: "One Page" },
              ]}
              className="w-full"
            />
          </div>
        </div>
      ) : null}
    </form>
  );
}

function PropertyRoute({
  runtime,
  propertyId,
  push,
  onBack,
  optionRegistries,
  onRequestPropertyOptions,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly propertyId: string;
  readonly push: (route: DatabaseSettingsRoute) => void;
  readonly onBack: () => void;
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions: (property: DataSourcePropertyRecordV2) => void;
}) {
  const authority = runtime.authority;
  const property = authority?.source.properties.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reorderOpen, setReorderOpen] = useState(false);
  useEffect(() => {
    if (property?.managementPolicy.canManageOptions) onRequestPropertyOptions(property);
  }, [onRequestPropertyOptions, property]);
  if (!authority || !property) return null;
  const Icon = dataSourcePropertyIcon(property);
  const policy = property.managementPolicy;
  const schema = property.schema;
  const options = optionRegistries[property.propertyId] ?? [];
  return (
    <div className="py-2">
      <div className="mx-2 flex h-11 items-center gap-2 px-2">
        <div className="-ml-1 mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-primary ring-[0.5px] ring-inset ring-token-border">
          <Icon className="icon-xs" />
        </div>
        <div className="min-w-0 flex-1">
          <InlineNameEditor
            label="Property name"
            value={property.name}
            busy={runtime.pendingKey !== null || !policy.canRename}
            onCommit={async (name) => {
              await runtime.mutate({
                pendingKey: `rename-property:${property.propertyId}`,
                buildOperations: (current) => [
                  putDataSourcePropertyOperation(current.source, property, { name }),
                ],
              });
            }}
          />
        </div>
        <button
          type="button"
          aria-label="Property actions"
          aria-expanded={reorderOpen}
          onClick={() => setReorderOpen((open) => !open)}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border/60"
        >
          <MoreActionsIcon className="icon-xs" />
        </button>
      </div>
      {reorderOpen ? (
        <div className="mx-2 mb-2 border-y-[0.5px] border-token-border/65 py-2">
          <RailRow
            icon={MoveUpIcon}
            label="Move property up"
            disabled={runtime.pendingKey !== null || !policy.canReorder}
            onClick={() => {
              const operation = moveDataSourcePropertyOperation(authority.source, property, "up");
              if (!operation) return;
              void runtime.mutate({
                pendingKey: `move-property:${property.propertyId}`,
                buildOperations: () => [operation],
              });
            }}
          />
          <RailRow
            icon={MoveDownIcon}
            label="Move property down"
            disabled={runtime.pendingKey !== null || !policy.canReorder}
            onClick={() => {
              const operation = moveDataSourcePropertyOperation(authority.source, property, "down");
              if (!operation) return;
              void runtime.mutate({
                pendingKey: `move-property:${property.propertyId}`,
                buildOperations: () => [operation],
              });
            }}
          />
        </div>
      ) : null}
      <div className="pb-2">
        <RailRow
          icon={Icon}
          label="Type"
          value={DATA_SOURCE_PROPERTY_TYPE_LABELS[property.valueType]}
          disabled={!policy.canChangeType}
          onClick={
            !policy.canChangeType
              ? undefined
              : () =>
                  push({
                    kind: "property_type",
                    dataSourceId: property.dataSourceId,
                    propertyId: property.propertyId,
                  })
          }
        />
        {property.valueType === "select" || property.valueType === "multi_select" ? (
          <RailRow
            icon={Icon}
            label="Options"
            value={`${property.optionCount}`}
            onClick={() =>
              push({
                kind: "property_options",
                dataSourceId: property.dataSourceId,
                propertyId: property.propertyId,
              })
            }
          />
        ) : null}
        {schema.kind === "number" ? (
          <RailRow
            label="Number format"
            value={
              NUMBER_FORMAT_OPTIONS.find((option) => option.value === numberFormatValue(schema))
                ?.label
            }
            disabled={!policy.canChangeType}
            onClick={
              policy.canChangeType
                ? () =>
                    push({
                      kind: "property_type",
                      dataSourceId: property.dataSourceId,
                      propertyId: property.propertyId,
                    })
                : undefined
            }
          />
        ) : null}
        {schema.kind === "date" || schema.kind === "datetime" ? (
          <RailRow
            label="Date format"
            value={DATE_FORMAT_OPTIONS.find((option) => option.value === schema.dateFormat)?.label}
            disabled={!policy.canChangeType}
            onClick={
              policy.canChangeType
                ? () =>
                    push({
                      kind: "property_type",
                      dataSourceId: property.dataSourceId,
                      propertyId: property.propertyId,
                    })
                : undefined
            }
          />
        ) : null}
        {schema.kind === "datetime" ? (
          <RailRow
            label="Time format"
            value={TIME_FORMAT_OPTIONS.find((option) => option.value === schema.timeFormat)?.label}
            disabled={!policy.canChangeType}
            onClick={
              policy.canChangeType
                ? () =>
                    push({
                      kind: "property_type",
                      dataSourceId: property.dataSourceId,
                      propertyId: property.propertyId,
                    })
                : undefined
            }
          />
        ) : null}
        {schema.kind === "relation" ? (
          <RailRow
            label="Relation"
            value={schema.cardinality === "one" ? "One Page" : "No limit"}
            disabled={!policy.canChangeType}
            onClick={
              policy.canChangeType
                ? () =>
                    push({
                      kind: "property_type",
                      dataSourceId: property.dataSourceId,
                      propertyId: property.propertyId,
                    })
                : undefined
            }
          />
        ) : null}
      </div>
      <div className="pb-2">
        <RailRow
          icon={CopyIcon}
          label="Duplicate property"
          disabled={
            runtime.pendingKey !== null ||
            !policy.canDuplicate ||
            options.length < property.optionCount
          }
          onClick={async () => {
            const operation = duplicateDataSourcePropertyOperation({
              source: authority.source,
              property,
              options,
            });
            const next = await runtime.mutate({
              pendingKey: `duplicate-property:${property.propertyId}`,
              buildOperations: () => [operation],
            });
            if (!next || operation.kind !== "duplicate_property") return;
            push({
              kind: "property",
              dataSourceId: property.dataSourceId,
              propertyId: operation.newPropertyId,
            });
          }}
        />
        <RailRow
          icon={DeleteIcon}
          label={policy.canDelete ? "Delete property" : "Required Property"}
          value={policy.canDelete ? undefined : "Managed by Nodex"}
          disabled={!policy.canDelete}
          onClick={policy.canDelete ? () => setConfirmDelete(!confirmDelete) : undefined}
        />
        {confirmDelete ? (
          <div className="mx-3 mb-2 border-l-2 border-token-error-foreground/40 py-1 pl-2">
            <p className="text-xs leading-5 text-token-description-foreground">
              The Property disappears from the Source. References in{" "}
              {property.referencedViewIds.length} View
              {property.referencedViewIds.length === 1 ? "" : "s"} are removed in the same
              transaction; Page values are retained for restore.
            </p>
            <div className="mt-2 flex justify-end gap-1.5">
              <NodexButton size="xs" variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </NodexButton>
              <NodexButton
                size="xs"
                variant="destructive"
                disabled={runtime.pendingKey !== null}
                onClick={async () => {
                  const next = await runtime.mutate({
                    pendingKey: `delete-property:${property.propertyId}`,
                    buildOperations: (current) =>
                      deleteDataSourcePropertyOperations({
                        source: current.source,
                        views: current.database.views,
                        property,
                      }),
                  });
                  if (next) onBack();
                }}
              >
                Delete
              </NodexButton>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PropertyTypeRoute({
  runtime,
  propertyId,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly propertyId: string;
}) {
  const authority = runtime.authority;
  const property = authority?.source.properties.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  if (!authority || !property) return null;
  const schema = property.schema;
  const activeSources = authority.database.dataSources.filter(
    (candidate) => candidate.lifecycle === "active",
  );
  const updateSchema = (schema: DatabasePropertySchemaV2) => {
    void runtime.mutate({
      pendingKey: `property-schema:${property.propertyId}`,
      buildOperations: (current) => {
        const latest = current.source.properties.find(
          (candidate) => candidate.propertyId === property.propertyId,
        );
        if (!latest) return [];
        return [
          changeDataSourcePropertyTypeOperation({
            source: current.source,
            property: latest,
            schema,
          }),
        ];
      },
    });
  };
  return (
    <div className="py-2">
      {schema.kind === "number" ? (
        <RailSection title="Number format">
          <div className="px-3">
            <DatabaseViewSelect
              ariaLabel="Number display format"
              value={numberFormatValue(schema)}
              valueLabel={
                NUMBER_FORMAT_OPTIONS.find((option) => option.value === numberFormatValue(schema))
                  ?.label ?? "Number"
              }
              disabled={runtime.pendingKey !== null}
              onValueChange={(value) =>
                updateSchema({
                  kind: "number",
                  format:
                    value === "plain" || value === "percent"
                      ? { kind: value }
                      : {
                          kind: "currency",
                          currencyCode: value as "usd" | "eur" | "gbp" | "jpy" | "cny",
                        },
                })
              }
              options={[...NUMBER_FORMAT_OPTIONS]}
              className="w-full"
            />
          </div>
        </RailSection>
      ) : null}
      {schema.kind === "date" || schema.kind === "datetime" ? (
        <RailSection title="Date format">
          <div className="px-3">
            <DatabaseViewSelect
              ariaLabel="Date display format"
              value={schema.dateFormat}
              valueLabel={
                DATE_FORMAT_OPTIONS.find((option) => option.value === schema.dateFormat)?.label ??
                "Full date"
              }
              disabled={runtime.pendingKey !== null}
              onValueChange={(dateFormat) =>
                updateSchema(
                  schema.kind === "date"
                    ? {
                        kind: "date",
                        dateFormat: dateFormat as Extract<
                          DatabasePropertySchemaV2,
                          { readonly kind: "date" }
                        >["dateFormat"],
                      }
                    : {
                        ...schema,
                        dateFormat: dateFormat as Extract<
                          DatabasePropertySchemaV2,
                          { readonly kind: "datetime" }
                        >["dateFormat"],
                      },
                )
              }
              options={[...DATE_FORMAT_OPTIONS]}
              className="w-full"
            />
          </div>
        </RailSection>
      ) : null}
      {schema.kind === "datetime" ? (
        <RailSection title="Time format">
          <div className="px-3">
            <DatabaseViewSelect
              ariaLabel="Time display format"
              value={schema.timeFormat}
              valueLabel={
                TIME_FORMAT_OPTIONS.find((option) => option.value === schema.timeFormat)?.label ??
                "12 hour"
              }
              disabled={runtime.pendingKey !== null}
              onValueChange={(timeFormat) =>
                updateSchema({
                  ...schema,
                  timeFormat: timeFormat as Extract<
                    DatabasePropertySchemaV2,
                    { readonly kind: "datetime" }
                  >["timeFormat"],
                })
              }
              options={[...TIME_FORMAT_OPTIONS]}
              className="w-full"
            />
            <p className="pt-2 text-[11px] leading-4 text-token-description-foreground">
              Datetime values keep their defined UTC semantics; this only changes display.
            </p>
          </div>
        </RailSection>
      ) : null}
      {schema.kind === "relation" ? (
        <RailSection title="Relation settings">
          <div className="space-y-2 px-3">
            <DatabaseViewSelect
              ariaLabel="Related Data Source"
              value={schema.targetDataSourceId}
              valueLabel={
                activeSources.find(
                  (candidate) => candidate.dataSourceId === schema.targetDataSourceId,
                )?.name ?? "Data source"
              }
              disabled={runtime.pendingKey !== null || property.nonEmptyValueCount > 0}
              onValueChange={(targetDataSourceId) =>
                updateSchema({
                  ...schema,
                  targetDataSourceId: targetDataSourceId as DataSourceId,
                })
              }
              options={activeSources.map((candidate) => ({
                value: candidate.dataSourceId,
                label: candidate.name,
              }))}
              className="w-full"
            />
            <DatabaseViewSelect
              ariaLabel="Relation cardinality"
              value={schema.cardinality}
              valueLabel={schema.cardinality === "one" ? "One Page" : "No limit"}
              disabled={runtime.pendingKey !== null || property.nonEmptyValueCount > 0}
              onValueChange={(cardinality) =>
                updateSchema({
                  ...schema,
                  cardinality: cardinality as "one" | "many",
                })
              }
              options={[
                { value: "many", label: "No limit" },
                { value: "one", label: "One Page" },
              ]}
              className="w-full"
            />
          </div>
        </RailSection>
      ) : null}
      <RailSection title="Property type">
        {PROPERTY_TYPES.filter((candidate) =>
          property.managementPolicy.allowedTypes.includes(candidate.value),
        ).map((candidate) => {
          const Icon = dataSourcePropertyTypeIcon(candidate.value);
          return (
            <button
              key={candidate.value}
              type="button"
              disabled={
                runtime.pendingKey !== null ||
                !property.managementPolicy.canChangeType ||
                (candidate.value !== property.valueType && property.nonEmptyValueCount > 0)
              }
              onClick={() => {
                if (candidate.value === property.valueType) return;
                updateSchema(
                  propertySchemaForType(candidate.value, authority.source.dataSource.dataSourceId),
                );
              }}
              className="mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-md px-2 text-left text-sm leading-[16.8px] text-token-text-primary outline-none hover:bg-token-foreground/5"
            >
              <Icon className="icon-xs text-token-text-primary" />
              <span className="flex-1">{candidate.label}</span>
              {candidate.value === property.valueType ? (
                <span className="text-token-charts-blue">✓</span>
              ) : null}
            </button>
          );
        })}
      </RailSection>
      <p className="px-3 pt-3 text-xs leading-5 text-token-description-foreground">
        {property.nonEmptyValueCount > 0
          ? `${property.nonEmptyValueCount} Pages contain a value. Display formats remain editable; clear values before changing type or Relation structure.`
          : "Changing type keeps this Property identity. Relation target and cardinality can be configured above."}
      </p>
    </div>
  );
}

function PropertyOptionsRoute({
  runtime,
  propertyId,
  optionRegistries,
  onRequestPropertyOptions,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly propertyId: string;
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions: (property: DataSourcePropertyRecordV2) => void;
}) {
  const property = runtime.authority?.source.properties.find(
    (candidate) => candidate.propertyId === propertyId,
  );
  const [name, setName] = useState("");
  const [confirmOptionId, setConfirmOptionId] = useState<string | null>(null);
  useEffect(() => {
    if (property) onRequestPropertyOptions(property);
  }, [onRequestPropertyOptions, property]);
  if (!property || (property.valueType !== "select" && property.valueType !== "multi_select")) {
    return null;
  }
  const options = optionRegistries[property.propertyId] ?? [];
  const role = resolveDataSourcePropertyPresentationRole(property);
  const semanticKind =
    role.kind === "status" || role.kind === "priority" || role.kind === "estimate"
      ? role.kind
      : null;
  const fixedWorkflowOptions = property.systemRole === "status";
  const putOption = async (option: DatabasePropertyOption, nextName: string, color?: string) => {
    await runtime.mutate({
      pendingKey: `option:${option.id}`,
      buildOperations: (current) => {
        const latest = current.source.properties.find(
          (candidate) => candidate.propertyId === property.propertyId,
        );
        if (!latest) return [];
        return [
          {
            kind: "put_option",
            dataSourceId: latest.dataSourceId,
            propertyId: latest.propertyId,
            optionId: parseDataSourceOptionId({
              propertyId: latest.propertyId,
              value: option.id,
            }),
            name: nextName,
            ...(color ? { color } : {}),
            expectedPropertyRevision: latest.revision,
          },
        ];
      },
    });
    onRequestPropertyOptions(property);
  };
  const deleteOption = async (option: DatabasePropertyOption, clearValues: boolean) => {
    await runtime.mutate({
      pendingKey: `delete-option:${option.id}`,
      buildOperations: (current) => {
        const latest = current.source.properties.find(
          (candidate) => candidate.propertyId === property.propertyId,
        );
        if (!latest) return [];
        return [
          {
            kind: clearValues ? "delete_option_and_clear_values" : "delete_option",
            dataSourceId: latest.dataSourceId,
            propertyId: latest.propertyId,
            optionId: parseDataSourceOptionId({
              propertyId: latest.propertyId,
              value: option.id,
            }),
            expectedPropertyRevision: latest.revision,
          },
        ];
      },
    });
    setConfirmOptionId(null);
    onRequestPropertyOptions(property);
  };
  const moveOption = async (
    option: DatabasePropertyOption,
    placement:
      | { readonly kind: "before"; readonly option: DatabasePropertyOption }
      | { readonly kind: "end" },
  ) => {
    const next = await runtime.mutate({
      pendingKey: `move-option:${option.id}`,
      buildOperations: (current) => {
        const latest = current.source.properties.find(
          (candidate) => candidate.propertyId === property.propertyId,
        );
        if (!latest) return [];
        return [
          {
            kind: "move_option",
            dataSourceId: latest.dataSourceId,
            propertyId: latest.propertyId,
            optionId: parseDataSourceOptionId({ propertyId: latest.propertyId, value: option.id }),
            expectedPropertyRevision: latest.revision,
            placement:
              placement.kind === "end"
                ? placement
                : {
                    kind: "before",
                    optionId: parseDataSourceOptionId({
                      propertyId: latest.propertyId,
                      value: placement.option.id,
                    }),
                  },
          },
        ];
      },
    });
    const latest = next?.source.properties.find(
      (candidate) => candidate.propertyId === property.propertyId,
    );
    if (latest) onRequestPropertyOptions(latest);
  };
  return (
    <div className="py-2">
      {options.map((option, index) => (
        <div key={option.id} className="group/option px-2">
          <div className="flex min-h-7 items-center gap-1">
            {semanticKind ? (
              <SemanticPropertyOptionIcon
                kind={semanticKind}
                option={option}
                className="icon-xs shrink-0 text-token-text-secondary"
              />
            ) : (
              <span
                className="size-2.5 shrink-0 rounded-full bg-token-foreground/20"
                style={{
                  backgroundColor: databasePropertyOptionDotColor(option.color, option.id),
                }}
              />
            )}
            <div className="min-w-0 flex-1">
              <InlineNameEditor
                label={`Option ${option.name}`}
                value={option.name}
                busy={runtime.pendingKey !== null}
                onCommit={(nextName) => putOption(option, nextName, option.color)}
              />
            </div>
            <DatabaseViewSelect
              ariaLabel={`Color for ${option.name}`}
              value={option.color ?? "gray"}
              valueLabel={option.color ?? "gray"}
              disabled={runtime.pendingKey !== null}
              onValueChange={(color) => void putOption(option, option.name, color)}
              options={OPTION_COLORS.map((color) => ({ value: color, label: color }))}
              className="w-20 shrink-0"
            />
            <NodexIconButton
              icon={MoveUpIcon}
              size="xs"
              ariaLabel={`Move option ${option.name} up`}
              disabled={runtime.pendingKey !== null || fixedWorkflowOptions || index === 0}
              onClick={() => {
                const previous = options[index - 1];
                if (!previous) return;
                void moveOption(option, { kind: "before", option: previous });
              }}
            />
            <NodexIconButton
              icon={MoveDownIcon}
              size="xs"
              ariaLabel={`Move option ${option.name} down`}
              disabled={
                runtime.pendingKey !== null || fixedWorkflowOptions || index === options.length - 1
              }
              onClick={() => {
                const afterNext = options[index + 2];
                void moveOption(
                  option,
                  afterNext ? { kind: "before", option: afterNext } : { kind: "end" },
                );
              }}
            />
            <NodexIconButton
              icon={DeleteIcon}
              size="xs"
              tone="danger"
              ariaLabel={`Delete option ${option.name}`}
              disabled={runtime.pendingKey !== null || fixedWorkflowOptions}
              onClick={() => {
                if ((option.selectedPageCount ?? 0) > 0) {
                  setConfirmOptionId(option.id);
                  return;
                }
                void deleteOption(option, false);
              }}
            />
          </div>
          {confirmOptionId === option.id ? (
            <div className="mb-2 ml-5 border-l-2 border-token-error-foreground/40 py-1 pl-2">
              <p className="text-xs leading-5 text-token-description-foreground">
                Remove this option from {option.selectedPageCount ?? 0} Page
                {option.selectedPageCount === 1 ? "" : "s"}, then delete it?
              </p>
              <div className="mt-1 flex justify-end gap-1.5">
                <NodexButton size="xs" variant="ghost" onClick={() => setConfirmOptionId(null)}>
                  Cancel
                </NodexButton>
                <NodexButton
                  size="xs"
                  variant="destructive"
                  onClick={() => void deleteOption(option, true)}
                >
                  Clear values and delete
                </NodexButton>
              </div>
            </div>
          ) : null}
        </div>
      ))}
      <form
        className="mx-2 mt-2 flex items-center gap-1 border-t-[0.5px] border-token-border/65 px-1 pt-2"
        onSubmit={async (event) => {
          event.preventDefault();
          const normalized = name.trim();
          if (!normalized) return;
          const optionId = createCustomOptionId();
          await putOption({ id: optionId, name: normalized }, normalized, "gray");
          setName("");
        }}
      >
        <Input
          value={name}
          aria-label="New option name"
          placeholder="New option"
          disabled={runtime.pendingKey !== null || fixedWorkflowOptions}
          onChange={(event) => setName(event.target.value)}
          className="h-7 rounded-md border-token-border/70 bg-transparent px-2 text-sm shadow-none"
        />
        <NodexIconButton
          icon={PlusIcon}
          size="xs"
          type="submit"
          ariaLabel="Add option"
          disabled={!name.trim() || runtime.pendingKey !== null || fixedWorkflowOptions}
        />
      </form>
      {fixedWorkflowOptions ? (
        <p className="px-3 pt-2 text-xs leading-5 text-token-description-foreground">
          Canonical options can be renamed and recolored; their membership and order are managed by
          Nodex.
        </p>
      ) : null}
    </div>
  );
}

const PAGE_VISIBILITY_OPTIONS: readonly {
  readonly value: DatabasePagePropertyVisibilityV2;
  readonly label: string;
}[] = [
  { value: "always_show", label: "Always show" },
  { value: "hide_when_empty", label: "Hide when empty" },
  { value: "always_hide", label: "Always hide" },
];

function PageLayoutRoute({
  runtime,
  dataSourceId,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly dataSourceId: string;
}) {
  const source = runtime.authority?.source;
  const layout = runtime.pageLayout?.dataSourceId === dataSourceId ? runtime.pageLayout : null;
  const loadPageLayout = runtime.loadPageLayout;
  useEffect(() => {
    void loadPageLayout(dataSourceId);
  }, [dataSourceId, loadPageLayout]);
  if (!source || !layout) {
    return (
      <p className="px-3 py-6 text-center text-xs text-token-description-foreground">
        {runtime.pageLayoutLoading ? "Loading Page layout…" : "Page layout is unavailable"}
      </p>
    );
  }
  const propertyById = new Map(
    source.properties.map((property) => [property.propertyId, property]),
  );
  const commit = async (
    propertyId: DataSourcePropertyRecordV2["propertyId"],
    visibility: DatabasePagePropertyVisibilityV2,
    placement?:
      | { readonly kind: "before"; readonly propertyId: DataSourcePropertyRecordV2["propertyId"] }
      | { readonly kind: "end" },
  ) => {
    const next = await runtime.mutate({
      pendingKey: `page-layout:${propertyId}`,
      buildOperations: () => [
        {
          kind: "put_page_layout_entry",
          dataSourceId: source.dataSource.dataSourceId,
          expectedRevision: layout.revision,
          propertyId,
          visibility,
          ...(placement ? { placement } : {}),
        },
      ],
    });
    if (next) await runtime.loadPageLayout(dataSourceId);
  };
  return (
    <div className="py-2">
      <p className="px-4 pb-3 text-xs leading-[18px] text-token-description-foreground">
        Applies to every Page in this Data Source. View card and row fields stay independent.
      </p>
      {layout.entries.map((entry, index) => {
        const property = propertyById.get(entry.propertyId);
        if (!property || property.lifecycle !== "active") return null;
        const Icon = dataSourcePropertyIcon(property);
        return (
          <div
            key={entry.propertyId}
            className="group/page-layout mx-2 flex min-h-7 items-center gap-1 rounded-md px-1 hover:bg-token-foreground/5"
          >
            <DragHandleDotsIcon className="icon-2xs shrink-0 text-token-description-foreground" />
            <Icon className="icon-xs shrink-0 text-token-text-primary" />
            <span className="ml-1 min-w-0 flex-1 truncate text-sm leading-[16.8px] text-token-text-primary">
              {property.name}
            </span>
            <DatabaseViewSelect
              ariaLabel={`Page visibility for ${property.name}`}
              value={entry.visibility}
              valueLabel={
                PAGE_VISIBILITY_OPTIONS.find((option) => option.value === entry.visibility)
                  ?.label ?? "Always show"
              }
              disabled={runtime.pendingKey !== null}
              onValueChange={(visibility) =>
                void commit(entry.propertyId, visibility as DatabasePagePropertyVisibilityV2)
              }
              options={PAGE_VISIBILITY_OPTIONS}
              className="w-[108px]"
            />
            <div className="hidden items-center group-hover/page-layout:flex group-focus-within/page-layout:flex">
              <NodexIconButton
                icon={MoveUpIcon}
                size="xs"
                ariaLabel={`Move ${property.name} up in Page layout`}
                disabled={runtime.pendingKey !== null || index === 0}
                onClick={() => {
                  const previous = layout.entries[index - 1];
                  if (!previous) return;
                  void commit(entry.propertyId, entry.visibility, {
                    kind: "before",
                    propertyId: previous.propertyId,
                  });
                }}
              />
              <NodexIconButton
                icon={MoveDownIcon}
                size="xs"
                ariaLabel={`Move ${property.name} down in Page layout`}
                disabled={runtime.pendingKey !== null || index === layout.entries.length - 1}
                onClick={() => {
                  const afterNext = layout.entries[index + 2];
                  void commit(
                    entry.propertyId,
                    entry.visibility,
                    afterNext
                      ? { kind: "before", propertyId: afterNext.propertyId }
                      : { kind: "end" },
                  );
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DeletedPropertiesRoute({ runtime }: { readonly runtime: DatabaseSettingsRuntime }) {
  const source = runtime.authority?.source;
  const [confirmPermanentId, setConfirmPermanentId] = useState<string | null>(null);
  if (!source) return null;
  const deleted = source.properties.filter((property) => property.lifecycle === "deleted");
  return (
    <div className="py-2">
      {deleted.map((property) => {
        const Icon = dataSourcePropertyIcon(property);
        return (
          <div key={property.propertyId} className="px-3">
            <div className="flex min-h-9 items-center gap-2">
              <Icon className="size-4 text-token-text-primary" />
              <span className="min-w-0 flex-1 truncate text-left text-[13px] text-token-text-primary">
                {property.name}
              </span>
              <NodexButton
                size="xs"
                variant="ghost"
                disabled={runtime.pendingKey !== null}
                onClick={() =>
                  void runtime.mutate({
                    pendingKey: `restore-property:${property.propertyId}`,
                    buildOperations: (current) => [
                      restoreDataSourcePropertyOperation({
                        source: current.source,
                        property,
                      }),
                    ],
                  })
                }
              >
                Restore
              </NodexButton>
              <NodexIconButton
                icon={DeleteIcon}
                size="xs"
                tone="danger"
                ariaLabel={`Permanently delete ${property.name}`}
                disabled={
                  runtime.pendingKey !== null || !property.managementPolicy.canPermanentlyDelete
                }
                onClick={() =>
                  setConfirmPermanentId(
                    confirmPermanentId === property.propertyId ? null : property.propertyId,
                  )
                }
              />
            </div>
            {confirmPermanentId === property.propertyId ? (
              <div className="mb-2 ml-5 border-l-2 border-token-error-foreground/40 py-1 pl-3">
                <p className="text-xs leading-5 text-token-description-foreground">
                  Permanently delete “{property.name}”, its saved values, and retire this identity?
                  This cannot be undone.
                </p>
                <div className="mt-2 flex justify-end gap-1.5 pr-2">
                  <NodexButton
                    size="xs"
                    variant="ghost"
                    onClick={() => setConfirmPermanentId(null)}
                  >
                    Cancel
                  </NodexButton>
                  <NodexButton
                    size="xs"
                    variant="destructive"
                    onClick={() =>
                      void runtime
                        .mutate({
                          pendingKey: `permanent-property:${property.propertyId}`,
                          buildOperations: (current) => [
                            permanentlyDeleteDataSourcePropertyOperation({
                              source: current.source,
                              property,
                            }),
                          ],
                        })
                        .then(() => setConfirmPermanentId(null))
                    }
                  >
                    Delete forever
                  </NodexButton>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      {deleted.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-token-description-foreground">
          No deleted properties
        </p>
      ) : null}
    </div>
  );
}

export function DatabaseSettingsRail({
  runtime,
  routeStack,
  model,
  effectivePresentation,
  durablePresentation,
  viewNameFocusRequest,
  viewActionMenu,
  presentationActivity,
  presentationError,
  optionRegistries,
  onRequestPropertyOptions,
  onChangePresentation,
  onResetPresentation,
  onPublishPresentation,
  onProjectionCommitted,
  onSelectView,
  onPush,
  onReplace,
  onBack,
  onClose,
}: {
  readonly runtime: DatabaseSettingsRuntime;
  readonly routeStack: DatabaseSettingsRouteStack;
  readonly model: DatabaseViewRenderModel;
  readonly effectivePresentation: EffectiveDatabaseView;
  readonly durablePresentation: EffectiveDatabaseView;
  readonly viewNameFocusRequest: number;
  readonly viewActionMenu?: DatabaseViewActionMenuSession;
  readonly presentationActivity: DatabaseViewPresentationActivity;
  readonly presentationError: string | null;
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly onChangePresentation: (next: EffectiveDatabaseView) => void;
  readonly onResetPresentation: () => void;
  readonly onPublishPresentation: () => void | Promise<void>;
  readonly onProjectionCommitted: () => void | Promise<void>;
  readonly onSelectView: (viewId: string, title: string) => void;
  readonly onPush: (route: DatabaseSettingsRoute) => void;
  readonly onReplace: (route: DatabaseSettingsRoute) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const route = routeStack.at(-1)!;
  const rootRoute = route.kind === "root" || route.kind === "view";
  const headerRef = useRef<HTMLDivElement | null>(null);
  const [entered, setEntered] = useState(false);
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    const focusTarget = headerRef.current?.querySelector<HTMLElement>("button, input");
    focusTarget?.focus();
  }, [route.kind]);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (routeStack.length > 1) onBack();
      else onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onBack, onClose, routeStack.length]);
  const authority = runtime.authority;
  const activeView = authority?.database.views.find(
    (view) => view.lifecycle === "active" && view.viewId === model.databaseViewId,
  );
  const hasPersonalOverride =
    effectivePresentation.layout !== durablePresentation.layout ||
    JSON.stringify(effectivePresentation.presentation) !==
      JSON.stringify(durablePresentation.presentation);
  const presentationLocked = presentationActivity.interactionLocked;
  const personalActions = (
    <PersonalViewActions
      changed={hasPersonalOverride}
      busy={presentationLocked}
      error={presentationError}
      onReset={onResetPresentation}
      onPublish={onPublishPresentation}
    />
  );
  const routeTitle =
    route.kind === "root"
      ? "View settings"
      : route.kind === "create_property" && authority
        ? `New property on ${authority.dataSource.name}`
        : databaseSettingsRouteTitle(route);
  let body: ReactNode = null;
  if (!authority || !activeView) {
    body = (
      <div className="px-3 py-6 text-center text-xs text-token-description-foreground">
        {runtime.error ?? "Loading settings…"}
      </div>
    );
  } else if (route.kind === "root" || route.kind === "view") {
    body = (
      <ViewOverview
        runtime={runtime}
        activeView={activeView}
        push={onPush}
        onSelectView={onSelectView}
        onProjectionCommitted={onProjectionCommitted}
        viewNameFocusRequest={viewNameFocusRequest}
        viewActionMenu={viewActionMenu}
      />
    );
  } else if (route.kind === "create_view") {
    body = <CreateViewRoute runtime={runtime} onSelectView={onSelectView} />;
  } else if (route.kind === "view_layout") {
    body = (
      <>
        <ViewLayoutRoute runtime={runtime} onProjectionCommitted={onProjectionCommitted} />
        <ViewLayoutOptionsRoute
          effective={effectivePresentation}
          properties={model.query.properties}
          busy={presentationLocked}
          onChange={onChangePresentation}
          personalActions={personalActions}
        />
      </>
    );
  } else if (route.kind === "view_properties") {
    body = (
      <ViewPropertiesRoute
        effective={effectivePresentation}
        properties={model.query.properties}
        busy={presentationLocked}
        onChange={onChangePresentation}
        personalActions={personalActions}
      />
    );
  } else if (route.kind === "view_group") {
    body = (
      <ViewGroupingRoute
        kind="group"
        effective={effectivePresentation}
        properties={model.query.properties}
        busy={presentationLocked}
        onChange={onChangePresentation}
        personalActions={personalActions}
      />
    );
  } else if (route.kind === "view_subgroup") {
    body = (
      <ViewGroupingRoute
        kind="subgroup"
        effective={effectivePresentation}
        properties={model.query.properties}
        busy={presentationLocked}
        onChange={onChangePresentation}
        personalActions={personalActions}
      />
    );
  } else if (route.kind === "view_display") {
    body = (
      <ViewLayoutOptionsRoute
        effective={effectivePresentation}
        properties={model.query.properties}
        busy={presentationLocked}
        onChange={onChangePresentation}
        personalActions={personalActions}
      />
    );
  } else if (route.kind === "view_conditional_color") {
    body = (
      <ViewConditionalColorRoute
        runtime={runtime}
        activeView={activeView}
        properties={model.query.properties}
        optionRegistries={optionRegistries}
        onRequestPropertyOptions={onRequestPropertyOptions}
        onProjectionCommitted={onProjectionCommitted}
      />
    );
  } else if (route.kind === "source_properties") {
    body = <SourcePropertiesRoute runtime={runtime} push={onPush} />;
  } else if (route.kind === "create_property") {
    body = <CreatePropertyRoute runtime={runtime} replace={onReplace} />;
  } else if (route.kind === "property") {
    body = (
      <PropertyRoute
        runtime={runtime}
        propertyId={route.propertyId}
        push={onPush}
        onBack={onBack}
        optionRegistries={optionRegistries}
        onRequestPropertyOptions={onRequestPropertyOptions}
      />
    );
  } else if (route.kind === "property_type") {
    body = <PropertyTypeRoute runtime={runtime} propertyId={route.propertyId} />;
  } else if (route.kind === "property_options") {
    body = (
      <PropertyOptionsRoute
        runtime={runtime}
        propertyId={route.propertyId}
        optionRegistries={optionRegistries}
        onRequestPropertyOptions={onRequestPropertyOptions}
      />
    );
  } else if (route.kind === "deleted_properties") {
    body = <DeletedPropertiesRoute runtime={runtime} />;
  } else if (route.kind === "page_layout") {
    body = <PageLayoutRoute runtime={runtime} dataSourceId={route.dataSourceId} />;
  }
  return (
    <aside
      aria-label="Database settings"
      data-testid="database-settings-rail"
      data-database-settings-entered={entered}
      data-database-presentation-activity={presentationActivity.phase}
      style={{
        opacity: entered ? 1 : 0,
        transform: `translateX(${entered ? 0 : 12}px)`,
      }}
      className={cn(
        "absolute inset-y-0 right-0 z-40 h-full min-h-0 w-[290px] max-w-full border-l-[0.5px] border-token-border/70",
        "bg-token-main-surface-primary font-normal text-token-text-primary transition-[opacity,transform] duration-200 [transition-timing-function:ease] motion-reduce:duration-[1ms]",
        "max-[880px]:shadow-[-12px_0_28px_color-mix(in_srgb,var(--foreground)_10%,transparent)]",
      )}
    >
      <div className="flex h-full min-h-0 w-full flex-col">
        <div
          ref={headerRef}
          className={cn("flex h-[42px] shrink-0 items-center", rootRoute ? "px-4" : "px-[10px]")}
        >
          {!rootRoute ? (
            <button
              type="button"
              aria-label="Back"
              onClick={onBack}
              className="-ml-0.5 mr-2 flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border/60"
            >
              <ChevronLeft className="icon-xs" />
            </button>
          ) : null}
          <h2
            className={cn(
              "min-w-0 flex-1 truncate",
              rootRoute
                ? "text-xs font-medium leading-4 text-token-description-foreground"
                : "text-sm font-semibold leading-[21px] text-token-text-primary",
            )}
          >
            {routeTitle}
          </h2>
          <button
            type="button"
            aria-label="Close settings"
            onClick={onClose}
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-token-text-secondary outline-none hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:ring-2 focus-visible:ring-token-focus-border/60"
          >
            <CloseIcon className="icon-2xs" />
          </button>
        </div>
        {runtime.error ? (
          <div
            role="alert"
            className="shrink-0 border-b-[0.5px] border-token-border/70 px-3 py-2 text-xs text-token-error-foreground"
          >
            {runtime.error}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">{body}</div>
      </div>
    </aside>
  );
}

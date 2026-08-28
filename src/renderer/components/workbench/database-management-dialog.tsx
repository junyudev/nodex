import {
  DatabaseIcon,
  DeleteIcon,
  ListLayoutIcon,
  MoveDownIcon,
  MoveUpIcon,
  PlusIcon,
} from "@/components/shared/icons";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Columns3, SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import {
  databaseViewReferencedPropertyIdsV4,
  type DatabasePropertyOption,
  type DatabasePropertyValueType,
  type DatabaseViewConfigV4,
  type DatabaseViewLayout,
} from "../../../shared/database-kernel";
import type {
  DatabaseContainerDescriptorV2,
  DataSourceDescriptorV2,
} from "../../../shared/database-module-v2";
import { createCustomOptionId } from "../../../shared/database-identities";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  databaseViewConfigsEqual,
  databaseViewMoveBeforeId,
  readDatabasePropertyOptions,
} from "@/lib/database-view-authoring";
import { cn } from "@/lib/utils";
import { DatabaseViewConfigEditor } from "./database-view-config-editor";
import { DatabaseViewSelect } from "./database-view-select";
import {
  DATA_SOURCE_PROPERTY_TYPE_LABELS,
  dataSourcePropertyTypeIcon,
} from "../database/data-source-property-presentation";
import { databasePropertyOptionDotColor } from "../database/property-value-chip";

export interface CreateDatabasePropertyDraft {
  readonly dataSourceId: string;
  readonly name: string;
  readonly valueType: DatabasePropertyValueType;
  readonly targetDataSourceId?: string;
}

export interface CreateDatabaseViewDraft {
  readonly databaseId: string;
  readonly dataSourceId: string;
  readonly name: string;
  readonly defaultLayout: DatabaseViewLayout;
}

export interface UpdateDatabaseViewDraft extends CreateDatabaseViewDraft {
  readonly viewId: string;
  readonly expectedRevision: number;
  readonly config: DatabaseViewConfigV4;
  /** Undefined preserves placement; null appends. */
  readonly beforeViewId?: string | null;
}

export interface PutDatabasePropertyOptionDraft {
  readonly dataSourceId: string;
  readonly propertyId: string;
  readonly option: DatabasePropertyOption;
}

export interface DatabaseManagementSurfaceProps {
  readonly databases: readonly DatabaseContainerDescriptorV2[];
  readonly source: DataSourceDescriptorV2 | null;
  readonly selectedDatabaseId: string | null;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onSelectDatabase: (databaseId: string) => void;
  readonly onCreateProperty: (draft: CreateDatabasePropertyDraft) => void | Promise<void>;
  readonly onDeleteProperty: (dataSourceId: string, propertyId: string) => void | Promise<void>;
  readonly onCreateView: (draft: CreateDatabaseViewDraft) => void | Promise<void>;
  readonly onUpdateView: (draft: UpdateDatabaseViewDraft) => void | Promise<void>;
  readonly onDeleteView: (databaseId: string, viewId: string) => void | Promise<void>;
  readonly onPutPropertyOption: (draft: PutDatabasePropertyOptionDraft) => void | Promise<void>;
  readonly onDeletePropertyOption: (
    dataSourceId: string,
    propertyId: string,
    optionId: string,
  ) => void | Promise<void>;
}

interface DatabaseManagementDialogProps extends DatabaseManagementSurfaceProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

const PROPERTY_TYPES: readonly {
  readonly value: DatabasePropertyValueType;
  readonly label: string;
}[] = [
  ...Object.entries(DATA_SOURCE_PROPERTY_TYPE_LABELS).map(([value, label]) => ({
    value: value as DatabasePropertyValueType,
    label,
  })),
];

const VIEW_LAYOUTS: readonly {
  readonly value: DatabaseViewLayout;
  readonly label: string;
}[] = [
  { value: "list", label: "List" },
  { value: "board", label: "Board" },
];

const viewLayoutIcon = (layout: DatabaseViewLayout) =>
  layout === "board" ? Columns3 : ListLayoutIcon;

const submitTrimmed = (
  event: FormEvent<HTMLFormElement>,
  value: string,
  submit: (value: string) => void,
): void => {
  event.preventDefault();
  const normalized = value.trim();
  if (normalized) submit(normalized);
};

function SectionHeader({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="mb-2 flex min-w-0 items-end gap-3">
      <h3 className="shrink-0 text-sm font-medium text-token-text-primary">{title}</h3>
      <p className="truncate pb-px text-xs text-token-description-foreground">{detail}</p>
    </div>
  );
}

export function DatabaseManagementSurface({
  databases,
  source,
  selectedDatabaseId,
  busy = false,
  error = null,
  onSelectDatabase,
  onCreateProperty,
  onDeleteProperty,
  onCreateView,
  onUpdateView,
  onDeleteView,
  onPutPropertyOption,
  onDeletePropertyOption,
}: DatabaseManagementSurfaceProps) {
  const descriptor =
    databases.find((candidate) => candidate.database.databaseId === selectedDatabaseId) ??
    databases[0] ??
    null;
  const [propertyName, setPropertyName] = useState("");
  const [propertyType, setPropertyType] = useState<DatabasePropertyValueType>("text");
  const [relationTargetDataSourceId, setRelationTargetDataSourceId] = useState<string>("");
  const [viewName, setViewName] = useState("");
  const [viewLayout, setViewLayout] = useState<DatabaseViewLayout>("list");
  const [viewDrafts, setViewDrafts] = useState<
    Readonly<
      Record<
        string,
        {
          readonly baseRevision: number;
          readonly name: string;
          readonly defaultLayout: DatabaseViewLayout;
          readonly config: DatabaseViewConfigV4;
        }
      >
    >
  >({});
  const [expandedViewId, setExpandedViewId] = useState<string | null>(null);
  const [optionDrafts, setOptionDrafts] = useState<Readonly<Record<string, string>>>({});
  const [pendingDeletePropertyId, setPendingDeletePropertyId] = useState<string | null>(null);

  useEffect(() => {
    if (!descriptor) return;
    if (descriptor.database.databaseId === selectedDatabaseId) return;
    onSelectDatabase(descriptor.database.databaseId);
  }, [descriptor, onSelectDatabase, selectedDatabaseId]);

  const activeProperties = useMemo(
    () => source?.properties.filter((property) => property.lifecycle === "active") ?? [],
    [source?.properties],
  );
  const activeViews =
    descriptor?.views.filter(
      (view) =>
        view.lifecycle === "active" && view.dataSourceId === source?.dataSource.dataSourceId,
    ) ?? [];

  useEffect(() => {
    if (!pendingDeletePropertyId) return;
    if (activeProperties.some((property) => property.propertyId === pendingDeletePropertyId))
      return;
    setPendingDeletePropertyId(null);
  }, [activeProperties, pendingDeletePropertyId]);

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] bg-token-main-surface-primary max-sm:grid-cols-1">
      <aside className="flex min-h-0 flex-col border-r-[0.5px] border-token-border bg-token-side-bar-background max-sm:hidden">
        <div className="px-3 pb-3 pt-4">
          <h2 className="flex items-center gap-2 text-base font-medium text-token-text-primary">
            <DatabaseIcon className="size-4 shrink-0 text-token-description-foreground" />
            Databases
          </h2>
          <p className="mt-1 truncate text-xs text-token-description-foreground">
            Project binding and granted resources
          </p>
        </div>
        <nav aria-label="Authorized Databases" className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          {databases.map((candidate) => {
            const selected = candidate.database.databaseId === descriptor?.database.databaseId;
            const activeSourceCount = candidate.dataSources.filter(
              (dataSource) => dataSource.lifecycle === "active",
            ).length;
            return (
              <button
                key={candidate.database.databaseId}
                type="button"
                aria-current={selected ? "page" : undefined}
                onClick={() => onSelectDatabase(candidate.database.databaseId)}
                className={cn(
                  "mb-0.5 flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm outline-none",
                  "focus-visible:ring-2 focus-visible:ring-token-focus",
                  selected
                    ? "bg-transparent text-token-text-primary ring-[0.5px] ring-inset ring-token-border-heavy"
                    : "text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-text-primary",
                )}
              >
                <DatabaseIcon className="size-3.5 shrink-0 opacity-70" />
                <span className="min-w-0 flex-1 truncate">{candidate.database.name}</span>
                <span className="shrink-0 text-[10px] tabular-nums text-token-description-foreground">
                  {activeSourceCount} source
                </span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="min-h-0 overflow-y-auto bg-token-main-surface-primary px-5 pb-6 pt-4 max-sm:px-3">
        {descriptor && source ? (
          <>
            <header className="mb-6 pr-9">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate text-lg font-medium text-token-text-primary">
                  {descriptor.database.name}
                </h2>
                <span className="shrink-0 rounded-md bg-transparent px-1.5 py-0.5 text-[10px] text-token-description-foreground ring-[0.5px] ring-inset ring-token-border">
                  {source.dataSource.name}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-token-description-foreground">
                {activeProperties.length} properties · {activeViews.length} Views · single Source
              </p>
            </header>

            <section className="mb-7" aria-labelledby="database-properties-heading">
              <SectionHeader title="Properties" detail="Schema owned by this Data Source" />
              <h3 id="database-properties-heading" className="sr-only">
                Data Source properties
              </h3>
              <div className="divide-y-[0.5px] divide-token-border border-y-[0.5px] border-token-border">
                {activeProperties.map((property) => {
                  const Icon = dataSourcePropertyTypeIcon(property.valueType);
                  const options = readDatabasePropertyOptions(property);
                  const deletePending = pendingDeletePropertyId === property.propertyId;
                  const blockingViews = activeViews.filter((view) =>
                    databaseViewReferencedPropertyIdsV4(view.config).includes(property.propertyId),
                  );
                  return (
                    <div key={property.propertyId} className="group py-2.5">
                      <div className="flex min-h-7 items-center gap-2">
                        <Icon className="size-3.5 shrink-0 text-token-description-foreground" />
                        <span className="min-w-0 flex-1 truncate text-sm text-token-text-primary">
                          {property.name}
                        </span>
                        <span className="shrink-0 text-xs text-token-description-foreground">
                          {PROPERTY_TYPES.find((type) => type.value === property.valueType)?.label}
                        </span>
                        <NodexIconButton
                          icon={DeleteIcon}
                          size="xs"
                          tone="danger"
                          ariaLabel={`Delete property ${property.name}`}
                          disabled={busy}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={() =>
                            setPendingDeletePropertyId(deletePending ? null : property.propertyId)
                          }
                        />
                      </div>
                      {deletePending ? (
                        <div
                          role={blockingViews.length > 0 ? "alert" : "group"}
                          aria-label={`Confirm deletion of property ${property.name}`}
                          className="ml-5 mt-1.5 flex min-h-8 items-center gap-2 border-l-2 border-token-error-foreground/35 pl-2"
                        >
                          <p className="min-w-0 flex-1 text-xs text-token-description-foreground">
                            {blockingViews.length > 0
                              ? `Used by ${blockingViews.map((view) => view.name).join(", ")}. Remove it from those Views first.`
                              : "Delete this Property and its values from every Page?"}
                          </p>
                          <NodexButton
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => setPendingDeletePropertyId(null)}
                          >
                            Cancel
                          </NodexButton>
                          {blockingViews.length === 0 ? (
                            <NodexButton
                              type="button"
                              size="xs"
                              variant="destructive"
                              disabled={busy}
                              aria-label={`Confirm delete property ${property.name}`}
                              onClick={() => {
                                setPendingDeletePropertyId(null);
                                void onDeleteProperty(
                                  source.dataSource.dataSourceId,
                                  property.propertyId,
                                );
                              }}
                            >
                              Delete
                            </NodexButton>
                          ) : null}
                        </div>
                      ) : null}
                      {property.valueType === "select" || property.valueType === "multi_select" ? (
                        <div className="ml-5 mt-2 flex flex-wrap items-center gap-1.5">
                          {options.map((option) => (
                            <span
                              key={option.id}
                              className="group/option inline-flex h-6 items-center gap-1.5 rounded-md bg-transparent pl-1.5 pr-1 text-xs text-token-text-secondary ring-[0.5px] ring-inset ring-token-border"
                            >
                              <span
                                aria-hidden="true"
                                className="size-1.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: databasePropertyOptionDotColor(
                                    option.color,
                                    option.id,
                                  ),
                                }}
                              />
                              {option.name}
                              <button
                                type="button"
                                aria-label={`Delete option ${option.name}`}
                                disabled={busy}
                                onClick={() =>
                                  void onDeletePropertyOption(
                                    source.dataSource.dataSourceId,
                                    property.propertyId,
                                    option.id,
                                  )
                                }
                                className="rounded p-0.5 text-token-description-foreground opacity-0 hover:text-token-error-foreground group-hover/option:opacity-100 focus-visible:opacity-100"
                              >
                                <DeleteIcon className="size-3 shrink-0" />
                              </button>
                            </span>
                          ))}
                          <form
                            onSubmit={(event) =>
                              submitTrimmed(
                                event,
                                optionDrafts[property.propertyId] ?? "",
                                (name) => {
                                  void onPutPropertyOption({
                                    dataSourceId: source.dataSource.dataSourceId,
                                    propertyId: property.propertyId,
                                    option: { id: createCustomOptionId(), name },
                                  });
                                  setOptionDrafts((current) => ({
                                    ...current,
                                    [property.propertyId]: "",
                                  }));
                                },
                              )
                            }
                          >
                            <input
                              aria-label={`Add option to ${property.name}`}
                              value={optionDrafts[property.propertyId] ?? ""}
                              disabled={busy}
                              onInput={(event) =>
                                setOptionDrafts((current) => ({
                                  ...current,
                                  [property.propertyId]: event.currentTarget.value,
                                }))
                              }
                              placeholder="Add option"
                              className="h-6 w-24 bg-transparent px-1 text-xs text-token-text-secondary outline-none placeholder:text-token-description-foreground focus:w-32"
                            />
                          </form>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <form
                  className="flex items-center gap-2 py-2.5"
                  onSubmit={(event) =>
                    submitTrimmed(event, propertyName, (name) => {
                      void onCreateProperty({
                        dataSourceId: source.dataSource.dataSourceId,
                        name,
                        valueType: propertyType,
                        ...(propertyType === "relation"
                          ? {
                              targetDataSourceId:
                                relationTargetDataSourceId || source.dataSource.dataSourceId,
                            }
                          : {}),
                      });
                      setPropertyName("");
                    })
                  }
                >
                  <PlusIcon className="size-3.5 shrink-0 text-token-description-foreground" />
                  <Input
                    aria-label="New property name"
                    value={propertyName}
                    disabled={busy}
                    onInput={(event) => setPropertyName(event.currentTarget.value)}
                    placeholder="New property"
                    className="h-8 min-w-0 flex-1 border-transparent bg-transparent text-sm focus:bg-token-input-background"
                  />
                  <DatabaseViewSelect
                    ariaLabel="New property type"
                    value={propertyType}
                    valueLabel={DATA_SOURCE_PROPERTY_TYPE_LABELS[propertyType]}
                    disabled={busy}
                    onValueChange={(value) => setPropertyType(value as DatabasePropertyValueType)}
                    options={PROPERTY_TYPES}
                    triggerStyle="settings"
                    className="min-w-28"
                  />
                  {propertyType === "relation" ? (
                    <DatabaseViewSelect
                      ariaLabel="Relation target database"
                      search="filter"
                      searchPlaceholder="Search databases…"
                      value={relationTargetDataSourceId || source.dataSource.dataSourceId}
                      valueLabel={
                        databases
                          .flatMap((database) =>
                            database.dataSources.map((dataSource) => ({
                              dataSourceId: dataSource.dataSourceId,
                              name: database.database.name,
                            })),
                          )
                          .find(
                            (candidate) =>
                              candidate.dataSourceId ===
                              (relationTargetDataSourceId || source.dataSource.dataSourceId),
                          )?.name ?? "Current database"
                      }
                      disabled={busy}
                      onValueChange={setRelationTargetDataSourceId}
                      options={databases.flatMap((database) =>
                        database.dataSources
                          .filter((dataSource) => dataSource.lifecycle === "active")
                          .map((dataSource) => ({
                            value: dataSource.dataSourceId,
                            label: database.database.name,
                          })),
                      )}
                      triggerStyle="settings"
                      className="max-w-40"
                    />
                  ) : null}
                  <NodexButton
                    type="submit"
                    size="xs"
                    variant="secondary"
                    disabled={busy || !propertyName.trim()}
                  >
                    Add
                  </NodexButton>
                </form>
              </div>
            </section>

            <section aria-labelledby="database-views-heading">
              <SectionHeader title="Views" detail="Presentation over this Data Source" />
              <h3 id="database-views-heading" className="sr-only">
                Database Views
              </h3>
              <div className="divide-y-[0.5px] divide-token-border border-y-[0.5px] border-token-border">
                {activeViews.map((view, index) => {
                  const storedDraft = viewDrafts[view.viewId];
                  const storedMatchesAuthority = storedDraft
                    ? storedDraft.name.trim() === view.name &&
                      storedDraft.defaultLayout === view.defaultLayout &&
                      databaseViewConfigsEqual(storedDraft.config, view.config)
                    : false;
                  const draft =
                    storedDraft && !storedMatchesAuthority
                      ? storedDraft
                      : {
                          baseRevision: view.revision,
                          name: view.name,
                          defaultLayout: view.defaultLayout,
                          config: view.config,
                        };
                  const stale = draft.baseRevision !== view.revision;
                  const Icon = viewLayoutIcon(draft.defaultLayout);
                  const changed =
                    draft.name.trim() !== view.name ||
                    draft.defaultLayout !== view.defaultLayout ||
                    !databaseViewConfigsEqual(draft.config, view.config);
                  const expanded = expandedViewId === view.viewId;
                  const moveUpBeforeId = databaseViewMoveBeforeId(activeViews, view.viewId, "up");
                  const moveDownBeforeId = databaseViewMoveBeforeId(
                    activeViews,
                    view.viewId,
                    "down",
                  );
                  const updateDraft = (
                    update: Partial<Pick<typeof draft, "name" | "defaultLayout" | "config">>,
                  ) =>
                    setViewDrafts((current) => ({
                      ...current,
                      [view.viewId]: { ...draft, ...update },
                    }));
                  const submitView = (beforeViewId?: string | null): void => {
                    void onUpdateView({
                      databaseId: descriptor.database.databaseId,
                      dataSourceId: source.dataSource.dataSourceId,
                      viewId: view.viewId,
                      expectedRevision: draft.baseRevision,
                      name: draft.name.trim(),
                      defaultLayout: draft.defaultLayout,
                      config: draft.config,
                      ...(beforeViewId === undefined ? {} : { beforeViewId }),
                    });
                  };
                  return (
                    <div key={view.viewId} className="group/view">
                      <div className="flex min-h-10 items-center gap-1.5 py-1.5">
                        <Icon className="size-3.5 shrink-0 text-token-description-foreground" />
                        <Input
                          aria-label={`View name ${view.name}`}
                          value={draft.name}
                          disabled={busy || stale}
                          onInput={(event) =>
                            updateDraft({
                              name: event.currentTarget.value,
                            })
                          }
                          className="h-8 min-w-0 flex-1 border-transparent bg-transparent text-sm focus:bg-token-input-background"
                        />
                        <DatabaseViewSelect
                          ariaLabel={`Default layout ${view.name}`}
                          value={draft.defaultLayout}
                          valueLabel={
                            VIEW_LAYOUTS.find((layout) => layout.value === draft.defaultLayout)
                              ?.label ?? "List"
                          }
                          disabled={busy || stale}
                          onValueChange={(value) =>
                            updateDraft({
                              defaultLayout: value as DatabaseViewLayout,
                            })
                          }
                          options={VIEW_LAYOUTS}
                          triggerStyle="settings"
                          className="w-24"
                        />
                        <NodexIconButton
                          icon={SlidersHorizontal}
                          size="xs"
                          active={expanded}
                          ariaLabel={`${expanded ? "Hide" : "Edit"} View settings ${view.name}`}
                          disabled={busy}
                          onClick={() => setExpandedViewId(expanded ? null : view.viewId)}
                        />
                        <NodexIconButton
                          icon={MoveUpIcon}
                          size="xs"
                          ariaLabel={`Move View ${view.name} up`}
                          disabled={
                            busy || stale || changed || index === 0 || moveUpBeforeId === undefined
                          }
                          onClick={() => submitView(moveUpBeforeId)}
                        />
                        <NodexIconButton
                          icon={MoveDownIcon}
                          size="xs"
                          ariaLabel={`Move View ${view.name} down`}
                          disabled={
                            busy ||
                            stale ||
                            changed ||
                            index === activeViews.length - 1 ||
                            moveDownBeforeId === undefined
                          }
                          onClick={() => submitView(moveDownBeforeId)}
                        />
                        {stale ? (
                          <NodexTooltip tooltipContent="This View changed in another window">
                            <NodexButton
                              type="button"
                              size="xs"
                              variant="ghost"
                              disabled={busy}
                              aria-label={`Reload View ${view.name}`}
                              onClick={() =>
                                setViewDrafts((current) => {
                                  const next = { ...current };
                                  delete next[view.viewId];
                                  return next;
                                })
                              }
                            >
                              Reload
                            </NodexButton>
                          </NodexTooltip>
                        ) : (
                          <NodexButton
                            type="button"
                            size="xs"
                            variant="ghost"
                            disabled={busy || !changed || !draft.name.trim()}
                            aria-label={`Save View ${view.name}`}
                            onClick={() => submitView()}
                          >
                            Save
                          </NodexButton>
                        )}
                        {view.isDefault ? (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide text-token-description-foreground">
                            Default
                          </span>
                        ) : (
                          <NodexIconButton
                            icon={DeleteIcon}
                            size="xs"
                            tone="danger"
                            ariaLabel={`Delete View ${view.name}`}
                            disabled={busy}
                            className="opacity-0 group-hover/view:opacity-100 focus-visible:opacity-100"
                            onClick={() =>
                              void onDeleteView(descriptor.database.databaseId, view.viewId)
                            }
                          />
                        )}
                      </div>
                      {expanded ? (
                        <div className="mb-2 rounded-lg bg-transparent px-2 ring-[0.5px] ring-inset ring-token-border">
                          <DatabaseViewConfigEditor
                            config={draft.config}
                            layout={draft.defaultLayout}
                            properties={activeProperties}
                            disabled={busy || stale}
                            onChange={(config) => updateDraft({ config })}
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <form
                  className="flex items-center gap-2 py-2.5"
                  onSubmit={(event) =>
                    submitTrimmed(event, viewName, (name) => {
                      void onCreateView({
                        databaseId: descriptor.database.databaseId,
                        dataSourceId: source.dataSource.dataSourceId,
                        name,
                        defaultLayout: viewLayout,
                      });
                      setViewName("");
                    })
                  }
                >
                  <PlusIcon className="size-3.5 shrink-0 text-token-description-foreground" />
                  <Input
                    aria-label="New View name"
                    value={viewName}
                    disabled={busy}
                    onInput={(event) => setViewName(event.currentTarget.value)}
                    placeholder="New View"
                    className="h-8 min-w-0 flex-1 border-transparent bg-transparent text-sm focus:bg-token-input-background"
                  />
                  <DatabaseViewSelect
                    ariaLabel="New View default layout"
                    value={viewLayout}
                    valueLabel={
                      VIEW_LAYOUTS.find((layout) => layout.value === viewLayout)?.label ?? "List"
                    }
                    disabled={busy}
                    onValueChange={(value) => setViewLayout(value as DatabaseViewLayout)}
                    options={VIEW_LAYOUTS}
                    triggerStyle="settings"
                    className="w-24"
                  />
                  <NodexButton
                    type="submit"
                    size="xs"
                    variant="secondary"
                    disabled={busy || !viewName.trim()}
                  >
                    Add
                  </NodexButton>
                </form>
              </div>
            </section>

            {error ? (
              <p role="alert" className="mt-5 text-sm text-token-error-foreground">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <DatabaseIcon className="mb-2 size-5 shrink-0 text-token-description-foreground" />
            <p className="text-sm font-medium text-token-text-primary">Database unavailable</p>
            <p className="mt-1 max-w-xs text-xs text-token-description-foreground">
              This Project needs an active Database binding and Data Source.
            </p>
            {error ? (
              <p role="alert" className="mt-3 text-xs text-token-error-foreground">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

export function DatabaseManagementDialog({
  open,
  onOpenChange,
  ...surfaceProps
}: DatabaseManagementDialogProps) {
  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent
        className="flex h-[min(680px,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] w-[min(900px,calc(100vw-2rem))] max-w-none sm:max-w-none"
        closeButtonAriaLabel="Close Database manager"
      >
        <NodexDialogTitle className="sr-only">Manage Databases</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">
          Manage Data Source properties and durable Database Views.
        </NodexDialogDescription>
        <DatabaseManagementSurface {...surfaceProps} />
      </NodexDialogContent>
    </NodexDialog>
  );
}

import { DeleteIcon, PlusIcon } from "@/components/shared/icons";
import { FilterIcon, MoveDownIcon, MoveUpIcon } from "@/components/shared/icons";
import { useEffect, type ReactNode } from "react";
import type {
  DatabaseJsonValue,
  DatabaseViewFilterClause,
  DatabaseViewFilterNode,
  DatabaseViewFilterOperator,
  DatabaseViewLayout,
  DatabaseViewSort,
  DatabaseViewConfigV4,
  DatabasePropertyOption,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { NodexButton, NodexIconButton, NodexSwitch } from "@/components/ui/button";
import {
  appendDatabaseViewFilterChild,
  createDatabaseViewFilterClause,
  createDatabaseViewSort,
  databaseFilterClauseWithOperator,
  databaseFilterClauseWithProperty,
  filterOperatorsForProperty,
  moveDatabaseViewSort,
  readDatabasePropertyOptions,
  removeDatabaseViewFilterNode,
  updateDatabaseViewFilterNode,
  type DatabaseViewFilterPath,
} from "@/lib/database-view-authoring";
import { cn } from "@/lib/utils";
import { databaseIntrinsicFieldsForLayout } from "@/lib/database-intrinsic-field-registry";
import { useObjectIdentityKey } from "@/lib/use-object-identity-keys";
import { DatabaseViewSelect } from "./database-view-select";

interface DatabaseViewConfigEditorProps {
  readonly config: DatabaseViewConfigV4;
  readonly layout: DatabaseViewLayout;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries?: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly disabled?: boolean;
  readonly onlyFilter?: boolean;
  readonly onChange: (config: DatabaseViewConfigV4) => void;
}

const EMPTY_OPTION_REGISTRIES: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {};

const inputClass = cn(
  "h-7 min-w-0 rounded-md border border-transparent bg-token-foreground/5 px-2 text-xs",
  "text-token-text-primary outline-none placeholder:text-token-description-foreground focus:border-token-focus-border",
);

const FILTER_OPERATOR_LABELS: Readonly<Record<DatabaseViewFilterOperator, string>> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "does not contain",
  is_empty: "is empty",
  is_not_empty: "is not empty",
};

const activeProperties = (
  properties: readonly DataSourcePropertyRecordV2[],
): readonly DataSourcePropertyRecordV2[] =>
  properties.filter((property) => property.lifecycle === "active");

const propertyForClause = (
  properties: readonly DataSourcePropertyRecordV2[],
  clause: DatabaseViewFilterClause,
): DataSourcePropertyRecordV2 | null =>
  properties.find((property) => property.propertyId === clause.propertyId) ?? null;

const stringValue = (value: DatabaseJsonValue | undefined): string =>
  typeof value === "string" ? value : "";

const datetimeLocalValue = (value: DatabaseJsonValue | undefined): string => {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
};

function FilterValueField({
  clause,
  property,
  options,
  onRequestOptions,
  disabled,
  onChange,
}: {
  readonly clause: DatabaseViewFilterClause;
  readonly property: DataSourcePropertyRecordV2;
  readonly options: readonly DatabasePropertyOption[];
  readonly onRequestOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly disabled: boolean;
  readonly onChange: (value: DatabaseJsonValue) => void;
}) {
  useEffect(() => {
    if (property.valueType !== "select" && property.valueType !== "multi_select") return;
    onRequestOptions?.(property);
  }, [onRequestOptions, property]);
  if (clause.operator === "is_empty" || clause.operator === "is_not_empty") {
    return null;
  }
  if (property.valueType === "checkbox") {
    const value = clause.value === true ? "true" : "false";
    return (
      <DatabaseViewSelect
        ariaLabel={`Filter value for ${property.name}`}
        value={value}
        valueLabel={value === "true" ? "Checked" : "Unchecked"}
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue === "true")}
        options={[
          { value: "true", label: "Checked" },
          { value: "false", label: "Unchecked" },
        ]}
        className="w-24"
      />
    );
  }
  if (property.valueType === "select" || property.valueType === "multi_select") {
    const isMembershipOperator =
      clause.operator === "contains" || clause.operator === "not_contains";
    const rawValue =
      property.valueType === "multi_select" && !isMembershipOperator
        ? Array.isArray(clause.value) && typeof clause.value[0] === "string"
          ? clause.value[0]
          : ""
        : stringValue(clause.value);
    const selectedOption = options.find((option) => option.id === rawValue);
    return (
      <DatabaseViewSelect
        ariaLabel={`Filter value for ${property.name}`}
        search="filter"
        searchPlaceholder={`Search ${property.name} options…`}
        value={rawValue}
        valueLabel={selectedOption?.name ?? "None"}
        disabled={disabled}
        onValueChange={(value) => {
          onChange(
            property.valueType === "multi_select" && !isMembershipOperator
              ? value
                ? [value]
                : []
              : value || null,
          );
        }}
        options={[
          { value: "", label: "None" },
          ...options.map((option) => ({ value: option.id, label: option.name })),
        ]}
        className="min-w-24 max-w-36"
      />
    );
  }
  if (property.valueType === "number") {
    return (
      <input
        type="number"
        aria-label={`Filter value for ${property.name}`}
        value={typeof clause.value === "number" ? String(clause.value) : ""}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
        className={cn(inputClass, "w-28")}
      />
    );
  }
  return (
    <input
      type={
        property.valueType === "date"
          ? "date"
          : property.valueType === "datetime"
            ? "datetime-local"
            : "text"
      }
      aria-label={`Filter value for ${property.name}`}
      value={
        property.valueType === "datetime"
          ? datetimeLocalValue(clause.value)
          : stringValue(clause.value)
      }
      disabled={disabled}
      onChange={(event) => {
        if (property.valueType !== "datetime") {
          onChange(event.target.value);
          return;
        }
        const parsed = new Date(event.target.value);
        onChange(Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString());
      }}
      className={cn(inputClass, "w-36")}
    />
  );
}

function FilterNodeEditor({
  node,
  path,
  depth,
  properties,
  optionRegistries,
  onRequestPropertyOptions,
  disabled,
  onUpdate,
  onRemove,
  onAppend,
}: {
  readonly node: DatabaseViewFilterNode;
  readonly path: DatabaseViewFilterPath;
  readonly depth: number;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly disabled: boolean;
  readonly onUpdate: (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) => void;
  readonly onRemove: (path: DatabaseViewFilterPath) => void;
  readonly onAppend: (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) => void;
}) {
  const objectIdentityKey = useObjectIdentityKey();
  if (node.kind === "clause") {
    const property = propertyForClause(properties, node);
    if (!property) {
      return (
        <div className="flex min-h-8 items-center gap-2 rounded-md bg-token-error-background/30 px-2 text-xs text-token-error-foreground">
          <span className="min-w-0 flex-1 truncate">Missing property {node.propertyId}</span>
          <NodexIconButton
            icon={DeleteIcon}
            size="xs"
            tone="danger"
            ariaLabel="Remove invalid filter"
            disabled={disabled}
            onClick={() => onRemove(path)}
          />
        </div>
      );
    }
    return (
      <div className="flex min-h-8 flex-wrap items-center gap-1.5">
        <DatabaseViewSelect
          ariaLabel={`Filter property ${property.name}`}
          search="filter"
          searchPlaceholder="Search properties…"
          value={property.propertyId}
          valueLabel={property.name}
          disabled={disabled}
          onValueChange={(value) => {
            const nextProperty = properties.find((candidate) => candidate.propertyId === value);
            if (!nextProperty) return;
            onUpdate(path, databaseFilterClauseWithProperty(node, nextProperty));
          }}
          options={properties.map((candidate) => ({
            value: candidate.propertyId,
            label: candidate.name,
          }))}
          className="min-w-28 max-w-40"
        />
        <DatabaseViewSelect
          ariaLabel={`Filter operator for ${property.name}`}
          value={node.operator}
          valueLabel={FILTER_OPERATOR_LABELS[node.operator]}
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate(
              path,
              databaseFilterClauseWithOperator(property, value as DatabaseViewFilterOperator),
            )
          }
          options={filterOperatorsForProperty(property).map((operator) => ({
            value: operator,
            label: FILTER_OPERATOR_LABELS[operator],
          }))}
          className="min-w-24"
        />
        <FilterValueField
          clause={node}
          property={property}
          options={optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property)}
          onRequestOptions={onRequestPropertyOptions}
          disabled={disabled}
          onChange={(value) => onUpdate(path, { ...node, value })}
        />
        <NodexIconButton
          icon={DeleteIcon}
          size="xs"
          tone="danger"
          ariaLabel={`Remove filter ${property.name}`}
          disabled={disabled}
          onClick={() => onRemove(path)}
        />
      </div>
    );
  }

  return (
    <div className={cn("min-w-0", depth > 0 && "rounded-lg bg-token-foreground/3 px-2 py-1.5")}>
      <div className="flex min-h-8 items-center gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-token-description-foreground">
          {depth === 0 ? "Match" : "Group"}
        </span>
        <DatabaseViewSelect
          ariaLabel={
            depth === 0 ? "Filter group operator" : `Nested filter group ${path.join(".")}`
          }
          value={node.operator}
          valueLabel={node.operator === "and" ? "All" : "Any"}
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate(path, {
              ...node,
              operator: value as "and" | "or",
            })
          }
          options={[
            { value: "and", label: "All" },
            { value: "or", label: "Any" },
          ]}
          className="w-18"
        />
        <span className="text-xs text-token-description-foreground">of these rules</span>
        <div className="ml-auto flex items-center gap-1">
          {properties[0] ? (
            <NodexButton
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onAppend(path, createDatabaseViewFilterClause(properties[0]!))}
            >
              <PlusIcon /> Rule
            </NodexButton>
          ) : null}
          {depth < 7 ? (
            <NodexButton
              type="button"
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => onAppend(path, { kind: "group", operator: "and", children: [] })}
            >
              <PlusIcon /> Group
            </NodexButton>
          ) : null}
          {depth > 0 ? (
            <NodexIconButton
              icon={DeleteIcon}
              size="xs"
              tone="danger"
              ariaLabel={`Remove filter group ${path.join(".")}`}
              disabled={disabled}
              onClick={() => onRemove(path)}
            />
          ) : null}
        </div>
      </div>
      <div className={cn("space-y-1", depth > 0 && "pl-2")}>
        {node.children.map((child, index) => (
          <FilterNodeEditor
            key={objectIdentityKey(child)}
            node={child}
            path={[...path, index]}
            depth={depth + 1}
            properties={properties}
            optionRegistries={optionRegistries}
            onRequestPropertyOptions={onRequestPropertyOptions}
            disabled={disabled}
            onUpdate={onUpdate}
            onRemove={onRemove}
            onAppend={onAppend}
          />
        ))}
        {node.children.length === 0 ? (
          <p className="px-1 pb-1 text-xs text-token-description-foreground">
            No rules. This {node.operator === "and" ? "matches every" : "matches no"} Page.
          </p>
        ) : null}
      </div>
    </div>
  );
}

const sortFieldValue = (sort: DatabaseViewSort): string =>
  sort.field.kind === "property" ? `property:${sort.field.propertyId}` : sort.field.kind;

const sortWithField = (sort: DatabaseViewSort, encoded: string): DatabaseViewSort => ({
  ...sort,
  field: encoded.startsWith("property:")
    ? { kind: "property", propertyId: encoded.slice("property:".length) }
    : encoded === "manual"
      ? { kind: "manual" }
      : encoded === "created"
        ? { kind: "created" }
        : { kind: "title" },
});

function SortEditor({
  sorts,
  properties,
  disabled,
  onChange,
}: {
  readonly sorts: readonly DatabaseViewSort[];
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly disabled: boolean;
  readonly onChange: (sorts: readonly DatabaseViewSort[]) => void;
}) {
  const objectIdentityKey = useObjectIdentityKey();
  return (
    <div className="space-y-1">
      {sorts.map((sort, index) => (
        <div key={objectIdentityKey(sort)} className="flex min-h-8 items-center gap-1.5">
          <span className="w-4 text-center text-[11px] text-token-description-foreground">
            {index + 1}
          </span>
          <DatabaseViewSelect
            ariaLabel={`Sort field ${index + 1}`}
            search="filter"
            searchPlaceholder="Search sort fields…"
            value={sortFieldValue(sort)}
            valueLabel={(() => {
              if (sort.field.kind === "property") {
                const propertyId = sort.field.propertyId;
                return (
                  properties.find((property) => property.propertyId === propertyId)?.name ??
                  "Missing property"
                );
              }
              if (sort.field.kind === "manual") return "Manual order";
              if (sort.field.kind === "created") return "Created";
              return "Title";
            })()}
            disabled={disabled}
            onValueChange={(value) =>
              onChange(
                sorts.map((candidate, candidateIndex) =>
                  candidateIndex === index ? sortWithField(candidate, value) : candidate,
                ),
              )
            }
            options={[
              { value: "manual", label: "Manual order" },
              { value: "title", label: "Title" },
              { value: "created", label: "Created" },
              ...properties.map((property) => ({
                value: `property:${property.propertyId}`,
                label: property.name,
              })),
            ]}
            className="w-36"
          />
          <DatabaseViewSelect
            ariaLabel={`Sort direction ${index + 1}`}
            value={sort.direction}
            valueLabel={sort.direction === "asc" ? "Ascending" : "Descending"}
            disabled={disabled}
            onValueChange={(value) =>
              onChange(
                sorts.map((candidate, candidateIndex) =>
                  candidateIndex === index
                    ? { ...candidate, direction: value as "asc" | "desc" }
                    : candidate,
                ),
              )
            }
            options={[
              { value: "asc", label: "Ascending" },
              { value: "desc", label: "Descending" },
            ]}
            className="w-24"
          />
          <DatabaseViewSelect
            ariaLabel={`Sort empty values ${index + 1}`}
            value={sort.nulls}
            valueLabel={sort.nulls === "first" ? "Empty first" : "Empty last"}
            disabled={disabled}
            onValueChange={(value) =>
              onChange(
                sorts.map((candidate, candidateIndex) =>
                  candidateIndex === index
                    ? { ...candidate, nulls: value as "first" | "last" }
                    : candidate,
                ),
              )
            }
            options={[
              { value: "last", label: "Empty last" },
              { value: "first", label: "Empty first" },
            ]}
            className="w-24"
          />
          <NodexIconButton
            icon={MoveUpIcon}
            size="xs"
            ariaLabel={`Move sort ${index + 1} up`}
            disabled={disabled || index === 0}
            onClick={() => onChange(moveDatabaseViewSort(sorts, index, "up"))}
          />
          <NodexIconButton
            icon={MoveDownIcon}
            size="xs"
            ariaLabel={`Move sort ${index + 1} down`}
            disabled={disabled || index === sorts.length - 1}
            onClick={() => onChange(moveDatabaseViewSort(sorts, index, "down"))}
          />
          <NodexIconButton
            icon={DeleteIcon}
            size="xs"
            tone="danger"
            ariaLabel={`Remove sort ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(sorts.filter((_, candidateIndex) => candidateIndex !== index))}
          />
        </div>
      ))}
      <NodexButton
        type="button"
        size="xs"
        variant="ghost"
        disabled={disabled}
        onClick={() => onChange([...sorts, createDatabaseViewSort()])}
      >
        <PlusIcon /> Sort
      </NodexButton>
    </div>
  );
}

function ConfigSection({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid grid-cols-[112px_minmax(0,1fr)] gap-3 py-2.5 max-sm:grid-cols-1 max-sm:gap-1">
      <div>
        <h4 className="text-xs font-medium text-token-text-primary">{title}</h4>
        <p className="mt-0.5 text-[11px] leading-4 text-token-description-foreground">{detail}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export function DatabaseViewConfigEditor({
  config,
  layout,
  properties: allProperties,
  optionRegistries = EMPTY_OPTION_REGISTRIES,
  onRequestPropertyOptions,
  disabled = false,
  onlyFilter = false,
  onChange,
}: DatabaseViewConfigEditorProps) {
  const properties = activeProperties(allProperties);
  const sortableProperties = properties.filter(
    (property) => property.capabilities?.sortable ?? property.valueType !== "relation",
  );
  const groupableProperties = properties.filter(
    (property) => property.capabilities?.groupable ?? property.valueType !== "relation",
  );
  const presentation = config.presentation;
  const layoutConfig = presentation.layouts[layout];
  const intrinsicFields = databaseIntrinsicFieldsForLayout(layout);
  const updateFilter = (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) =>
    onChange({
      ...config,
      filter: updateDatabaseViewFilterNode(config.filter, path, node),
    });
  const removeFilter = (path: DatabaseViewFilterPath) =>
    onChange({
      ...config,
      filter: removeDatabaseViewFilterNode(config.filter, path),
    });
  const appendFilter = (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) =>
    onChange({
      ...config,
      filter: appendDatabaseViewFilterChild(config.filter, path, node),
    });

  const filterEditor = (
    <div className="flex items-start gap-2">
      <FilterIcon className="mt-1.5 size-3.5 shrink-0 text-token-description-foreground" />
      <div className="min-w-0 flex-1">
        {config.filter.kind === "group" ? (
          <FilterNodeEditor
            node={config.filter}
            path={[]}
            depth={0}
            properties={properties}
            optionRegistries={optionRegistries}
            onRequestPropertyOptions={onRequestPropertyOptions}
            disabled={disabled}
            onUpdate={updateFilter}
            onRemove={removeFilter}
            onAppend={appendFilter}
          />
        ) : (
          <div className="space-y-1">
            <FilterNodeEditor
              node={config.filter}
              path={[]}
              depth={0}
              properties={properties}
              optionRegistries={optionRegistries}
              onRequestPropertyOptions={onRequestPropertyOptions}
              disabled={disabled}
              onUpdate={updateFilter}
              onRemove={removeFilter}
              onAppend={appendFilter}
            />
            {properties[0] ? (
              <NodexButton
                type="button"
                size="xs"
                variant="ghost"
                disabled={disabled}
                onClick={() =>
                  onChange({
                    ...config,
                    filter: {
                      kind: "group",
                      operator: "and",
                      children: [config.filter, createDatabaseViewFilterClause(properties[0]!)],
                    },
                  })
                }
              >
                <PlusIcon /> Rule
              </NodexButton>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );

  if (onlyFilter) {
    return <div className="px-1 py-1">{filterEditor}</div>;
  }

  return (
    <div className="divide-y divide-token-border/60 px-1 pb-1">
      <ConfigSection title="Filter" detail="Shared by every window">
        {filterEditor}
      </ConfigSection>

      <>
        <ConfigSection title="Sort" detail="First rule wins">
          <SortEditor
            sorts={presentation.sort}
            properties={sortableProperties}
            disabled={disabled}
            onChange={(sort) =>
              onChange({
                ...config,
                presentation: { ...presentation, sort },
              })
            }
          />
        </ConfigSection>

        <ConfigSection title="Grouping" detail="Group, then subgroup">
          <div className="flex flex-wrap gap-2">
            <DatabaseViewSelect
              ariaLabel="Group View by property"
              search="filter"
              searchPlaceholder="Search group properties…"
              value={presentation.group?.propertyId ?? ""}
              valueLabel={
                groupableProperties.find(
                  (property) => property.propertyId === presentation.group?.propertyId,
                )?.name ?? "No grouping"
              }
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...config,
                  presentation: {
                    ...presentation,
                    group: value ? { propertyId: value } : null,
                    subgroup:
                      value && presentation.subgroup?.propertyId !== value
                        ? presentation.subgroup
                        : null,
                  },
                })
              }
              options={[
                { value: "", label: "No grouping" },
                ...groupableProperties.map((property) => ({
                  value: property.propertyId,
                  label: property.name,
                })),
              ]}
              className="w-52"
            />
            <DatabaseViewSelect
              ariaLabel="Subgroup View by property"
              search="filter"
              searchPlaceholder="Search subgroup properties…"
              value={presentation.subgroup?.propertyId ?? ""}
              valueLabel={
                groupableProperties.find(
                  (property) => property.propertyId === presentation.subgroup?.propertyId,
                )?.name ?? "No subgroup"
              }
              disabled={disabled || presentation.group === null}
              onValueChange={(value) =>
                onChange({
                  ...config,
                  presentation: {
                    ...presentation,
                    subgroup: value ? { propertyId: value } : null,
                  },
                })
              }
              options={[
                { value: "", label: "No subgroup" },
                ...groupableProperties
                  .filter((property) => property.propertyId !== presentation.group?.propertyId)
                  .map((property) => ({
                    value: property.propertyId,
                    label: property.name,
                  })),
              ]}
              className="w-52"
            />
          </div>
        </ConfigSection>

        <ConfigSection title="Completed" detail="Visibility and ordering">
          <div className="flex flex-wrap items-center gap-3">
            <DatabaseViewSelect
              ariaLabel="Completed task range"
              value={presentation.completion.range}
              valueLabel={
                presentation.completion.range === "all"
                  ? "All completed"
                  : presentation.completion.range === "past_month"
                    ? "Past month"
                    : presentation.completion.range === "past_week"
                      ? "Past week"
                      : presentation.completion.range === "past_day"
                        ? "Past day"
                        : "Hide completed"
              }
              disabled={disabled}
              onValueChange={(value) =>
                onChange({
                  ...config,
                  presentation: {
                    ...presentation,
                    completion: {
                      ...presentation.completion,
                      range: value as typeof presentation.completion.range,
                    },
                  },
                })
              }
              options={[
                { value: "all", label: "All completed" },
                { value: "past_month", label: "Past month" },
                { value: "past_week", label: "Past week" },
                { value: "past_day", label: "Past day" },
                { value: "none", label: "Hide completed" },
              ]}
              className="w-40"
            />
            <div className="inline-flex h-7 items-center gap-2 text-xs text-token-text-secondary">
              <NodexSwitch
                ariaLabel="Recently completed first"
                checked={presentation.completion.orderByRecency}
                disabled={disabled}
                size="compact"
                onCheckedChange={(checked) =>
                  onChange({
                    ...config,
                    presentation: {
                      ...presentation,
                      completion: {
                        ...presentation.completion,
                        orderByRecency: checked,
                      },
                    },
                  })
                }
              />
              Recently completed first
            </div>
          </div>
        </ConfigSection>

        <ConfigSection title="Display" detail={`Visible fields in ${layout}`}>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {intrinsicFields.map((descriptor) => {
              const visible = layoutConfig.fields.some(
                (field) => field.kind === "intrinsic" && field.field === descriptor.field,
              );
              return (
                <div
                  key={descriptor.field}
                  className="inline-flex h-7 items-center gap-2 text-xs text-token-text-secondary"
                >
                  <NodexSwitch
                    ariaLabel={descriptor.label}
                    checked={visible}
                    disabled={disabled}
                    size="compact"
                    onCheckedChange={(checked) =>
                      onChange({
                        ...config,
                        presentation: {
                          ...presentation,
                          layouts: {
                            ...presentation.layouts,
                            [layout]: {
                              ...layoutConfig,
                              fields: checked
                                ? [
                                    { kind: "intrinsic" as const, field: descriptor.field },
                                    ...layoutConfig.fields,
                                  ]
                                : layoutConfig.fields.filter(
                                    (field) =>
                                      field.kind !== "intrinsic" ||
                                      field.field !== descriptor.field,
                                  ),
                            },
                          },
                        },
                      })
                    }
                  />
                  {descriptor.label}
                </div>
              );
            })}
            <div className="inline-flex h-7 items-center gap-2 text-xs text-token-text-secondary">
              <NodexSwitch
                ariaLabel="Show empty groups"
                checked={layoutConfig.showEmptyGroups}
                disabled={disabled}
                size="compact"
                onCheckedChange={(checked) =>
                  onChange({
                    ...config,
                    presentation: {
                      ...presentation,
                      layouts: {
                        ...presentation.layouts,
                        [layout]: {
                          ...layoutConfig,
                          showEmptyGroups: checked,
                        },
                      },
                    },
                  })
                }
              />
              Show empty groups
            </div>
            {properties.map((property) => {
              const visible = layoutConfig.fields.some(
                (field) => field.kind === "property" && field.propertyId === property.propertyId,
              );
              return (
                <div
                  key={property.propertyId}
                  className="inline-flex h-7 items-center gap-2 text-xs text-token-text-secondary"
                >
                  <NodexSwitch
                    ariaLabel={property.name}
                    checked={visible}
                    disabled={disabled}
                    size="compact"
                    onCheckedChange={(checked) =>
                      onChange({
                        ...config,
                        presentation: {
                          ...presentation,
                          layouts: {
                            ...presentation.layouts,
                            [layout]: {
                              ...layoutConfig,
                              fields: checked
                                ? [
                                    ...layoutConfig.fields,
                                    {
                                      kind: "property" as const,
                                      propertyId: property.propertyId,
                                    },
                                  ]
                                : layoutConfig.fields.filter(
                                    (field) =>
                                      field.kind !== "property" ||
                                      field.propertyId !== property.propertyId,
                                  ),
                            },
                          },
                        },
                      })
                    }
                  />
                  {property.name}
                </div>
              );
            })}
          </div>
        </ConfigSection>
      </>
    </div>
  );
}

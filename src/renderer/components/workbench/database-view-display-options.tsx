import { useState, type ReactNode } from "react";

import {
  BoardIcon,
  ListLayoutIcon,
  SortAscendingIcon,
  SortDescendingIcon,
} from "@/components/shared/icons";
import { SlidersHorizontal } from "@/components/shared/icons/generic-icons";
import { NodexButton, NodexIconButton, NodexSwitch } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { databaseIntrinsicFieldsForLayout } from "@/lib/database-intrinsic-field-registry";
import type {
  DatabaseViewCompletedRange,
  DatabaseViewField,
  DatabaseViewSort,
  EffectiveDatabaseViewPresentation,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import {
  databaseViewDisplayFieldKey,
  displayFieldForcedByOrdering,
  reduceDisplayOptionChange,
  type DatabaseViewDisplayOptionAction,
} from "./database-view-display-options-model";
import { DatabaseViewSelect } from "./database-view-select";

interface DatabaseViewDisplayOptionsProps {
  readonly effective: EffectiveDatabaseViewPresentation;
  readonly durable: EffectiveDatabaseViewPresentation;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onChange: (next: EffectiveDatabaseViewPresentation) => void;
  readonly onReset: () => void;
  readonly onPublish: () => void | Promise<void>;
  readonly onForcedFieldChange?: (field: DatabaseViewField | null) => void;
}

function DisplayRow({
  label,
  children,
  disabled = false,
}: {
  readonly label: ReactNode;
  readonly children: ReactNode;
  readonly disabled?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 px-3 text-[13px] leading-4",
        disabled && "opacity-55",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-token-description-foreground">{label}</span>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

function DisplaySeparator() {
  return <div role="separator" className="my-1 h-px bg-token-menu-border/80" />;
}

const completedRangeLabel = (range: DatabaseViewCompletedRange): string => {
  if (range === "past_month") return "Past month";
  if (range === "past_week") return "Past week";
  if (range === "past_day") return "Past day";
  if (range === "none") return "None";
  return "All";
};

const sortFieldKey = (field: DatabaseViewSort["field"]): string =>
  field.kind === "property" ? `property:${field.propertyId}` : field.kind;

const sortFieldFromKey = (value: string): DatabaseViewSort["field"] => {
  if (value.startsWith("property:")) {
    return { kind: "property", propertyId: value.slice("property:".length) };
  }
  if (value === "created") return { kind: "created" };
  if (value === "title") return { kind: "title" };
  return { kind: "manual" };
};

export function DatabaseViewDisplayOptions({
  effective,
  durable,
  properties,
  busy = false,
  error = null,
  open,
  onOpenChange,
  onChange,
  onReset,
  onPublish,
  onForcedFieldChange,
}: DatabaseViewDisplayOptionsProps) {
  const [forcedField, setForcedField] = useState<DatabaseViewField | null>(null);
  const activeProperties = properties.filter((property) => property.lifecycle === "active");
  const sortable = activeProperties.filter((property) => property.capabilities.sortable);
  const groupable = activeProperties.filter((property) => property.capabilities.groupable);
  const capabilities = {
    groupablePropertyIds: new Set(groupable.map((property) => String(property.propertyId))),
  };
  const presentation = effective.presentation;
  const layout = effective.layout;
  const layoutConfig = presentation.layouts[layout];
  const hasOverride = JSON.stringify(effective) !== JSON.stringify(durable);
  const currentSort = presentation.sort[0] ?? {
    field: { kind: "manual" as const },
    direction: "asc" as const,
    nulls: "last" as const,
  };
  const currentSortKey = sortFieldKey(currentSort.field);
  const currentSortPropertyId =
    currentSort.field.kind === "property" ? currentSort.field.propertyId : null;
  const currentSortLabel =
    currentSortPropertyId !== null
      ? (sortable.find((property) => property.propertyId === currentSortPropertyId)?.name ??
        "Missing property")
      : currentSort.field.kind === "manual"
        ? "Manual"
        : currentSort.field.kind === "created"
          ? "Created"
          : "Title";
  const groupLabel =
    groupable.find((property) => property.propertyId === presentation.group?.propertyId)?.name ??
    "No grouping";
  const subgroupLabel =
    groupable.find((property) => property.propertyId === presentation.subgroup?.propertyId)?.name ??
    "No grouping";
  const dispatch = (action: DatabaseViewDisplayOptionAction): void => {
    onChange(reduceDisplayOptionChange(effective, action, capabilities));
  };
  const changeOrdering = (value: string): void => {
    const field = sortFieldFromKey(value);
    const nextForcedField = displayFieldForcedByOrdering(field);
    setForcedField(nextForcedField);
    onForcedFieldChange?.(nextForcedField);
    dispatch({ kind: "set_order_field", field });
  };
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen) {
      setForcedField(null);
      onForcedFieldChange?.(null);
    }
    onOpenChange?.(nextOpen);
  };
  const intrinsicFields = databaseIntrinsicFieldsForLayout(layout);
  const identityFields = intrinsicFields.filter(
    ({ slot, advanced }) => slot === "identity" && !advanced,
  );
  const advancedFields = intrinsicFields.filter(({ advanced }) => advanced);
  const metadataFields = intrinsicFields.filter(({ slot }) => slot === "metadata");
  const fields = [
    ...identityFields.map((descriptor) => ({
      key: `intrinsic:${descriptor.field}`,
      label: descriptor.label,
      field: { kind: "intrinsic" as const, field: descriptor.field },
    })),
    ...activeProperties.map((property) => ({
      key: `property:${property.propertyId}`,
      label: property.name,
      field: { kind: "property" as const, propertyId: property.propertyId },
    })),
    ...metadataFields.map((descriptor) => ({
      key: `intrinsic:${descriptor.field}`,
      label: descriptor.label,
      field: { kind: "intrinsic" as const, field: descriptor.field },
    })),
  ];
  const fieldGroups = [
    { label: "Display fields", fields },
    ...(advancedFields.length > 0
      ? [
          {
            label: "Advanced identity",
            fields: advancedFields.map((descriptor) => ({
              key: `intrinsic:${descriptor.field}`,
              label: descriptor.label,
              field: { kind: "intrinsic" as const, field: descriptor.field },
            })),
          },
        ]
      : []),
  ];

  return (
    <NodexPopover open={open} onOpenChange={handleOpenChange}>
      <NodexPopoverTrigger>
        <NodexIconButton
          icon={SlidersHorizontal}
          size="sm"
          active={hasOverride || open}
          ariaLabel="Display options"
          title="Display options"
        />
      </NodexPopoverTrigger>
      <NodexPopoverContent
        align="end"
        sideOffset={6}
        className={cn(
          "max-h-[min(720px,calc(100vh-72px))] w-[320px] overflow-y-auto p-0",
          "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]",
          "motion-reduce:data-[state=open]:animate-none",
        )}
      >
        <div className="px-3 pb-2 pt-3">
          <div
            role="tablist"
            aria-label="Database View layout"
            className="grid h-8 grid-cols-2 gap-1 rounded-lg bg-token-foreground/5 p-0.5"
          >
            {[
              { value: "list" as const, label: "List", icon: ListLayoutIcon },
              { value: "board" as const, label: "Board", icon: BoardIcon },
            ].map((candidate) => (
              <NodexButton
                key={candidate.value}
                role="tab"
                aria-selected={layout === candidate.value}
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => dispatch({ kind: "set_layout", layout: candidate.value })}
                className={cn(
                  "h-7 gap-1.5 rounded-md px-2 text-[13px] font-medium",
                  layout === candidate.value
                    ? "bg-token-main-surface-primary text-token-text-primary shadow-sm hover:bg-token-main-surface-primary"
                    : "text-token-description-foreground",
                )}
              >
                <candidate.icon className="size-3.5" />
                {candidate.label}
              </NodexButton>
            ))}
          </div>
        </div>

        <div className="pb-1">
          <DisplayRow label="Grouping">
            <DatabaseViewSelect
              ariaLabel="Group by"
              search="filter"
              searchPlaceholder="Search group properties…"
              value={presentation.group?.propertyId ?? ""}
              valueLabel={groupLabel}
              disabled={busy}
              chrome="raised"
              onValueChange={(value) =>
                dispatch({
                  kind: "set_group",
                  propertyId: value || null,
                })
              }
              options={[
                { value: "", label: "No grouping" },
                ...groupable.map((property) => ({
                  value: property.propertyId,
                  label: property.name,
                })),
              ]}
              className="w-[116px]"
            />
            <NodexIconButton
              icon={presentation.groupDirection === "asc" ? SortAscendingIcon : SortDescendingIcon}
              size="xs"
              ariaLabel="Group ordering"
              aria-pressed={presentation.groupDirection === "desc"}
              title={
                presentation.groupDirection === "asc" ? "Groups ascending" : "Groups descending"
              }
              disabled={busy || presentation.group === null}
              onClick={() => dispatch({ kind: "toggle_group_direction" })}
              className="order-first"
            />
          </DisplayRow>
          <DisplayRow label="Sub-grouping" disabled={presentation.group === null}>
            <DatabaseViewSelect
              ariaLabel="Subgroup by"
              search="filter"
              searchPlaceholder="Search subgroup properties…"
              value={presentation.subgroup?.propertyId ?? ""}
              valueLabel={subgroupLabel}
              disabled={busy || presentation.group === null}
              chrome="raised"
              onValueChange={(value) =>
                dispatch({
                  kind: "set_subgroup",
                  propertyId: value || null,
                })
              }
              options={[
                { value: "", label: "No grouping" },
                ...groupable
                  .filter((property) => property.propertyId !== presentation.group?.propertyId)
                  .map((property) => ({
                    value: property.propertyId,
                    label: property.name,
                  })),
              ]}
              className="w-[116px]"
            />
          </DisplayRow>
          <DisplayRow label="Ordering">
            <DatabaseViewSelect
              ariaLabel="Order by"
              search="filter"
              searchPlaceholder="Search ordering fields…"
              value={currentSortKey}
              valueLabel={currentSortLabel}
              disabled={busy}
              chrome="raised"
              onValueChange={changeOrdering}
              options={[
                { value: "manual", label: "Manual" },
                { value: "title", label: "Title" },
                { value: "created", label: "Created" },
                ...sortable.map((property) => ({
                  value: `property:${property.propertyId}`,
                  label: property.name,
                })),
              ]}
              className="w-[116px]"
            />
            <NodexIconButton
              icon={currentSort.direction === "asc" ? SortAscendingIcon : SortDescendingIcon}
              size="xs"
              ariaLabel="Direction"
              aria-pressed={currentSort.direction === "desc"}
              title={currentSort.direction === "asc" ? "Ascending" : "Descending"}
              disabled={busy}
              onClick={() => dispatch({ kind: "toggle_order_direction" })}
              className="order-first"
            />
          </DisplayRow>
          <DisplayRow label="Order completed by recency">
            <NodexSwitch
              ariaLabel="Order completed by recency"
              checked={presentation.completion.orderByRecency}
              disabled={busy}
              size="compact"
              onCheckedChange={(enabled) =>
                dispatch({
                  kind: "set_completed_recency",
                  enabled,
                })
              }
            />
          </DisplayRow>

          {activeProperties.some((property) => property.propertyId === "status") ? (
            <>
              <DisplaySeparator />
              <DisplayRow label="Completed Pages">
                <DatabaseViewSelect
                  ariaLabel="Completed Page range"
                  value={presentation.completion.range}
                  valueLabel={completedRangeLabel(presentation.completion.range)}
                  disabled={busy}
                  chrome="raised"
                  onValueChange={(range) =>
                    dispatch({
                      kind: "set_completed_range",
                      range: range as DatabaseViewCompletedRange,
                    })
                  }
                  options={[
                    { value: "all", label: "All" },
                    { value: "past_month", label: "Past month" },
                    { value: "past_week", label: "Past week" },
                    { value: "past_day", label: "Past day" },
                    { value: "none", label: "None" },
                  ]}
                  className="w-[116px]"
                />
              </DisplayRow>
            </>
          ) : null}

          <DisplayRow label="Show sub-pages">
            <NodexSwitch
              ariaLabel="Show sub-pages"
              checked={presentation.hierarchy.showSubPages}
              disabled={busy}
              size="compact"
              onCheckedChange={(enabled) =>
                dispatch({
                  kind: "set_show_sub_pages",
                  enabled,
                })
              }
            />
          </DisplayRow>

          <DisplaySeparator />
          <div className="px-3 pb-1 pt-1 text-[13px] font-medium text-token-text-primary">
            {layout === "list" ? "List options" : "Board options"}
          </div>
          <DisplayRow
            label="Nested sub-pages"
            disabled={layout !== "list" || !presentation.hierarchy.showSubPages}
          >
            <NodexSwitch
              ariaLabel="Nested sub-pages"
              checked={layout === "list" && presentation.hierarchy.nestedSubPages}
              disabled={busy || layout !== "list" || !presentation.hierarchy.showSubPages}
              size="compact"
              onCheckedChange={(enabled) =>
                dispatch({
                  kind: "set_nested_sub_pages",
                  enabled,
                })
              }
            />
          </DisplayRow>
          <DisplayRow label="Show empty groups" disabled={presentation.group === null}>
            <NodexSwitch
              ariaLabel="Show empty groups"
              checked={layoutConfig.showEmptyGroups}
              disabled={busy || presentation.group === null}
              size="compact"
              onCheckedChange={(enabled) =>
                dispatch({
                  kind: "set_show_empty_groups",
                  enabled,
                })
              }
            />
          </DisplayRow>

          {fieldGroups.map((group, groupIndex) => (
            <div key={group.label}>
              <div
                className={cn(
                  "px-3 pb-1 font-medium text-token-text-secondary",
                  groupIndex === 0 ? "pt-2 text-[13px]" : "pt-1 text-[12px]",
                )}
              >
                {group.label}
              </div>
              <div className="flex flex-wrap gap-1.5 px-3 pb-2">
                {group.fields.map(({ key, label, field }) => {
                  const durableVisible = layoutConfig.fields.some(
                    (candidate) => databaseViewDisplayFieldKey(candidate) === key,
                  );
                  const forced =
                    forcedField !== null && databaseViewDisplayFieldKey(forcedField) === key;
                  return (
                    <NodexTooltip
                      key={key}
                      tooltipContent={
                        forced && !durableVisible
                          ? "Visible while this field controls ordering"
                          : undefined
                      }
                    >
                      <NodexButton
                        size="xs"
                        variant="secondary"
                        aria-pressed={durableVisible}
                        data-forced-visible={forced || undefined}
                        disabled={busy}
                        onClick={() => dispatch({ kind: "toggle_field", field })}
                        className={cn(
                          "h-6 rounded-full border px-2 text-xs font-normal",
                          durableVisible || forced
                            ? "border-transparent bg-token-foreground/9 text-token-text-primary"
                            : "border-token-border/70 bg-transparent text-token-description-foreground hover:bg-token-foreground/5",
                        )}
                      >
                        {label}
                      </NodexButton>
                    </NodexTooltip>
                  );
                })}
                {groupIndex === 0 && layout === "board" ? (
                  <NodexButton
                    size="xs"
                    variant="secondary"
                    aria-pressed={layoutConfig.showDescription !== false}
                    disabled={busy}
                    onClick={() =>
                      dispatch({
                        kind: "set_show_description",
                        enabled: layoutConfig.showDescription === false,
                      })
                    }
                    className={cn(
                      "h-6 rounded-full border px-2 text-xs font-normal",
                      layoutConfig.showDescription !== false
                        ? "border-transparent bg-token-foreground/9 text-token-text-primary"
                        : "border-token-border/70 bg-transparent text-token-description-foreground hover:bg-token-foreground/5",
                    )}
                  >
                    Description
                  </NodexButton>
                ) : null}
              </div>
            </div>
          ))}
          {error ? (
            <div
              role="alert"
              className="mx-3 mb-2 rounded-md bg-token-error-background px-2 py-1.5 text-xs text-token-error-foreground"
            >
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex h-10 items-center border-t-[0.5px] border-token-border/70 px-3">
          <NodexButton
            size="xs"
            variant="ghost"
            disabled={busy || !hasOverride}
            onClick={onReset}
            className="h-7 px-2 text-[13px] font-normal"
          >
            Reset
          </NodexButton>
          <NodexButton
            size="xs"
            variant="ghost"
            disabled={busy || !hasOverride}
            className="ml-auto h-7 px-2 text-[13px] font-medium text-token-charts-blue"
            onClick={() => void onPublish()}
          >
            Set default for everyone
          </NodexButton>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

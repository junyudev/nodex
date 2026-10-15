import { useEffect, useState, type ReactNode } from "react";

import { DataSourcePropertyValueEditor } from "@/components/database/data-source-property-value-editor";
import { DueDateValueIcon } from "@/components/database/due-date-value-icon";
import { CalendarIcon } from "@/components/shared/icons";
import type {
  DataSourcePropertyEditorBinding,
  DataSourcePropertyOptionRegistryState,
} from "@/components/database/data-source-property-editor-binding";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import type { RelationTargetWindow } from "@/lib/data-source-relation-value";
import type {
  readDataSourceRelationTargetDescriptor,
  searchDataSourceRelationCandidates,
} from "@/lib/data-source-relation-runtime";
import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabaseViewField,
} from "../../../../shared/database-kernel";
import type {
  DataSourcePageRowV2,
  DataSourcePropertyRecordV2,
} from "../../../../shared/database-module-v2";
import {
  DatabaseListAssigneeIcon,
  DatabaseListEstimateIcon,
  DatabaseListLabelIcon,
  DatabaseListProjectIcon,
} from "./database-list-icons";
import {
  DATABASE_LIST_MUTED_ICON_COLOR,
  databaseListPropertyHasValue,
} from "./database-list-property-presentation";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

export interface DatabaseListPropertyRuntime {
  readonly isPending: (pageId: string, propertyId: string) => boolean;
  readonly errorFor: (pageId: string, propertyId: string) => string | null;
  readonly options: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly optionStates: Readonly<Record<string, DataSourcePropertyOptionRegistryState>>;
  readonly optionHasMore: Readonly<Record<string, boolean>>;
  readonly optionLoadingMore: Readonly<Record<string, boolean>>;
  readonly relationCandidates: () => readonly {
    readonly pageId: string;
    readonly title: string;
  }[];
  readonly onSetValue: (pageId: string, propertyId: string, value: DatabaseJsonValue) => void;
  readonly onPatchOptions: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    delta: {
      readonly addOptionIds: readonly string[];
      readonly removeOptionIds: readonly string[];
    },
  ) => void;
  readonly onPatchRelation: (
    pageId: string,
    propertyId: string,
    delta: {
      readonly addPageIds: readonly string[];
      readonly removeEdgeIds: readonly string[];
    },
  ) => void;
  readonly onReplaceOneRelation: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    targetPageId: string | null,
  ) => void;
  readonly onCreateOption: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    option: { readonly optionId: string; readonly name: string; readonly color?: string },
  ) => Promise<void>;
  readonly onRequestOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly onRequestMoreOptions: (property: DataSourcePropertyRecordV2) => void;
  readonly onLoadRelationTargets: (
    pageId: string,
    property: DataSourcePropertyRecordV2,
    after: string | null,
  ) => Promise<RelationTargetWindow>;
  readonly onSearchRelationCandidates: (
    property: DataSourcePropertyRecordV2,
    query: string,
    after?: string | null,
  ) => ReturnType<typeof searchDataSourceRelationCandidates>;
  readonly onLoadRelationTargetDescriptor: (
    property: DataSourcePropertyRecordV2,
  ) => ReturnType<typeof readDataSourceRelationTargetDescriptor>;
  readonly onOpenRelationPage: (pageId: string, title: string) => void;
  readonly onRelationValueStale: () => void;
}

/** Shared row authority adapter used by inline cells and the Page context menu. */
export const createDatabaseListPropertyEditorBinding = (
  property: DataSourcePropertyRecordV2,
  authority: DataSourcePageRowV2,
  runtime: DatabaseListPropertyRuntime,
): DataSourcePropertyEditorBinding => {
  const current = authority.values[property.propertyId];
  const pageId = authority.page.pageId;
  return {
    property,
    value: current?.value,
    revision: current?.revision ?? 0,
    disabled: property.lifecycle !== "active",
    pending: runtime.isPending(pageId, property.propertyId),
    error: runtime.errorFor(pageId, property.propertyId),
    options: runtime.options[property.propertyId] ?? [],
    optionRegistryState: runtime.optionStates[property.propertyId] ?? "ready",
    optionRegistryHasMore: runtime.optionHasMore[property.propertyId] ?? false,
    optionRegistryLoadingMore: runtime.optionLoadingMore[property.propertyId] ?? false,
    onRequestOptions: () => runtime.onRequestOptions(property),
    onRequestMoreOptions: () => runtime.onRequestMoreOptions(property),
    relationCandidates:
      property.valueType === "relation" ? runtime.relationCandidates() : undefined,
    relationSourcePageId: pageId,
    onChange: (value) => runtime.onSetValue(pageId, property.propertyId, value),
    onPatchOptions: (delta) => runtime.onPatchOptions(pageId, property, delta),
    onPatchRelation: (delta) => runtime.onPatchRelation(pageId, property.propertyId, delta),
    onReplaceOneRelation: (targetPageId) =>
      runtime.onReplaceOneRelation(pageId, property, targetPageId),
    onCreateOption: (option) => runtime.onCreateOption(pageId, property, option),
    onLoadRelationTargets: (after) => runtime.onLoadRelationTargets(pageId, property, after),
    onSearchRelationCandidates: (query, after) =>
      runtime.onSearchRelationCandidates(property, query, after),
    onLoadRelationTargetDescriptor: () => runtime.onLoadRelationTargetDescriptor(property),
    onOpenRelationPage: runtime.onOpenRelationPage,
    onRelationValueStale: runtime.onRelationValueStale,
  };
};

const propertyIcon = (
  property: DataSourcePropertyRecordV2,
  value: DatabaseJsonValue | undefined,
): ReactNode => {
  const role = resolveDataSourcePropertyPresentationRole(property);
  if (role.kind === "due_date") {
    return <DueDateValueIcon value={value} />;
  }
  if (role.kind === "schedule_boundary") {
    return <CalendarIcon style={{ color: DATABASE_LIST_MUTED_ICON_COLOR }} />;
  }
  if (role.kind === "estimate") {
    return <DatabaseListEstimateIcon style={{ color: DATABASE_LIST_MUTED_ICON_COLOR }} />;
  }
  if (property.valueType === "relation") {
    return <DatabaseListProjectIcon style={{ color: DATABASE_LIST_MUTED_ICON_COLOR }} />;
  }
  return <DatabaseListLabelIcon style={{ color: DATABASE_LIST_MUTED_ICON_COLOR }} />;
};

function DatabaseListAssigneeEditor({
  label,
  value,
  revision,
  pending,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly revision: number;
  readonly pending: boolean;
  readonly onChange: (value: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [revision, value]);
  const commit = () => {
    const next = draft.trim();
    if (next !== value) onChange(next || null);
    setOpen(false);
  };
  return (
    <NodexPopover
      open={open}
      onOpenChange={(next) => {
        if (next && pending) return;
        setDraft(value);
        setOpen(next);
      }}
    >
      <NodexTooltip tooltipContent={value}>
        <NodexPopoverTrigger disabled={pending}>
          <button
            type="button"
            aria-label={`Edit ${label}: ${value}`}
            className="grid size-[18px] shrink-0 place-items-center overflow-hidden rounded-full text-[var(--database-list-icon-muted)] outline-none hover:bg-[var(--database-list-row-hover)] focus-visible:ring-1 focus-visible:ring-[var(--database-list-focus)] disabled:opacity-50"
          >
            <DatabaseListAssigneeIcon />
          </button>
        </NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent align="end" className="w-64 p-2">
        <input
          autoFocus
          type="text"
          aria-label={`${label} value`}
          value={draft}
          disabled={pending}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key !== "Escape") return;
            setDraft(value);
            setOpen(false);
          }}
          className="h-8 w-full rounded-lg border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border"
        />
      </NodexPopoverContent>
    </NodexPopover>
  );
}

function PropertyEditor({
  property,
  authority,
  runtime,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly authority: DataSourcePageRowV2;
  readonly runtime: DatabaseListPropertyRuntime;
}) {
  const binding = createDatabaseListPropertyEditorBinding(property, authority, runtime);
  const current = authority.values[property.propertyId];
  const pending = binding.pending ?? false;
  const error = binding.error;
  const role = resolveDataSourcePropertyPresentationRole(property);
  if (role.kind === "assignee" && typeof current?.value === "string") {
    return (
      <span className="inline-flex shrink-0 items-center" data-list-property={property.propertyId}>
        <DatabaseListAssigneeEditor
          label={property.name}
          value={current.value}
          revision={current.revision}
          pending={pending}
          onChange={(value) => binding.onChange(value)}
        />
        {error ? (
          <span role="alert" className="sr-only">
            {error}
          </span>
        ) : null}
      </span>
    );
  }
  return (
    <NodexTooltip tooltipContent={error ?? property.name}>
      <span
        className="inline-flex min-w-0 shrink-0 items-center"
        data-list-property={property.propertyId}
      >
        <DataSourcePropertyValueEditor
          {...binding}
          showLabel={false}
          presentation="list"
          triggerIcon={propertyIcon(property, current?.value)}
        />
        {error ? (
          <span role="alert" className="sr-only">
            {error}
          </span>
        ) : null}
      </span>
    </NodexTooltip>
  );
}

export function DatabaseListInlineProperties({
  fields,
  properties,
  authority,
  runtime,
}: {
  readonly fields: readonly DatabaseViewField[];
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly authority: DataSourcePageRowV2;
  readonly runtime: DatabaseListPropertyRuntime;
}) {
  const propertyById = new Map(
    properties.map((property) => [String(property.propertyId), property] as const),
  );
  const visible = fields.flatMap((field) => {
    if (field.kind !== "property") return [];
    const property = propertyById.get(String(field.propertyId));
    if (!property) return [];
    const value = authority.values[property.propertyId]?.value;
    return databaseListPropertyHasValue(property, value) ? [property] : [];
  });
  if (visible.length === 0) return null;
  const assignees = visible.filter(
    (property) => resolveDataSourcePropertyPresentationRole(property).kind === "assignee",
  );
  const badges = visible.filter(
    (property) => resolveDataSourcePropertyPresentationRole(property).kind !== "assignee",
  );
  return (
    <>
      <div
        data-list-property-cluster="true"
        className="flex h-6 min-w-[90px] flex-[1_1.5_auto] items-center justify-between gap-[3px] overflow-hidden rounded-[50px]"
      >
        <span aria-hidden="true" className="min-w-0 flex-1" />
        <span className="flex min-w-0 shrink items-center justify-end gap-[3px] overflow-hidden">
          {badges.map((property) => (
            <PropertyEditor
              key={property.propertyId}
              property={property}
              authority={authority}
              runtime={runtime}
            />
          ))}
        </span>
      </div>
      {assignees.map((property) => (
        <PropertyEditor
          key={property.propertyId}
          property={property}
          authority={authority}
          runtime={runtime}
        />
      ))}
    </>
  );
}

export function DatabaseListTrailingPropertyCells({
  fields,
  authority,
}: {
  readonly fields: readonly DatabaseViewField[];
  readonly authority: DataSourcePageRowV2;
}) {
  return fields.flatMap((field) => {
    if (field.kind !== "intrinsic") return [];
    if (field.field === "page_key") return [];
    const value =
      field.field === "created_at" ? authority.page.createdAt : authority.page.updatedAt;
    return [
      <div
        key={`intrinsic:${field.field}`}
        role="gridcell"
        data-list-grid-column={field.field}
        data-list-field-key={`intrinsic:${field.field}`}
        className="relative z-[1] min-w-0 truncate text-right text-xs tabular-nums text-[var(--database-list-text-muted)]"
        style={{ gridColumn: field.field }}
      >
        {dateFormatter.format(new Date(value))}
      </div>,
    ];
  });
}

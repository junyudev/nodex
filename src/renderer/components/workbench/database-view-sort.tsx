import { DeleteIcon, MoveDownIcon, MoveUpIcon, PlusIcon } from "@/components/shared/icons";
import { ArrowUpDown } from "@/components/shared/icons/generic-icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { createDatabaseViewSort, moveDatabaseViewSort } from "@/lib/database-view-authoring";
import {
  databaseViewSortFieldLabel,
  hasCustomDatabaseViewSort,
} from "@/lib/database-view-rule-summary";
import type {
  DatabaseViewSort,
  EffectiveDatabaseViewPresentation,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { DatabaseViewSelect } from "./database-view-select";
import { useObjectIdentityKey } from "@/lib/use-object-identity-keys";

interface DatabaseViewSortProps {
  readonly effective: EffectiveDatabaseViewPresentation;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly busy?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onChange: (next: EffectiveDatabaseViewPresentation) => void;
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

export function DatabaseViewSort({
  effective,
  properties,
  busy = false,
  open,
  onOpenChange,
  onChange,
}: DatabaseViewSortProps) {
  const sortableProperties = properties.filter(
    (property) => property.lifecycle === "active" && property.capabilities.sortable,
  );
  const sorts = effective.presentation.sort;
  const objectIdentityKey = useObjectIdentityKey();
  const setSorts = (nextSorts: readonly DatabaseViewSort[]) =>
    onChange({
      ...effective,
      presentation: {
        ...effective.presentation,
        sort: nextSorts,
      },
    });
  const updateSort = (index: number, update: (sort: DatabaseViewSort) => DatabaseViewSort) =>
    setSorts(sorts.map((sort, candidateIndex) => (candidateIndex === index ? update(sort) : sort)));

  return (
    <NodexPopover open={open} onOpenChange={onOpenChange}>
      <NodexPopoverTrigger>
        <NodexIconButton
          icon={ArrowUpDown}
          size="sm"
          active={open || hasCustomDatabaseViewSort(sorts)}
          ariaLabel="Sort View"
          title="Sort"
        />
      </NodexPopoverTrigger>
      <NodexPopoverContent align="end" className="w-[430px] p-0">
        <div className="flex h-9 items-center px-3">
          <span className="text-xs font-medium uppercase tracking-label text-token-description-foreground">
            Sort
          </span>
          {sorts.length < 4 ? (
            <NodexButton
              size="xs"
              variant="ghost"
              disabled={busy}
              className="ml-auto"
              onClick={() => setSorts([...sorts, createDatabaseViewSort()])}
            >
              <PlusIcon /> Sort
            </NodexButton>
          ) : null}
        </div>
        <div className="space-y-1 px-2 pb-2">
          {sorts.length === 0 ? (
            <div className="flex h-9 items-center px-1 text-xs text-token-description-foreground">
              No sorting rules
            </div>
          ) : (
            sorts.map((sort, index) => (
              <div key={objectIdentityKey(sort)} className="flex min-h-8 items-center gap-1">
                <DatabaseViewSelect
                  ariaLabel={`Sort field ${index + 1}`}
                  search="filter"
                  searchPlaceholder="Search sort fields…"
                  value={sortFieldValue(sort)}
                  valueLabel={databaseViewSortFieldLabel(sort, sortableProperties)}
                  disabled={busy}
                  onValueChange={(value) =>
                    updateSort(index, (candidate) => sortWithField(candidate, value))
                  }
                  options={[
                    { value: "manual", label: "Manual order" },
                    { value: "title", label: "Title" },
                    { value: "created", label: "Created" },
                    ...sortableProperties.map((property) => ({
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
                  disabled={busy}
                  onValueChange={(value) =>
                    updateSort(index, (candidate) => ({
                      ...candidate,
                      direction: value as "asc" | "desc",
                    }))
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
                  disabled={busy}
                  onValueChange={(value) =>
                    updateSort(index, (candidate) => ({
                      ...candidate,
                      nulls: value as "first" | "last",
                    }))
                  }
                  options={[
                    { value: "first", label: "Empty first" },
                    { value: "last", label: "Empty last" },
                  ]}
                  className="w-24"
                />
                <div className="ml-auto flex items-center">
                  <NodexIconButton
                    icon={MoveUpIcon}
                    size="xs"
                    ariaLabel={`Move sort ${index + 1} up`}
                    disabled={busy || index === 0}
                    onClick={() => setSorts(moveDatabaseViewSort(sorts, index, "up"))}
                  />
                  <NodexIconButton
                    icon={MoveDownIcon}
                    size="xs"
                    ariaLabel={`Move sort ${index + 1} down`}
                    disabled={busy || index === sorts.length - 1}
                    onClick={() => setSorts(moveDatabaseViewSort(sorts, index, "down"))}
                  />
                  <NodexIconButton
                    icon={DeleteIcon}
                    size="xs"
                    tone="danger"
                    ariaLabel={`Remove sort ${index + 1}`}
                    disabled={busy}
                    onClick={() =>
                      setSorts(sorts.filter((_, candidateIndex) => candidateIndex !== index))
                    }
                  />
                </div>
              </div>
            ))
          )}
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}

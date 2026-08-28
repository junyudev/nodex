import { ArrowUpDown } from "@/components/shared/icons/generic-icons";
import { ChevronDownIcon, SortAscendingIcon, SortDescendingIcon } from "@/components/shared/icons";
import {
  databaseViewSortFieldLabel,
  hasCustomDatabaseViewSort,
  summarizeDatabaseViewFilter,
} from "@/lib/database-view-rule-summary";
import { cn } from "@/lib/utils";
import type {
  DatabasePropertyOption,
  DatabaseViewFilterNode,
  EffectiveDatabaseViewPresentation,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";

interface DatabaseViewRulesSummaryRowProps {
  readonly filter: DatabaseViewFilterNode;
  readonly effective: EffectiveDatabaseViewPresentation;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries?: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onOpenFilter: () => void;
  readonly onOpenSort: () => void;
}

const EMPTY_OPTION_REGISTRIES: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {};

const SUMMARY_BUTTON = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium",
  "bg-[color-mix(in_srgb,var(--accent-blue)_14%,transparent)] text-(--accent-blue)",
  "hover:bg-[color-mix(in_srgb,var(--accent-blue)_19%,transparent)]",
  "focus-visible:ring-2 focus-visible:ring-token-focus focus-visible:outline-none",
);

export function DatabaseViewRulesSummaryRow({
  filter,
  effective,
  properties,
  optionRegistries = EMPTY_OPTION_REGISTRIES,
  onOpenFilter,
  onOpenSort,
}: DatabaseViewRulesSummaryRowProps) {
  const filters = summarizeDatabaseViewFilter(filter, properties, optionRegistries);
  const customSort = hasCustomDatabaseViewSort(effective.presentation.sort);
  const primarySort = effective.presentation.sort[0] ?? null;
  if (filters.length === 0 && !customSort) return null;

  return (
    <div
      data-testid="database-view-rules-summary-row"
      className="flex min-h-9 items-center gap-1.5 overflow-x-auto border-t-[0.5px] border-token-border/60 px-3 py-1.5"
    >
      {customSort ? (
        <button type="button" className={SUMMARY_BUTTON} onClick={onOpenSort}>
          {effective.presentation.sort.length === 1 && primarySort ? (
            <>
              {primarySort.direction === "asc" ? (
                <SortAscendingIcon className="size-3.5" />
              ) : (
                <SortDescendingIcon className="size-3.5" />
              )}
              <span className="max-w-44 truncate">
                {databaseViewSortFieldLabel(primarySort, properties)}
              </span>
              <ChevronDownIcon className="size-3.5" />
            </>
          ) : (
            <>
              <ArrowUpDown className="size-3.5" />
              <span>{effective.presentation.sort.length} sorts</span>
              <ChevronDownIcon className="size-3.5" />
            </>
          )}
        </button>
      ) : null}
      {customSort && filters.length > 0 ? (
        <div className="h-5 w-px shrink-0 bg-token-border" />
      ) : null}
      {filters.map((summary) => (
        <button key={summary.key} type="button" className={SUMMARY_BUTTON} onClick={onOpenFilter}>
          <span>{summary.label}:</span>
          <span className="max-w-56 truncate">{summary.value}</span>
        </button>
      ))}
    </div>
  );
}

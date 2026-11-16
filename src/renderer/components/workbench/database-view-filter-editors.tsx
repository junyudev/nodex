import {
  defineMessage,
  defineMessages,
  getIntl,
  useIntl,
  type MessageDescriptor,
} from "@/lib/i18n";
import { parsePageAssignee } from "../../../shared/work-graph";
import { useMembers } from "@/lib/members-runtime";
import { InboxAgentPicker, useInboxAgents } from "@/features/inbox/inbox-agent-picker";
import { PageAssigneeLabel } from "@/components/database/page-assignee-label";
import { NodexDropdownButtonTrigger, NodexOptionPicker } from "@/components/ui/dropdown";
import {
  CheckmarkIcon,
  ChevronDownIcon,
  CopyIcon,
  DeleteIcon,
  FilterIcon,
  MoreActionsIcon,
  PageIcon,
  PlusIcon,
  SearchIcon,
} from "@/components/shared/icons";
import { DatePropertyEditor } from "@/components/database/date-property-editor";
import { PropertyEditorIcon } from "@/components/database/property-editor-icons";
import { PropertyOptionPicker } from "@/components/database/property-option-picker";
import {
  presentSemanticPropertyOptions,
  SemanticPropertyOption,
  SemanticSelectPropertyEditor,
  type SemanticSelectPropertyKind,
} from "@/components/database/semantic-property-editors";
import { NodexIconButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  appendDatabaseViewFilterChild,
  createDatabaseViewFilterClause,
  databaseFilterClauseWithOperator,
  databaseFilterClauseWithProperty,
  filterOperatorsForProperty,
  readDatabasePropertyOptions,
  removeDatabaseViewFilterNode,
  updateDatabaseViewFilterNode,
  type DatabaseViewFilterPath,
} from "@/lib/database-view-authoring";
import { cn } from "@/lib/utils";
import { searchDataSourceRelationCandidates } from "@/lib/data-source-relation-runtime";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import type { DatabaseViewRoutingContext } from "@/lib/database-view-render-model";
import {
  databaseViewAdvancedFilterDepth,
  duplicateDatabaseViewAdvancedFilterNode,
  unwrapDatabaseViewAdvancedFilterGroup,
  wrapDatabaseViewAdvancedFilterNode,
} from "@/lib/database-view-advanced-filter";
import { useObjectIdentityKey } from "@/lib/use-object-identity-keys";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type {
  DatabaseJsonValue,
  DatabasePropertyOption,
  DatabaseViewConfigV6,
  DatabaseViewFilterClause,
  DatabaseViewFilterGroup,
  DatabaseViewFilterNode,
  DatabaseViewFilterOperator,
} from "../../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../../shared/database-module-v2";
import { DatabaseViewSelect } from "./database-view-select";

const filterValueMessage = defineMessage<{ property: string }>({
  id: "database.databaseViewFilterEditors.filterValue",
  defaultMessage: "Filter value for {property}",
});
const searchPropertyOptionsMessage = defineMessage<{ property: string }>({
  id: "database.databaseViewFilterEditors.searchPropertyOptions",
  defaultMessage: "Search {property} options…",
});

const messages = defineMessages({
  untitled: {
    id: "database.databaseViewFilterEditors.untitled",
    defaultMessage: "Untitled",
  },
  selectOption: {
    id: "database.databaseViewFilterEditors.selectOption",
    defaultMessage: "Select option",
  },
  checked: {
    id: "database.databaseViewFilterEditors.checked",
    defaultMessage: "Checked",
  },
  unchecked: {
    id: "database.databaseViewFilterEditors.unchecked",
    defaultMessage: "Unchecked",
  },
  past: {
    id: "database.databaseViewFilterEditors.past",
    defaultMessage: "Past",
  },
  next: {
    id: "database.databaseViewFilterEditors.next",
    defaultMessage: "Next",
  },
  and: {
    id: "database.databaseViewFilterEditors.and",
    defaultMessage: "And",
  },
  or: {
    id: "database.databaseViewFilterEditors.or",
    defaultMessage: "Or",
  },
  addRule: {
    id: "database.databaseViewFilterEditors.addRule",
    defaultMessage: "Add filter rule",
  },
});

interface DatabaseViewAdvancedFilterEditorProps {
  readonly config: DatabaseViewConfigV6;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries?: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly routingContext?: DatabaseViewRoutingContext;
  readonly disabled?: boolean;
  readonly onChange: (config: DatabaseViewConfigV6) => void;
}

const EMPTY_OPTION_REGISTRIES: Readonly<Record<string, readonly DatabasePropertyOption[]>> = {};

const inputClass = cn(
  "h-8 min-w-0 rounded-lg border-[0.5px] border-token-border bg-token-bg-fog px-2 text-sm",
  "text-token-text-primary outline-none placeholder:text-token-description-foreground hover:bg-token-foreground/3 focus:border-token-focus-border focus:bg-token-foreground/3",
);

export function DatabaseRulePropertyLabel({
  property,
  className,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly className?: string;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <PropertyEditorIcon
        property={property}
        className="size-4 shrink-0 text-token-text-secondary"
      />
      <span className="truncate">{property.name}</span>
    </span>
  );
}

const operatorMessages = defineMessages({
  is: {
    id: "database.databaseViewFilterEditors.is",
    defaultMessage: "is",
    description: "Filter comparison operator",
  },
  isNot: {
    id: "database.databaseViewFilterEditors.isNot",
    defaultMessage: "is not",
    description: "Filter comparison operator",
  },
  contains: { id: "database.databaseViewFilterEditors.contains", defaultMessage: "contains" },
  doesNotContain: {
    id: "database.databaseViewFilterEditors.doesNotContain",
    defaultMessage: "does not contain",
  },
  startsWith: {
    id: "database.databaseViewFilterEditors.startsWith",
    defaultMessage: "starts with",
  },
  endsWith: {
    id: "database.databaseViewFilterEditors.endsWith",
    defaultMessage: "ends with",
  },
  numberEquals: {
    id: "database.databaseViewFilterEditors.numberEquals",
    defaultMessage: "equals",
  },
  numberDoesNotEqual: {
    id: "database.databaseViewFilterEditors.numberDoesNotEqual",
    defaultMessage: "does not equal",
  },
  greaterThan: {
    id: "database.databaseViewFilterEditors.greaterThan",
    defaultMessage: "is greater than",
  },
  lessThan: {
    id: "database.databaseViewFilterEditors.lessThan",
    defaultMessage: "is less than",
  },
  atLeast: {
    id: "database.databaseViewFilterEditors.atLeast",
    defaultMessage: "is at least",
  },
  atMost: {
    id: "database.databaseViewFilterEditors.atMost",
    defaultMessage: "is at most",
  },
  containsAll: {
    id: "database.databaseViewFilterEditors.containsAll",
    defaultMessage: "contains all",
  },
  before: { id: "database.databaseViewFilterEditors.before", defaultMessage: "is before" },
  after: { id: "database.databaseViewFilterEditors.after", defaultMessage: "is after" },
  onOrBefore: {
    id: "database.databaseViewFilterEditors.onOrBefore",
    defaultMessage: "is on or before",
  },
  onOrAfter: {
    id: "database.databaseViewFilterEditors.onOrAfter",
    defaultMessage: "is on or after",
  },
  within: { id: "database.databaseViewFilterEditors.within", defaultMessage: "is within" },
  relativeTo: {
    id: "database.databaseViewFilterEditors.relativeTo",
    defaultMessage: "is relative to",
  },
  isEmpty: { id: "database.databaseViewFilterEditors.isEmpty", defaultMessage: "is empty" },
  isNotEmpty: {
    id: "database.databaseViewFilterEditors.isNotEmpty",
    defaultMessage: "is not empty",
  },
});

export const FILTER_OPERATOR_MESSAGES = {
  equals: operatorMessages.is,
  not_equals: operatorMessages.isNot,
  contains: operatorMessages.contains,
  not_contains: operatorMessages.doesNotContain,
  text_is: operatorMessages.is,
  text_is_not: operatorMessages.isNot,
  text_contains: operatorMessages.contains,
  text_does_not_contain: operatorMessages.doesNotContain,
  text_starts_with: operatorMessages.startsWith,
  text_ends_with: operatorMessages.endsWith,
  number_equals: operatorMessages.numberEquals,
  number_does_not_equal: operatorMessages.numberDoesNotEqual,
  number_greater_than: operatorMessages.greaterThan,
  number_less_than: operatorMessages.lessThan,
  number_greater_than_or_equal_to: operatorMessages.atLeast,
  number_less_than_or_equal_to: operatorMessages.atMost,
  checkbox_is: operatorMessages.is,
  checkbox_is_not: operatorMessages.isNot,
  select_is: operatorMessages.is,
  select_is_not: operatorMessages.isNot,
  multi_select_contains: operatorMessages.contains,
  multi_select_does_not_contain: operatorMessages.doesNotContain,
  multi_select_contains_all: operatorMessages.containsAll,
  date_is: operatorMessages.is,
  date_is_not: operatorMessages.isNot,
  date_before: operatorMessages.before,
  date_after: operatorMessages.after,
  date_on_or_before: operatorMessages.onOrBefore,
  date_on_or_after: operatorMessages.onOrAfter,
  date_within: operatorMessages.within,
  date_relative_to: operatorMessages.relativeTo,
  relation_contains: operatorMessages.contains,
  relation_does_not_contain: operatorMessages.doesNotContain,
  is_empty: operatorMessages.isEmpty,
  is_not_empty: operatorMessages.isNotEmpty,
} satisfies Record<DatabaseViewFilterOperator, MessageDescriptor>;

export const FILTER_OPERATOR_LABELS = Object.fromEntries(
  Object.entries(FILTER_OPERATOR_MESSAGES).map(([operator, message]) => [
    operator,
    message.defaultMessage,
  ]),
) as Readonly<Record<DatabaseViewFilterOperator, string>>;

const propertyForClause = (
  properties: readonly DataSourcePropertyRecordV2[],
  clause: DatabaseViewFilterClause,
): DataSourcePropertyRecordV2 | null =>
  properties.find((property) => property.propertyId === clause.propertyId) ?? null;

const lastClauseInGroup = (
  group: Extract<DatabaseViewFilterNode, { kind: "group" }>,
): DatabaseViewFilterClause | null => {
  for (let index = group.children.length - 1; index >= 0; index -= 1) {
    const child = group.children[index];
    if (!child) continue;
    if (child.kind === "clause") return child;
    const nested = lastClauseInGroup(child);
    if (nested) return nested;
  }
  return null;
};

const ADVANCED_FILTER_MENU_ROW = cn(
  "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm text-token-foreground",
  "hover:bg-token-foreground/6 focus-visible:bg-token-foreground/6 focus-visible:outline-none",
);

function AdvancedFilterNodeActions({
  node,
  path,
  parentDepth,
  disabled,
  onDuplicate,
  onWrap,
  onUnwrap,
  onRemove,
}: {
  readonly node: DatabaseViewFilterNode;
  readonly path: DatabaseViewFilterPath;
  readonly parentDepth: number;
  readonly disabled: boolean;
  readonly onDuplicate: (path: DatabaseViewFilterPath) => void;
  readonly onWrap: (path: DatabaseViewFilterPath) => void;
  readonly onUnwrap: (path: DatabaseViewFilterPath) => void;
  readonly onRemove: (path: DatabaseViewFilterPath) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const canTurnClauseIntoGroup = node.kind === "clause" && parentDepth < 2;
  const canUnwrapGroup = node.kind === "group" && node.children.length === 1;
  const canWrapGroup =
    node.kind === "group" && parentDepth + databaseViewAdvancedFilterDepth(node) + 1 < 3;
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <button
          type="button"
          aria-label={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.filterNodeActions",
              defaultMessage:
                "{kind, select, group {Filter group actions {path}} other {Filter actions {path}}}",
            },
            { kind: node.kind, path: path.join(".") },
          )}
          disabled={disabled}
          className="inline-flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground"
        >
          <MoreActionsIcon className="size-4" />
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent className="w-48 p-1" align="end">
        <button
          type="button"
          className={cn(ADVANCED_FILTER_MENU_ROW, "text-token-error-foreground")}
          onClick={() => {
            setOpen(false);
            onRemove(path);
          }}
        >
          <DeleteIcon className="size-4" />{" "}
          {intl.formatMessage({
            id: "database.databaseViewFilterEditors.remove",
            defaultMessage: "Remove",
          })}
        </button>
        <button
          type="button"
          className={ADVANCED_FILTER_MENU_ROW}
          onClick={() => {
            setOpen(false);
            onDuplicate(path);
          }}
        >
          <CopyIcon className="size-4" />{" "}
          {intl.formatMessage({
            id: "database.databaseViewFilterEditors.duplicate",
            defaultMessage: "Duplicate",
          })}
        </button>
        {canTurnClauseIntoGroup ? (
          <button
            type="button"
            className={ADVANCED_FILTER_MENU_ROW}
            onClick={() => {
              setOpen(false);
              onWrap(path);
            }}
          >
            <FilterIcon className="size-4" />{" "}
            {intl.formatMessage({
              id: "database.databaseViewFilterEditors.turnIntoGroup",
              defaultMessage: "Turn into group",
            })}
          </button>
        ) : null}
        {canUnwrapGroup ? (
          <button
            type="button"
            className={ADVANCED_FILTER_MENU_ROW}
            onClick={() => {
              setOpen(false);
              onUnwrap(path);
            }}
          >
            <FilterIcon className="size-4" />
            {node.children[0]?.kind === "group"
              ? intl.formatMessage({
                  id: "database.databaseViewFilterEditors.unwrapGroup",
                  defaultMessage: "Unwrap group",
                })
              : intl.formatMessage({
                  id: "database.databaseViewFilterEditors.turnIntoFilter",
                  defaultMessage: "Turn into filter",
                })}
          </button>
        ) : null}
        {canWrapGroup ? (
          <button
            type="button"
            className={ADVANCED_FILTER_MENU_ROW}
            onClick={() => {
              setOpen(false);
              onWrap(path);
            }}
          >
            <FilterIcon className="size-4" />
            <span>
              <span className="block">
                {intl.formatMessage({
                  id: "database.databaseViewFilterEditors.wrapInGroup",
                  defaultMessage: "Wrap in group",
                })}
              </span>
              <span className="block text-xs text-token-description-foreground">
                {intl.formatMessage({
                  id: "database.databaseViewFilterEditors.wrapInGroupDescription",
                  defaultMessage: "Create a filter group around this",
                })}
              </span>
            </span>
          </button>
        ) : null}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

const stringValue = (value: DatabaseJsonValue | undefined): string =>
  typeof value === "string" ? value : "";

const datetimeLocalValue = (value: DatabaseJsonValue | undefined): string => {
  if (typeof value !== "string") return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const offset = parsed.getTimezoneOffset() * 60_000;
  return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
};

const jsonRecord = (
  value: DatabaseJsonValue | undefined,
): Readonly<Record<string, DatabaseJsonValue>> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, DatabaseJsonValue>>)
    : {};

function DebouncedFilterTextInput({
  value,
  type,
  ariaLabel,
  disabled,
  className,
  onChange,
}: {
  readonly value: string;
  readonly type: "text" | "date" | "datetime-local";
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly className?: string;
  readonly onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const pendingDraftRef = useRef<string | null>(null);
  const commitPending = useEffectEvent((previousValue: string) => {
    const pending = pendingDraftRef.current;
    if (pending !== null && pending !== previousValue) onChange(pending);
  });
  const [previousValue, setPreviousValue] = useState(value);
  if (previousValue !== value) {
    setPreviousValue(value);
    setDraft(value);
  }
  useEffect(() => {
    if (draft === value) return;
    const timeout = window.setTimeout(() => onChange(draft), 250);
    return () => window.clearTimeout(timeout);
  }, [draft, onChange, value]);
  useEffect(() => {
    pendingDraftRef.current = null;
    return () => commitPending(value);
  }, [value]);
  return (
    <input
      type={type}
      aria-label={ariaLabel}
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        pendingDraftRef.current = event.target.value;
        setDraft(event.target.value);
      }}
      onBlur={() => {
        if (draft !== value) onChange(draft);
      }}
      className={cn(inputClass, "w-36", className)}
    />
  );
}

function RelationFilterValuePicker({
  host = "popover",
  property,
  routingContext,
  selectedIds,
  disabled,
  onChange,
}: {
  readonly host?: "popover" | "embedded";
  readonly property: DataSourcePropertyRecordV2;
  readonly routingContext?: DatabaseViewRoutingContext;
  readonly selectedIds: readonly string[];
  readonly disabled: boolean;
  readonly onChange: (pageIds: readonly string[]) => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(host === "embedded");
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<
    readonly { readonly pageId: string; readonly title: string }[]
  >([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [projectionRevision, setProjectionRevision] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!open || !routingContext) return;
    const current = ++generation.current;
    const timeout = window.setTimeout(() => {
      setLoading(true);
      setError(null);
      void searchDataSourceRelationCandidates({ routingContext, property, query })
        .then((window) => {
          if (current !== generation.current) return;
          setCandidates(window.candidates);
          setNextCursor(window.nextCursor);
          setProjectionRevision(window.projectionRevision);
        })
        .catch((cause: unknown) => {
          if (current !== generation.current) return;
          setCandidates([]);
          setNextCursor(null);
          setError(
            cause instanceof Error
              ? cause.message
              : getIntl().formatMessage({
                  id: "database.databaseViewFilterEditors.loadPagesFailed",
                  defaultMessage: "Pages could not be loaded",
                }),
          );
        })
        .finally(() => {
          if (current === generation.current) setLoading(false);
        });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [routingContext, open, property, query]);

  const selectedNames = selectedIds.flatMap((pageId) => {
    const candidate = candidates.find((item) => item.pageId === pageId);
    return candidate ? [candidate.title || intl.formatMessage(messages.untitled)] : [];
  });
  const loadMore = () => {
    if (!routingContext || !nextCursor || loading) return;
    const current = generation.current;
    setLoading(true);
    void searchDataSourceRelationCandidates({ routingContext, property, query, after: nextCursor })
      .then(async (window) => {
        if (current !== generation.current) return;
        if (projectionRevision !== null && window.projectionRevision !== projectionRevision) {
          const refreshed = await searchDataSourceRelationCandidates({
            routingContext,
            property,
            query,
          });
          if (current !== generation.current) return;
          setCandidates(refreshed.candidates);
          setNextCursor(refreshed.nextCursor);
          setProjectionRevision(refreshed.projectionRevision);
          return;
        }
        const byId = new Map(candidates.map((candidate) => [candidate.pageId, candidate]));
        for (const candidate of window.candidates) byId.set(candidate.pageId, candidate);
        setCandidates([...byId.values()]);
        setNextCursor(window.nextCursor);
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : getIntl().formatMessage({
                id: "database.databaseViewFilterEditors.loadMorePagesFailed",
                defaultMessage: "More Pages could not be loaded",
              }),
        ),
      )
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  };

  const content = (
    <>
      <div className="flex h-9 items-center gap-2 border-b-[0.5px] border-token-border px-2">
        <SearchIcon className="size-4 text-token-description-foreground" />
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={intl.formatMessage({
            id: "database.databaseViewFilterEditors.searchPages",
            defaultMessage: "Search Pages…",
          })}
          aria-label={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.searchPagesForProperty",
              defaultMessage: "Search Pages for {property}",
            },
            { property: property.name },
          )}
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-token-description-foreground"
        />
      </div>
      <div className="max-h-64 overflow-y-auto p-1">
        {candidates.map((candidate) => {
          const selected = selectedIds.includes(candidate.pageId);
          return (
            <button
              key={candidate.pageId}
              type="button"
              className="flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm hover:bg-token-foreground/5"
              onClick={() =>
                onChange(
                  selected
                    ? selectedIds.filter((pageId) => pageId !== candidate.pageId)
                    : [...selectedIds, candidate.pageId],
                )
              }
            >
              <PageIcon className="size-4 text-token-description-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {candidate.title || intl.formatMessage(messages.untitled)}
              </span>
              {selected ? <CheckmarkIcon className="size-4 text-info" /> : null}
            </button>
          );
        })}
        {!loading && candidates.length === 0 && !error ? (
          <p className="px-2 py-4 text-center text-xs text-token-description-foreground">
            {intl.formatMessage({
              id: "database.databaseViewFilterEditors.noMatchingPages",
              defaultMessage: "No matching Pages",
            })}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="px-2 py-3 text-xs text-token-error-foreground">
            {error}
          </p>
        ) : null}
        {nextCursor ? (
          <button
            type="button"
            className="flex min-h-8 w-full items-center justify-center rounded-lg text-xs text-info hover:bg-token-foreground/5"
            disabled={loading}
            onClick={loadMore}
          >
            {intl.formatMessage({
              id: "database.databaseViewFilterEditors.loadMore",
              defaultMessage: "Load more",
            })}
          </button>
        ) : null}
        {loading ? (
          <p className="px-2 py-3 text-center text-xs text-token-description-foreground">
            {intl.formatMessage({
              id: "database.databaseViewFilterEditors.loading",
              defaultMessage: "Loading…",
            })}
          </p>
        ) : null}
      </div>
    </>
  );
  if (host === "embedded") return <div className="w-full min-w-0 overflow-hidden">{content}</div>;

  return (
    <NodexPopover
      open={open}
      onOpenChange={(next) => {
        if (next && (!routingContext || disabled)) return;
        setOpen(next);
        if (next) return;
        generation.current += 1;
        setQuery("");
        setError(null);
      }}
    >
      <NodexPopoverTrigger disabled={disabled || !routingContext}>
        <button
          type="button"
          aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
          className={cn(inputClass, "inline-flex max-w-48 items-center gap-1.5 text-left")}
        >
          <PageIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {selectedIds.length === 0
              ? intl.formatMessage({
                  id: "database.databaseViewFilterEditors.selectPages",
                  defaultMessage: "Select Pages",
                })
              : selectedNames.length === selectedIds.length
                ? intl.formatList(selectedNames, { type: "unit", style: "short" })
                : intl.formatMessage(
                    {
                      id: "database.databaseViewFilterEditors.selectedCount",
                      defaultMessage: "{count} selected",
                    },
                    { count: selectedIds.length },
                  )}
          </span>
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent className="w-[260px] overflow-hidden p-0" align="start">
        {content}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function DatabaseViewFilterValueField({
  clause,
  property,
  options,
  onRequestOptions,
  routingContext,
  disabled,
  presentation = "advanced",
  onChange,
}: {
  readonly clause: DatabaseViewFilterClause;
  readonly property: DataSourcePropertyRecordV2;
  readonly options: readonly DatabasePropertyOption[];
  readonly onRequestOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly routingContext?: DatabaseViewRoutingContext;
  readonly disabled: boolean;
  readonly presentation?: "advanced" | "quick" | "conditional";
  readonly onChange: (value: DatabaseJsonValue) => void;
}) {
  const intl = useIntl();
  const role = resolveDataSourcePropertyPresentationRole(property);
  const fillRow = presentation === "quick" || presentation === "conditional";
  const semanticKind: SemanticSelectPropertyKind | null =
    role.kind === "status" || role.kind === "priority" || role.kind === "estimate"
      ? role.kind
      : null;
  useEffect(() => {
    if (property.valueType !== "select" && property.valueType !== "multi_select") return;
    onRequestOptions?.(property);
  }, [onRequestOptions, property]);
  if (clause.operator === "is_empty" || clause.operator === "is_not_empty") return null;

  if (property.valueType === "assignment")
    return (
      <AssignmentFilterValue
        property={property}
        value={clause.value ?? null}
        onChange={onChange}
        disabled={disabled}
      />
    );
  if (property.valueType === "checkbox") {
    const value = clause.value === true ? "true" : "false";
    if (presentation === "quick") {
      return (
        <div
          role="listbox"
          aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
          className="p-1"
        >
          {[
            {
              value: "false",
              label: intl.formatMessage(messages.unchecked),
            },
            {
              value: "true",
              label: intl.formatMessage(messages.checked),
            },
          ].map((option) => {
            const selected = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                onClick={() => onChange(option.value === "true")}
                className="flex min-h-8 w-full items-center justify-between rounded-lg px-2 text-left text-sm hover:bg-token-list-hover-background disabled:opacity-50"
              >
                {option.label}
                {selected ? <CheckmarkIcon className="size-4 text-info" /> : null}
              </button>
            );
          })}
        </div>
      );
    }
    return (
      <DatabaseViewSelect
        ariaLabel={intl.formatMessage(filterValueMessage, { property: property.name })}
        value={value}
        valueLabel={
          value === "true"
            ? intl.formatMessage(messages.checked)
            : intl.formatMessage(messages.unchecked)
        }
        disabled={disabled}
        onValueChange={(nextValue) => onChange(nextValue === "true")}
        options={[
          {
            value: "true",
            label: intl.formatMessage(messages.checked),
          },
          {
            value: "false",
            label: intl.formatMessage(messages.unchecked),
          },
        ]}
        size="rule"
        className="w-auto min-w-24"
      />
    );
  }

  if (property.valueType === "select" && semanticKind) {
    const selectedId = stringValue(clause.value) || null;
    const presentedOptions = presentSemanticPropertyOptions(
      semanticKind,
      options,
      selectedId,
      "ready",
    );
    const selectedOption = presentedOptions.find((option) => option.id === selectedId);
    return (
      <SemanticSelectPropertyEditor
        host={presentation === "quick" ? "embedded" : "popover"}
        kind={semanticKind}
        label={property.name}
        triggerAriaLabel={intl.formatMessage(filterValueMessage, { property: property.name })}
        options={options}
        selectedId={selectedId}
        disabled={disabled}
        presentation="compact"
        searchPlaceholder={intl.formatMessage(searchPropertyOptionsMessage, {
          property: property.name,
        })}
        contentClassName="w-[260px]"
        emptyOptionLabel={intl.formatMessage(
          {
            id: "database.databaseViewFilterEditors.emptyPropertyOption",
            defaultMessage: "No {property}",
          },
          { property: property.name.toLocaleLowerCase() },
        )}
        allowClear
        onRequestOptions={() => onRequestOptions?.(property)}
        onChange={onChange}
        triggerButton={
          <button
            type="button"
            aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
            className={cn(
              inputClass,
              "inline-flex items-center gap-1.5 truncate text-left",
              fillRow ? "w-full min-w-0 max-w-none" : "min-w-[120px] max-w-[180px]",
            )}
          >
            {selectedOption ? (
              <SemanticPropertyOption
                kind={semanticKind}
                option={{ ...selectedOption, missing: false }}
              />
            ) : (
              intl.formatMessage(messages.selectOption)
            )}
          </button>
        }
      />
    );
  }

  if (property.valueType === "select" || property.valueType === "multi_select") {
    const selectedIds =
      property.valueType === "multi_select"
        ? Array.isArray(clause.value)
          ? clause.value.filter((value): value is string => typeof value === "string")
          : []
        : [stringValue(clause.value)].filter(Boolean);
    const selectedNames = selectedIds.flatMap((optionId) => {
      const option = options.find((candidate) => candidate.id === optionId);
      return option ? [option.name] : [];
    });
    return (
      <PropertyOptionPicker
        host={presentation === "quick" ? "embedded" : "popover"}
        label={property.name}
        triggerAriaLabel={intl.formatMessage(filterValueMessage, { property: property.name })}
        mode={property.valueType === "multi_select" ? "multiple" : "single"}
        options={options}
        selectedIds={selectedIds}
        disabled={disabled}
        searchPlaceholder={intl.formatMessage(searchPropertyOptionsMessage, {
          property: property.name,
        })}
        onOpen={() => onRequestOptions?.(property)}
        onSelectedIdsChange={(next) =>
          onChange(property.valueType === "multi_select" ? next : (next[0] ?? null))
        }
        contentClassName="w-[260px]"
        triggerButton={
          <button
            type="button"
            aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
            className={cn(
              inputClass,
              "gap-1.5 truncate text-left",
              fillRow ? "w-full min-w-0 max-w-none" : "min-w-[120px] max-w-[180px]",
            )}
          >
            {selectedNames.length > 0
              ? intl.formatList(selectedNames, { type: "unit", style: "short" })
              : intl.formatMessage(messages.selectOption)}
          </button>
        }
      />
    );
  }

  if (property.valueType === "number") {
    return (
      <input
        type="number"
        aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
        value={typeof clause.value === "number" ? String(clause.value) : ""}
        disabled={disabled}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : Number(event.target.value))
        }
        className={cn(inputClass, fillRow ? "w-full" : "w-28")}
      />
    );
  }

  if (clause.operator === "date_within") {
    const range = jsonRecord(clause.value);
    const start = typeof range.start === "string" ? range.start : "";
    const end = typeof range.end === "string" ? range.end : "";
    return (
      <span
        className={cn(
          "flex items-center gap-1",
          fillRow && "grid w-full grid-cols-[1fr_auto_1fr]",
          presentation === "quick" && "px-2 pb-2",
        )}
      >
        <input
          type="date"
          aria-label={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.rangeStart",
              defaultMessage: "Filter range start for {property}",
            },
            { property: property.name },
          )}
          value={start}
          disabled={disabled}
          onChange={(event) => onChange({ start: event.target.value, end })}
          className={cn(inputClass, fillRow ? "w-full" : "w-32")}
        />
        <span className="text-xs text-token-description-foreground">
          {intl.formatMessage({
            id: "database.databaseViewFilterEditors.dateRangeSeparator",
            defaultMessage: "to",
            description: "Separator between the start and end dates",
          })}
        </span>
        <input
          type="date"
          aria-label={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.rangeEnd",
              defaultMessage: "Filter range end for {property}",
            },
            { property: property.name },
          )}
          value={end}
          disabled={disabled}
          onChange={(event) => onChange({ start, end: event.target.value })}
          className={cn(inputClass, fillRow ? "w-full" : "w-32")}
        />
      </span>
    );
  }

  if (clause.operator === "date_relative_to") {
    const relative = jsonRecord(clause.value);
    const direction = relative.direction === "future" ? "future" : "past";
    const count = typeof relative.count === "number" ? relative.count : 1;
    const unit =
      relative.unit === "day" || relative.unit === "month" || relative.unit === "year"
        ? relative.unit
        : "week";
    const update = (next: {
      readonly direction: string;
      readonly count: number;
      readonly unit: string;
    }) => onChange(next);
    return (
      <span className={cn("flex items-center gap-1", presentation === "quick" && "px-2 pb-2")}>
        <DatabaseViewSelect
          ariaLabel={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.relativeDirection",
              defaultMessage: "Relative date direction for {property}",
            },
            { property: property.name },
          )}
          value={direction}
          valueLabel={
            direction === "past"
              ? intl.formatMessage(messages.past)
              : intl.formatMessage(messages.next)
          }
          disabled={disabled}
          onValueChange={(next) => update({ direction: next, count, unit })}
          options={[
            {
              value: "past",
              label: intl.formatMessage(messages.past),
            },
            {
              value: "future",
              label: intl.formatMessage(messages.next),
            },
          ]}
          size="rule"
          className="w-auto min-w-20"
        />
        <input
          type="number"
          min={1}
          max={10_000}
          aria-label={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.relativeCount",
              defaultMessage: "Relative date count for {property}",
            },
            { property: property.name },
          )}
          value={count}
          disabled={disabled}
          onChange={(event) =>
            update({ direction, count: Math.max(1, Number(event.target.value) || 1), unit })
          }
          className={cn(inputClass, "w-16")}
        />
        <DatabaseViewSelect
          ariaLabel={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.relativeUnit",
              defaultMessage: "Relative date unit for {property}",
            },
            { property: property.name },
          )}
          value={unit}
          valueLabel={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.relativeUnitValue",
              defaultMessage:
                "{unit, select, day {{count, plural, one {day} other {days}}} week {{count, plural, one {week} other {weeks}}} month {{count, plural, one {month} other {months}}} year {{count, plural, one {year} other {years}}} other {{count, plural, one {day} other {days}}}}",
            },
            { unit, count },
          )}
          disabled={disabled}
          onValueChange={(next) => update({ direction, count, unit: next })}
          options={[
            {
              value: "day",
              label: intl.formatMessage({
                id: "database.databaseViewFilterEditors.days",
                defaultMessage: "Days",
              }),
            },
            {
              value: "week",
              label: intl.formatMessage({
                id: "database.databaseViewFilterEditors.weeks",
                defaultMessage: "Weeks",
              }),
            },
            {
              value: "month",
              label: intl.formatMessage({
                id: "database.databaseViewFilterEditors.months",
                defaultMessage: "Months",
              }),
            },
            {
              value: "year",
              label: intl.formatMessage({
                id: "database.databaseViewFilterEditors.years",
                defaultMessage: "Years",
              }),
            },
          ]}
          size="rule"
          className="w-auto min-w-24"
        />
      </span>
    );
  }

  if (property.valueType === "relation") {
    const pageIds = Array.isArray(clause.value)
      ? clause.value.filter((value): value is string => typeof value === "string")
      : [];
    return (
      <RelationFilterValuePicker
        host={presentation === "quick" ? "embedded" : "popover"}
        property={property}
        routingContext={routingContext}
        selectedIds={pageIds}
        disabled={disabled}
        onChange={onChange}
      />
    );
  }

  if (
    presentation === "quick" &&
    (property.valueType === "date" || property.valueType === "datetime")
  ) {
    return (
      <DatePropertyEditor
        host="embedded"
        label={property.name}
        mode={property.valueType}
        value={stringValue(clause.value) || null}
        revision={property.revision}
        disabled={disabled}
        presentation="page"
        onChange={(value) => onChange(value ?? "")}
      />
    );
  }

  const type =
    property.valueType === "date"
      ? "date"
      : property.valueType === "datetime"
        ? "datetime-local"
        : "text";
  const value =
    property.valueType === "datetime"
      ? datetimeLocalValue(clause.value)
      : stringValue(clause.value);
  return (
    <DebouncedFilterTextInput
      type={type}
      ariaLabel={intl.formatMessage(filterValueMessage, { property: property.name })}
      value={value}
      disabled={disabled}
      className={fillRow ? "w-full" : undefined}
      onChange={(next) => {
        if (property.valueType !== "datetime") {
          onChange(next);
          return;
        }
        const parsed = new Date(next);
        onChange(Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString());
      }}
    />
  );
}

interface FilterTreeEditorCommands {
  readonly onUpdate: (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) => void;
  readonly onRemove: (path: DatabaseViewFilterPath) => void;
  readonly onAppend: (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) => void;
  readonly onDuplicate: (path: DatabaseViewFilterPath) => void;
  readonly onWrap: (path: DatabaseViewFilterPath) => void;
  readonly onUnwrap: (path: DatabaseViewFilterPath) => void;
}

interface FilterTreeEditorContext extends FilterTreeEditorCommands {
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly optionRegistries: Readonly<Record<string, readonly DatabasePropertyOption[]>>;
  readonly onRequestPropertyOptions?: (property: DataSourcePropertyRecordV2) => void;
  readonly routingContext?: DatabaseViewRoutingContext;
  readonly disabled: boolean;
}

const advancedFilterBooleanCell =
  "flex min-h-8 items-center justify-end pr-1 text-sm text-token-foreground";

const advancedFilterRowClassName = (depth: number): string =>
  cn(
    "grid min-h-8 w-full items-start",
    depth === 0
      ? "grid-cols-[72px_max-content_max-content_max-content_16px_32px] gap-x-2"
      : depth === 1
        ? "grid-cols-[64px_max-content_max-content_max-content_12px_28px] gap-x-1"
        : "grid-cols-[64px_max-content_max-content_max-content_12px_28px] gap-x-1",
  );

function FilterBooleanPrefix({
  group,
  path,
  index,
  disabled,
  onUpdate,
}: {
  readonly group: DatabaseViewFilterGroup;
  readonly path: DatabaseViewFilterPath;
  readonly index: number;
  readonly disabled: boolean;
  readonly onUpdate: FilterTreeEditorCommands["onUpdate"];
}) {
  const intl = useIntl();
  if (index === 0) {
    return (
      <div className={advancedFilterBooleanCell}>
        {intl.formatMessage({
          id: "database.databaseViewFilterEditors.where",
          defaultMessage: "Where",
        })}
      </div>
    );
  }
  if (index === 1) {
    return (
      <div className={advancedFilterBooleanCell}>
        <DatabaseViewSelect
          ariaLabel={intl.formatMessage(
            {
              id: "database.databaseViewFilterEditors.groupOperator",
              defaultMessage: "Filter group operator {path}",
            },
            {
              path:
                path.join(".") ||
                intl.formatMessage({
                  id: "database.databaseViewFilterEditors.rootGroup",
                  defaultMessage: "root",
                }),
            },
          )}
          value={group.operator}
          valueLabel={
            group.operator === "and"
              ? intl.formatMessage(messages.and)
              : intl.formatMessage(messages.or)
          }
          disabled={disabled}
          onValueChange={(value) =>
            onUpdate(path, { ...group, operator: value as DatabaseViewFilterGroup["operator"] })
          }
          options={[
            {
              value: "and",
              label: intl.formatMessage(messages.and),
            },
            {
              value: "or",
              label: intl.formatMessage(messages.or),
            },
          ]}
          size="rule"
          triggerWidth="content"
          className={cn(
            "min-w-max",
            path.length > 0 && "bg-[var(--color-background-control-opaque)]",
          )}
        />
      </div>
    );
  }
  return (
    <div className={advancedFilterBooleanCell}>
      {intl.formatMessage(
        {
          id: "database.databaseViewFilterEditors.booleanOperator",
          defaultMessage: "{operator, select, and {and} other {or}}",
        },
        { operator: group.operator },
      )}
    </div>
  );
}

const nextFilterClause = (
  group: DatabaseViewFilterGroup,
  properties: readonly DataSourcePropertyRecordV2[],
): DatabaseViewFilterClause | null => {
  const previous = lastClauseInGroup(group);
  if (previous) return { ...previous };
  const property = properties[0];
  return property ? createDatabaseViewFilterClause(property) : null;
};

function AdvancedFilterAddMenu({
  group,
  path,
  depth,
  properties,
  disabled,
  onAppend,
}: {
  readonly group: DatabaseViewFilterGroup;
  readonly path: DatabaseViewFilterPath;
  readonly depth: number;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly disabled: boolean;
  readonly onAppend: FilterTreeEditorCommands["onAppend"];
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const clause = nextFilterClause(group, properties);
  const addFilter = () => {
    if (!clause) return;
    setOpen(false);
    onAppend(path, { ...clause });
  };
  const addGroup = () => {
    if (!clause || depth >= 2) return;
    setOpen(false);
    onAppend(path, {
      kind: "group",
      operator: group.operator === "and" ? "or" : "and",
      children: [{ ...clause }],
    });
  };
  const trigger = (
    <button
      type="button"
      disabled={disabled || !clause}
      onClick={depth >= 2 ? addFilter : undefined}
      className="flex h-8 w-full items-center justify-start gap-2 rounded-lg px-2 text-sm text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-foreground disabled:pointer-events-none disabled:opacity-50"
    >
      <PlusIcon className="size-4" />
      <span>{intl.formatMessage(messages.addRule)}</span>
      {depth < 2 ? <ChevronDownIcon className="size-3.5" /> : null}
    </button>
  );
  if (depth >= 2) {
    return (
      <div data-slot="advanced-filter-add-row" data-depth={depth} className="px-1 py-1">
        {trigger}
      </div>
    );
  }
  return (
    <div data-slot="advanced-filter-add-row" data-depth={depth} className="px-1 py-1">
      <NodexPopover open={open} onOpenChange={setOpen}>
        <NodexPopoverTrigger disabled={disabled || !clause}>{trigger}</NodexPopoverTrigger>
        <NodexPopoverContent className="w-64 p-1" align="start">
          <button type="button" className={ADVANCED_FILTER_MENU_ROW} onClick={addFilter}>
            <PlusIcon className="size-4" /> {intl.formatMessage(messages.addRule)}
          </button>
          <button type="button" className={ADVANCED_FILTER_MENU_ROW} onClick={addGroup}>
            <FilterIcon className="size-4" />
            <span>
              <span className="block">
                {intl.formatMessage({
                  id: "database.databaseViewFilterEditors.addGroup",
                  defaultMessage: "Add filter group",
                })}
              </span>
              <span className="block text-xs text-token-description-foreground">
                {intl.formatMessage({
                  id: "database.databaseViewFilterEditors.addGroupDescription",
                  defaultMessage: "A group to nest more filters",
                })}
              </span>
            </span>
          </button>
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}

function FilterClauseCells({
  clause,
  path,
  parentDepth,
  prefix,
  ...context
}: FilterTreeEditorContext & {
  readonly clause: DatabaseViewFilterClause;
  readonly path: DatabaseViewFilterPath;
  readonly parentDepth: number;
  readonly prefix: ReactNode;
}) {
  const intl = useIntl();
  const property = propertyForClause(context.properties, clause);
  if (!property) {
    return (
      <div className={advancedFilterRowClassName(parentDepth)}>
        {prefix}
        <div className="col-span-3 flex min-h-8 items-center rounded-md bg-token-error-background/30 px-2 text-xs text-token-error-foreground">
          <span className="min-w-0 flex-1 truncate">
            {intl.formatMessage(
              {
                id: "database.databaseViewFilterEditors.missingProperty",
                defaultMessage: "Missing property {property}",
              },
              { property: clause.propertyId },
            )}
          </span>
        </div>
        <span aria-hidden="true" />
        <div className="flex min-h-8 items-center justify-center">
          <NodexIconButton
            icon={DeleteIcon}
            size="xs"
            tone="danger"
            ariaLabel={intl.formatMessage({
              id: "database.databaseViewFilterEditors.removeInvalidFilter",
              defaultMessage: "Remove invalid filter",
            })}
            disabled={context.disabled}
            onClick={() => context.onRemove(path)}
          />
        </div>
      </div>
    );
  }
  return (
    <div className={advancedFilterRowClassName(parentDepth)}>
      {prefix}
      <DatabaseViewSelect
        ariaLabel={intl.formatMessage(
          {
            id: "database.databaseViewFilterEditors.filterProperty",
            defaultMessage: "Filter property {property}",
          },
          { property: property.name },
        )}
        search="filter"
        searchPlaceholder={intl.formatMessage({
          id: "database.databaseViewFilterEditors.searchProperties",
          defaultMessage: "Search properties…",
        })}
        value={property.propertyId}
        valueLabel={<DatabaseRulePropertyLabel property={property} />}
        disabled={context.disabled}
        onValueChange={(value) => {
          const nextProperty = context.properties.find(
            (candidate) => candidate.propertyId === value,
          );
          if (!nextProperty) return;
          context.onUpdate(path, databaseFilterClauseWithProperty(clause, nextProperty));
        }}
        options={context.properties.map((candidate) => ({
          value: candidate.propertyId,
          label: <DatabaseRulePropertyLabel property={candidate} />,
          searchText: candidate.name,
        }))}
        size="rule"
        triggerWidth="content"
        className={parentDepth > 0 ? "bg-[var(--color-background-control-opaque)]" : undefined}
      />
      {property.valueType === "assignment" ? (
        <AssignmentFilterOperator
          property={property}
          clause={clause}
          parentDepth={parentDepth}
          disabled={context.disabled}
          onChange={(next) => context.onUpdate(path, next)}
        />
      ) : (
        <FilterOperatorPicker
          property={property}
          clause={clause}
          parentDepth={parentDepth}
          disabled={context.disabled}
          onChange={(operator) =>
            context.onUpdate(path, databaseFilterClauseWithOperator(property, operator))
          }
        />
      )}

      <div
        className={cn(
          "flex min-h-8 min-w-0 items-center",
          parentDepth > 0 &&
            "[&_button]:bg-[var(--color-background-control-opaque)] [&_input]:bg-[var(--color-background-control-opaque)]",
        )}
      >
        <DatabaseViewFilterValueField
          clause={clause}
          property={property}
          options={
            context.optionRegistries[property.propertyId] ?? readDatabasePropertyOptions(property)
          }
          onRequestOptions={context.onRequestPropertyOptions}
          routingContext={context.routingContext}
          disabled={context.disabled}
          onChange={(value) => context.onUpdate(path, { ...clause, value })}
        />
      </div>
      <span aria-hidden="true" />
      <AdvancedFilterNodeActions
        node={clause}
        path={path}
        parentDepth={parentDepth}
        disabled={context.disabled}
        onDuplicate={context.onDuplicate}
        onWrap={context.onWrap}
        onUnwrap={context.onUnwrap}
        onRemove={context.onRemove}
      />
    </div>
  );
}

function FilterGroupEditor({
  group,
  path,
  depth,
  ...context
}: FilterTreeEditorContext & {
  readonly group: DatabaseViewFilterGroup;
  readonly path: DatabaseViewFilterPath;
  readonly depth: number;
}) {
  const objectIdentityKey = useObjectIdentityKey();
  return (
    <div
      data-slot="advanced-filter-group"
      data-depth={depth}
      className={cn("w-max min-w-full", depth > 0 && "pl-3")}
    >
      <div className="flex flex-col gap-2 px-2 pt-2">
        {group.children.map((child, index) => {
          const childPath = [...path, index];
          const prefix = (
            <FilterBooleanPrefix
              group={group}
              path={path}
              index={index}
              disabled={context.disabled}
              onUpdate={context.onUpdate}
            />
          );
          if (child.kind === "clause") {
            return (
              <FilterClauseCells
                key={objectIdentityKey(child)}
                clause={child}
                path={childPath}
                parentDepth={depth}
                prefix={prefix}
                {...context}
              />
            );
          }
          return (
            <div key={objectIdentityKey(child)} className={advancedFilterRowClassName(depth)}>
              {prefix}
              <div className="col-span-4 min-w-0 self-stretch rounded-md bg-token-foreground/[0.035] ring-[0.5px] ring-token-border/70">
                <FilterGroupEditor group={child} path={childPath} depth={depth + 1} {...context} />
              </div>
              <AdvancedFilterNodeActions
                node={child}
                path={childPath}
                parentDepth={depth}
                disabled={context.disabled}
                onDuplicate={context.onDuplicate}
                onWrap={context.onWrap}
                onUnwrap={context.onUnwrap}
                onRemove={context.onRemove}
              />
            </div>
          );
        })}
      </div>
      <AdvancedFilterAddMenu
        group={group}
        path={path}
        depth={depth}
        properties={context.properties}
        disabled={context.disabled}
        onAppend={context.onAppend}
      />
    </div>
  );
}

export function DatabaseViewAdvancedFilterEditor({
  config,
  properties: allProperties,
  optionRegistries = EMPTY_OPTION_REGISTRIES,
  onRequestPropertyOptions,
  routingContext,
  disabled = false,
  onChange,
}: DatabaseViewAdvancedFilterEditorProps) {
  const properties = allProperties.filter(
    (property) =>
      property.lifecycle === "active" && property.capabilities.filterOperators.length > 0,
  );
  const root = config.rules.advancedFilter ?? {
    kind: "group" as const,
    operator: "and" as const,
    children: [],
  };
  const withFilter = (filter: DatabaseViewFilterNode): DatabaseViewConfigV6 => ({
    ...config,
    rules: {
      ...config.rules,
      advancedFilter:
        filter.kind === "group"
          ? filter.children.length === 0
            ? null
            : filter
          : { kind: "group", operator: "and", children: [filter] },
    },
  });
  const updateFilter = (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) =>
    onChange(withFilter(updateDatabaseViewFilterNode(root, path, node)));
  const removeFilter = (path: DatabaseViewFilterPath) =>
    onChange(withFilter(removeDatabaseViewFilterNode(root, path)));
  const appendFilter = (path: DatabaseViewFilterPath, node: DatabaseViewFilterNode) =>
    onChange(withFilter(appendDatabaseViewFilterChild(root, path, node)));
  const duplicateFilter = (path: DatabaseViewFilterPath) =>
    onChange(withFilter(duplicateDatabaseViewAdvancedFilterNode(root, path)));
  const wrapFilter = (path: DatabaseViewFilterPath) =>
    onChange(withFilter(wrapDatabaseViewAdvancedFilterNode(root, path)));
  const unwrapFilter = (path: DatabaseViewFilterPath) =>
    onChange(withFilter(unwrapDatabaseViewAdvancedFilterGroup(root, path)));

  return (
    <div className="w-max min-w-full max-w-full overflow-x-auto">
      <FilterGroupEditor
        group={root}
        path={[]}
        depth={0}
        properties={properties}
        optionRegistries={optionRegistries}
        onRequestPropertyOptions={onRequestPropertyOptions}
        routingContext={routingContext}
        disabled={disabled}
        onUpdate={updateFilter}
        onRemove={removeFilter}
        onAppend={appendFilter}
        onDuplicate={duplicateFilter}
        onWrap={wrapFilter}
        onUnwrap={unwrapFilter}
      />
    </div>
  );
}

interface FilterOperatorProps {
  readonly property: DataSourcePropertyRecordV2;
  readonly clause: DatabaseViewFilterClause;
  readonly parentDepth: number;
  readonly disabled: boolean;
}

function FilterOperatorPicker({
  property,
  clause,
  parentDepth,
  disabled,
  onChange,
}: FilterOperatorProps & { readonly onChange: (operator: DatabaseViewFilterOperator) => void }) {
  const intl = useIntl();
  return (
    <DatabaseViewSelect
      ariaLabel={intl.formatMessage(
        {
          id: "database.databaseViewFilterEditors.filterOperator",
          defaultMessage: "Filter operator for {property}",
        },
        { property: property.name },
      )}
      value={clause.operator}
      valueLabel={intl.formatMessage(FILTER_OPERATOR_MESSAGES[clause.operator])}
      disabled={disabled}
      onValueChange={(value) => onChange(value as DatabaseViewFilterOperator)}
      options={filterOperatorsForProperty(property).map((operator) => ({
        value: operator,
        label: intl.formatMessage(FILTER_OPERATOR_MESSAGES[operator]),
      }))}
      size="rule"
      triggerWidth="content"
      className={parentDepth > 0 ? "bg-[var(--color-background-control-opaque)]" : undefined}
    />
  );
}

/** A new identity predicate starts with a real person, never an invalid null draft. */
function AssignmentFilterOperator({
  property,
  clause,
  parentDepth,
  disabled,
  onChange,
}: FilterOperatorProps & { readonly onChange: (clause: DatabaseViewFilterClause) => void }) {
  const members = useMembers();
  const first = members.data?.find((member) => member.lifecycle === "active");
  return (
    <FilterOperatorPicker
      property={property}
      clause={clause}
      parentDepth={parentDepth}
      disabled={disabled || !first}
      onChange={(operator) => {
        const next = databaseFilterClauseWithOperator(property, operator);
        if (operator === "is_empty" || operator === "is_not_empty") {
          onChange(next);
          return;
        }
        const assignment =
          parsePageAssignee(clause.value ?? null) ??
          (first ? { kind: "member" as const, member_id: first.id } : null);
        if (assignment) onChange({ ...next, value: assignment });
      }}
    />
  );
}

function AssignmentFilterValue({
  property,
  value,
  onChange,
  disabled,
}: {
  readonly property: DataSourcePropertyRecordV2;
  readonly value: DatabaseJsonValue;
  readonly onChange: (value: DatabaseJsonValue) => void;
  readonly disabled: boolean;
}) {
  const intl = useIntl();
  const members = useMembers();
  const agents = useInboxAgents();
  const assignment = parsePageAssignee(value);
  const people = members.data?.filter((member) => member.lifecycle === "active") ?? [];
  const trigger = (
    <NodexDropdownButtonTrigger
      size="xs"
      chrome="transparent"
      aria-label={intl.formatMessage(filterValueMessage, { property: property.name })}
    >
      <PageAssigneeLabel assignee={assignment} />
    </NodexDropdownButtonTrigger>
  );
  if (property.propertyId === "owner")
    return (
      <NodexOptionPicker
        disabled={disabled}
        value={assignment?.kind === "member" ? assignment.member_id : ""}
        options={people.map((member) => ({ value: member.id, label: member.display_name }))}
        onValueChange={(member_id) => onChange({ kind: "member", member_id })}
        triggerButton={trigger}
      />
    );
  const agent = assignment?.kind === "agent" ? assignment : null;
  return (
    <InboxAgentPicker
      agents={agents}
      purpose="chat"
      scope="page"
      disabled={disabled}
      trigger={trigger}
      value={
        agent
          ? {
              instanceId: agent.instance_id,
              model: agent.model,
              reasoningEffort: agent.effort ?? null,
              serviceTier: null,
            }
          : agents.settings.chatAgent
      }
      people={{
        members: people,
        value: assignment?.kind === "member" ? assignment.member_id : agent ? undefined : null,
        choose: (member_id) => onChange(member_id ? { kind: "member", member_id } : null),
      }}
      onChange={(next) => {
        if (next.model)
          onChange({
            kind: "agent",
            instance_id: next.instanceId,
            model: next.model,
            effort: next.reasoningEffort,
          });
      }}
    />
  );
}

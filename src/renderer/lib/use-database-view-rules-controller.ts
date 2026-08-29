import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  DatabaseViewFilterClause,
  DatabaseViewFilterGroup,
  DatabaseViewPropertyFilter,
  DatabaseViewRules,
  DatabaseViewSort,
} from "../../shared/database-kernel";
import type { DataSourcePropertyRecordV2 } from "../../shared/database-module-v2";
import { createUuidV7 } from "../../shared/uuid-v7";
import { createDatabaseViewFilterClause } from "./database-view-authoring";
import { hasCustomDatabaseViewSort } from "./database-view-rule-summary";

export type DatabaseViewRulePopoverTarget =
  | { readonly kind: "create_filter"; readonly origin: "toolbar" | "bar" }
  | { readonly kind: "create_sort" }
  | { readonly kind: "quick_filter"; readonly filterId: string }
  | { readonly kind: "sort" }
  | { readonly kind: "advanced_filter" }
  | null;

type DatabaseViewRuleBarPopoverTarget = Extract<
  Exclude<DatabaseViewRulePopoverTarget, null>,
  { readonly kind: "quick_filter" | "sort" | "advanced_filter" }
>;

const popoverTargetsEqual = (
  left: DatabaseViewRulePopoverTarget,
  right: DatabaseViewRulePopoverTarget,
): boolean => {
  if (!left || !right || left.kind !== right.kind) return left === right;
  if (left.kind === "quick_filter" && right.kind === "quick_filter") {
    return left.filterId === right.filterId;
  }
  if (left.kind === "create_filter" && right.kind === "create_filter") {
    return left.origin === right.origin;
  }
  return true;
};

const sortFieldsEqual = (
  left: DatabaseViewSort["field"],
  right: DatabaseViewSort["field"],
): boolean =>
  left.kind === right.kind &&
  (left.kind !== "property" || (right.kind === "property" && left.propertyId === right.propertyId));

export interface DatabaseViewRulesController {
  readonly rules: DatabaseViewRules;
  readonly barOpen: boolean;
  readonly popover: DatabaseViewRulePopoverTarget;
  readonly pulse: number;
  readonly filtersPersonal: boolean;
  readonly sortsPersonal: boolean;
  readonly busy: boolean;
  readonly error: string | null;
  readonly setBarOpen: (open: boolean) => void;
  readonly setPopover: (target: DatabaseViewRulePopoverTarget) => void;
  readonly setPopoverOpen: (
    target: Exclude<DatabaseViewRulePopoverTarget, null>,
    open: boolean,
  ) => void;
  readonly invokeFilterToolbar: () => void;
  readonly invokeSortToolbar: () => void;
  readonly addQuickFilter: (property: DataSourcePropertyRecordV2) => void;
  readonly addSort: (field: DatabaseViewSort["field"]) => void;
  readonly editAdvancedFilter: () => void;
  readonly updateQuickFilter: (filterId: string, clause: DatabaseViewFilterClause) => void;
  readonly removeQuickFilter: (filterId: string) => void;
  readonly moveQuickFilterToAdvanced: (filterId: string) => void;
  readonly reorderQuickFilters: (orderedFilterIds: readonly string[]) => void;
  readonly setAdvancedFilter: (filter: DatabaseViewFilterGroup | null) => void;
  readonly setSorts: (sorts: readonly DatabaseViewSort[]) => void;
  readonly reset: (scope: "filters" | "sorts" | "all") => void;
  readonly publish: (scope: "filters" | "sorts" | "all") => void;
}

export function useDatabaseViewRulesController(input: {
  /** Changes whenever authoring moves to another durable View. */
  readonly ownerKey: string;
  readonly rules: DatabaseViewRules;
  readonly barOpen: boolean;
  readonly onBarOpenChange: (open: boolean) => void;
  readonly onRulesChange: (rules: DatabaseViewRules) => void;
  readonly filtersPersonal: boolean;
  readonly sortsPersonal: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly onReset: (scope: "filters" | "sorts" | "all") => void;
  readonly onPublish: (scope: "filters" | "sorts" | "all") => void;
}): DatabaseViewRulesController {
  const [popover, setPopover] = useState<DatabaseViewRulePopoverTarget>(null);
  const [pendingPopover, setPendingPopover] = useState<DatabaseViewRuleBarPopoverTarget | null>(
    null,
  );
  const [pulse, setPulse] = useState(0);

  useEffect(() => {
    setPendingPopover(null);
    setPopover(null);
    setPulse(0);
  }, [input.ownerKey]);
  const setPopoverOpen = useCallback(
    (target: Exclude<DatabaseViewRulePopoverTarget, null>, open: boolean) => {
      if (open) setPendingPopover(null);
      setPopover((current) => {
        if (open) return target;
        return popoverTargetsEqual(current, target) ? null : current;
      });
    },
    [],
  );
  const setBarOpen = useCallback(
    (open: boolean) => {
      input.onBarOpenChange(open);
      if (open) return;
      setPendingPopover(null);
      setPopover(null);
    },
    [input],
  );

  useEffect(() => {
    if (!input.barOpen || !pendingPopover) return;
    const frame = window.requestAnimationFrame(() => {
      setPopover(pendingPopover);
      setPendingPopover(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [input.barOpen, pendingPopover]);

  useEffect(() => {
    if (popover?.kind !== "quick_filter") return;
    if (input.rules.propertyFilters.some((filter) => filter.filterId === popover.filterId)) return;
    setPopover(null);
  }, [input.rules.propertyFilters, popover]);

  const revealInBar = useCallback(
    (target: DatabaseViewRuleBarPopoverTarget) => {
      if (input.barOpen) {
        setPendingPopover(null);
        if (popoverTargetsEqual(popover, target)) setPulse((current) => current + 1);
        setPopover(target);
        return;
      }
      setPopover(null);
      setPendingPopover(target);
      input.onBarOpenChange(true);
    },
    [input, popover],
  );

  const toggleToolbarPopover = useCallback(
    (
      target: Extract<
        Exclude<DatabaseViewRulePopoverTarget, null>,
        { readonly kind: "create_filter" | "create_sort" }
      >,
    ) => {
      setPendingPopover(null);
      // A floating-layer close and its origin click can share one event turn. Toggle the
      // render snapshot the user acted on, not an intermediate close update from that turn.
      setPopover(popoverTargetsEqual(popover, target) ? null : target);
    },
    [popover],
  );

  const invokeFilterToolbar = useCallback(() => {
    const hasFilters =
      input.rules.propertyFilters.length > 0 || input.rules.advancedFilter !== null;
    if (!input.barOpen && !hasFilters) {
      toggleToolbarPopover({ kind: "create_filter", origin: "toolbar" });
      return;
    }
    input.onBarOpenChange(!input.barOpen);
    setPendingPopover(null);
    setPopover(null);
  }, [input, toggleToolbarPopover]);

  const invokeSortToolbar = useCallback(() => {
    const hasSorts = hasCustomDatabaseViewSort(input.rules.sorts);
    const hasFilters =
      input.rules.propertyFilters.length > 0 || input.rules.advancedFilter !== null;
    const hasAuthoringSurface = hasSorts || hasFilters || input.barOpen;
    if (!hasAuthoringSurface) {
      toggleToolbarPopover({ kind: "create_sort" });
      return;
    }

    const nextBarOpen = !input.barOpen;
    input.onBarOpenChange(nextBarOpen);
    if (!hasSorts) {
      toggleToolbarPopover({ kind: "create_sort" });
      return;
    }
    if (!nextBarOpen) {
      setPendingPopover(null);
      setPopover(null);
      return;
    }
    setPopover(null);
    setPendingPopover({ kind: "sort" });
  }, [input, toggleToolbarPopover]);

  const addQuickFilter = useCallback(
    (property: DataSourcePropertyRecordV2) => {
      const existing = input.rules.propertyFilters.find(
        (filter) => filter.clause.propertyId === property.propertyId,
      );
      if (existing) {
        revealInBar({ kind: "quick_filter", filterId: existing.filterId });
        return;
      }
      const filter: DatabaseViewPropertyFilter = {
        filterId: createUuidV7(),
        clause: createDatabaseViewFilterClause(property),
      };
      input.onRulesChange({
        ...input.rules,
        propertyFilters: [...input.rules.propertyFilters, filter],
      });
      revealInBar({ kind: "quick_filter", filterId: filter.filterId });
    },
    [input, revealInBar],
  );

  const addSort = useCallback(
    (field: DatabaseViewSort["field"]) => {
      const visibleSorts = hasCustomDatabaseViewSort(input.rules.sorts) ? input.rules.sorts : [];
      if (visibleSorts.some((sort) => sortFieldsEqual(sort.field, field))) {
        revealInBar({ kind: "sort" });
        return;
      }
      input.onRulesChange({
        ...input.rules,
        sorts: [...visibleSorts, { field, direction: "asc", nulls: "last" }],
      });
      revealInBar({ kind: "sort" });
    },
    [input, revealInBar],
  );

  const editAdvancedFilter = useCallback(() => {
    revealInBar({ kind: "advanced_filter" });
  }, [revealInBar]);

  const updateQuickFilter = useCallback(
    (filterId: string, clause: DatabaseViewFilterClause) => {
      input.onRulesChange({
        ...input.rules,
        propertyFilters: input.rules.propertyFilters.map((filter) =>
          filter.filterId === filterId ? { ...filter, clause } : filter,
        ),
      });
    },
    [input],
  );

  const removeQuickFilter = useCallback(
    (filterId: string) => {
      input.onRulesChange({
        ...input.rules,
        propertyFilters: input.rules.propertyFilters.filter(
          (filter) => filter.filterId !== filterId,
        ),
      });
      setPopover(null);
    },
    [input],
  );

  const moveQuickFilterToAdvanced = useCallback(
    (filterId: string) => {
      const filter = input.rules.propertyFilters.find(
        (candidate) => candidate.filterId === filterId,
      );
      if (!filter) return;
      const advancedFilter: DatabaseViewFilterGroup = input.rules.advancedFilter
        ? {
            ...input.rules.advancedFilter,
            children: [...input.rules.advancedFilter.children, filter.clause],
          }
        : { kind: "group", operator: "and", children: [filter.clause] };
      input.onRulesChange({
        ...input.rules,
        propertyFilters: input.rules.propertyFilters.filter(
          (candidate) => candidate.filterId !== filterId,
        ),
        advancedFilter,
      });
      revealInBar({ kind: "advanced_filter" });
    },
    [input, revealInBar],
  );

  const reorderQuickFilters = useCallback(
    (orderedFilterIds: readonly string[]) => {
      const byId = new Map(input.rules.propertyFilters.map((filter) => [filter.filterId, filter]));
      if (
        orderedFilterIds.length !== byId.size ||
        new Set(orderedFilterIds).size !== orderedFilterIds.length
      ) {
        return;
      }
      const next = orderedFilterIds.flatMap((filterId) => {
        const filter = byId.get(filterId);
        return filter ? [filter] : [];
      });
      if (next.length !== input.rules.propertyFilters.length) return;
      input.onRulesChange({ ...input.rules, propertyFilters: next });
    },
    [input],
  );

  const setAdvancedFilter = useCallback(
    (advancedFilter: DatabaseViewFilterGroup | null) => {
      input.onRulesChange({ ...input.rules, advancedFilter });
    },
    [input],
  );

  const setSorts = useCallback(
    (sorts: readonly DatabaseViewSort[]) => {
      input.onRulesChange({ ...input.rules, sorts });
    },
    [input],
  );

  return useMemo(
    () => ({
      rules: input.rules,
      barOpen: input.barOpen,
      popover,
      pulse,
      filtersPersonal: input.filtersPersonal,
      sortsPersonal: input.sortsPersonal,
      busy: input.busy ?? false,
      error: input.error ?? null,
      setBarOpen,
      setPopover,
      setPopoverOpen,
      invokeFilterToolbar,
      invokeSortToolbar,
      addQuickFilter,
      addSort,
      editAdvancedFilter,
      updateQuickFilter,
      removeQuickFilter,
      moveQuickFilterToAdvanced,
      reorderQuickFilters,
      setAdvancedFilter,
      setSorts,
      reset: input.onReset,
      publish: input.onPublish,
    }),
    [
      addQuickFilter,
      addSort,
      editAdvancedFilter,
      input.barOpen,
      input.busy,
      input.error,
      input.filtersPersonal,
      input.onPublish,
      input.onReset,
      input.rules,
      input.sortsPersonal,
      invokeFilterToolbar,
      invokeSortToolbar,
      popover,
      pulse,
      removeQuickFilter,
      moveQuickFilterToAdvanced,
      reorderQuickFilters,
      setAdvancedFilter,
      setBarOpen,
      setPopoverOpen,
      setSorts,
      updateQuickFilter,
    ],
  );
}

export const databaseViewRulesHaveVisibleFilters = (rules: DatabaseViewRules): boolean =>
  rules.propertyFilters.length > 0 || rules.advancedFilter !== null;

export const databaseViewRulesHaveVisibleSorts = (rules: DatabaseViewRules): boolean =>
  hasCustomDatabaseViewSort(rules.sorts);

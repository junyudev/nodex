import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw, X } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { formatRulesV2AsJsonLogic, parseRulesV2FromJsonLogic } from "@/lib/toggle-list/rules-v2-jsonlogic";
import {
  deriveToggleListFilterRule,
  moveToggleListProperty,
  removeToggleListFieldClause,
  replaceToggleListFieldClause,
  resolveToggleListPrimarySort,
  setToggleListRulesV2,
  toggleIncludeHostCard,
  toggleShowEmptyEstimate,
  toggleToggleListHiddenProperty,
} from "@/lib/toggle-list/settings";
import {
  formatPropertyName,
  TOGGLE_LIST_PRIORITY_CHIP_LABELS,
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_RANK_FIELDS,
  TOGGLE_LIST_RANK_FIELD_LABELS,
  TOGGLE_LIST_STATUS_LABELS,
  TOGGLE_LIST_STATUS_ORDER,
  TOGGLE_LIST_TAG_FILTER_MODES,
  TOGGLE_LIST_TAG_FILTER_MODE_LABELS,
  type ToggleListClause,
  type ToggleListFilterGroup,
  type ToggleListRankDirection,
  type ToggleListRankField,
  type ToggleListRulesV2,
  type ToggleListSettings,
  type ToggleListSortKey,
  type ToggleListStatusId,
  type ToggleListTagFilterMode,
} from "@/lib/toggle-list/types";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/*  Tailwind class constants                                           */
/* ------------------------------------------------------------------ */

const SECTION_LABEL =
  "text-xs font-medium uppercase tracking-label text-[var(--foreground-tertiary)] select-none";

const ROW_LABEL =
  "text-xs text-[var(--foreground-secondary)] w-[calc(var(--spacing)*18)] shrink-0 select-none";

const CHIP_BASE =
  "h-[calc(var(--spacing)*6)] rounded-md bg-[var(--background-secondary)] text-[var(--foreground-secondary)] px-2 text-xs font-medium cursor-pointer hover:text-[var(--foreground)] hover:bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background-secondary))]";

const CHIP_ACTIVE =
  "bg-[color-mix(in_srgb,var(--accent-blue)_18%,var(--background))] text-[var(--accent-blue)] font-semibold hover:bg-[color-mix(in_srgb,var(--accent-blue)_24%,var(--background))] hover:text-[var(--accent-blue)]";

const ICON_BTN =
  "h-5 w-5 rounded bg-transparent text-[var(--foreground-tertiary)] inline-flex items-center justify-center cursor-pointer hover:not-disabled:text-[var(--foreground)] hover:not-disabled:bg-[var(--background-secondary)] disabled:opacity-30 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)] focus-visible:outline-offset-1";

const GHOST_BTN =
  "inline-flex items-center gap-1 text-xs font-medium text-[var(--foreground-tertiary)] cursor-pointer hover:text-[var(--foreground-secondary)]";

/** Shared overrides to make Radix selects match the compact chip aesthetic.
 *  `h-[calc(var(--spacing)*6)]!` forces height past the base `data-[size=default]:h-9`. */
const SELECT_TRIGGER =
  "shadow-none px-2 py-0! gap-1 h-[calc(var(--spacing)*6)]! [&_svg]:size-3 [&_svg]:opacity-40";

const TAG_MODE_SELECT =
  cn(SELECT_TRIGGER, `
    w-auto max-w-18 min-w-14 shrink-0 rounded-md border-transparent
    bg-(--background-secondary) text-xs
  `);

/* NOTE: The checkbox ::after pseudo-element (rotated checkmark via border-width trick) remains in CSS. */
const CHECKBOX =
  "appearance-none w-3.5 h-3.5 border border-[var(--border)] rounded-sm bg-[var(--background)] cursor-pointer relative shrink-0 hover:border-[var(--border-strong)] checked:bg-[var(--accent-blue)] checked:border-[var(--accent-blue)] focus-visible:outline-2 focus-visible:outline-[var(--accent-blue)] focus-visible:outline-offset-2";

const SUMMARY_BADGE_PRIMARY =
  "bg-[color-mix(in_srgb,var(--accent-blue)_12%,var(--background))] text-[var(--accent-blue)] border-[color-mix(in_srgb,var(--accent-blue)_20%,transparent)]";

/* ------------------------------------------------------------------ */
/*  Summary badges                                                     */
/* ------------------------------------------------------------------ */

const BADGE_BASE =
  "inline-flex items-center gap-1 h-[calc(var(--spacing)*5.5)] px-2 rounded-full text-xs font-medium whitespace-nowrap border";

export function ToggleListSummaryBadges({
  settings,
  visibleCount,
}: {
  settings: ToggleListSettings;
  visibleCount: number;
}) {
  const filter = deriveToggleListFilterRule(settings.rulesV2);
  const primarySort = resolveToggleListPrimarySort(settings.rulesV2);
  const primaryField = primarySort.field;
  const primaryDirection = primarySort.direction;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn(BADGE_BASE, SUMMARY_BADGE_PRIMARY)}>
        {visibleCount} {visibleCount === 1 ? "card" : "cards"}
      </span>
      {filter.statuses.length < TOGGLE_LIST_STATUS_ORDER.length && (
        <span
          className={cn(
            BADGE_BASE,
            "border-(--border) bg-(--background-secondary) text-(--foreground-secondary)",
          )}
        >
          {filter.statuses.length}/{TOGGLE_LIST_STATUS_ORDER.length} statuses
        </span>
      )}
      {filter.priorities.length < TOGGLE_LIST_PRIORITY_ORDER.length && (
        <span
          className={cn(
            BADGE_BASE,
            "border-(--border) bg-(--background-secondary) text-(--foreground-secondary)",
          )}
        >
          {filter.priorities.length}/{TOGGLE_LIST_PRIORITY_ORDER.length} priorities
        </span>
      )}
      {filter.tags.length > 0 && (
        <span
          className={cn(
            BADGE_BASE,
            "border-(--border) bg-(--background-secondary) text-(--foreground-secondary)",
          )}
        >
          {filter.tags.length} {filter.tags.length === 1 ? "tag" : "tags"}:{" "}
          {filter.tagMode}
        </span>
      )}
      <span className={cn(BADGE_BASE, "border-transparent bg-transparent text-(--foreground-tertiary)")}>
        {TOGGLE_LIST_RANK_FIELD_LABELS[primaryField]}{" "}
        {primaryDirection === "asc" ? "\u2191" : "\u2193"}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Rules body                                                         */
/* ------------------------------------------------------------------ */

interface ToggleListRulesBodyProps {
  settings: ToggleListSettings;
  availableTags: string[];
  updateSettings: (fn: (prev: ToggleListSettings) => ToggleListSettings) => void;
  showHostCardToggle?: boolean;
  /** Tighter spacing and smaller labels for inline embed context. */
  compact?: boolean;
}

export function ToggleListRulesBody({
  settings,
  availableTags,
  updateSettings,
  showHostCardToggle = false,
  compact = false,
}: ToggleListRulesBodyProps) {
  const [dslText, setDslText] = useState(() => formatRulesV2AsJsonLogic(settings.rulesV2));
  const [dslError, setDslError] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    setDslText(formatRulesV2AsJsonLogic(settings.rulesV2));
  }, [settings.rulesV2]);

  const updateRulesV2 = (fn: (rules: ToggleListRulesV2) => ToggleListRulesV2) => {
    updateSettings((prev) => setToggleListRulesV2(prev, {
      ...fn(prev.rulesV2),
      mode: "advanced",
    }));
  };

  const applyDslText = () => {
    const parsed = parseRulesV2FromJsonLogic(dslText);
    if (!parsed.rules) {
      setDslError(parsed.error);
      return;
    }
    const parsedRules = parsed.rules;
    setDslError(null);
    updateRulesV2(() => ({
      ...parsedRules,
      mode: "advanced",
    }));
  };

  const sectionPy = compact ? "py-2" : "py-2.5";
  const sectionGap = compact ? "gap-1.5" : "gap-2";

  return (
    <div className="flex flex-col">
      <div className="mt-1 flex items-center justify-end">
        <button
          type="button"
          role="switch"
          aria-checked={showRaw}
          className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium text-(--foreground-secondary) focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-(--accent-blue)/50 focus-visible:outline-none"
          onClick={() => setShowRaw((prev) => !prev)}
        >
          <span>Raw</span>
          <span
            className={cn(
              "relative inline-flex h-5 w-8 shrink-0 items-center rounded-full transition-colors duration-200 ease-out",
              showRaw ? "bg-(--accent-blue)" : "bg-foreground-10",
            )}
          >
            <span
              className={cn(
                "size-4 rounded-full border border-white bg-white shadow-sm transition-transform duration-200 ease-out",
                showRaw ? "translate-x-3.25" : "translate-x-0.75",
              )}
            />
          </span>
        </button>
      </div>

      {!showRaw ? (
        <div className="flex flex-col">
          <FilterSection
            compact={compact}
            sectionPy={sectionPy}
            sectionGap={sectionGap}
            settings={settings}
            availableTags={availableTags}
            updateRulesV2={updateRulesV2}
          />
          <SortSection
            compact={compact}
            sectionPy={sectionPy}
            sectionGap={sectionGap}
            settings={settings}
            updateRulesV2={updateRulesV2}
          />
          <PropertiesSection
            compact={compact}
            sectionPy={sectionPy}
            settings={settings}
            updateSettings={updateSettings}
            showHostCardToggle={showHostCardToggle}
          />
        </div>
      ) : (
        <div className={cn("flex flex-col border-t border-(--border)/40", sectionPy)}>
          <div className="flex flex-col gap-1.5">
            <textarea
              value={dslText}
              onChange={(event) => {
                if (dslError) setDslError(null);
                setDslText(event.target.value);
              }}
              className="min-h-80 w-full rounded-md border-[0.5px] border-(--border)/50 bg-[color-mix(in_srgb,var(--foreground)_3%,var(--background))] p-2 font-mono text-xs/relaxed text-(--foreground) focus:border-(--accent-blue)/40 focus:outline-none"
              spellCheck={false}
            />
            <div className="flex items-center justify-between">
              {dslError ? (
                <span className="truncate text-xs text-(--destructive)">{dslError}</span>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={cn(GHOST_BTN)}
                  onClick={() => {
                    setDslError(null);
                    setDslText(formatRulesV2AsJsonLogic(settings.rulesV2));
                  }}
                >
                  <RotateCcw className="size-3 shrink-0" />
                  Revert
                </button>
                <button
                  type="button"
                  className={cn(GHOST_BTN, "text-(--accent-blue) hover:text-(--accent-blue)")}
                  onClick={applyDslText}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Filter section                                                     */
/* ------------------------------------------------------------------ */

function FilterSection({
  compact,
  sectionPy,
  sectionGap,
  settings,
  availableTags,
  updateRulesV2,
}: {
  compact: boolean;
  sectionPy: string;
  sectionGap: string;
  settings: ToggleListSettings;
  availableTags: string[];
  updateRulesV2: (fn: (rules: ToggleListRulesV2) => ToggleListRulesV2) => void;
}) {
  const addGroup = () => {
    updateRulesV2((prev) => ({
      ...prev,
      filter: {
        any: [...prev.filter.any, createDefaultGroup()],
      },
    }));
  };

  const updateGroup = (index: number, group: ToggleListFilterGroup) => {
    updateRulesV2((prev) => {
      const nextGroups = [...prev.filter.any];
      nextGroups[index] = group;
      return { ...prev, filter: { any: nextGroups } };
    });
  };

  const removeGroup = (index: number) => {
    updateRulesV2((prev) => {
      if (prev.filter.any.length <= 1) {
        return { ...prev, filter: { any: [createDefaultGroup()] } };
      }
      return { ...prev, filter: { any: prev.filter.any.filter((_, i) => i !== index) } };
    });
  };

  return (
    <div className={cn("flex flex-col border-t border-(--border)/40", sectionPy, sectionGap)}>
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL}>Filters</span>
        <button type="button" className={GHOST_BTN} onClick={addGroup}>
          <Plus className="size-3" />
          Group
        </button>
      </div>

      {settings.rulesV2.filter.any.map((group, groupIndex) => (
        <div key={`group-${groupIndex}`}>
          {groupIndex > 0 && (
            <div className="flex items-center gap-3 py-1.5">
              <div className="flex-1 border-t border-(--border)/30" />
              <span className="text-xs font-medium tracking-widest text-(--foreground-tertiary)/60 uppercase select-none">
                or
              </span>
              <div className="flex-1 border-t border-(--border)/30" />
            </div>
          )}
          <GroupEditor
            groupIndex={groupIndex}
            group={group}
            availableTags={availableTags}
            onChange={(next) => updateGroup(groupIndex, next)}
            onRemove={() => removeGroup(groupIndex)}
            removable={settings.rulesV2.filter.any.length > 1}
            compact={compact}
          />
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sort section                                                       */
/* ------------------------------------------------------------------ */

function SortSection({
  compact,
  sectionPy,
  sectionGap,
  settings,
  updateRulesV2,
}: {
  compact: boolean;
  sectionPy: string;
  sectionGap: string;
  settings: ToggleListSettings;
  updateRulesV2: (fn: (rules: ToggleListRulesV2) => ToggleListRulesV2) => void;
}) {
  const addSort = () => {
    updateRulesV2((prev) => {
      const used = new Set(prev.sort.map((entry) => entry.field));
      const nextField = TOGGLE_LIST_RANK_FIELDS.find((field) => !used.has(field)) ?? "board-order";
      return { ...prev, sort: [...prev.sort, { field: nextField, direction: "asc" }] };
    });
  };

  const updateSort = (index: number, entry: ToggleListSortKey) => {
    updateRulesV2((prev) => {
      const nextSort = [...prev.sort];
      nextSort[index] = entry;
      return { ...prev, sort: nextSort };
    });
  };

  const moveSort = (index: number, direction: -1 | 1) => {
    updateRulesV2((prev) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= prev.sort.length) return prev;
      const nextSort = [...prev.sort];
      nextSort[index] = nextSort[nextIndex];
      nextSort[nextIndex] = prev.sort[index];
      return { ...prev, sort: nextSort };
    });
  };

  const removeSort = (index: number) => {
    updateRulesV2((prev) => {
      if (prev.sort.length <= 1) return prev;
      return { ...prev, sort: prev.sort.filter((_, i) => i !== index) };
    });
  };

  return (
    <div className={cn("flex flex-col border-t border-(--border)/40", sectionPy, sectionGap)}>
      <div className="flex items-center justify-between">
        <span className={SECTION_LABEL}>Sort</span>
        <button type="button" className={GHOST_BTN} onClick={addSort}>
          <Plus className="size-3" />
          Sort
        </button>
      </div>

      <div className={cn("flex flex-col", compact ? "gap-1" : "gap-1.5")}>
        {settings.rulesV2.sort.map((entry, index) => (
          <div key={`${entry.field}:${index}`} className="flex items-center gap-1.5">
            <Select
              value={entry.field}
              onValueChange={(value) => updateSort(index, { ...entry, field: value as ToggleListRankField })}
            >
              <SelectTrigger className={cn(SELECT_TRIGGER, "max-w-32.5 min-w-25 rounded-md border-transparent bg-(--background-secondary) text-xs")}>
                {TOGGLE_LIST_RANK_FIELD_LABELS[entry.field]}
              </SelectTrigger>
              <SelectContent sideOffset={4}>
                {TOGGLE_LIST_RANK_FIELDS.map((field) => (
                  <SelectItem key={field} value={field}>
                    {TOGGLE_LIST_RANK_FIELD_LABELS[field]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={entry.direction}
              onValueChange={(value) => updateSort(index, { ...entry, direction: value as ToggleListRankDirection })}
            >
              <SelectTrigger className={cn(SELECT_TRIGGER, "w-16 rounded-md border-transparent bg-(--background-secondary) text-xs")}>
                {entry.direction === "asc" ? "Asc" : "Desc"}
              </SelectTrigger>
              <SelectContent sideOffset={4}>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </Select>

            <div className="ml-auto flex items-center gap-0.5">
              <button
                type="button"
                className={ICON_BTN}
                onClick={() => moveSort(index, -1)}
                disabled={index === 0}
                title="Move up"
              >
                <ArrowUp className="size-3" />
              </button>
              <button
                type="button"
                className={ICON_BTN}
                onClick={() => moveSort(index, 1)}
                disabled={index === settings.rulesV2.sort.length - 1}
                title="Move down"
              >
                <ArrowDown className="size-3" />
              </button>
              <button
                type="button"
                className={ICON_BTN}
                onClick={() => removeSort(index)}
                disabled={settings.rulesV2.sort.length <= 1}
                title="Remove sort"
              >
                <X className="size-3" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Properties & Display section                                       */
/* ------------------------------------------------------------------ */

function PropertiesSection({
  compact,
  sectionPy,
  settings,
  updateSettings,
  showHostCardToggle,
}: {
  compact: boolean;
  sectionPy: string;
  settings: ToggleListSettings;
  updateSettings: (fn: (prev: ToggleListSettings) => ToggleListSettings) => void;
  showHostCardToggle: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-2 border-t border-(--border)/40", sectionPy)}>
      <span className={SECTION_LABEL}>Properties</span>

      <div className={cn("flex gap-4", compact ? "flex-col" : "flex-row items-start")}>
        {/* Property rows */}
        <div className="flex min-w-45 flex-col gap-1">
          {settings.propertyOrder.map((property, index) => {
            const hidden = settings.hiddenProperties.includes(property);
            return (
              <div key={property} className="group flex h-6 items-center gap-1">
                <span className={cn("w-18 shrink-0 truncate text-xs font-medium", hidden ? "text-(--foreground-tertiary)" : "text-(--foreground-secondary)")}>
                  {formatPropertyName(property)}
                </span>
                <button
                  type="button"
                  className={cn(ICON_BTN, hidden && "text-(--foreground-tertiary)/40")}
                  onClick={() => updateSettings((prev) => toggleToggleListHiddenProperty(prev, property))}
                  title={hidden ? "Show" : "Hide"}
                >
                  {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
                </button>
                <button
                  type="button"
                  className={cn(ICON_BTN, "opacity-0 group-hover:opacity-100")}
                  onClick={() => updateSettings((prev) => moveToggleListProperty(prev, property, -1))}
                  disabled={index === 0}
                  title="Move up"
                >
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  className={cn(ICON_BTN, "opacity-0 group-hover:opacity-100")}
                  onClick={() => updateSettings((prev) => moveToggleListProperty(prev, property, 1))}
                  disabled={index === settings.propertyOrder.length - 1}
                  title="Move down"
                >
                  <ArrowDown className="size-3" />
                </button>
              </div>
            );
          })}
        </div>

        {/* Display toggles */}
        <div className={cn("flex flex-col gap-1.5", !compact && "pt-0.5")}>
          {showHostCardToggle && (
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-(--foreground-secondary) select-none">
              <input
                type="checkbox"
                checked={settings.rulesV2.includeHostCard}
                onChange={() => updateSettings((prev) => toggleIncludeHostCard(prev))}
                className={cn(CHECKBOX, "nodex-toggle-list-checkbox")}
              />
              Include host card
            </label>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-(--foreground-secondary) select-none">
            <input
              type="checkbox"
              checked={settings.showEmptyEstimate}
              onChange={() => updateSettings((prev) => toggleShowEmptyEstimate(prev))}
              className={cn(CHECKBOX, "nodex-toggle-list-checkbox")}
            />
            Show empty estimate as &ndash;
          </label>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Group editor (flat rows)                                           */
/* ------------------------------------------------------------------ */

function GroupEditor({
  group,
  groupIndex,
  availableTags,
  onChange,
  onRemove,
  removable,
  compact,
}: {
  group: ToggleListFilterGroup;
  groupIndex: number;
  availableTags: string[];
  onChange: (group: ToggleListFilterGroup) => void;
  onRemove: () => void;
  removable: boolean;
  compact: boolean;
}) {
  const statusValues = getStatusValues(group);
  const priorityValues = getPriorityValues(group);
  const tagClause = getTagClause(group);
  const tagValues = tagClause?.values ?? [];
  const tagMode: ToggleListTagFilterMode = tagClause
    ? tagClause.op === "hasAny"
      ? "any"
      : tagClause.op === "hasAll"
        ? "all"
        : "none"
    : "any";

  const toggleStatus = (status: ToggleListStatusId) => {
    const exists = statusValues.includes(status);
    const next = exists
      ? statusValues.filter((item) => item !== status)
      : [...statusValues, status];
    onChange(upsertClause(group, { field: "status", op: "in", values: next }));
  };

  const togglePriority = (priority: typeof TOGGLE_LIST_PRIORITY_ORDER[number]) => {
    const exists = priorityValues.includes(priority);
    const next = exists
      ? priorityValues.filter((item) => item !== priority)
      : [...priorityValues, priority];
    onChange(upsertClause(group, { field: "priority", op: "in", values: next }));
  };

  const toggleTag = (tag: string) => {
    const exists = tagValues.includes(tag);
    const next = exists
      ? tagValues.filter((item) => item !== tag)
      : [...tagValues, tag];
    if (next.length === 0) {
      onChange(removeClause(group, "tags"));
      return;
    }
    const op = tagMode === "any" ? "hasAny" : tagMode === "all" ? "hasAll" : "hasNone";
    onChange(upsertClause(group, { field: "tags", op, values: next }));
  };

  const setTagMode = (mode: ToggleListTagFilterMode) => {
    if (tagValues.length === 0) {
      onChange(removeClause(group, "tags"));
      return;
    }
    const op = mode === "any" ? "hasAny" : mode === "all" ? "hasAll" : "hasNone";
    onChange(upsertClause(group, { field: "tags", op, values: tagValues }));
  };

  const rowGap = compact ? "gap-1" : "gap-1.5";

  return (
    <div className={cn("relative flex flex-col", rowGap)}>
      {removable && (
        <button
          type="button"
          className={cn(ICON_BTN, "absolute -top-0.5 -right-0.5")}
          onClick={onRemove}
          title="Remove group"
        >
          <X className="size-3" />
        </button>
      )}

      {/* Status row */}
      <div className="flex items-start gap-2">
        <span className={cn(ROW_LABEL, "pt-0.75")}>Status</span>
        <div className="flex flex-wrap gap-1">
          {TOGGLE_LIST_STATUS_ORDER.map((status) => (
            <button
              key={`s-${groupIndex}-${status}`}
              type="button"
              onClick={() => toggleStatus(status)}
              className={cn(CHIP_BASE, statusValues.includes(status) && CHIP_ACTIVE)}
            >
              {TOGGLE_LIST_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
      </div>

      {/* Priority row */}
      <div className="flex items-start gap-2">
        <span className={cn(ROW_LABEL, "pt-0.75")}>Priority</span>
        <div className="flex flex-wrap gap-1">
          {TOGGLE_LIST_PRIORITY_ORDER.map((priority) => (
            <button
              key={`p-${groupIndex}-${priority}`}
              type="button"
              onClick={() => togglePriority(priority)}
              className={cn(CHIP_BASE, priorityValues.includes(priority) && CHIP_ACTIVE)}
            >
              {TOGGLE_LIST_PRIORITY_CHIP_LABELS[priority]}
            </button>
          ))}
        </div>
      </div>

      {/* Tags row */}
      <div className="flex items-start gap-2">
        <span className={cn(ROW_LABEL, "pt-0.75")}>Tags</span>
        <div className="flex flex-wrap items-start gap-1.5">
          <Select
            value={tagMode}
            onValueChange={(value) => setTagMode(value as ToggleListTagFilterMode)}
          >
            <SelectTrigger className={TAG_MODE_SELECT}>
              {TOGGLE_LIST_TAG_FILTER_MODE_LABELS[tagMode]}
            </SelectTrigger>
            <SelectContent sideOffset={4}>
              {TOGGLE_LIST_TAG_FILTER_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {TOGGLE_LIST_TAG_FILTER_MODE_LABELS[mode]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {availableTags.length === 0 && (
            <span className="pt-[calc(var(--spacing)*1)] text-xs text-(--foreground-tertiary) italic">
              No tags in project
            </span>
          )}
          {availableTags.map((tag) => (
            <button
              key={`t-${groupIndex}-${tag}`}
              type="button"
              onClick={() => toggleTag(tag)}
              className={cn(CHIP_BASE, tagValues.includes(tag) && CHIP_ACTIVE)}
            >
              {tag}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function createDefaultGroup(): ToggleListFilterGroup {
  return {
    all: [
      { field: "status", op: "in", values: [...TOGGLE_LIST_STATUS_ORDER] },
      { field: "priority", op: "in", values: [...TOGGLE_LIST_PRIORITY_ORDER] },
    ],
  };
}

function getStatusValues(group: ToggleListFilterGroup): ToggleListStatusId[] {
  const clause = group.all.find((candidate): candidate is Extract<ToggleListClause, { field: "status" }> =>
    candidate.field === "status",
  );
  return clause ? clause.values : [...TOGGLE_LIST_STATUS_ORDER];
}

function getPriorityValues(group: ToggleListFilterGroup): typeof TOGGLE_LIST_PRIORITY_ORDER[number][] {
  const clause = group.all.find((candidate): candidate is Extract<ToggleListClause, { field: "priority" }> =>
    candidate.field === "priority",
  );
  return clause ? clause.values : [...TOGGLE_LIST_PRIORITY_ORDER];
}

function getTagClause(
  group: ToggleListFilterGroup,
): Extract<ToggleListClause, { field: "tags" }> | null {
  const clause = group.all.find((candidate): candidate is Extract<ToggleListClause, { field: "tags" }> =>
    candidate.field === "tags",
  );
  return clause ?? null;
}

function removeClause(
  group: ToggleListFilterGroup,
  field: ToggleListClause["field"],
): ToggleListFilterGroup {
  return removeToggleListFieldClause(group, field);
}

function upsertClause(
  group: ToggleListFilterGroup,
  clause: ToggleListClause,
): ToggleListFilterGroup {
  return replaceToggleListFieldClause(group, clause);
}

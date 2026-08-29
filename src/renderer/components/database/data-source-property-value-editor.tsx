import { useEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { NodexCheckbox } from "@/components/ui/settings";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { dataSourcePropertyIcon } from "./data-source-property-presentation";
import { DueDateValueIcon } from "./due-date-value-icon";
import {
  createCustomOptionId,
  isCustomDataSourcePropertyId,
  TASK_PARENT_PROPERTY_ID,
} from "../../../shared/database-identities";
import type { DatabaseJsonValue } from "../../../shared/database-kernel";
import { resolveDataSourcePropertyPresentationRole } from "@/lib/data-source-property-presentation-role";
import { defaultDataSourcePropertyOptionColor } from "@/lib/data-source-property-options";
import { formatDatabaseNumber } from "@/lib/database-property-display-format";
import { RelationPropertyEditor } from "./relation-property-editor";
import { PropertyOptionPicker, type PropertyOptionPickerHost } from "./property-option-picker";
import { SemanticSelectPropertyEditor } from "./semantic-property-editors";
import { DatePropertyEditor } from "./date-property-editor";
import type { DataSourcePropertyEditorBinding } from "./data-source-property-editor-binding";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PROPERTY_EMPTY_VALUE_LABEL,
} from "./property-empty-value";
import {
  DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME,
  type DatabasePropertyValuePresentation,
} from "./property-value-chip";

const valueInputClass = cn(
  "h-6 min-w-0 rounded-md border border-transparent bg-transparent",
  "text-token-text-secondary outline-none placeholder:text-token-text-secondary hover:bg-token-foreground/5 focus:border-token-focus-border focus:bg-token-foreground/5",
);

// An inset ring preserves focus feedback without shifting Page scalar text past borderless triggers.
const pageScalarInputClass =
  "w-full max-w-72 border-0 px-1 text-sm focus:ring-1 focus:ring-inset focus:ring-token-focus-border";

const scalarString = (value: DatabaseJsonValue | undefined): string =>
  typeof value === "string" ? value : "";

const unsupportedPropertyValueType = (valueType: never): never => {
  throw new Error(`Unsupported Property value type: ${String(valueType)}`);
};

interface ScalarPropertyEditorProps {
  readonly label: string;
  readonly value: string;
  readonly revision: number;
  readonly disabled: boolean;
  readonly presentation: DatabasePropertyValuePresentation;
  readonly kind: "text" | "number";
  readonly triggerIcon?: ReactNode;
  readonly formatDisplayValue?: (value: string) => string;
  readonly onChange: (value: DatabaseJsonValue) => void;
}

function ScalarPropertyEditor({
  label,
  value,
  revision,
  disabled,
  presentation,
  kind,
  triggerIcon,
  formatDisplayValue,
  onChange,
}: ScalarPropertyEditorProps) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const skipBlurCommitRef = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  useEffect(() => {
    setDraft(value);
    setError(null);
  }, [revision, value]);

  const commit = () => {
    if (disabledRef.current) {
      setDraft(value);
      setError(null);
      return;
    }
    if (draft === value) return;
    if (kind !== "number") {
      onChange(draft || null);
      return;
    }
    if (!draft.trim()) {
      onChange(null);
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setError("Enter a finite number");
      return;
    }
    setError(null);
    onChange(parsed);
  };

  const dense = presentation === "list" || presentation === "board";
  const presentedDraft = focused || !formatDisplayValue ? draft : formatDisplayValue(draft);
  const input = (
    <input
      type="text"
      inputMode={kind === "number" ? "decimal" : "text"}
      aria-label={`${label} value`}
      aria-invalid={error !== null}
      size={presentation === "board" ? Math.max(1, Math.min(presentedDraft.length, 18)) : undefined}
      value={presentedDraft}
      disabled={disabled}
      placeholder={PROPERTY_EMPTY_VALUE_LABEL}
      onFocus={() => setFocused(true)}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setFocused(false);
        if (skipBlurCommitRef.current) {
          skipBlurCommitRef.current = false;
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key !== "Escape") return;
        skipBlurCommitRef.current = true;
        setDraft(value);
        setError(null);
        event.currentTarget.blur();
      }}
      className={cn(
        valueInputClass,
        presentation === "page"
          ? cn(
              pageScalarInputClass,
              draft.length === 0 && DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
            )
          : presentation === "list"
            ? "h-full min-w-0 max-w-40 flex-1 border-0 bg-transparent p-0 text-xs text-[var(--database-property-chip-current-text,var(--database-property-chip-text))] hover:bg-transparent focus:bg-transparent focus:ring-0"
            : presentation === "board"
              ? "h-full min-w-[2ch] max-w-40 flex-none border-0 bg-transparent p-0 text-xs text-[var(--database-property-chip-current-text,var(--database-property-chip-text))] hover:bg-transparent focus:bg-transparent focus:ring-0"
              : "w-32 px-1.5 text-[11px]",
      )}
    />
  );
  return (
    <span className="inline-flex min-w-0 flex-col items-start">
      {dense ? (
        <span className={DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME}>
          {triggerIcon}
          {input}
        </span>
      ) : (
        input
      )}
      {error ? (
        <span role="alert" className="px-1.5 text-xs text-token-error-foreground">
          {error}
        </span>
      ) : null}
    </span>
  );
}

export interface DataSourcePropertyValueEditorProps extends DataSourcePropertyEditorBinding {
  readonly showLabel?: boolean;
  readonly presentation?: DatabasePropertyValuePresentation;
  readonly triggerIcon?: ReactNode;
  readonly optionPickerHost?: PropertyOptionPickerHost;
  readonly optionPickerTrigger?: ReactElement;
  readonly onOptionPickerCommit?: () => void;
  readonly overlayHost?: "popover" | "embedded";
  readonly onOverlayRequestClose?: () => void;
}

const EMPTY_RELATION_CANDIDATES: NonNullable<
  DataSourcePropertyValueEditorProps["relationCandidates"]
> = [];
const EMPTY_PROPERTY_OPTIONS: NonNullable<DataSourcePropertyValueEditorProps["options"]> = [];
const ignoreRelationPatch: NonNullable<
  DataSourcePropertyValueEditorProps["onPatchRelation"]
> = () => undefined;

export function DataSourcePropertyValueEditor({
  property,
  value,
  revision,
  disabled,
  pending = false,
  showLabel = true,
  presentation = "compact",
  triggerIcon,
  optionPickerHost,
  optionPickerTrigger,
  onOptionPickerCommit,
  overlayHost = "popover",
  onOverlayRequestClose,
  onChange,
  onCreateOption,
  onRequestOptions,
  optionRegistryHasMore = false,
  optionRegistryLoadingMore = false,
  onRequestMoreOptions,
  onPatchOptions,
  relationCandidates = EMPTY_RELATION_CANDIDATES,
  relationSourcePageId,
  options = EMPTY_PROPERTY_OPTIONS,
  optionRegistryState = "ready",
  onPatchRelation = ignoreRelationPatch,
  onReplaceOneRelation,
  onLoadRelationTargets,
  onSearchRelationCandidates,
  onLoadRelationTargetDescriptor,
  onOpenRelationPage,
  onRelationValueStale,
}: DataSourcePropertyValueEditorProps) {
  const role = resolveDataSourcePropertyPresentationRole(property);
  const PropertyIcon = dataSourcePropertyIcon(property);
  const boardIcon =
    presentation !== "board" ? undefined : role.kind === "due_date" ? (
      <DueDateValueIcon value={value} />
    ) : PropertyIcon ? (
      <PropertyIcon className="size-3.5 shrink-0 text-[var(--database-property-chip-current-text,var(--database-property-chip-text))]" />
    ) : undefined;
  const valueTriggerIcon = presentation === "board" ? boardIcon : triggerIcon;
  const createOption = onCreateOption
    ? (name: string) => {
        const optionId = createCustomOptionId();
        return onCreateOption({
          optionId,
          name,
          color: defaultDataSourcePropertyOptionColor(optionId),
        });
      }
    : undefined;
  const textClass = presentation === "page" ? "text-sm" : "text-[11px]";
  const label = showLabel ? (
    <span className={cn("shrink-0 text-token-description-foreground", textClass)}>
      {property.name}
    </span>
  ) : null;
  if (property.valueType === "relation") {
    return (
      <RelationPropertyEditor
        label={property.name}
        value={value}
        candidates={relationCandidates}
        excludedPageId={
          property.propertyId === TASK_PARENT_PROPERTY_ID ? relationSourcePageId : undefined
        }
        cardinality={property.schema.kind === "relation" ? property.schema.cardinality : "many"}
        disabled={disabled}
        pending={pending}
        targetMatchesCurrentSource={
          property.schema.kind === "relation" &&
          property.schema.targetDataSourceId === property.dataSourceId
        }
        targetDataSourceId={
          property.schema.kind === "relation" ? property.schema.targetDataSourceId : undefined
        }
        onPatch={onPatchRelation}
        onReplace={onReplaceOneRelation}
        onClear={() => onChange([])}
        onLoadMore={onLoadRelationTargets}
        onSearchCandidates={onSearchRelationCandidates}
        onLoadTargetDescriptor={onLoadRelationTargetDescriptor}
        onOpenPage={onOpenRelationPage}
        onValueStale={onRelationValueStale}
        showLabel={showLabel}
        presentation={presentation}
        triggerIcon={valueTriggerIcon}
        host={overlayHost}
        onRequestClose={onOverlayRequestClose}
      />
    );
  }
  if (property.valueType === "checkbox") {
    if (presentation === "board") {
      const checked = value === true;
      return (
        <NodexTooltip tooltipContent={`${property.name}: ${checked ? "Yes" : "No"}`}>
          <button
            type="button"
            role="checkbox"
            aria-checked={checked}
            aria-label={`${property.name} value: ${checked ? "Yes" : "No"}`}
            disabled={disabled || pending}
            onClick={() => onChange(!checked)}
            className={DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME}
          >
            {boardIcon}
            <span>{checked ? "Yes" : "No"}</span>
          </button>
        </NodexTooltip>
      );
    }
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {label}
        <NodexCheckbox
          ariaLabel={`${property.name} value`}
          checked={value === true}
          disabled={disabled || pending}
          onCheckedChange={(checked) => onChange(checked)}
          className={presentation === "list" ? "size-3.5" : undefined}
        />
      </span>
    );
  }
  if (property.valueType === "select") {
    const selectedId = scalarString(value) || null;
    const semanticKind =
      role.kind === "status" || role.kind === "priority" || role.kind === "estimate"
        ? role.kind
        : null;
    const editor = semanticKind ? (
      <SemanticSelectPropertyEditor
        host={optionPickerHost}
        kind={semanticKind}
        label={property.name}
        options={options}
        registryState={optionRegistryState}
        selectedId={selectedId}
        disabled={disabled}
        pending={pending}
        presentation={presentation}
        triggerPrefix={
          presentation === "list" ? triggerIcon : presentation === "board" ? boardIcon : undefined
        }
        triggerButton={optionPickerTrigger}
        onRequestOptions={onRequestOptions}
        hasMore={optionRegistryHasMore}
        loadingMore={optionRegistryLoadingMore}
        onRequestMoreOptions={onRequestMoreOptions}
        onCommit={onOptionPickerCommit}
        onChange={onChange}
      />
    ) : (
      <PropertyOptionPicker
        host={optionPickerHost}
        label={property.name}
        mode="single"
        options={options}
        selectedIds={selectedId ? [selectedId] : []}
        disabled={disabled}
        pending={pending}
        presentation={presentation}
        triggerPrefix={presentation === "list" ? triggerIcon : undefined}
        triggerButton={optionPickerTrigger}
        registryError={optionRegistryState === "error"}
        loading={optionRegistryState === "idle" || optionRegistryState === "loading"}
        onOpen={onRequestOptions}
        hasMore={optionRegistryHasMore}
        loadingMore={optionRegistryLoadingMore}
        onLoadMore={onRequestMoreOptions}
        onCommit={onOptionPickerCommit}
        allowCreate={
          optionRegistryState === "ready" &&
          !optionRegistryHasMore &&
          isCustomDataSourcePropertyId(property.propertyId)
        }
        onSelectedIdsChange={(ids) => onChange(ids[0] ?? null)}
        onCreateOption={createOption}
      />
    );
    if (optionPickerHost === "embedded") return editor;
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {label}
        {editor}
      </span>
    );
  }
  if (property.valueType === "multi_select") {
    const selectedIds = Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === "string")
      : [];
    const changeSelectedIds = (nextIds: readonly string[]) => {
      if (!onPatchOptions) {
        onChange([...nextIds]);
        return;
      }
      const current = new Set(selectedIds);
      const next = new Set(nextIds);
      onPatchOptions({
        addOptionIds: [...next].filter((optionId) => !current.has(optionId)),
        removeOptionIds: [...current].filter((optionId) => !next.has(optionId)),
      });
    };
    const editor = (
      <PropertyOptionPicker
        host={optionPickerHost}
        label={property.name}
        mode="multiple"
        options={options}
        loading={optionRegistryState === "idle" || optionRegistryState === "loading"}
        registryError={optionRegistryState === "error"}
        onOpen={onRequestOptions}
        hasMore={optionRegistryHasMore}
        loadingMore={optionRegistryLoadingMore}
        onLoadMore={onRequestMoreOptions}
        selectedIds={selectedIds}
        disabled={disabled}
        pending={pending}
        presentation={presentation}
        triggerPrefix={presentation === "list" ? triggerIcon : undefined}
        triggerButton={optionPickerTrigger}
        onCommit={onOptionPickerCommit}
        allowCreate={
          optionRegistryState === "ready" &&
          !optionRegistryHasMore &&
          (role.kind === "tags" || isCustomDataSourcePropertyId(property.propertyId))
        }
        onSelectedIdsChange={changeSelectedIds}
        onCreateOption={createOption}
      />
    );
    if (optionPickerHost === "embedded") return editor;
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {label}
        {editor}
      </span>
    );
  }
  if (property.valueType === "date" || property.valueType === "datetime") {
    const editor = (
      <DatePropertyEditor
        label={property.name}
        mode={property.valueType}
        value={scalarString(value) || null}
        revision={revision}
        disabled={disabled || pending}
        presentation={presentation}
        dateFormat={
          property.schema.kind === "date" || property.schema.kind === "datetime"
            ? property.schema.dateFormat
            : "full"
        }
        timeFormat={
          property.schema.kind === "datetime" ? property.schema.timeFormat : "twelve_hour"
        }
        triggerIcon={
          presentation === "list" || presentation === "board" ? valueTriggerIcon : undefined
        }
        host={overlayHost}
        onRequestClose={onOverlayRequestClose}
        onChange={onChange}
      />
    );
    if (overlayHost === "embedded") return editor;
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {label}
        {editor}
      </span>
    );
  }
  if (property.valueType === "text" || property.valueType === "number") {
    const numberFormat = property.schema.kind === "number" ? property.schema.format : null;
    return (
      <span className="inline-flex min-w-0 items-center gap-1">
        {label}
        <ScalarPropertyEditor
          label={property.name}
          value={
            property.valueType === "number"
              ? typeof value === "number"
                ? String(value)
                : ""
              : scalarString(value)
          }
          revision={revision}
          disabled={disabled || pending}
          presentation={presentation}
          kind={property.valueType}
          triggerIcon={
            presentation === "list" || presentation === "board" ? valueTriggerIcon : undefined
          }
          formatDisplayValue={
            numberFormat
              ? (raw) => {
                  if (!raw.trim()) return raw;
                  const parsed = Number(raw);
                  return Number.isFinite(parsed) ? formatDatabaseNumber(parsed, numberFormat) : raw;
                }
              : undefined
          }
          onChange={onChange}
        />
      </span>
    );
  }
  return unsupportedPropertyValueType(property.valueType);
}

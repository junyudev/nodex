import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import { CheckmarkIcon, CloseIcon, PlusIcon, SearchIcon } from "@/components/shared/icons";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NODEX_RAISED_CONTROL_CHROME_CLASS_NAME } from "@/components/ui/control-chrome";
import {
  canCreateDataSourcePropertyOption,
  filterDataSourcePropertyOptions,
  presentSelectedDataSourcePropertyOptions,
  propertyOptionColorClassName,
  type PresentedDataSourcePropertyOption,
} from "@/lib/data-source-property-options";
import { cn } from "@/lib/utils";
import type { DatabasePropertyOption } from "../../../shared/database-kernel";
import {
  DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME,
  PROPERTY_EMPTY_VALUE_LABEL,
  PropertyEmptyValue,
} from "./property-empty-value";
import {
  DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME,
  DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME,
  DATABASE_PROPERTY_VALUE_ICON_CHIP_CLASS_NAME,
  databasePropertyOptionDotColor,
  useDatabasePropertyListInlineLabelLimit,
} from "./property-value-chip";

export type PropertyOptionPickerMode = "single" | "multiple";
export type PropertyOptionPickerHost = "popover" | "embedded";

export interface PropertyOptionRenderContext {
  readonly selected: boolean;
  readonly location: "trigger" | "list" | "selected";
  readonly missing: boolean;
}

export interface PropertyOptionPickerProps {
  readonly host?: PropertyOptionPickerHost;
  readonly label: string;
  readonly triggerAriaLabel?: string;
  readonly mode: PropertyOptionPickerMode;
  readonly options: readonly DatabasePropertyOption[];
  readonly selectedIds: readonly string[];
  readonly disabled?: boolean;
  readonly pending?: boolean;
  readonly loading?: boolean;
  readonly loadingMore?: boolean;
  readonly registryError?: boolean;
  readonly hasMore?: boolean;
  readonly presentation?: "compact" | "page" | "chip" | "list" | "board";
  readonly triggerButton?: ReactElement;
  readonly triggerPrefix?: ReactNode;
  readonly triggerIconOnly?: boolean;
  readonly searchPlaceholder?: string;
  readonly searchLeading?: ReactNode;
  readonly contentClassName?: string;
  readonly allowCreate?: boolean;
  readonly allowClear?: boolean;
  readonly emptyOptionLabel?: string;
  readonly onOpen?: () => void;
  readonly onOpenChange?: (open: boolean) => void;
  readonly onCommit?: () => void;
  readonly onLoadMore?: () => void;
  readonly onSelectedIdsChange: (selectedIds: readonly string[]) => void;
  readonly onCreateOption?: (name: string) => void | Promise<unknown>;
  readonly renderOption?: (
    option: PresentedDataSourcePropertyOption,
    context: PropertyOptionRenderContext,
  ) => ReactNode;
}

const DEFAULT_SEARCH_LEADING = (
  <SearchIcon className="icon-2xs shrink-0 text-token-description-foreground" />
);
const renderDefaultPropertyOption: NonNullable<PropertyOptionPickerProps["renderOption"]> = (
  option,
) => <PropertyOptionToken option={option} />;

export function PropertyOptionToken({
  option,
  className,
}: {
  readonly option: PresentedDataSourcePropertyOption;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        DATABASE_PAGE_PROPERTY_VALUE_TOKEN_CLASS_NAME,
        "max-w-full",
        option.missing
          ? "bg-token-error-background/25 text-token-error-foreground"
          : propertyOptionColorClassName(option.color),
        className,
      )}
    >
      <span className="truncate">{option.name}</span>
    </span>
  );
}

const dedupe = (values: readonly string[]): readonly string[] => [...new Set(values)];

function PropertyOptionDot({
  option,
  className,
  style,
}: {
  readonly option: PresentedDataSourcePropertyOption;
  readonly className?: string;
  readonly style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-[9px] shrink-0 rounded-full", className)}
      style={{
        backgroundColor: databasePropertyOptionDotColor(option.color, option.id),
        ...style,
      }}
    />
  );
}

function PropertyOptionDotSlot({ option }: { readonly option: PresentedDataSourcePropertyOption }) {
  return (
    <span aria-hidden="true" className="grid size-3.5 shrink-0 place-items-center">
      <PropertyOptionDot option={option} />
    </span>
  );
}

function PropertyListMultipleDots({
  options,
}: {
  readonly options: readonly PresentedDataSourcePropertyOption[];
}) {
  const visible = options.slice(0, 3);
  return (
    <span
      aria-hidden="true"
      className="relative h-[9px] shrink-0"
      style={{ width: 9 + Math.max(0, visible.length - 1) * 4.5 }}
    >
      {visible.map((option, index) => (
        <PropertyOptionDot
          key={option.id}
          option={option}
          className="absolute top-0 ring-1 ring-[var(--database-property-chip-surface)]"
          style={{ left: index * 4.5 }}
        />
      ))}
    </span>
  );
}

function PropertyListMultipleTrigger({
  options,
}: {
  readonly options: readonly PresentedDataSourcePropertyOption[];
}) {
  const limit = useDatabasePropertyListInlineLabelLimit();
  const inline = options.length > limit ? options.slice(0, limit - 1) : options;
  const hidden = options.length > limit ? options.slice(limit - 1) : [];
  return (
    <span className="flex h-6 min-w-0 max-w-full items-center gap-[3px] overflow-hidden">
      {inline.map((option) => (
        <span key={option.id} className={DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME}>
          <PropertyOptionDotSlot option={option} />
          <span className="truncate">{option.name}</span>
        </span>
      ))}
      {hidden.length > 0 ? (
        <span className={DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME}>
          <PropertyListMultipleDots options={hidden} />
          <span className="truncate">
            +{hidden.length} {hidden.length === 1 ? "label" : "labels"}
          </span>
        </span>
      ) : null}
    </span>
  );
}

function PropertyBoardMultipleTrigger({
  options,
}: {
  readonly options: readonly PresentedDataSourcePropertyOption[];
}) {
  return (
    <span className="flex min-w-0 max-w-full flex-wrap items-center gap-1">
      {options.map((option) => (
        <span key={option.id} className={DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME}>
          <PropertyOptionDotSlot option={option} />
          <span className="truncate">{option.name}</span>
        </span>
      ))}
    </span>
  );
}

function PropertyOptionPickerFrame({
  host,
  open,
  disabled,
  trigger,
  triggerTooltipContent,
  contentClassName,
  contentInitialFocus,
  onOpenChange,
  children,
}: {
  readonly host: PropertyOptionPickerHost;
  readonly open: boolean;
  readonly disabled: boolean;
  readonly trigger: ReactElement;
  readonly triggerTooltipContent?: ReactNode;
  readonly contentClassName?: string;
  readonly contentInitialFocus: RefObject<HTMLInputElement | null>;
  readonly onOpenChange: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  if (host === "embedded") return children;

  return (
    <NodexPopover open={open} onOpenChange={onOpenChange}>
      <NodexTooltip tooltipContent={triggerTooltipContent}>
        <NodexPopoverTrigger disabled={disabled}>{trigger}</NodexPopoverTrigger>
      </NodexTooltip>
      <NodexPopoverContent
        align="start"
        className={cn("w-[min(320px,calc(100vw-16px))] overflow-hidden p-0", contentClassName)}
        initialFocus={contentInitialFocus}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }}
      >
        {children}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

export function PropertyOptionPicker({
  host = "popover",
  label,
  triggerAriaLabel,
  mode,
  options,
  selectedIds,
  disabled = false,
  pending = false,
  loading = false,
  loadingMore = false,
  registryError = false,
  hasMore = false,
  presentation = "compact",
  triggerButton,
  triggerPrefix,
  triggerIconOnly = false,
  searchPlaceholder = "Search options…",
  searchLeading = DEFAULT_SEARCH_LEADING,
  contentClassName,
  allowCreate = false,
  allowClear = true,
  emptyOptionLabel = PROPERTY_EMPTY_VALUE_LABEL,
  onOpen,
  onOpenChange,
  onCommit,
  onLoadMore,
  onSelectedIdsChange,
  onCreateOption,
  renderOption = renderDefaultPropertyOption,
}: PropertyOptionPickerProps) {
  const [open, setOpen] = useState(host === "embedded");
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const onOpenRef = useRef(onOpen);
  const optionLoadRequestedRef = useRef(false);
  onOpenRef.current = onOpen;
  const triggerDisabled = disabled || pending;
  const mutationDisabled = triggerDisabled || loading;
  const selected = dedupe(selectedIds);
  const selectedSet = new Set(selected);
  const presentedSelected = presentSelectedDataSourcePropertyOptions(options, selected).map(
    (option) =>
      option.missing && loading ? { ...option, name: "Loading…", missing: false } : option,
  );
  const filtered = filterDataSourcePropertyOptions(options, query);
  const canCreate =
    allowCreate &&
    onCreateOption !== undefined &&
    canCreateDataSourcePropertyOption(options, query);
  const changeOpen = (next: boolean) => {
    if (host === "embedded") {
      setOpen(true);
      return;
    }
    if (next) {
      const selectedIndex = options.findIndex((option) => selectedSet.has(option.id));
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    }
    setOpen(next);
    onOpenChange?.(next);
  };
  const changeHostOpen = (next: boolean) => {
    if (next && triggerDisabled) return;
    if (next && !open) {
      optionLoadRequestedRef.current = true;
      onOpen?.();
    }
    changeOpen(next);
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      setCreating(false);
      setError(null);
      return;
    }
    if (host === "popover") return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [host, open]);

  useEffect(() => {
    if (host === "embedded" || !disabled || !open) return;
    setOpen(false);
    onOpenChange?.(false);
  }, [disabled, host, onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      optionLoadRequestedRef.current = false;
      return;
    }
    if (!loading) {
      optionLoadRequestedRef.current = false;
      return;
    }
    if (registryError || optionLoadRequestedRef.current) return;
    optionLoadRequestedRef.current = true;
    onOpenRef.current?.();
  }, [loading, open, registryError]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  const selectOption = (optionId: string) => {
    if (mutationDisabled) return;
    if (mode === "single") {
      if (selectedSet.has(optionId)) {
        changeOpen(false);
        onCommit?.();
        return;
      }
      onSelectedIdsChange([optionId]);
      changeOpen(false);
      onCommit?.();
      return;
    }
    onSelectedIdsChange(
      selectedSet.has(optionId)
        ? selected.filter((id) => id !== optionId)
        : [...selected, optionId],
    );
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const createOption = async () => {
    if (mutationDisabled || !canCreate || !onCreateOption) return;
    setCreating(true);
    setError(null);
    try {
      await onCreateOption(query.trim());
      setQuery("");
      if (mode === "single") {
        changeOpen(false);
        onCommit?.();
      }
    } catch (cause) {
      console.error("[property-option:create]", cause);
      setError("Couldn’t create option. Try again.");
    } finally {
      setCreating(false);
    }
  };

  const regularTriggerContent =
    presentedSelected.length === 0 ? (
      <PropertyEmptyValue />
    ) : mode === "single" ? (
      renderOption(presentedSelected[0]!, {
        selected: true,
        location: "trigger",
        missing: presentedSelected[0]!.missing,
      })
    ) : (
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {presentedSelected.map((option) => (
          <span key={option.id} className="min-w-0">
            {renderOption(option, {
              selected: true,
              location: "trigger",
              missing: option.missing,
            })}
          </span>
        ))}
      </span>
    );
  const listMultipleTrigger =
    presentation === "list" && mode === "multiple" && presentedSelected.length > 0;
  const boardMultipleTrigger =
    presentation === "board" && mode === "multiple" && presentedSelected.length > 0;
  const selectedNames = presentedSelected.map((option) => option.name);
  const closedTriggerLabel =
    triggerAriaLabel ??
    `Edit ${label}${presentation === "board" && selectedNames.length > 0 ? `: ${selectedNames.join(", ")}` : ""}`;
  const triggerContent = listMultipleTrigger ? (
    <PropertyListMultipleTrigger options={presentedSelected} />
  ) : boardMultipleTrigger ? (
    <PropertyBoardMultipleTrigger options={presentedSelected} />
  ) : presentation === "board" ? (
    presentedSelected.length > 0 ? (
      triggerIconOnly ? null : (
        <>
          {!triggerPrefix ? <PropertyOptionDotSlot option={presentedSelected[0]!} /> : null}
          <span className="max-w-44 truncate">{selectedNames.join(", ")}</span>
        </>
      )
    ) : (
      <PropertyEmptyValue />
    )
  ) : presentation === "chip" || presentation === "list" ? (
    <span className="max-w-44 truncate">
      {presentedSelected.length > 0
        ? presentedSelected.map((option) => option.name).join(", ")
        : label}
    </span>
  ) : (
    regularTriggerContent
  );
  const defaultTrigger = (
    <button
      type="button"
      aria-label={closedTriggerLabel}
      className={cn(
        "inline-flex min-h-6 min-w-0 max-w-full items-center text-left outline-hidden",
        "hover:bg-token-foreground/5 focus-visible:ring-2 focus-visible:ring-token-focus disabled:opacity-50",
        presentation === "page"
          ? cn(
              "text-sm",
              presentedSelected.length === 0
                ? DATABASE_PAGE_PROPERTY_EMPTY_TRIGGER_CLASS_NAME
                : "rounded-md pr-1",
            )
          : presentation === "chip"
            ? cn(
                "h-6 gap-1 rounded-full border-[0.5px] pl-1.5 pr-2 text-xs/4 font-medium [&_svg]:size-4 [&_svg]:shrink-0",
                NODEX_RAISED_CONTROL_CHROME_CLASS_NAME,
              )
            : presentation === "list"
              ? listMultipleTrigger
                ? "h-6 gap-[3px] overflow-hidden rounded-[48px] border-0 bg-transparent p-0 hover:bg-transparent focus-visible:ring-1 focus-visible:ring-[var(--database-list-focus)]"
                : DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME
              : presentation === "board"
                ? boardMultipleTrigger
                  ? "inline-flex max-w-full flex-wrap gap-1 rounded-[48px] border-0 bg-transparent p-0 hover:bg-transparent focus-visible:ring-1 focus-visible:ring-[var(--database-property-chip-focus)]"
                  : triggerIconOnly
                    ? DATABASE_PROPERTY_VALUE_ICON_CHIP_CLASS_NAME
                    : DATABASE_PROPERTY_VALUE_CHIP_CLASS_NAME
                : "rounded-md px-1 text-[11px]",
      )}
    >
      {listMultipleTrigger || boardMultipleTrigger ? null : triggerPrefix}
      {triggerContent}
      {presentation !== "chip" &&
      presentation !== "list" &&
      presentation !== "board" &&
      mode === "multiple" &&
      presentedSelected.length > 0 ? (
        <span className="ml-1 inline-flex shrink-0 items-center gap-0.5 text-token-description-foreground">
          <PlusIcon className="icon-2xs" />
        </span>
      ) : null}
    </button>
  );

  return (
    <PropertyOptionPickerFrame
      host={host}
      open={open}
      disabled={triggerDisabled}
      trigger={triggerButton ?? defaultTrigger}
      triggerTooltipContent={presentation === "board" ? closedTriggerLabel : undefined}
      contentClassName={contentClassName}
      contentInitialFocus={inputRef}
      onOpenChange={changeHostOpen}
    >
      {mode === "multiple" && presentedSelected.length > 0 ? (
        <div className="flex flex-wrap gap-1 px-2 pb-1 pt-2" aria-label={`Selected ${label}`}>
          {presentedSelected.map((option) => (
            <span
              key={option.id}
              className="inline-flex min-w-0 items-center rounded-md bg-token-foreground/5 pl-0.5"
            >
              {renderOption(option, {
                selected: true,
                location: "selected",
                missing: option.missing,
              })}
              <button
                type="button"
                aria-label={`Remove ${option.name}`}
                disabled={mutationDisabled}
                onClick={() => {
                  if (mutationDisabled) return;
                  onSelectedIdsChange(selected.filter((id) => id !== option.id));
                }}
                className="mx-0.5 grid size-5 shrink-0 place-items-center rounded text-token-description-foreground hover:bg-token-foreground/10 hover:text-token-foreground"
              >
                <CloseIcon className="icon-xxs" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-9 items-center gap-1.5 px-2">
        {searchLeading}
        <input
          ref={inputRef}
          role="combobox"
          aria-label={`Search ${label} options`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={
            filtered[activeIndex] ? `${listboxId}-${filtered[activeIndex]!.id}` : undefined
          }
          value={query}
          disabled={mutationDisabled}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Backspace" &&
              mode === "multiple" &&
              query.length === 0 &&
              selected.length > 0
            ) {
              event.preventDefault();
              onSelectedIdsChange(selected.slice(0, -1));
              return;
            }
            if (event.key === "Home") {
              event.preventDefault();
              if (filtered.length > 0) setActiveIndex(0);
              return;
            }
            if (event.key === "End") {
              event.preventDefault();
              if (filtered.length > 0) setActiveIndex(filtered.length - 1);
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              if (filtered.length === 0) return;
              setActiveIndex((current) => Math.min(filtered.length - 1, current + 1));
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(0, current - 1));
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              const active = filtered[activeIndex];
              if (active) selectOption(active.id);
              else void createOption();
            }
          }}
          placeholder={searchPlaceholder}
          className="h-8 min-w-0 flex-1 bg-transparent text-sm text-token-text-primary outline-none placeholder:text-token-description-foreground"
        />
      </div>
      <div className="h-px bg-token-foreground/8" />
      <div
        id={listboxId}
        role="listbox"
        aria-multiselectable={mode === "multiple"}
        className="max-h-64 overflow-y-auto p-1"
        onScroll={(event) => {
          if (!hasMore || loadingMore || registryError || !onLoadMore) return;
          const list = event.currentTarget;
          if (list.scrollHeight - list.scrollTop - list.clientHeight > 48) return;
          onLoadMore();
        }}
      >
        {mode === "single" && allowClear && selected.length > 0 && !query ? (
          <button
            type="button"
            role="option"
            aria-selected={false}
            disabled={mutationDisabled}
            onClick={() => {
              if (mutationDisabled) return;
              onSelectedIdsChange([]);
              changeOpen(false);
              onCommit?.();
            }}
            className="flex min-h-7 w-full items-center rounded-lg px-2 text-left text-sm text-token-description-foreground hover:bg-token-list-hover-background"
          >
            {emptyOptionLabel}
          </button>
        ) : null}
        {filtered.map((option, index) => {
          const isSelected = selectedSet.has(option.id);
          const presented = { ...option, missing: false };
          return (
            <button
              key={option.id}
              id={`${listboxId}-${option.id}`}
              type="button"
              role="option"
              aria-selected={isSelected}
              disabled={mutationDisabled}
              onMouseEnter={() => setActiveIndex(index)}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => selectOption(option.id)}
              className={cn(
                "flex min-h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-sm outline-hidden",
                "hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background",
                activeIndex === index && "bg-token-list-hover-background",
              )}
            >
              <span className="min-w-0 flex-1">
                {renderOption(presented, {
                  selected: isSelected,
                  location: "list",
                  missing: false,
                })}
              </span>
              {isSelected ? (
                <CheckmarkIcon className="icon-2xs shrink-0 text-token-text-secondary" />
              ) : null}
            </button>
          );
        })}
      </div>
      {registryError ? (
        <div role="alert" aria-atomic="true">
          <button
            type="button"
            aria-label="Couldn’t load options. Retry"
            onClick={onOpen}
            className="flex min-h-9 w-full items-center justify-between px-3 text-left text-sm text-token-error-foreground hover:bg-token-error-background/20"
          >
            <span>Couldn’t load options</span>
            <span className="text-xs font-medium">Retry</span>
          </button>
        </div>
      ) : filtered.length === 0 && !canCreate ? (
        <p className="px-3 py-2 text-sm text-token-description-foreground">
          {loading ? "Loading options…" : "No options"}
        </p>
      ) : null}
      {canCreate ? (
        <div className="p-1">
          <button
            type="button"
            disabled={mutationDisabled || creating}
            onClick={() => void createOption()}
            className="flex min-h-8 w-full items-center gap-1.5 rounded-lg px-2 text-left text-sm text-token-text-primary hover:bg-token-list-hover-background disabled:opacity-50"
          >
            <PlusIcon className="icon-2xs shrink-0 text-token-text-secondary" />
            <span className="truncate">Create “{query.trim()}”</span>
          </button>
        </div>
      ) : null}
      {hasMore && !registryError ? (
        <div className="border-t border-token-foreground/8 p-1">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="min-h-8 w-full rounded-lg px-2 text-left text-sm text-token-description-foreground hover:bg-token-list-hover-background disabled:opacity-50"
          >
            {loadingMore ? "Loading more…" : "Load more"}
          </button>
        </div>
      ) : null}
      {error ? (
        <p
          role="alert"
          aria-atomic="true"
          className="px-3 py-1.5 text-xs text-token-error-foreground"
        >
          {error}
        </p>
      ) : null}
    </PropertyOptionPickerFrame>
  );
}

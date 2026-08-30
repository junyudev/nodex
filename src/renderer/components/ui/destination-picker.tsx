import type { KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";

import {
  ActivitySpinnerIcon,
  NfmSideMenuChevronRightIcon,
  SearchIcon,
} from "@/components/shared/icons";
import { StatusIcon } from "@/lib/status-presentation";
import { cn } from "@/lib/utils";
import { NodexTooltip } from "./tooltip";

interface NodexDestinationPickerProps {
  readonly ariaLabel: string;
  readonly placeholder: string;
  readonly query: string;
  readonly inputId: string;
  readonly listboxId: string;
  readonly activeDescendantId?: string;
  readonly busy?: boolean;
  readonly onQueryChange: (query: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly children: ReactNode;
  readonly className?: string;
  readonly dialogRole?: "dialog" | "presentation";
  readonly autoFocus?: boolean;
}

export function NodexDestinationPicker({
  ariaLabel,
  placeholder,
  query,
  inputId,
  listboxId,
  activeDescendantId,
  busy = false,
  onQueryChange,
  onKeyDown,
  children,
  className,
  dialogRole = "dialog",
  autoFocus = false,
}: NodexDestinationPickerProps) {
  return (
    <div
      role={dialogRole}
      aria-label={dialogRole === "dialog" ? ariaLabel : undefined}
      className={cn(
        "flex max-h-[70vh] w-[330px] max-w-[calc(100vw-24px)] flex-col overflow-hidden text-[14px] leading-[1.2]",
        className,
      )}
      contentEditable={false}
    >
      <div className="flex h-[38px] shrink-0 items-center gap-1.5 px-2 py-[5px]">
        <SearchIcon
          className="size-4 shrink-0 text-token-description-foreground"
          aria-hidden="true"
        />
        <input
          id={inputId}
          autoFocus={autoFocus}
          role="combobox"
          aria-label={ariaLabel}
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded="true"
          aria-haspopup="listbox"
          aria-activedescendant={activeDescendantId}
          value={query}
          placeholder={placeholder}
          className="h-7 min-w-0 flex-1 rounded-[7px] bg-transparent px-1.5 py-[3px] text-[14px] text-token-foreground outline-hidden placeholder:text-token-description-foreground focus:bg-token-foreground/5"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            onKeyDown(event);
          }}
        />
      </div>
      <div className="notion-scroller vertical h-[374px] min-h-0 overflow-y-auto pb-3">
        <div id={listboxId} role="listbox" aria-labelledby={inputId} aria-busy={busy}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function NodexDestinationPickerSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="pb-1">
      <div className="flex h-7 items-end px-[14px] pb-1 pt-3 text-[12px] leading-4 font-medium text-token-description-foreground">
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </div>
      <div className="flex flex-col gap-px px-1">{children}</div>
    </div>
  );
}

/** Shared option substrate for destination pickers; domain workflows own its content and action. */
export function NodexDestinationPickerOption({
  id,
  focused,
  disabled,
  depth = 0,
  expanded,
  icon,
  children,
  onFocus,
  onToggle,
  onSelect,
}: {
  readonly id: string;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly depth?: number;
  readonly expanded?: boolean;
  readonly icon: ReactNode;
  readonly children: ReactNode;
  readonly onFocus: () => void;
  readonly onToggle?: () => void;
  readonly onSelect: () => void;
}) {
  const expandable = expanded !== undefined && onToggle !== undefined;

  return (
    <button
      id={id}
      type="button"
      role="option"
      aria-selected={focused}
      aria-disabled={disabled || undefined}
      aria-expanded={expandable ? expanded : undefined}
      data-focused={focused ? "true" : undefined}
      className={cn(
        "group flex h-7 w-full select-none items-center gap-1.5 rounded-[7px] pr-2 text-left text-[14px] leading-7 outline-hidden",
        disabled
          ? "cursor-default opacity-55"
          : "cursor-interaction hover:bg-token-list-hover-background",
        focused && "bg-token-list-hover-background",
      )}
      style={{ paddingLeft: 6 + depth * 18 }}
      onPointerEnter={onFocus}
      onClick={() => {
        if (!disabled) onSelect();
      }}
    >
      <span
        className="relative flex h-[18px] w-[22px] shrink-0 items-center justify-center text-token-description-foreground"
        onPointerDown={(event: ReactPointerEvent<HTMLSpanElement>) => {
          if (!expandable || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => {
          if (!expandable) return;
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }}
      >
        <span
          className={cn(
            "flex items-center justify-center transition-opacity",
            expandable && "group-hover:opacity-0 group-focus-visible:opacity-0",
            expandable && focused && "opacity-0",
          )}
        >
          {icon}
        </span>
        {expandable ? (
          <NfmSideMenuChevronRightIcon
            className={cn(
              "absolute icon-2xs opacity-0 transition-[opacity,transform] duration-150 ease-out",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
              focused && "opacity-100",
              expanded && "rotate-90",
            )}
            aria-hidden="true"
          />
        ) : null}
      </span>
      {children}
    </button>
  );
}

export function NodexDestinationPickerPageRowContent({
  title,
  statusId,
  statusLabel,
  projectName,
  accepting = false,
}: {
  readonly title: string;
  readonly statusId: string;
  readonly statusLabel: string;
  readonly projectName?: string;
  readonly accepting?: boolean;
}) {
  return (
    <>
      <NodexTooltip tooltipContent={statusLabel}>
        <span className="flex h-[18px] w-[22px] shrink-0 items-center justify-center">
          <StatusIcon statusId={statusId} label={statusLabel} className="size-4" />
        </span>
      </NodexTooltip>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {projectName ? (
        <span className="ml-1 max-w-[112px] shrink truncate text-[12px] leading-4 text-token-description-foreground">
          {projectName}
        </span>
      ) : null}
      {accepting ? (
        <ActivitySpinnerIcon className="size-3.5 shrink-0 text-token-description-foreground" />
      ) : null}
    </>
  );
}

export function NodexDestinationPickerStatus({
  children,
  role,
}: {
  readonly children: ReactNode;
  readonly role?: "alert" | "status";
}) {
  return (
    <div
      role={role}
      className="flex min-h-9 items-center px-3 py-2 text-[13px] leading-5 text-token-description-foreground"
    >
      {children}
    </div>
  );
}

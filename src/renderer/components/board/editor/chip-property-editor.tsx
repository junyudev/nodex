import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckmarkIcon, EstimateIcon, PriorityValueIcon } from "@/components/shared/icons";
import { EMPTY_PRIORITY_OPTION_VALUE, BOARD_PRIORITY_SELECT_OPTIONS } from "@/lib/board-options";
import { NodexDropdownActionRow, NodexDropdownSurface } from "@/components/ui/dropdown";
import { estimateOptions, estimateStyles } from "@/lib/types";
import { TOGGLE_LIST_STATUS_ORDER, TOGGLE_LIST_STATUS_LABELS } from "@/lib/toggle-list/types";
import { cn } from "@/lib/utils";
import { StatusLabel } from "@/lib/status-presentation";
import type { MetaChipPropertyType } from "@/lib/toggle-list/meta-chips";
import {
  tokenToPriorityValue,
  tokenToEstimateValue,
  tokenToStatusId,
} from "@/lib/toggle-list/meta-chips";
import type { DatabasePropertyOption } from "../../../../shared/database-kernel";
import { propertyOptionColorClassName } from "@/lib/data-source-property-options";
import { isPriority } from "../../../../shared/priority";

export interface ChipPropertyEditorProps {
  propertyType: MetaChipPropertyType;
  currentToken: string;
  selectedValues?: readonly string[];
  options?: readonly DatabasePropertyOption[];
  pageId: string;
  anchorRect: DOMRect;
  onSelect: (propertyType: string, pageId: string, value: string) => void;
  onClose: () => void;
}

const MENU_GAP = 4;
const EMPTY_SELECTED_CHIP_VALUES: readonly string[] = [];
const EMPTY_CHIP_OPTIONS: readonly DatabasePropertyOption[] = [];

function computePosition(
  anchorRect: DOMRect,
  menuRect: { width: number; height: number },
): { top: number; left: number } {
  const viewportH = window.innerHeight;
  const viewportW = window.innerWidth;

  const spaceBelow = viewportH - anchorRect.bottom - MENU_GAP;
  const top =
    spaceBelow >= menuRect.height
      ? anchorRect.bottom + MENU_GAP
      : anchorRect.top - MENU_GAP - menuRect.height;

  let left = anchorRect.left;
  if (left + menuRect.width > viewportW - 8) {
    left = viewportW - menuRect.width - 8;
  }
  if (left < 8) left = 8;

  return { top: Math.max(4, top), left };
}

export function ChipPropertyEditor({
  propertyType,
  currentToken,
  selectedValues = EMPTY_SELECTED_CHIP_VALUES,
  options = EMPTY_CHIP_OPTIONS,
  pageId,
  anchorRect,
  onSelect,
  onClose,
}: ChipPropertyEditorProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const currentValue = resolveCurrentValue(propertyType, currentToken);
  const selectedSet = new Set(selectedValues);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPosition(computePosition(anchorRect, { width: rect.width, height: rect.height }));
  }, [anchorRect]);

  // Close on outside click
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  // Close on scroll of any ancestor
  useEffect(() => {
    const handleScroll = () => onClose();
    window.addEventListener("scroll", handleScroll, true);
    return () => window.removeEventListener("scroll", handleScroll, true);
  }, [onClose]);

  const handleSelect = useCallback(
    (value: string) => {
      onSelect(propertyType, pageId, value);
      if (propertyType !== "tag") onClose();
    },
    [pageId, onClose, onSelect, propertyType],
  );

  const items = getItemsForType(propertyType, options);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((i) => (i + 1) % items.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex((i) => (i - 1 + items.length) % items.length);
      } else if (e.key === "Enter" && highlightedIndex >= 0) {
        e.preventDefault();
        const item = items[highlightedIndex];
        if (item) handleSelect(item.value);
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleSelect, highlightedIndex, items]);

  return createPortal(
    <NodexDropdownSurface
      ref={menuRef}
      className={cn(
        "fixed min-w-36 outline-none",
        position ? "opacity-100" : "invisible opacity-0",
      )}
      style={position ? { top: position.top, left: position.left } : undefined}
      role="listbox"
      aria-label={`Edit ${propertyType}`}
    >
      {items.map((item, index) => (
        <NodexDropdownActionRow
          key={item.value}
          role="option"
          aria-selected={
            propertyType === "tag" ? selectedSet.has(item.value) : item.value === currentValue
          }
          className={cn(
            "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-none bg-transparent text-left text-inherit",
            index === highlightedIndex && "bg-token-list-hover-background",
          )}
          onPointerEnter={() => setHighlightedIndex(index)}
          onPointerLeave={() => setHighlightedIndex(-1)}
          onClick={() => handleSelect(item.value)}
        >
          <span className="min-w-0 truncate">{renderItemContent(propertyType, item)}</span>
          {(propertyType === "tag" ? selectedSet.has(item.value) : item.value === currentValue) && (
            <CheckmarkIcon className="h-3.5 w-3.5 shrink-0 text-token-foreground" />
          )}
        </NodexDropdownActionRow>
      ))}
    </NodexDropdownSurface>,
    document.body,
  );
}

interface MenuItemData {
  value: string;
  label: string;
  className?: string;
}

function getItemsForType(
  propertyType: string,
  options: readonly DatabasePropertyOption[],
): MenuItemData[] {
  switch (propertyType) {
    case "priority":
      return BOARD_PRIORITY_SELECT_OPTIONS.map((opt) => ({
        value: opt.value,
        label: opt.label,
        className: opt.className,
      }));
    case "estimate":
      return estimateOptions.map((opt) => ({
        value: opt.value,
        label: opt.label,
        className: opt.value === "none" ? "" : estimateStyles[opt.value].className,
      }));
    case "status":
      return TOGGLE_LIST_STATUS_ORDER.map((statusId) => ({
        value: statusId,
        label: TOGGLE_LIST_STATUS_LABELS[statusId],
      }));
    case "tag":
      return options.map((option) => ({
        value: option.id,
        label: option.name,
        className: propertyOptionColorClassName(option.color),
      }));
    default:
      return [];
  }
}

function resolveCurrentValue(propertyType: string, token: string): string {
  switch (propertyType) {
    case "priority":
      return tokenToPriorityValue(token) ?? EMPTY_PRIORITY_OPTION_VALUE;
    case "estimate":
      return tokenToEstimateValue(token) ?? "none";
    case "status":
      return tokenToStatusId(token) ?? "";
    default:
      return "";
  }
}

function renderItemContent(propertyType: string, item: MenuItemData) {
  if (propertyType === "priority") {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm/5 text-token-text-primary">
        <PriorityValueIcon
          priority={isPriority(item.value) ? item.value : null}
          className="size-4 text-token-description-foreground"
        />
        <span className="truncate">{item.label}</span>
      </span>
    );
  }

  if (propertyType === "estimate") {
    return (
      <span className="inline-flex min-w-0 items-center gap-2 text-sm/5 text-token-text-primary">
        <EstimateIcon className="size-4 text-token-description-foreground" />
        <span className="truncate">{item.label}</span>
      </span>
    );
  }

  if (propertyType === "status") {
    return <StatusLabel statusId={item.value} label={item.label} />;
  }

  if (propertyType === "tag") {
    return (
      <span
        className={cn("inline-flex h-5 items-center rounded-sm px-1.5 text-sm/5", item.className)}
      >
        {item.label}
      </span>
    );
  }

  return <span>{item.label}</span>;
}
